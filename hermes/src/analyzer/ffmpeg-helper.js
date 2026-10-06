/**
 * FFmpeg Helper
 * Locates and wraps ffmpeg/ffprobe for video analysis.
 * Searches multiple known locations; falls back gracefully if not found.
 */
import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// drawtext/subtitles 滤镜转义：':' ''' '[' ']' ';' ',' '\\' '%' 换行都会破坏滤镜语法，
// 未转义的 LLM/用户文本可导致 ffmpeg 报错或读取意外文件。统一先转义再拼接。
export function escapeDrawtext(text) {
  return String(text ?? '')
    .slice(0, 200)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

export function escapeSubtitlesPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/[\r\n\x00]/g, '')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
}

/**
 * drawtext 的 fontfile= 专用转义。
 * 不能直接复用 escapeSubtitlesPath：它会把 ':' 转成 '\:'，而 fontfile 的值是单引号包裹的
 * 字面量段，ffmpeg 在里面只认 \\ 和 \' 两个转义 —— "C:/Windows/Fonts/msyh.ttc" 会被写成
 * "C\:/Windows/Fonts/msyh.ttc"，字体打不开，封面和成片合成直接失败（而且会连试 3 个编码器
 * 各等满超时才回退，一次失败要 30 分钟）。
 */
export function escapeFilterPath(p) {
  return String(p || '')
    .replace(/\\/g, '/') // 反斜杠统一成正斜杠，顺带省掉转义
    .replace(/[\r\n\x00]/g, '')
    .replace(/'/g, "\\'");
}

/**
 * 全局进程登记表：所有 FFmpegHelper 实例 spawn 出去的 ffmpeg/ffprobe 都记在这里。
 * 以前 Hermes 崩溃退出（uncaughtException → process.exit(1)）时没人管这些子进程，
 * 它们变成孤儿继续跑，吃满 CPU 和文件句柄，得去任务管理器手动杀。
 * 退出前调一次 killAllFfmpeg() 收干净。
 */
const ACTIVE_CHILDREN = new Set();

/**
 * 杀掉所有在跑的 ffmpeg/ffprobe。
 *
 * 两个用途：
 *  - 进程退出前收干净（孤儿进程会吃满 CPU 和文件句柄）
 *  - 用户取消分析时立即停掉（以前取消只让 Hermes 抛错，ffmpeg 照跑到底，
 *    用户点完取消立刻重跑就被拖住 —— 实测第二次请求直接 HeadersTimeout）
 *
 * Windows 上必须按进程树杀：ffmpeg 会再拉子进程，只杀父进程会留下孤儿。
 */
export function killAllFfmpeg() {
  let n = 0;
  for (const child of ACTIVE_CHILDREN) {
    try {
      if (child.killed || child.exitCode !== null) continue;
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
      n++;
    } catch { /* 已退出 */ }
  }
  ACTIVE_CHILDREN.clear();
  return n;
}

function sanitizeColor(c, fallback) {
  const s = String(c || fallback || 'white').trim().slice(0, 32);
  if (/^#[0-9a-fA-F]{6}(@0\.[0-9]+)?$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s)) return s;
  return fallback;
}

export class FFmpegHelper {
  constructor() {
    this.ffmpegPath = null;
    this.ffprobePath = null;
    this._findBinaries();
  }

  _findBinaries() {
    const candidates = [
      // 相对路径优先：全家桶挪盘/改名也能用；绝对 D:/ 仅做兼容兜底
      join(__dirname, '..', '..', '..', 'GLB', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
      // Hermes own bin dir
      join(__dirname, '..', '..', 'bin', 'ffmpeg.exe'),
      // Common install locations
      'C:/ffmpeg/bin/ffmpeg.exe',
      'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
      'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
      '<GLB_ROOT>/GLB/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe',
    ];

    const ffprobeCandidates = [
      join(__dirname, '..', '..', '..', 'GLB', 'resources', 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
      join(__dirname, '..', '..', 'bin', 'ffprobe.exe'),
      'C:/ffmpeg/bin/ffprobe.exe',
      'C:/Program Files/ffmpeg/bin/ffprobe.exe',
      'C:/ProgramData/chocolatey/bin/ffprobe.exe',
      '<GLB_ROOT>/GLB/resources/app.asar.unpacked/node_modules/@ffprobe-installer/win32-x64/ffprobe.exe',
    ];

    for (const p of candidates) {
      if (existsSync(p)) { this.ffmpegPath = p; break; }
    }
    for (const p of ffprobeCandidates) {
      if (existsSync(p)) { this.ffprobePath = p; break; }
    }

    if (this.ffmpegPath) console.log(`[FFmpegHelper] ffmpeg: ${this.ffmpegPath}`);
    if (this.ffprobePath) console.log(`[FFmpegHelper] ffprobe: ${this.ffprobePath}`);
    if (!this.ffmpegPath) console.warn('[FFmpegHelper] ffmpeg not found!');
    if (!this.ffprobePath) console.warn('[FFmpegHelper] ffprobe not found!');
  }

  get isAvailable() {
    return !!this.ffmpegPath && !!this.ffprobePath;
  }

  async run(cmd, args, timeoutMs = 600000, signal = null) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        /*
         * windowsHide 必须有。
         *
         * ffmpeg/ffprobe 在 Windows 上是控制台程序，spawn 时不带 windowsHide
         * 会**每调用一次弹一个黑框**，而且会抢最顶层焦点。
         * 用户批量上传素材时，每条素材都要跑好几次 ffmpeg（探测/抽音/转码），
         * 于是黑框弹个没完、电脑被抢焦点 —— 这正是 2026-10-05 报的灾难性 bug。
         *
         * 底下那些 taskkill 已经设了 windowsHide，唯独主 spawn 漏了，
         * 所以现象是"分析本身不弹、但每条素材都会闪几下"。
         */
        child = spawn(cmd, args, { shell: false, windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      ACTIVE_CHILDREN.add(child);
      const deregister = () => ACTIVE_CHILDREN.delete(child);
      let stdout = '';
      let stderr = '';
      /*
       * 2026-10-05 修：timer 必须先于 onAbort 声明。
       *
       * 原来 const timer 在下面第 199 行，而 `if (signal.aborted) onAbort()`
       * 在它之前就可能执行 —— onAbort 里第一句是 clearTimeout(timer)，
       * 于是命中**暂时性死区**：抛 ReferenceError: Cannot access 'timer'
       * before initialization。
       *
       * 后果不是"报错难看"这么轻：
       *   - 这个 ReferenceError 从 Promise executor 里逃出去，
       *     调用方拿到的是 ReferenceError 而不是 err.name === 'AbortError'，
       *     于是 sherpa-asr 那边判断"是不是用户取消"的分支不成立，
       *     取消语义整个丢掉。
       *   - 更糟：第 160 行 spawn 出来的 ffmpeg 已经登记进 ACTIVE_CHILDREN，
       *     但 onAbort 没跑到 deregister 也没跑到 taskkill ——
       *     **留下一个杀不掉的孤儿 ffmpeg 进程 + 一条永不释放的登记表项**。
       *     反复取消就会攒下一堆僵尸，持续吃 CPU 和文件句柄。
       *
       * 改成 let + 先赋值 null，onAbort 里判空再清。
       */
      let timer = null;
      // 用户取消：立刻杀掉 ffmpeg 进程树。
      // 以前只有超时能杀它，于是"取消分析"之后 ffmpeg 还在跑到底，
      // 占满 CPU 和文件句柄；用户立刻重跑就会被上一次拖住（实测请求直接超时）。
      const onAbort = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        deregister();
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
        const err = new Error(`${cmd} 已取消`);
        err.name = 'AbortError';
        err.userCancelled = true;
        reject(err);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // stderr 必须封顶：getEnergyCurve 之类是逐帧 -loglevel info 输出，长片跑一小时能攒出 GB 级字符串，
      // 失败时还会被整段复制进 Error.message。只留最后 8KB（够定位错误，又不吃内存）。
      const STDERR_CAP = 8192;
      const pushErr = (chunk) => {
        stderr += chunk;
        if (stderr.length > STDERR_CAP * 2) stderr = stderr.slice(-STDERR_CAP);
      };
      // 以前无超时：ffmpeg 卡住时调用方（调度/转写/合成）永远挂起。默认 10 分钟掐掉
      timer = setTimeout(() => {
        timer = null;
        deregister();
        if (signal) signal.removeEventListener('abort', onAbort);
        /* 必须杀整棵进程树：ffmpeg 自己会再拉子进程，只杀父进程的话那些会活下来继续占 CPU，
           而调用方已经认为"超时失败了"，无从察觉。下面 killAllFfmpeg / onAbort 用的都是 taskkill /T /F。 */
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
        reject(new Error(`ffmpeg timeout ${timeoutMs}ms: ${cmd} ${String(args?.[1] || '')}`.slice(0, 200)));
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); deregister(); if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => pushErr(d.toString()));
      child.on('close', code => {
        clearTimeout(timer);
        deregister();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code !== 0) reject(new Error(`ffmpeg error ${code}: ${stderr.slice(-STDERR_CAP)}`));
        else resolve(stdout);
      });
    });
  }

  async getMetadata(videoPath) {
    if (!this.ffprobePath) throw new Error('ffprobe not found');
    const stdout = await this.run(this.ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath
    ]);
    return JSON.parse(stdout);
  }

  async extractKeyframes(videoPath, outputDir, sceneThreshold = 0.3) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    const framesDir = join(outputDir, 'frames');
    const { mkdirSync } = await import('fs');
    mkdirSync(framesDir, { recursive: true });
    // 注：GLB 自带 ffmpeg 6.1.1 的 mjpeg 编码器多线程初始化失败，改用 png + 单线程，稳。
    // 上限 30 帧：爆款都是 1 分钟内短视频，场景帧足够结构分析；失败重试不再重复堆 GB
    await this.run(this.ffmpegPath, [
      '-i', videoPath,
      '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
      '-fps_mode', 'vfr',
      '-frames:v', '30',
      '-threads:v', '1',
      // -y 必须有：重分析时 %04d.png 已存在，ffmpeg 会在管道里停下来等 stdin 回答"覆盖吗"，
      // 而父进程永远不写 → 卡满 timeout(600s) 才失败，表现为"跑着跑着不动了"。
      '-y',
      join(framesDir, '%04d.png')
    ]);
    return framesDir;
  }

  async extractAudio(videoPath, outputWav, signal = null) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    await this.run(this.ffmpegPath, [
      '-i', videoPath,
      '-vn', '-acodec', 'pcm_s16le',
      '-ar', '16000', '-ac', '1',
      '-y', // 同名 wav 已存在时 ffmpeg 会阻塞等 stdin，同 extractKeyframes
      outputWav
    ], 600000, signal);
    return outputWav;
  }

  /**
   * 单帧抓拍（vision 复看 / 封面候选用）：取某秒画面。
   * width 传 0/null 时不缩放，输出原始分辨率（封面要清晰，不能压到 384 再放大）。
   */
  async extractFrameAt(videoPath, sec, outJpg, width = 384) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    const args = [
      '-ss', String(Math.max(0, sec)),
      '-i', videoPath,
      '-vframes', '1',
    ];
    const w = Number(width) || 0;
    if (w > 0) args.push('-vf', `scale=${w}:-2`);
    args.push('-q:v', w > 0 ? '4' : '2', '-y', outJpg);
    await this.run(this.ffmpegPath, args, 120000);
    return outJpg;
  }

  async extractFirstFrame(videoPath, outputImage) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    await this.run(this.ffmpegPath, [
      '-ss', '00:00:00',
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y', // 封面已存在时 ffmpeg 会阻塞等 stdin，卡满超时才失败
      outputImage
    ]);
    return outputImage;
  }

  /**
   * 切片 —— **字级精度的关键就在这里**。
   *
   * 【2026-10-05 重大改动：-c copy → 重新编码】
   *
   * 原来这里是 `-c copy`。那个 flag 的意思是"直接复制压缩后的数据，不解码"，
   * 所以切点**只能落在关键帧上** —— 而手机录屏的关键帧间隔通常 2~10 秒。
   * 后果是：你按逐句算好"切在第 3.2 秒"，实际成片从第 0.8 秒或第 6.1 秒才开始，
   * 而且**不会报任何错**。逐句拆剪算得再准也没用，因为刀口本身就是漂的。
   *
   * 改成重新编码后：ffmpeg 从最近的关键帧开始解码、丢弃前面的帧，
   * 于是切点精确到**毫秒** —— 这才让"精确到每个字"成为可能
   * （一个汉字的时长大约 200~300 毫秒）。
   *
   * 代价（老板 2026-10-05 明确选了方案 A：接受慢）：
   *   1. 慢 5~15 倍。原素材越长越明显。
   *   2. 多一次有损压缩 —— 用 CRF 17 压到肉眼几乎看不出，代价是文件大一点。
   *   3. 字级落刀可能切断单个字的音（物理限制：无法绕过）。
   *      已把淡入淡出做成可选，需要时开 default 那一行即可消掉大部分咔声。
   *
   * 为什么 concatCopy 还能继续用 -c copy：
   * 所有切片都由**同一个函数、同样的编码参数**产出，编码参数完全一致，
   * concat demuxer 要求的就是这一点，所以拼接依然是秒级、无损。
   *
   * @param {string} videoPath
   * @param {number} startSec    起点（秒，支持小数 = 毫秒精度）
   * @param {number} durationSec 时长（秒）
   * @param {string} outputPath
   * @param {object} [opts]
   * @param {boolean} [opts.accurate=true] false = 退回旧的快速切法（只切关键帧，快但不准）
   * @param {boolean} [opts.fadeMs=0]  边缘淡入淡出毫秒数，>0 可减轻字级落刀的咔声
   * @param {AbortSignal} [opts.signal]
   */
  async clipSegment(videoPath, startSec, durationSec, outputPath, opts = {}) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    const accurate = opts.accurate !== false;

    // 快速模式：保留旧行为，仅供"只要个大概位置"的场景使用
    if (!accurate) {
      await this.run(this.ffmpegPath, [
        '-ss', String(startSec),
        '-t', String(durationSec),
        '-i', videoPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputPath
      ], 600000, opts.signal ?? null);
      return outputPath;
    }

    /*
     * 精确模式。
     *
     * `-ss` 放在 `-i` **之前**：ffmpeg 会跳到不晚于该时间的关键帧开始解码，
     * 再靠解码丢弃前面的帧 —— 最终切点就是精确的，而且比放在 `-i` 之后快得多。
     * （只有 `-c copy` 时这个技巧才不准，因为它不解码；这里正是要解码。）
     */
    const args = [
      '-ss', String(Math.max(0, startSec)),
      '-t', String(durationSec),
      '-i', videoPath,
    ];

    // 画质/体积平衡点：17 肉眼基本无损。preset veryfast 是速度与压缩率的折中，
    // 慢一档（medium）画质好一点但耗时接近翻倍，对批量出片不划算。
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k');
    // 关键帧间隔压到 1 秒：万一后面还有别的地方要快速裁剪，别又被关键帧坑一次
    args.push('-g', '30');

    // 淡入淡出：字级落刀最明显的听感问题就是"咔"。给首尾各一小段渐变能消掉大部分。
    // 默认关（0）—— 因为它会在头尾留下几帧画面略暗，正常剪辑不需要。
    const fadeMs = Math.max(0, Number(opts.fadeMs) || 0);
    if (fadeMs > 0) {
      const fadeSec = (fadeMs / 1000).toFixed(3);
      args.push('-vf', `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${Math.max(0, durationSec - fadeMs / 1000).toFixed(3)}:d=${fadeSec}`);
      args.push('-af', `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${Math.max(0, durationSec - fadeMs / 1000).toFixed(3)}:d=${fadeSec}`);
    }

    args.push('-movflags', '+faststart', '-y', outputPath);

    // 重新编码慢，超时必须放宽：原来 copy 是秒级，现在一个 8 分钟成片可能要几分钟
    await this.run(this.ffmpegPath, args, Math.max(600000, Math.ceil(durationSec * 120000)), opts.signal ?? null);
    return outputPath;
  }

  async overlayText(videoPath, text, outputPath, options = {}) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    const fontSize = Math.max(12, Math.min(200, Number(options.fontSize) || 48));
    const fontColor = sanitizeColor(options.fontColor, 'white');
    const bgColor = sanitizeColor(options.bgColor, '#FF6B35');
    const yPos = Math.max(0, Math.min(2000, Number(options.yPos) || 50));
    const drawtext = `drawtext=text='${escapeDrawtext(text)}':fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=${bgColor}:x=(w-text_w)/2:y=${yPos}`;
    await this.run(this.ffmpegPath, [
      '-i', videoPath,
      '-vf', drawtext,
      '-c:a', 'copy',
      '-y',
      outputPath
    ]);
    return outputPath;
  }

  async burnSubtitles(videoPath, srtPath, outputPath) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    await this.run(this.ffmpegPath, [
      '-i', videoPath,
      '-vf', `subtitles='${escapeSubtitlesPath(srtPath)}'`,
      '-c:a', 'copy',
      '-y',
      outputPath
    ]);
    return outputPath;
  }

  /**
   * 无损拼接：多段同编码 mp4 按顺序拼成一条完整视频（-c copy，不重编码，秒级）。
   * @param {string[]} clipPaths - 按成片顺序排列的片段路径
   * @param {string} outputPath - 输出 roughcut 路径
   */
  async concatCopy(clipPaths, outputPath) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    if (!clipPaths.length) throw new Error('no clips to concat');
    if (clipPaths.length === 1) {
      const { copyFileSync } = await import('fs');
      copyFileSync(clipPaths[0], outputPath);
      return outputPath;
    }
    const { writeFileSync } = await import('fs');
    // concat demuxer 要求单引号转义，中文路径用 -safe 0；换行/空字节必须先清掉，否则可注入新的 file 指令
    const listPath = outputPath + '.filelist.txt';
    const lines = clipPaths.map(p => `file '${String(p).replace(/\\/g, '/').replace(/[\r\n\x00]/g, '_').replace(/'/g, "'\\''")}'`);
    writeFileSync(listPath, lines.join('\n'), 'utf-8');
    try {
      await this.run(this.ffmpegPath, [
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', outputPath
      ]);
    } finally {
      try { (await import('fs')).unlinkSync(listPath); } catch { /* ignore */ }
    }
    return outputPath;
  }

  /**
   * 音频能量曲线：单遍扫描整条音轨的瞬时响度（ebur128 M 值，10Hz），按秒取平均。
   * 用途：找到音量情绪高点（高潮/喝彩/强调），辅助爆点判断。不需要任何模型。
   * @returns {Promise<Array<{t:number, db:number}>>} 每秒平均响度（LUFS，越大越响）；无音轨返回 []
   */
  async getEnergyCurve(videoPath) {
    if (!this.ffmpegPath) throw new Error('ffmpeg not found');
    const stderr = await new Promise((resolve) => {
      // framelog 必须是 info：quiet 会把逐帧响度行吞掉，下游正则一行都匹配不到，
      // 能量峰记忆永远为空（线上 retention_signals=0 就是这么来的）
      const child = spawn(this.ffmpegPath, [
        '-i', videoPath, '-map', 'a', '-af', 'ebur128=framelog=info', '-f', 'null', '-'
        // windowsHide：见 run() 里的说明。漏了就会每条素材弹一个黑框并抢焦点。
      ], { shell: false, windowsHide: true });
      let err = '';
      // 兜底超时：超长直播误走此路时不至于永远挂起
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 600000);
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('close', () => { clearTimeout(timer); resolve(err); });
    });
    // 行格式（ffmpeg 6.x）：[Parsed_ebur128_0 @ ...] t: 12.3  TARGET:-23 LUFS    M: -23.5  S: ... I: ... LRA: ...
    // 注意 t: 与 M: 之间隔着 TARGET 段，旧正则 /t:..M:/ 跨不过去导致永远 0 行——必须按行分别提取
    const perSec = new Map();
    for (const line of String(stderr || '').split('\n')) {
      if (!line.includes('Parsed_ebur128')) continue;
      const tm = line.match(/t:\s*([\d.]+)/);
      const mm = line.match(/M:\s*(-?[\d.]+)/);
      if (!tm || !mm) continue;
      const sec = Math.floor(parseFloat(tm[1]));
      const db = parseFloat(mm[1]);
      if (!Number.isFinite(sec) || !Number.isFinite(db)) continue;
      if (!perSec.has(sec)) perSec.set(sec, []);
      perSec.get(sec).push(db);
    }
    return [...perSec.entries()]
      .map(([t, arr]) => ({ t, db: arr.reduce((a, b) => a + b, 0) / arr.length }))
      .sort((a, b) => a.t - b.t);
  }
}

export default FFmpegHelper;
