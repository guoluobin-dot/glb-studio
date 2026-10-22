/**
 * ASR Helper —— 双通道自动兜底
 * Sources (in priority order):
 *   1. GLB 输出 transcript JSON（视频已在 GLB 里处理过，最准零成本）
 *   2. Hermes temp 缓存（上次转写结果）
 *   3. 【新增】Sherpa 本地 ASR（复用 GLB 自带 sherpa-onnx + sense-voice/paraformer 模型，离线免费）
 *   4. 外部 whisper（如已安装）
 *   5. unavailable（提示先走 GLB 转写）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
// 2026-09-27：唱歌领域术语纠错（混声/声带/关闭唱法…的 ASR 同音字错）
import { correctTranscript } from './term-corrector.js';
import { CloudASR } from './cloud-asr.js';
import { countWords } from '../utils/count-words.js';

const HERMES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ASRHelper {
  /** 在跑的外部进程：cmd -> Set<ChildProcess>。用于取消时杀掉它们 */
  static _running = new Map();
  /**
   * ASR 缓存/中间产物的文件键。
   *
   * 2026-10-12 修：原来只用 basename（`${name}_asr.json`），
   * 而 hits 与 live 两条链路**共用同一个 tempDir**。于是：
   *   - `upload/hits/A.mp4` 和 `upload/live/A.mp4` 共用同一份 A_asr.json
   *     → 后分析的直接复用前一条的稿（hit-analyzer 还会把这个错路径写进 asr_path）
   *   - 同名视频重新上传/内容替换，缓存永不失效（没有 mtime/大小比对），
   *     scanAndAnalyze 只看 analysis_status，于是分析用旧稿
   *   - 并发时两条链路还会互相覆写同一个 wav（whisper 完成后还原地覆写 json）
   *
   * 改成"目录名 + 文件名"的哈希，既避免撞车又保持文件名可读，
   * 同时保留老的纯名字文件：先查新键，找不到再回落到旧键
   * （否则升级后所有已缓存的转写都要重跑一遍）。
   */
  _cacheKey(videoPath) {
    const abs = String(videoPath || '').replace(/\\/g, '/');
    const dir = basename(dirname(abs));
    const name = basename(abs).replace(/\.[^.]+$/, '');
    const h = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8);
    return `${dir}__${name}_${h}`;
  }

  /** 缓存文件路径（新键优先，回落旧键） */
  _cachePaths(videoPath) {
    const name = basename(videoPath, '.mp4').replace(/\.(mov|mkv|webm|flv|avi)$/i, '');
    return {
      current: join(this.tempDir, `${this._cacheKey(videoPath)}_asr.json`),
      legacy: join(this.tempDir, `${name}_asr.json`),
    };
  }

  /**
   * 内容指纹（2026-10-21）：让"同名重传/内容替换"的缓存失效。
   *
   * 缓存键本身只含目录名+文件名+路径哈希 —— 元数据撞车依旧可能（之前的
   * 注释里就留着"同名视频重新上传缓存永不失效"这一条尾巴）。只存 size
   * 不算内容哈希：几 GB 视频全量读一遍付不起 IO；字节大小几乎只有在
   * 换了内容时才会巧合相等，mtime 反而复制/搬盘就变，不能当失效依据。
   */
  _fingerprint(videoPath) {
    try {
      const s = statSync(videoPath);
      return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    } catch { return null; }
  }

  /**
   * 缓存条目是否过期：带指纹且 size 与当前文件不符 → 过期。
   *
   * **老缓存（没有 _fp 字段）一律放行** —— 里面躺着 226 分钟量级的
   * 云端转写结果，那是真金白银买的；宁可保留"老名字旧内容继续沿用"
   * 的旧行为，也不做一次性清库升级。
   */
  _fpStale(cached, videoPath) {
    const fp = cached?._fp;
    if (!fp) return false;
    const cur = this._fingerprint(videoPath);
    if (!cur) return false; // 视频读不到就不乱判，保持旧行为
    return fp.size !== cur.size;
  }
  constructor(config) {
    this.config = config;
    // tempDir 必须是绝对路径：以前用 dirname(config.memory.dbPath) 拼相对路径，
    // 一旦启动 cwd 不是 Hermes 目录就会写到别处去。
    this.tempDir = config.upload?.tempDir || join(HERMES_ROOT, 'upload', 'temp');
    this.glbOutputDir = config.glb?.transcriptDir;
    this.ffmpegPath = null;
    // 术语纠错总开关：config/analyzer.termCorrect 或环境变量，默认开启
    this.termCorrect = config?.analyzer?.termCorrect !== false && process.env.HERMES_NO_TERM_CORRECT !== '1';
    // 云端识别客户端，懒构造（见 _cloud）
    this._cloudAsrClient = undefined;
  }

  /**
   * ASR 出口统一做一遍术语纠错。
   *
   * 2026-09-27 移到这里是有原因的：以前纠错过 generator 出字幕前的最后一步
   * （src/generator/index.js 的 _correctSubtitleText），也就是说分段、主题匹配、
   * 粗剪选段全程都跑在"混生/生带/同友们"这种带错字的文本上——理解从源头就歪了，
   * 表现为"筛不出爆款感、教学段认不出来"。错字必须先在这里清干净。
   *
   * 幂等：正确词不在错字表 key 里，重复调用不会出问题（缓存复读场景必需）。
   */
  /**
   * 云端识别客户端（懒构造）。
   *
   * 懒构造的原因：CloudASR 构造函数里会 new FFmpegHelper（走 _findBinaries），
   * 而 ASRHelper 在不少不转写的场景下也会被创建（预设/只读元信息）。
   * 让那部分场景不必付这次探测成本。
   * 静态 import 已经足够 —— cloud-asr 只依赖 ffmpeg-helper 与 proxy，
   * 不像 sherpa-asr 那样要加载 native 模块。
   */
  _cloud() {
    if (this._cloudAsrClient !== undefined) return this._cloudAsrClient;
    try {
      this._cloudAsrClient = new CloudASR(this.config);
    } catch (err) {
      console.warn(`[ASR] 云端识别客户端构造失败（跳过云端转写）：${err.message}`);
      this._cloudAsrClient = null;
    }
    return this._cloudAsrClient;
  }

  /**
   * 跑一次云端识别，成功就写进本地缓存并返回（失败则返回 null 让调用方回退）。
   *
   * 为什么要写缓存：云端识别按分钟计费，同一素材重分析/重进调度
   * 不该再付一次钱；而且写进标准 _cacheKey 之后，第 2 步的缓存命中
   * 就直接返回，连"该不该调云端"这个判断都省了。
   *
   * @param {string} videoPath
   * @param {object} opts getTranscript 的 opts（signal / onProgress…）
   * @param {{current:string, legacy:string}} cachePaths
   * @returns {Promise<null|{source:string, transcript:Array, rawPath:string, fromCloud:boolean}>}
   */
  async _cloudAsr(videoPath, opts, cachePaths) {
    const cloud = this._cloud();
    if (!cloud || !cloud.available) {
      // 没启用/没配 key 时静默 —— 本地链路本来就在跑，不该为它刷日志
      return null;
    }

    const t0 = Date.now();
    const durationMin = Math.round((opts.durationSec || 0) / 60);
    console.log(
      `[ASR] 用云端识别：${basename(videoPath)}`
      + `${durationMin ? `（约 ${durationMin} 分钟）` : ''}`
      + `模型=${cloud.model} 片长=${cloud.chunkSeconds}s 并发=${cloud.concurrency}`
    );

    const r = await cloud.transcribe(videoPath, {
      signal: opts.signal ?? null,
      onProgress: (p) => {
        if (p.phase === 'cloud' && p.total) {
          opts.onProgress?.({
            phase: 'asr-cloud',
            done: p.done,
            total: p.total,
            chars: p.chars,
          });
        }
      },
    });

    if (!r.ok) {
      /*
       * 这里的日志要能一眼看出"该改哪"。
       * 缺配置 → 配一下就通；key 无效 → 换 key；片太大 → 调片长。
       * 都写成同一句"云端识别失败"等于没写。
       */
      console.warn(`[ASR] 云端识别失败（${((Date.now() - t0) / 1000).toFixed(1)}s）：${r.reason}`);
      if (r.partial) {
        console.warn(`[ASR]   进度 ${r.done}/${r.total} 片已完成，已落缓存 —— 修好后重跑只会补剩下的，不会重新计费`);
      }
      return null; // 回退本地
    }

    // 落标准缓存，之后直接从第 2 步命中。
    // 2026-10-21：纠错前置到写缓存之前，缓存里的稿直接是"发布级"文本；
    // 读缓存时 _withTermCorrection 第二遍跑出来是 no-op（纠错幂等）。
    // 同时带上内容指纹 _fp：同名重传/内容替换能让整稿缓存失效。
    const corrected = this._withTermCorrection({
      source: 'cloud-asr',
      transcript: r.transcript,
      rawPath: cachePaths.current,
      fromCloud: true,
    });
    try {
      if (!existsSync(this.tempDir)) mkdirSync(this.tempDir, { recursive: true });
      writeFileSync(
        cachePaths.current,
        JSON.stringify({ segments: corrected.transcript, _fp: this._fingerprint(videoPath), source: 'cloud-asr', videoPath }, null, 2),
        'utf-8'
      );
    } catch (err) {
      // 缓存写不进也照常用这次结果，只是下次要重付一次钱
      console.warn(`[ASR] 云端结果写缓存失败（${err.message}），本次继续使用`);
    }

    console.log(
      `[ASR] 云端识别完成：${r.chunkCount} 片 / ${r.chars} 字 / ${((r.elapsedMs || 0) / 1000).toFixed(1)}s`
    );
    return corrected;
  }

  /** 云端识别是否可用（诊断/面板显示） */
  cloudAsrStatus() {
    const c = this._cloud();
    if (!c) return { available: false, reason: '客户端构造失败' };
    if (!c.available) return { available: false, reason: c.configError, enabled: c.enabled };
    return {
      available: true,
      enabled: c.enabled,
      provider: c._useGemini() ? 'gemini' : 'openai-compatible',
      baseUrl: c.baseUrl,
      model: c.model,
      chunkSeconds: c.chunkSeconds,
      concurrency: c.concurrency,
      maxMinutesPerRun: c.maxMinutesPerRun,
      ...c.cachedCount ? {} : {},
    };
  }

  _withTermCorrection(result) {
    if (!this.termCorrect) return result;
    try {
      if (!Array.isArray(result?.transcript) || result.transcript.length === 0) return result;
      const { transcript, stats } = correctTranscript(result.transcript);
      if (stats.corrected > 0) {
        console.log(`[ASR] 术语纠错(${result.source})：修正 ${stats.corrected} 处 → ${stats.details
          .slice(0, 3)
          .map((d) => d.fixes.map((f) => `${f.from}→${f.to}`).join('、'))
          .join('；')}${stats.details.length > 3 ? ' 等' : ''}`);
        result.transcript = transcript;
        result.termCorrections = stats.corrected;
      }
    } catch (err) {
      console.warn(`[ASR] 术语纠错失败（用原文继续）：${err.message}`);
    }
    return result;
  }

  /**
   * Try to find transcript for a video from multiple sources.
   *
   * 2026-10-12：在 GLB 稿和本地缓存之后、Sherpa 之前插入**云端识别**一档
   * （可通过 analyzer.cloudAsr.priority 调成 after-local）。
   *
   * 为什么插这个位置：本地 sherpa 对一场 3-4 小时直播要跑 180~240 片、
   * 每片同步 decode 卡主线程十几秒，整场几小时起步，且 int8 模型在连麦、
   * 口音、专业术语上准确率有限 —— 这正是用户"本地根本不够"的场景。
   * 而 GIF 稿和本地缓存是**已经花过钱的现成结果**，优先级永远最高。
   *
   * 云端失败默认回退本地（fallbackToLocal）：宁可慢一场，也不要让分析断掉。
   *
   * @param {string} videoPath
   * @returns {Promise<{source: string, transcript: Array<{start: number, end: number, text: string}>, rawPath: string|null}>}
   */
  async getTranscript(videoPath, opts = {}) {
    const videoName = basename(videoPath, '.mp4').replace(/\.(mov|mkv|webm|flv|avi)$/i, '');

    // 1. Check if GLB already processed this video
    if (this.glbOutputDir) {
      const glbTranscript = this._findGLBTranscript(videoName);
      if (glbTranscript) {
        return this._withTermCorrection({ source: 'glb', transcript: glbTranscript.segments, rawPath: glbTranscript.path });
      }
    }

    // 2. Check if we already have an ASR result in temp dir
    //    新键（含目录名+哈希，避免 hits/live 同名撞车）优先，
    //    找不到再回落老的纯文件名键 —— 升级后不必重跑全部已缓存的转写。
    const cachePaths = this._cachePaths(videoPath);
    let cachedPath = cachePaths.current;
    for (const p of [cachePaths.current, cachePaths.legacy]) {
      if (!existsSync(p)) continue;
      try {
        const cached = JSON.parse(readFileSync(p, 'utf-8'));
        if (cached.segments?.length) {
          // 同名文件被换成新内容 → 旧稿不能再用（2026-10-21，见 _fingerprint）
          if (this._fpStale(cached, videoPath)) {
            console.log(`[ASR] 缓存指纹不符（字节 ${cached._fp.size} ≠ 当前 ${this._fingerprint(videoPath)?.size}），旧稿作废重新转写：${basename(videoPath)}`);
            continue;
          }
          cachedPath = p;
          return this._withTermCorrection({ source: 'cached', transcript: cached.segments || [], rawPath: cachedPath });
        }
      } catch { /* corrupt cache -> re-transcribe */ }
    }

    /*
     * 2.5 云端识别（长直播主力）。
     *
     * 放在缓存之后、本地之前：已花过钱的现成结果优先；
     * 而本地 sherpa 一场几小时，能不跑就不跑。
     * 优先级和是否回退都由配置决定（默认 before-local + 回退本地）。
     */
    const cloudFirst = (this.config?.analyzer?.cloudAsr?.priority || 'before-local') === 'before-local';
    const cloud = this._cloud();
    if (cloudFirst && cloud?.available) {
      const cr = await this._cloudAsr(videoPath, opts, cachePaths);
      if (cr) return cr;
    }

    // 3. 【新增】Sherpa 本地 ASR（复用 GLB 模型，离线免费）
    let sherpaHeardNothing = false;
    try {
      const { SherpaASR } = await import('./sherpa-asr.js');
      const { FFmpegHelper } = await import('./ffmpeg-helper.js').catch(() => ({ FFmpegHelper: null }));
      const ff = FFmpegHelper ? new FFmpegHelper() : null;
      const sherpa = new SherpaASR(ff);
      if (sherpa.available) {
        console.log(`[ASR] GLB 转写缺失，用 Sherpa 本地转写: ${basename(videoPath)}`);
        const segments = await sherpa.transcribe(videoPath, null, opts.signal ?? null);
        if (segments.length === 0) sherpaHeardNothing = true;
        if (segments.length > 0) {
          // 写入新键：原来写的是纯文件名的 cachedPath，
          // hits 与 live 两条链路会互相覆盖同一份稿（见 _cacheKey 的注释）
          cachedPath = cachePaths.current;
          // 2026-10-21：纠错前置 + 带内容指纹（见 _fingerprint）
          const corrected = this._withTermCorrection({ source: 'sherpa-local', transcript: segments, rawPath: cachedPath });
          try {
            if (!existsSync(this.tempDir)) (await import('fs')).mkdirSync(this.tempDir, { recursive: true });
            writeFileSync(cachedPath, JSON.stringify({ segments: corrected.transcript, _fp: this._fingerprint(videoPath), source: 'sherpa', videoPath }, null, 2), 'utf-8');
          } catch { /* cache 写失败不影响 */ }
          return corrected;
        }
        console.warn('[ASR] Sherpa 转写为空（可能是纯音乐/静音），继续尝试 whisper');
      } else {
        console.log('[ASR] Sherpa 不可用（缺 ffmpeg 或模型），尝试 whisper');
      }
    } catch (err) {
      // 2026-09-30 补日志:以前这里只 console.warn 错误消息就继续往下走,
      // 失败会一路静默到"字幕没生成",用户完全看不出是转写环节坏了。
      console.warn(`[ASR] Sherpa 本地转写失败: ${err.message}`);
      console.warn(`[ASR] 堆栈: ${(err.stack || '').split('\n').slice(0, 4).join(' | ')}`);
    }

    // 3.5 云端识别排在本地之后（priority=after-local 时才走到这里）
    if (!cloudFirst) {
      const cr = await this._cloudAsr(videoPath, opts, cachePaths);
      if (cr) return cr;
    }

    // 4. Try external ASR (whisper, etc.)
    const externalResult = await this._tryExternalASR(videoPath, videoName, opts.signal ?? null);
    if (externalResult) {
      return this._withTermCorrection(externalResult);
    }

    // 5. Fallback: return empty transcript with metadata
    //    把"试过哪几条路都失败了"一并带出去,便于直接判断该修模型还是该改路径。
    const reason = sherpaHeardNothing
      ? '本地 ASR 识别到整段无人声(纯音乐/静音),无法生成字幕。'
      : `本地 ASR 与外部 ASR 都未产出文本(视频:${basename(videoPath)})。请检查语音模型是否就绪,或先在 GLB 里对这条素材跑一次转写。`;
    console.warn(`[ASR] 转写不可用: ${reason}`);
    return {
      source: 'unavailable',
      transcript: [],
      rawPath: null,
      silent: sherpaHeardNothing,
      reason
    };
  }

  _findGLBTranscript(videoName) {
    if (!this.glbOutputDir) return null;
    // GLB typically names transcripts like: {videoName}_transcript.json or transcript_{videoName}.json
    const patterns = [
      join(this.glbOutputDir, `${videoName}_transcript.json`),
      join(this.glbOutputDir, `transcript_${videoName}.json`),
      join(this.glbOutputDir, `${videoName}.json`),
    ];
    for (const p of patterns) {
      if (existsSync(p)) {
        try {
          const data = JSON.parse(readFileSync(p, 'utf-8'));
          const segments = this._normalizeTranscript(data);
          return { path: p, segments };
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  _normalizeTranscript(data) {
    // 统一输出 {start, end, start_ms, end_ms, text}，时间全部为毫秒。
    // 调用方（learner / copywriting / generator）混用了 start_ms 和 start 两种写法，
    // 这里两种键都给，避免下游读到 undefined 变成 NaN 或空上下文。
    //
    // 单位判定注意：裸 {start,end} 可能是秒也可能是毫秒（不同 ASR 来源），
    // 不能只用“最大值<100000 就 x1000”——90 秒短视频的毫秒值(0~90000)也会中招，
    // 被放大成 90000000（25 小时）。改用：小数痕迹 + 平均段长双重判定。
    const toMs = (s) => {
      if (s.start_ms != null || s.end_ms != null || s.startSec != null || s.endSec != null) {
        const st = s.start_ms ?? (s.startSec != null ? s.startSec * 1000 : 0);
        const en = s.end_ms ?? (s.endSec != null ? s.endSec * 1000 : st);
        return { start: st, end: en, text: s.text || s.word || '' };
      }
      // 裸 start/end：先标记，unifyUnit 再判定单位
      return { _sec: true, start: s.start ?? 0, end: s.end ?? s.start ?? 0, text: s.text || s.word || '' };
    };
    const unifyUnit = (segs) => {
      let looksLikeSeconds = false;
      if (segs.length > 0) {
        const hasFraction = segs.some(s => s._sec && (!Number.isInteger(s.start) || !Number.isInteger(s.end)));
        const maxEnd = segs.reduce((m, s) => Math.max(m, s.end || 0), 0);
        const avgDur = segs.reduce((a, s) => a + ((s.end || 0) - (s.start || 0)), 0) / segs.length;
        // 秒级数据：常带小数；或总量不大且平均段长很小（句子级段落秒均<500，毫秒均数千）
        looksLikeSeconds = hasFraction || (maxEnd <= 20000 && avgDur < 500);
      }
      return segs
        .filter(s => s.text)
        .map(s => {
          const st = (looksLikeSeconds && s._sec) ? Math.round(s.start * 1000) : Math.round(s.start);
          const en = (looksLikeSeconds && s._sec) ? Math.round(s.end * 1000) : Math.round(s.end);
          return { start: st, end: en, start_ms: st, end_ms: en, text: s.text };
        });
    };
    if (Array.isArray(data)) return unifyUnit(data.map(toMs));
    if (data.segments) return unifyUnit(data.segments.map(toMs));
    if (data.transcript?.segments) return unifyUnit(data.transcript.segments.map(toMs));
    if (data.words) {
      // Group words into sentence-level segments
      return unifyUnit(this._wordsToSegments(data.words));
    }
    return [];
  }

  _wordsToSegments(words) {
    const segments = [];
    let current = { start: words[0]?.start || 0, end: 0, text: '' };
    /*
     * 2026-10-21 修：以前按下一个词的 start 用 words.indexOf(w) 回查 —— O(n²)。
     * 3 小时直播 whisper 词级输出几上万词，一次全量回查要盯住"整段卡死"的嫌疑
     * （实测一次 40k 词进来 CPU 独占几十秒）。现在顺序迭代按 i+1 取下词，
     * O(n) 一遍过，语义不变。
     */
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      current.text += (current.text ? ' ' : '') + (w.word || w.text || '');
      current.end = w.end || w.start || current.end;
      if (w.word?.match(/[.!?。！？]$/)) {
        segments.push({ ...current });
        const next = words[i + 1];
        current = { start: next?.start || current.end, end: 0, text: '' };
      }
    }
    if (current.text) segments.push(current);
    return segments;
  }

  async _tryExternalASR(videoPath, videoName, signal = null) {
    // Check if whisper.cpp or faster-whisper is available
    const whisperPaths = [
      'whisper',
      'whisper-cli',
      'faster-whisper',
      'C:/Program Files/whisper/whisper.exe',
    ];

    // 进程内只检测一次：以前每次转写 miss 都 spawn 4 个进程试 --help
    if (ASRHelper._whisperChecked === undefined) {
      ASRHelper._whisperChecked = null;
      for (const cmd of whisperPaths) {
        try {
          const result = await this._exec(cmd, ['--help'], 15000);
          if (result.includes('usage') || result.includes('Usage')) {
            ASRHelper._whisperChecked = cmd;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    const whisperCmd = ASRHelper._whisperChecked;
    if (!whisperCmd) return null;

    // Extract audio and run whisper
    // 同样改用 _cachePaths：hits 与 live 两条链路共用 tempDir，
    // 原来 `${videoName}.wav` / `${videoName}_asr.json` 会互相覆写，
    // 并发时还可能读到对方只写了一半的 json（下次就整条重转写）。
    const paths = this._cachePaths(videoPath);
    const audioPath = join(this.tempDir, `${paths.legacy.replace(/\.json$/, '')}.wav`);
    const outputJson = paths.current;

    try {
      // tempDir 可能还没建（首次启动/被手工清空）：不建的话 ffmpeg 直接 ENOENT，
      // 而外层 catch 只 console.warn 一行，表现为"外部 whisper 通道永远静默失败"。
      mkdirSync(this.tempDir, { recursive: true });
      // Extract audio using ffmpeg (if available)
      await this._extractAudio(videoPath, audioPath, signal);

      // Run whisper
      await this._exec(whisperCmd, [
        audioPath,
        '--model', 'base',
        '--output_json', 'true',
        '--output_file', outputJson
      ], 120000, signal);

      if (existsSync(outputJson)) {
        const data = JSON.parse(readFileSync(outputJson, 'utf-8'));
        const segments = this._normalizeTranscript(data);
        // 2026-10-21：纠错前置 + 带内容指纹（见 _fingerprint）
        const corrected = this._withTermCorrection({ source: 'whisper', transcript: segments, rawPath: outputJson });
        writeFileSync(outputJson, JSON.stringify({ segments: corrected.transcript, _fp: this._fingerprint(videoPath), source: 'whisper', videoPath }, null, 2), 'utf-8');
        return corrected;
      }
    } catch (err) {
      console.warn(`[ASR] External ASR failed: ${err.message}`);
    } finally {
      /*
       * 2026-09-24 加的清理，2026-10-12 才发现它一直是**死代码**：
       * unlinkSync 从没被 import（整个文件只在这一行用到它），
       * 于是这里抛 ReferenceError，被紧接着的空 catch 吞掉，一行日志都没有。
       * 后果：抽出来的 wav（16kHz 单声道 ≈ 32KB/s，一条 3 小时直播 ≈ 340MB）
       * 每跑一次 whisper 兜底就永久留在 upload/temp，无上限堆积直到磁盘写满 ——
       * 而磁盘满会连带让 ffmpeg/sherpa 写不出临时文件，转写随之全空。
       *
       * 所以这里不能只靠 import 修：清理失败必须能看见，否则下次再少个 import
       * 又是同样的静默泄漏。删不掉就打一行 warn。
       */
      try {
        if (existsSync(audioPath)) unlinkSync(audioPath);
      } catch (err) {
        console.warn(`[ASR] 清理临时 wav 失败（${audioPath}）: ${err.message}`);
      }
    }

    return null;
  }

  async _extractAudio(videoPath, audioPath, signal = null) {
    // Use FFmpegHelper if available, otherwise try system ffmpeg
    const { FFmpegHelper } = await import('./ffmpeg-helper.js').catch(() => ({ FFmpegHelper: null }));
    if (FFmpegHelper) {
      const ff = new FFmpegHelper();
      if (ff.isAvailable) {
        return ff.extractAudio(videoPath, audioPath, signal);
      }
    }
    // Fallback: try spawning ffmpeg directly
    return this._exec('ffmpeg', [
      '-i', videoPath,
      '-vn', '-acodec', 'pcm_s16le',
      '-ar', '16000', '-ac', '1',
      audioPath
    ]);
  }

  /**
 * 跑一个外部命令。
 *
 * 关键：要能被别人杀掉。
 *
 * 真实问题：以前这里 spawn 之后没有任何中断通道，于是「取消分析」只是让
 * Hermes 自己抛了个错，ffmpeg/sherpa 子进程照样跑到底 —— 占着 CPU、文件句柄、
 * sherpa 的模型显存。用户点完取消立刻重跑，就会撞上"上一次还没真正结束"：
 * 实测第二次请求直接超时（HeadersTimeout），而界面上已经显示"已取消"。
 *
 * 所以把当前子进程登记到静态表里，取消时按进程树杀掉。
 */
  _exec(cmd, args, timeoutMs = 120000, signal = null) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        /*
         * windowsHide 必须有（同 ffmpeg-helper.run 的注释）：
         * ffmpeg / sherpa-asr 都是控制台程序，不设就每调用一次弹一个黑框。
         * 批量上传素材时每条都要转写，于是弹个没完、还抢最上层焦点。
         */
        child = spawn(cmd, args, { shell: false, windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      // 登记：按 cmd 分组，一个 cmd 可能被并发调用多次
      ASRHelper._running.set(cmd, (ASRHelper._running.get(cmd) || new Set()).add(child));
      // 命令行指纹：killForFile 按视频名定向杀时要看它（2026-10-21）
      child._argsStr = [cmd, args].flat().filter(Boolean).join(' ');
      const forget = () => {
        const set = ASRHelper._running.get(cmd);
        if (!set) return;
        set.delete(child);
        if (!set.size) ASRHelper._running.delete(cmd);
      };

      const killIt = () => {
        try {
          // 杀整个进程组：ffmpeg 会再拉子进程，只杀父进程会留下孤儿继续吃 CPU
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      };

      let stdout = '';
      let stderr = '';
      // 以前无超时：whisper/ffmpeg 挂起时整个调度 tick 永不返回。默认 120s 掐掉
      const timer = setTimeout(() => {
        killIt();
        forget();
        reject(new Error(`${cmd} timeout ${timeoutMs}ms`));
      }, timeoutMs);

      // 用户取消：立刻杀掉子进程并以 AbortError 结束
      const onAbort = () => {
        clearTimeout(timer);
        killIt();
        forget();
        const err = new Error(`${cmd} 已取消`);
        err.name = 'AbortError';
        err.userCancelled = true;
        reject(err);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timer);
        forget();
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      // 关键：命令不存在时会触发 error 事件，必须捕获，否则整个 Hermes 进程崩溃
      child.on('error', (err) => { cleanup(); reject(err); });
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', code => {
        cleanup();
        if (code !== 0) reject(new Error(`${cmd} error ${code}: ${stderr}`));
        else resolve(stdout);
      });
    });
  }

  /**
   * 杀掉所有在跑的外部命令。
   *
   * 取消分析时调用。不杀的话，子进程会一直跑到结束 ——
   * 用户看到"已取消"，实际 CPU 还在满载、下一次重跑被拖住。
   */
  static killAll() {
    let n = 0;
    for (const [, set] of ASRHelper._running) {
      for (const child of set) {
        n++;
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      }
    }
    if (n) console.log(`[ASR] 已终止 ${n} 个外部进程`);
    return n;
  }

  /**
   * 只杀属于某一条视频的在跑进程（2026-10-21）。
   *
   * 以前「取消一条视频」走的是 killAll —— 会把调度器此刻正在转写的
   * **其他素材**的切片/whisper 进程一起杀掉，别人的任务凭空失败。
   * 现在按命令行里的视频文件名/stem 定向匹配（_exec 登记 _argsStr）。
   */
  static killForFile(pathOrName) {
    const norm = String(pathOrName || '').toLowerCase().replace(/\\/g, '/');
    if (!norm) return 0;
    const base = norm.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '');
    let n = 0;
    for (const [, set] of ASRHelper._running) {
      for (const child of set) {
        try {
          const cmdline = String(child._argsStr || '').toLowerCase().replace(/\\/g, '/');
          if (!cmdline || (!cmdline.includes(base) && (stem.length < 3 || !cmdline.includes(stem)))) continue;
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
          n++;
        } catch { /* ignore */ }
      }
    }
    if (n) console.log(`[ASR] 已按文件定向终止 ${n} 个外部进程（${base}）`);
    return n;
  }

  /**
   * Get a plain text summary of transcript for LLM analysis.
   */
  static transcriptToText(transcript) {
    if (!Array.isArray(transcript)) return '';
    return transcript.map(s => s.text || s.word || '').join(' ').trim();
  }

  /**
   * 带时间戳的转写文本（供主题分段/结构拆解用）。
   * 以前分段提示词只给纯文本却让 LLM 报 start_seconds，时间全靠幻觉；
   * 现在每行带 [秒数]，LLM 有依据可查。
   */
  static transcriptToTimestampedText(transcript) {
    if (!Array.isArray(transcript)) return '';
    return transcript
      .map(s => {
        const ms = s.start_ms ?? s.start ?? 0;
        return `[${(ms / 1000).toFixed(1)}s] ${s.text || s.word || ''}`;
      })
      .join('\n');
  }

  /**
   * Get transcript chunks suitable for LLM context windows.
   * 按“词数或字符数”双预算切分：中文无空格，一段即一“词”，纯词数切分会把几万字塞进一个 chunk 撑爆上下文。
   * 默认每 chunk 最多 800 词或 3000 字符（约 2~3K tokens，留足系统提示词+输出空间）。
   */
  static chunkTranscript(transcript, maxWords = 800, maxChars = 3000) {
    if (!Array.isArray(transcript)) return [];
    const chunks = [];
    let current = [];
    let wordCount = 0;
    let charCount = 0;
    for (const seg of transcript) {
      const text = seg.text || '';
      const words = countWords(text) || 1;
      if ((wordCount + words > maxWords || charCount + text.length > maxChars) && current.length > 0) {
        chunks.push(current);
        current = [seg];
        wordCount = words;
        charCount = text.length;
      } else {
        current.push(seg);
        wordCount += words;
        charCount += text.length;
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }
}

export default ASRHelper;
