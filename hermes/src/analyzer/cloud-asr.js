/**
 * 云端语音识别 —— 长直播（1~4 小时）的转写主力。
 * © 2026 郭洛斌
 *
 * 为什么需要它：
 *    本地 sherpa-onnx（sense-voice / paraformer）能跑，但一场 3-4 小时的直播
 *    按 60 秒一片要 180~240 片，每片同步 native decode 卡主线程十几秒，
 *    整场几小时起步，而且 int8 模型对连麦/口音/专业术语的准确率有限。
 *    云端 whisper 一类的接口按分钟计费、可并发，同一场通常几分钟出稿。
 *
 * 三个实现要点（对应三个真实约束）：
 *
 *   1) 上传体积：服务商普遍限制 25MB/请求。ffmpeg 用**一条命令**
 *      「抽音轨 + 转码 + 按固定时长切片」同时做完 —— libopus 24kbps 单声道，
 *      1 小时音频 ≈ 10.8MB，4 小时整场拆完约 43MB，单片（默认 10 分钟）约 1.8MB。
 *      注意不能用 wav（16kHz PCM ≈ 115MB/小时，一片就超限）。
 *
 *   2) 断点续传：按分钟计费，中途失败重跑不能重新计费。
 *      所以每片结果单独落盘成 <temp>/asr-cloud/<素材键>/chunk_NNN.json，
 *      重跑只补缺片。
 *
 *   3) 可控：并发度、单场上限（maxMinutesPerRun）、超时、取消都可配。
 *      取消要把 ffmpeg 和在飞的 HTTP 一起掐掉 —— 否则用户点了取消还在上传扣费。
 *
 * 时间戳：ffmpeg 的 segment 按固定 `-segment_time` 切，第 i 片的起点就是
 * i * chunkSeconds（`-reset_timestamps 1` 会让每片自己的时间戳从 0 开始）。
 * 拼装时用 i * chunkSeconds 做偏移即可，不需要再对每片 ffprobe ——
 * 少 N 次进程往返，也避免"读不到时长就静默错位"。
 *
 * 支持两类服务：
 *   - openai 兼容：POST {baseUrl}/audio/transcriptions（multipart）。
 *     OpenAI / Groq 以及绝大多数第三方中转都是这一套
 *   - gemini 原生：inlineData 走 generateContent（≤20MB，片要切小）
 */

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  renameSync, unlinkSync, rmdirSync, mkdtempSync, statSync,
} from 'fs';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { FFmpegHelper } from './ffmpeg-helper.js';
import { fetchWithDiagnostics, describeHttpFailure, resolveProxy } from '../llm/proxy.js';

const HERMES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 数值配置项的统一取法。
 *
 * 为什么不能用 `Number(x) ?? default`：Number(undefined) 是 **NaN**，
 * 而 NaN 不是 nullish，`??` 不会兜底 —— 拿到 NaN 再拿去比较
 * （`for (attempt = 0; attempt <= retries; ...)`）永远是 false，
 * 循环一次都不执行，最后落到"未知失败"这种查不出原因的错误上。
 *
 * 这个坑在本次开发里真实踩到过：retries 没配 → NaN → 整个转写一片都不发。
 */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 整数配置项：带上下限夹取 */
function clampInt(value, fallback, min = -Infinity, max = Infinity) {
  const n = Math.round(num(value, fallback));
  return Math.min(max, Math.max(min, n));
}

/** key 的三种写法：明文 / {env:NAME} / 环境变量兜底 */
function resolveKey(raw, envName) {
  const s = String(raw ?? '').trim();
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s);
  if (m) return process.env[m[1]] || '';
  if (s) return s;
  return envName ? (process.env[envName] || '') : '';
}

/** 重试退避：1s → 2s → 4s，带 jitter，可被取消 */
function backoff(attempt, signal) {
  const ms = Math.min(8000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('已取消')); }, { once: true });
  });
}

export class CloudASR {
  /** @param {object} config Hermes 配置（读 analyzer.cloudAsr） */
  constructor(config = {}) {
    this.config = config || {};
    const c = this.config?.analyzer?.cloudAsr || {};

    this.enabled = c.enabled === true;
    this.provider = String(c.provider || 'auto').toLowerCase();

    /*
     * 地址/key/模型：显式配的优先；没配就"继承"云端 LLM 那一套。
     *
     * 为什么要继承：key 和地址都已经在云端配置里填过一次（桌面面板 /
     * setup-cloud.mjs），为音频再让人填一遍纯属刁难 ——
     * 而且不少中转是同一把 key 同时开着 chat 和 audio。
     */
    const inherit = c.inherit !== false;
    const g = this.config?.gemini || {};
    this.baseUrl = String(c.baseUrl || (inherit ? (g.baseUrl || '') : '')).replace(/\/+$/, '');
    this.apiKey = resolveKey(c.apiKey, c.apiKeyEnv || 'CLOUD_ASR_API_KEY')
      || (inherit ? resolveKey(g.apiKey, 'GEMINI_API_KEY') : '');
    this.model = String(c.model || (inherit ? (g.model || '') : '') || 'whisper-1').trim();

    this.language = String(c.language || 'zh').trim();
    this.chunkSeconds = clampInt(c.chunkSeconds, 600, 30);
    this.concurrency = clampInt(c.concurrency, 2, 1, 8);
    // opus 24kbps → 单片约 chunkSeconds*3KB。10 分钟的片 1.8MB，
    // 正常远不到上限；这道闸是防有人把片长调到几小时。
    this.maxFileMB = clampInt(c.maxFileMB, 24, 1);
    this.retries = clampInt(c.retries, 2, 0, 8);
    this.timeoutMs = clampInt(c.timeoutMs, 300000, 10000);
    /** 单场最多送多少分钟音频（0 = 不限）。防手滑把整个库都送上去 */
    this.maxMinutesPerRun = clampInt(c.maxMinutesPerRun, 0, 0);
    this.bitrateKbps = clampInt(c.bitrateKbps, 24, 8);

    this.tempDir = String(c.tempDir || this.config?.upload?.tempDir
      || join(HERMES_ROOT, 'upload', 'temp')).replace(/\/+$/, '');
    this._ff = null;
  }

  get ff() {
    if (this._ff === null) this._ff = new FFmpegHelper();
    return this._ff;
  }

  /** 缺什么就说什么，别只回一个"不可用" */
  get configError() {
    if (!this.enabled) return '云端识别未启用（analyzer.cloudAsr.enabled = false）';
    if (!this.ff.isAvailable) return '找不到 ffmpeg（云端识别需要先用它切片）';
    if (!this.baseUrl) return '未配置音频接口地址（analyzer.cloudAsr.baseUrl）';
    if (!this.apiKey) return '未配置音频 key（analyzer.cloudAsr.apiKey，或让 inherit 复用云端那一把）';
    if (!this.model) return '未配置音频模型（analyzer.cloudAsr.model，如 whisper-1 / groq-whisper-large-v3）';
    return null;
  }

  get available() { return !this.configError; }

  /** 素材缓存键：路径哈希，避免不同素材共用一个目录 */
  _key(videoPath) {
    const abs = String(videoPath || '').replace(/\\/g, '/');
    const h = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 10);
    return `${basename(dirname(abs))}__${basename(abs).replace(/\.[^.]+$/, '')}_${h}`;
  }

  chunkDir(videoPath) { return join(this.tempDir, 'asr-cloud', this._key(videoPath)); }

  /**
   * 内容指纹（2026-10-21）：同名素材被换成新内容时，旧分片/识别缓存不能复用
   * —— 那会把 A 视频的音频分片当 B 视频转写。只存 size（几 GB 视频算哈希
   * 付不起 IO）；mtime 复制/搬盘就变，不可靠。
   */
  _fp(videoPath) {
    try {
      const s = statSync(videoPath);
      return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    } catch { return null; }
  }

  _chunkFile(dir, index) { return join(dir, `c_${String(index).padStart(4, '0')}.ogg`); }
  _cacheFile(dir, index) { return join(dir, `chunk_${String(index).padStart(4, '0')}.json`); }
  _listFile(dir) { return join(dir, 'seg.csv'); }

  /**
   * 列出已切好的分片（按序号），**带每片的真实起止时间**。
   *
   * 为什么不能按 `index * chunkSeconds` 算偏移（2026-10-13 实测踩的坑）：
   * ffmpeg 的 `-segment_time` 只是"目标时长"，实际切点受输入流影响。
   * 一场 226 分钟的直播录屏，实测切出了 5 秒、309 秒、460 秒的片 ——
   * 拿 `index * 300` 去拼，整条时间轴会系统性错位几百秒，
   * 表现为"中文字幕对不上画面、越往后偏得越远"。
   *
   * 所以切片时同时让 ffmpeg 写一份 seg.csv（`-segment_list ... -segment_list_type csv`），
   * 里面是每片的确切 start/end。读不到 csv 时才退回估算。
   */
  listChunks(dir) {
    if (!existsSync(dir)) return [];

    // 1) ffmpeg 的清单：文件名 + 真实起止秒
    const starts = new Map();
    try {
      const csv = readFileSync(this._listFile(dir), 'utf-8');
      for (const line of csv.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cols = line.split(',');
        const name = String(cols[0] || '').trim();
        const m = /^c_(\d+)\.ogg$/.exec(name);
        if (!m) continue;
        const start = Number(cols[1]);
        const end = Number(cols[2]);
        if (!Number.isFinite(start)) continue;
        starts.set(Number(m[1]), { start, end: Number.isFinite(end) ? end : start });
      }
    } catch { /* 没有清单就靠估算 */ }

    // 2) 实际存在的分片文件
    const re = /^c_(\d+)\.ogg$/;
    const out = [];
    let lastKnown = -1;
    for (const f of readdirSync(dir)) {
      const m = re.exec(f);
      if (!m) continue;
      const index = Number(m[1]);
      const hit = starts.get(index);
      if (hit) {
        lastKnown = index;
        out.push({
          index,
          file: join(dir, f),
          startMs: Math.round(hit.start * 1000),
          endMs: Math.round(hit.end * 1000),
          durationMs: Math.max(0, Math.round((hit.end - hit.start) * 1000)),
          exact: true,
        });
      } else {
        /*
         * 清单里没有这一片（老缓存 / 清单被删）。
         * 退回按 index 估算 —— 这是没有清单时唯一可用的信息，
         * 别去用"上一片的 end"：没有清单时上一片也没有 end，会连锁算成 0。
         */
        const base = index * this.chunkSeconds * 1000;
        out.push({
          index,
          file: join(dir, f),
          startMs: base,
          endMs: base + this.chunkSeconds * 1000,
          durationMs: this.chunkSeconds * 1000,
          exact: false,
        });
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  /** 读某片的识别缓存（续跑的关键） */
  readCached(dir, index) {
    try {
      const f = this._cacheFile(dir, index);
      if (!existsSync(f)) return null;
      const data = JSON.parse(readFileSync(f, 'utf-8'));
      return Array.isArray(data) ? data : null;
    } catch { return null; }
  }

  /** 原子写：先 .part 再 rename，避免并发读到写一半的 JSON */
  writeCached(dir, index, segments) {
    try {
      const target = this._cacheFile(dir, index);
      writeFileSync(`${target}.part`, JSON.stringify(segments), 'utf-8');
      renameSync(`${target}.part`, target);
    } catch { /* 写失败不影响本次结果，只是下次重跑这一片（重新计费） */ }
  }

  /** 已缓存片数（诊断/断点展示用） */
  cachedCount(videoPath) {
    const dir = this.chunkDir(videoPath);
    if (!existsSync(dir)) return { chunks: 0, cached: 0 };
    const chunks = this.listChunks(dir).length;
    let cached = 0;
    for (const c of this.listChunks(dir)) if (this.readCached(dir, c.index)) cached++;
    return { chunks, cached };
  }

  /** 清掉某条素材的切片与缓存（素材删除/文件被替换时用） */
  clear(videoPath) {
    const dir = this.chunkDir(videoPath);
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir);
    for (const f of files) unlinkSync(join(dir, f));
    try { rmdirSync(dir); } catch { /* 非空就不删，剩下的日志里能看到 */ }
    return files.length;
  }

  /**
   * 一步 ffmpeg 同时做「抽音轨 + 转码 + 按固定时长切片」。
   *
   * 为什么不先抽整段再切：先抽整段 opus 再切要写两遍全量数据（4 小时 43MB），
   * segment muxer 一遍就能边转边切。
   */
  async slice(videoPath, outDir, signal) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', `${this.bitrateKbps}k`,
      '-f', 'segment',
      '-segment_time', String(this.chunkSeconds),
      '-reset_timestamps', '1',
      // 让 ffmpeg 同时写出每片的真实起止时间。没有它就只能按 index*chunkSeconds
      // 估算，而实际片长受输入流影响会忽长忽短（实测一片 5s、一片 460s），
      // 时间轴会整体错位几百秒。
      '-segment_list', this._listFile(outDir),
      '-segment_list_type', 'csv',
      // 0 = 不限制清单条数。默认值是 cache 语义下的清理策略，
      // 片数多的时候早先的条目会被挤出清单。
      '-segment_list_size', '0',
      join(outDir, 'c_%04d.ogg'),
    ];
    const t0 = Date.now();
    // 4 小时素材扫一遍几十秒，但给足余量；超时由调用方的 signal 负责掐
    await this.ff.run(this.ff.ffmpegPath, args, 3600_000, signal);
    return Date.now() - t0;
  }

  _useGemini() {
    if (this.provider === 'gemini') return true;
    if (this.provider === 'openai') return false;
    return /generativelanguage\.googleapis\.com/.test(this.baseUrl);
  }

  _geminiPrompt() {
    const lang = this.language === 'zh' || this.language === 'zh-CN' ? '中文' : this.language;
    return '请逐句转写这段音频，只输出 JSON 数组，不要任何解释。'
      + `每项格式：{"start":秒,"end":秒,"text":"该句原文"}，语言用${lang}。`
      + '时间从 0 开始、单调递增，覆盖整段音频。';
  }

  /**
   * 送一片到云端。
   * @returns {Promise<{ok:boolean, segments?:Array, error?:string, status?:number, fatal?:boolean, aborted?:boolean, empty?:boolean}>}
   */
  async transcribeChunk(chunk, signal) {
    let bytes;
    try { bytes = readFileSync(chunk.file); } catch (err) {
      return { ok: false, error: `读不到分片 ${chunk.file}：${err.message}`, fatal: true };
    }
    if (!bytes.length) return { ok: false, error: `分片 ${chunk.index} 是空文件`, fatal: true };

    /*
     * 超过单请求上限就别硬发。硬发只会拿到 413，而用户看到的只是一句"识别失败"，
     * 半天查不出是片长调太大。
     */
    if (bytes.length > this.maxFileMB * 1024 * 1024) {
      return {
        ok: false, fatal: true,
        error: `分片 ${chunk.index} 有 ${(bytes.length / 1048576).toFixed(1)}MB，超过单请求上限 ${this.maxFileMB}MB。`
          + `请把 analyzer.cloudAsr.chunkSeconds 调小（当前 ${this.chunkSeconds} 秒）。`,
      };
    }

    const useGemini = this._useGemini();
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    let url;
    let body;

    if (useGemini) {
      /*
       * Gemini 原生：音频走 inlineData + 文本提示词，让它逐句带时间戳输出。
       * inline 有 20MB 上限（base64 还要再胀 1/3），所以用 Gemini 时必须把片切小。
       * 输出不保证是 JSON，靠 parseGeminiTranscript 兜住。
       */
      url = `${this.baseUrl}/models/${this.model}:generateContent`;
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        contents: [{
          parts: [
            { text: this._geminiPrompt() },
            { inlineData: { mimeType: 'audio/ogg', data: bytes.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      });
    } else {
      /*
       * OpenAI 兼容：multipart/form-data。
       * 用全局 FormData/Blob（Node 18+ 原生，undici 自动带 boundary），
       * 不引 form-data 包 —— 少一个依赖少一次踩坑。
       *
       * response_format=verbose_json 是必须的：默认的 json 只给整段 text，
       * 没有分段时间戳，下游分片/打轴会全部失效。
       */
      url = `${this.baseUrl}/audio/transcriptions`;
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'audio/ogg' }), `chunk_${chunk.index}.ogg`);
      fd.append('model', this.model);
      fd.append('response_format', 'verbose_json');
      if (this.language) fd.append('language', this.language);
      body = fd;
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted) return { ok: false, error: '已取消', aborted: true };
      try {
        const res = await fetchWithDiagnostics(url, { method: 'POST', headers, body, signal }, this.timeoutMs);
        const text = await res.text();

        if (!res.ok) {
          const msg = describeHttpFailure(res.status, res.statusText, text);
          /*
           * 4xx 里只有 429（限流）和 408 值得重试。
           * 其它（401 key 无效 / 404 模型不存在 / 413 太大）是配置或额度问题 ——
           * 重发只是继续烧钱，而且每一片报同一个错，刷一屏没用的日志。
           */
          if (res.status === 429 || res.status === 408 || res.status >= 500) {
            lastErr = msg;
            if (attempt < this.retries) { await backoff(attempt, signal); continue; }
          }
          return { ok: false, error: msg, status: res.status, fatal: true };
        }

        let json;
        try { json = JSON.parse(text); } catch {
          return { ok: false, error: `云端返回的不是 JSON：${text.slice(0, 160)}`, status: res.status, fatal: true };
        }
        const segments = useGemini ? parseGeminiTranscript(json) : normalizeOpenAiTranscript(json);
        // 静音/纯音乐的片子本来就没字，不算失败 —— 但要和"接口坏了"区分开
        return { ok: true, segments, empty: segments.length === 0 };
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          return { ok: false, error: '已取消', aborted: true };
        }
        lastErr = `请求失败：${err?.message || err}（代理 ${resolveProxy(this.config) || '未配置'}）`;
        if (attempt < this.retries) { await backoff(attempt, signal); continue; }
      }
    }
    return { ok: false, error: lastErr || '未知失败' };
  }

  /**
   * 转写整个视频。
   *
   * @param {string} videoPath
   * @param {{signal?:AbortSignal, onProgress?:(p:{phase:string,done:number,total:number,chars:number})=>void}} opts
   * @returns {Promise<{ok:boolean, transcript?:Array, source?:string, reason?:string, done?:number, total?:number, chars?:number, chunkCount?:number, elapsedMs?:number, silent?:boolean}>}
   */
  async transcribe(videoPath, opts = {}) {
    const signal = opts.signal || null;
    const onProgress = opts.onProgress || null;
    const t0 = Date.now();

    const cfgErr = this.configError;
    if (cfgErr) return { ok: false, reason: cfgErr };

    const dir = this.chunkDir(videoPath);
    mkdirSync(dir, { recursive: true });

    // 内容指纹守卫（2026-10-21）。
    // 只对"带 fp.json 的新目录"生效：老目录没有 fp.json 一律放行 ——
    // 保护已花钱的 226 分钟级云端缓存，不做一次性清库升级。
    try {
      const fpFile = join(dir, 'fp.json');
      let cur = null;
      if (existsSync(fpFile)) {
        const prev = JSON.parse(readFileSync(fpFile, 'utf-8'));
        cur = this._fp(videoPath);
        if (prev && cur && prev.size !== cur.size) {
          console.warn(`[CloudASR] 内容指纹变了（${prev.size} → ${cur.size} 字节），清掉旧分片重切：${basename(videoPath)}`);
          this.clear(videoPath);
          mkdirSync(dir, { recursive: true });
          writeFileSync(fpFile, JSON.stringify(cur), 'utf-8');
        }
      }
      if (!cur && !existsSync(fpFile) && !this.listChunks(dir).length) {
        // 首次（老目录且无分片 / 全新素材）切片前落指纹
        writeFileSync(fpFile, JSON.stringify(this._fp(videoPath)), 'utf-8');
      }
    } catch { /* 指纹设施坏了不影响主流程 */ }

    // 1) 切片。已切过的目录直接复用（续跑不必再把 4 小时扫一遍）
    let chunks = this.listChunks(dir);
    if (!chunks.length) {
      onProgress?.({ phase: 'slicing', done: 0, total: 0, chars: 0 });
      try {
        await this.slice(videoPath, dir, signal);
      } catch (err) {
        if (signal?.aborted) return { ok: false, reason: '已取消' };
        return { ok: false, reason: `ffmpeg 切片失败：${err.message}` };
      }
      chunks = this.listChunks(dir);
      if (!chunks.length) return { ok: false, reason: '切片后没有得到任何音频分片（视频没有音轨？）' };
    }

    const total = chunks.length;

    // 单场上限：每分钟都花的是钱，宁可失败也不要静默超额
    const totalSeconds = total * this.chunkSeconds;
    if (this.maxMinutesPerRun && totalSeconds / 60 > this.maxMinutesPerRun) {
      return {
        ok: false,
        reason: `这场素材约 ${Math.round(totalSeconds / 60)} 分钟，超过单场上限 ${this.maxMinutesPerRun} 分钟。`
          + `需要跑请调大 analyzer.cloudAsr.maxMinutesPerRun。`,
      };
    }

    // 2) 逐片识别（带磁盘缓存，重跑只补缺片）
    let done = 0;
    let chars = 0;
    for (const ch of chunks) {
      const c = this.readCached(dir, ch.index);
      if (c) { done++; chars += c.reduce((a, s) => a + (s.text?.length || 0), 0); }
    }
    onProgress?.({ phase: 'cloud', done, total, chars });

    const errors = [];
    let stopAll = false;   // 配置/额度类错误：立刻停手
    let cursor = 0;        // worker 共享游标

    const worker = async () => {
      for (;;) {
        if (stopAll || signal?.aborted) return;
        const i = cursor++;
        if (i >= chunks.length) return;
        const ch = chunks[i];
        if (this.readCached(dir, ch.index)) continue; // 已完成（含上一轮落的缓存）

        const r = await this.transcribeChunk(ch, signal);
        if (r.aborted) return;
        if (r.ok) {
          this.writeCached(dir, ch.index, r.segments);
          done++;
          chars += r.segments.reduce((a, s) => a + (s.text?.length || 0), 0);
          onProgress?.({ phase: 'cloud', done, total, chars });
          continue;
        }
        if (r.fatal) {
          // 只记第一个 fatal：它是根因，后面的都是同一原因的重复
          if (!errors.some((e) => e.fatal)) errors.push({ index: ch.index, error: r.error, fatal: true });
          stopAll = true;
          return;
        }
        errors.push({ index: ch.index, error: r.error, fatal: false });
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));

    if (signal?.aborted) return { ok: false, reason: '已取消', done, total };

    if (errors.length) {
      const fatal = errors.find((e) => e.fatal);
      return {
        ok: false,
        reason: (fatal ? fatal.error : `${errors.length}/${total} 片识别失败：${errors.slice(0, 3).map((e) => `#${e.index} ${e.error}`).join('；')}`),
        done, total, partial: true,
      };
    }

    // 3) 拼装：偏移用**每片自己的真实起点**（见 listChunks 的注释），
    //    并做一次单调性规范化。
    //
    // 注意坐标系：缓存里存的是**片内相对时间**（ffmpeg 的
    // -reset_timestamps 1 让每片自己的时间戳从 0 开始），
    // 所以钳制必须在片内那一帧做，再加绝对偏移 base。
    // 混着比会让"片内 10s"被绝对偏移 600000 直接顶成 600000。
    const merged = [];
    for (const ch of chunks) {
      const segs = this.readCached(dir, ch.index) || [];
      const base = ch.startMs ?? (ch.index * this.chunkSeconds * 1000);
      const limit = (ch.endMs ?? (base + this.chunkSeconds * 1000)) - base;
      for (const s of segs) {
        const raw = Number(s.start);
        const rawEnd = Number(s.end);
        if (!Number.isFinite(raw) || !Number.isFinite(rawEnd)) continue;
        // 模型有时会把时间戳报出本片之外（实测一片 300s 的音频报到 460s）。
        // 越界部分会跟下一片重叠，打轴时句子跳到别处 —— 钳回本片窗口。
        const localStart = Math.min(Math.max(raw, 0), Math.max(0, limit - 100));
        const localEnd = Math.min(Math.max(rawEnd, localStart + 100), Math.max(100, limit));
        const start = base + localStart;
        const end = base + localEnd;
        merged.push({ ...s, start, end, start_ms: start, end_ms: end, _k: merged.length });
      }
    }
    // 稳定排序：保证全局单调。同起点的按"片内原始顺序"排，
    // 所以同一片内部不会被重排（模型给的相对顺序通常比按 start 排更可信）。
    merged.sort((a, b) => (a.start - b.start) || (a._k - b._k));

    if (!merged.length) {
      return { ok: false, reason: '云端识别完成但没有产出任何文本（可能整场是静音/纯音乐）', silent: true, done, total };
    }

    return {
      ok: true,
      // _k 只是排序用的内部序号，不能漏给下游 —— 它会跟着 transcript
      // 一起被 JSON.stringify 写进 asr_path 缓存和数据库里。
      transcript: merged.map(({ _k, ...rest }) => rest),
      source: 'cloud-asr',
      chunkCount: total,
      chars,
      elapsedMs: Date.now() - t0,
    };
  }

  /**
   * 健康检查：真发一小段音频上去，而不是只查 /models。
   *
   * 为什么必须真发：音频模型和聊天模型是两条产品线，中转站支持 chat
   * 不代表支持 audio（APIMart 就是典型）。只查模型列表会把"不支持音频"
   * 报成"可用"，然后到分析时才炸。
   */
  async probe() {
    const cfgErr = this.configError;
    if (cfgErr) return { ok: false, error: cfgErr, supported: false };

    // mkdtempSync 走系统 temp：探测用的临时文件不该占用素材缓存目录
    const tmp = mkdtempSync(join(tmpdir(), 'hermes-asr-probe-'));
    try {
      const wav = join(tmp, 'p.ogg');
      await this.ff.run(this.ff.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
        '-t', '1', '-c:a', 'libopus', '-b:a', '24k', wav,
      ], 60000, null);
      if (!existsSync(wav)) return { ok: false, error: '生成探测音频失败（ffmpeg）', supported: false };

      const r = await this.transcribeChunk({ index: 0, file: wav }, null);
      if (r.ok) return { ok: true, supported: true };
      // 403/404/405/413/415/422 属于"这位服务商不认这条路"，和 key 无效要分开说
      const unsupported = r.status && [404, 405, 413, 415, 422].includes(r.status);
      return { ok: false, error: r.error, status: r.status, supported: !unsupported };
    } catch (err) {
      return { ok: false, error: err.message, supported: false };
    } finally {
      try { for (const f of readdirSync(tmp)) unlinkSync(join(tmp, f)); rmdirSync(tmp); } catch { /* ignore */ }
    }
  }
}

/**
 * 清掉 Gemini 吐进 text 里的原始 JSON 碎片。
 *
 * 2026-10-13 实测：模型会返回
 *   [{"start":0,"end":2,"text":"开始请罪吧"},{"start":5,"end":11,"text":"..."},...]
 * 但**某些项的 text 字段里又塞进了它自己正在生成的 JSON 片段**，例如
 *   "text": ", \"end\": 2, \"text\": \"开始请罪吧，第二首我们唱这首歌，好不好？\"}"
 * 这是长输出接近 token 上限时模型自顾自续写造成的。不清理的话，
 * 这些片段会变成字幕里的乱码，还会把时间戳带偏。
 *
 * 处理：能从中抽出 "text":"..." 的就拼起来，抽不出来的整段丢掉 ——
 * 它本来就不是语音内容，留着只会污染下游的分段与挑句。
 */
function sanitizeSegmentText(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const looksLikeJson = /^[{,]/.test(t) || /"\s*(?:start|end|text)\s*"\s*:/.test(t);
  if (!looksLikeJson) return t;
  const vals = [...t.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (!vals.length) return '';
  return vals
    .map((v) => { try { return JSON.parse(`"${v}"`); } catch { return v; } })
    .join(' ')
    .trim();
}

/**
 * OpenAI 兼容 → 标准 {start,end,text}（毫秒）。
 *
 * 同时接受 `{segments:[...]}` 和裸数组 `[...]`：OpenAI 给的是前者，
 * 但解析 Gemini 那一路传下来的是我们自己 map 出来的**裸数组**。
 * 这里只认 {segments} 的话，Gemini 解析结果会静默变成空数组 ——
 * 表现为"云端识别成功但一个字都没有"，而且没有任何报错。
 */
export function normalizeOpenAiTranscript(json) {
  const raw = Array.isArray(json) ? json : (Array.isArray(json?.segments) ? json.segments : []);
  const out = [];
  for (const s of raw) {
    const start = Number(s?.start ?? s?.from ?? 0);
    const end = Number(s?.end ?? s?.to ?? 0);
    const text = sanitizeSegmentText(s?.text ?? s?.transcript ?? '');
    if (!text) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start: Math.round(start * 1000), end: Math.round(end * 1000), text });
  }
  // 下游混用 start_ms/start 两种写法，两种键都给，避免读到 undefined
  for (const o of out) { o.start_ms = o.start; o.end_ms = o.end; }
  return out;
}

/**
 * Gemini 的音频转写：模型不保证按 JSON 返回，这里必须兜住。
 * 接受：{segments:[...]} / 裸数组 / ```json 代码块 / 逐行 "12.3-15.6 文本"
 */
export function parseGeminiTranscript(json) {
  let text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) return [];
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  if (parsed) {
    const arr = Array.isArray(parsed) ? parsed : (parsed.segments || parsed.transcript || []);
    return normalizeOpenAiTranscript(
      (Array.isArray(arr) ? arr : []).map((s) => ({
        start: s?.start ?? s?.from ?? 0,
        end: s?.end ?? s?.to ?? 0,
        text: s?.text ?? '',
      }))
    );
  }

  // 兜底：按行解析 "[12.3s] 文本" / "12.3-15.6 文本"
  const segs = [];
  for (const line of text.split('\n')) {
    const m = /\[?(\d+(?:\.\d+)?)s?\]?\s*[-~]?\s*(?:(\d+(?:\.\d+)?)s?\s*)?[:\-]?\s*(.+)/.exec(line.trim());
    if (!m || !m[3]) continue;
    const lineText = sanitizeSegmentText(m[3]);
    if (!lineText) continue;
    const start = Number(m[1]) || 0;
    const end = m[2] ? Number(m[2]) : start + 5;
    segs.push({ start: Math.round(start * 1000), end: Math.round(Math.max(start + 0.5, end) * 1000), text: lineText });
  }
  for (const o of segs) { o.start_ms = o.start; o.end_ms = o.end; }
  return segs;
}
