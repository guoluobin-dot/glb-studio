/**
 * ASR Helper —— 双通道自动兜底
 * Sources (in priority order):
 *   1. GLB 输出 transcript JSON（视频已在 GLB 里处理过，最准零成本）
 *   2. Hermes temp 缓存（上次转写结果）
 *   3. 【新增】Sherpa 本地 ASR（复用 GLB 自带 sherpa-onnx + sense-voice/paraformer 模型，离线免费）
 *   4. 外部 whisper（如已安装）
 *   5. unavailable（提示先走 GLB 转写）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
// 2026-09-27：唱歌领域术语纠错（混声/声带/关闭唱法…的 ASR 同音字错）
import { correctTranscript } from './term-corrector.js';

const HERMES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ASRHelper {
  /** 在跑的外部进程：cmd -> Set<ChildProcess>。用于取消时杀掉它们 */
  static _running = new Map();
  constructor(config) {
    this.config = config;
    // tempDir 必须是绝对路径：以前用 dirname(config.memory.dbPath) 拼相对路径，
    // 一旦启动 cwd 不是 Hermes 目录就会写到别处去。
    this.tempDir = config.upload?.tempDir || join(HERMES_ROOT, 'upload', 'temp');
    this.glbOutputDir = config.glb?.transcriptDir;
    this.ffmpegPath = null;
    // 术语纠错总开关：config/analyzer.termCorrect 或环境变量，默认开启
    this.termCorrect = config?.analyzer?.termCorrect !== false && process.env.HERMES_NO_TERM_CORRECT !== '1';
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
    const cachedPath = join(this.tempDir, `${videoName}_asr.json`);
    if (existsSync(cachedPath)) {
      try {
        const cached = JSON.parse(readFileSync(cachedPath, 'utf-8'));
        if (cached.segments?.length) {
          return this._withTermCorrection({ source: 'cached', transcript: cached.segments || [], rawPath: cachedPath });
        }
      } catch { /* corrupt cache -> re-transcribe */ }
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
          try {
            if (!existsSync(this.tempDir)) (await import('fs')).mkdirSync(this.tempDir, { recursive: true });
            writeFileSync(cachedPath, JSON.stringify({ segments, source: 'sherpa', videoPath }, null, 2), 'utf-8');
          } catch { /* cache 写失败不影响 */ }
          return this._withTermCorrection({ source: 'sherpa-local', transcript: segments, rawPath: cachedPath });
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
    for (const w of words) {
      current.text += (current.text ? ' ' : '') + (w.word || w.text || '');
      current.end = w.end || w.start || current.end;
      if (w.word?.match(/[.!?。！？]$/)) {
        segments.push({ ...current });
        current = { start: (words[words.indexOf(w) + 1]?.start) || current.end, end: 0, text: '' };
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
    const audioPath = join(this.tempDir, `${videoName}.wav`);
    const outputJson = join(this.tempDir, `${videoName}_asr.json`);

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
        writeFileSync(outputJson, JSON.stringify({ segments, source: 'whisper', videoPath }, null, 2), 'utf-8');
        return { source: 'whisper', transcript: segments, rawPath: outputJson };
      }
    } catch (err) {
      console.warn(`[ASR] External ASR failed: ${err.message}`);
    } finally {
      // 2026-09-24：抽出来的 wav 从不清理，长跑会把 upload/temp 堆满。json 是返回值要留，
      // 但 wav 纯属中间产物（几百 MB/条）。
      try { if (existsSync(audioPath)) unlinkSync(audioPath); } catch { /* 删不掉不影响结果 */ }
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
      const words = text.split(/\s+/).filter(Boolean).length || 1;
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
