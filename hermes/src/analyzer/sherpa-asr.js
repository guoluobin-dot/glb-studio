/**
 * Sherpa Local ASR - 复用 GLB 自带的 sherpa-onnx + 语音模型做本地转写
 *
 * 双通道中的兜底通道：upload/hits|live 丢进来的视频还没经过 GLB，
 * 没有 transcript JSON 时，直接用本机模型转写，不用再下 whisper。
 *
 * 模型位置（GLB 安装后自带）：
 *   APPDATA/GLB/models/sherpa-onnx-sense-voice-xxx/model.int8.onnx（优先，多语，带标点归一）
 *   APPDATA/GLB/models/sherpa-onnx-paraformer-zh-xxx/model.int8.onnx（备选，中文准）
 *
 * 策略：按 60s 切片逐段识别，每片一段 transcript segment，
 * 精度足够主题分段（30s~3min 粒度），又避开 OfflineRecognizer 无词级时间戳的问题。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { Worker } from 'node:worker_threads';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * sherpa-onnx 的加载位置。
 *
 * 2026-09-30 修：原来只写死一条 D:/GLB/GLB/resources/app.asar.unpacked/... ,
 * 那是旧宿主应用里的路径。宿主一旦重装/换路径，这条链就断，
 * 表现为转写静默失败（"sherpa-onnx-node not found"），
 * 而模型文件其实一直好好躺在 %APPDATA%\GLB\models 里。
 *
 * 现在按优先级多路径探测，且把 Hermes 自己的 node_modules 放在最前 ——
 * 原生模块应该由使用方自己声明依赖，而不是指望宿主应用带着走。
 */
const SHERPA_PATHS = [
  // 1) Hermes 自己的依赖（推荐路径：npm i sherpa-onnx-node sherpa-onnx-win-x64）
  'sherpa-onnx-node/sherpa-onnx.js',
  // 2) 宿主应用解包目录（兼容旧部署）
  'D:/GLB/GLB/resources/app.asar.unpacked/node_modules/sherpa-onnx-node/sherpa-onnx.js',
  // 3) 全家桶相对路径 —— 和语音模型同一个坑：跟着 bundle 一起挪盘就会断
  join(__dirname, '..', '..', '..', 'GLB', 'resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
];

// 分块长度。三次下调，都是被实测打回来的：
//   60 → 20：60s 分块让 ≤120s 的短素材只出 1~2 个 segment，逐句成片粒度被卡死。
//   20 → 10：sense-voice 在 16kHz 下的识别窗口上限约 15 秒，超过就返回空串。
//           实测 14s 有结果("爸爸")、16s 起恒为空，而 20s 分块必然踩线。
//           结果是所有 >20s 的素材转写全空 —— 表现为"分析失败：No ASR transcript available"，
//           而音频其实有声（-14dB）。这个坑不修，爆款库里超过 20 秒的素材一条都进不来。
//   取 10s 是留 1.67 倍安全余量；块数变多只影响转写耗时，不影响结果正确性。
const CHUNK_SECONDS = 10;

let _sherpa = null;
// 同步 require（Node ESM 下用 createRequire 加载 GLB 的 CJS 模块）
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
// 导出给 sherpa-worker.js（Worker 线程）复用，避免两份初始化逻辑分叉
export function loadSherpaSync() {
  if (_sherpa) return _sherpa;
  for (const p of SHERPA_PATHS) {
    // 关键：不能直接 existsSync(p)。包名(如 'sherpa-onnx-node/sherpa-onnx.js')
    // 是包内相对路径,不是文件系统路径,existsSync 恒为 false,
    // 于是走 require.resolve 从 node_modules 里解析。
    let resolved = null;
    try {
      resolved = _require.resolve(p);
    } catch {
      if (existsSync(p)) resolved = p;
    }
    if (!resolved) continue;
    try {
      _sherpa = _require(resolved);
      if (_sherpa) {
        console.log(`[SherpaASR] loaded from ${resolved}`);
        return _sherpa;
      }
    } catch (err) {
      console.warn(`[SherpaASR] load failed ${resolved}: ${err.message}`);
    }
  }
  return null;
}

/**
 * sherpa 语音模型的候选根目录。
 *
 * 2026-10-10 修：原来只认 `%APPDATA%\GLB\models` 一条路。
 * 全家桶挪盘/改目录后（这台机器就是 D:\GLB → E:\GLB-Studio-绿色全家桶-16GB），
 * GLB 的用户数据目录跟着搬到了 <bundle>\GLBUserData\models，
 * 而 %APPDATA% 下那条根本没生成 —— 于是 findModelDir 返回 null、
 * getSherpaStatus().available=false、每条素材的转写都直接 unavailable。
 *
 * 症状极具误导性：GPU 闲着、队列在跑、素材全是 pending，
 * 看板只显示"分析不出来"，没人会想到是模型路径找不到。
 * （同一个坑 orchestrator 的 resolveBundlePaths 已经为 upload/output 修过一次。）
 *
 * 顺序：环境变量 > 配置 > 全家桶相对路径 > 旧默认路径。
 */
function modelSearchBases(config = {}) {
  const bases = [];
  const push = (p) => {
    if (!p) return;
    const s = String(p);
    if (!bases.includes(s)) bases.push(s);
  };
  push(process.env.GLB_MODELS_DIR);
  push(config.security?.modelsDir);
  // src/analyzer -> src -> Hermes -> <bundle>/GLB ; GLBUserData 与 GLB 同级
  const bundleRoot = join(__dirname, '..', '..', '..');
  push(join(bundleRoot, 'GLBUserData', 'models'));
  push(join(bundleRoot, 'GLB', 'GLBUserData', 'models'));
  push(join(homedir(), 'AppData', 'Roaming', 'GLB', 'models'));
  push(join(homedir(), 'AppData', 'Local', 'GLB', 'models'));
  // 旧部署路径，留着兼容没挪盘的机器
  push('D:/GLB/GLBUserData/models');
  push('D:/GLB/GLB/models');
  return bases;
}

/** 命中的模型根目录（缓存：getSherpaStatus 每次都会问，别每次都 readdir 整个目录树） */
let _baseCache = null;
function resolveModelBase(config = {}) {
  if (_baseCache !== null) return _baseCache || null;
  for (const b of modelSearchBases(config)) {
    try {
      if (existsSync(b) && readdirSync(b).some((d) => d.startsWith('sherpa-onnx-'))) {
        _baseCache = b;
        return b;
      }
    } catch { /* ignore */ }
  }
  _baseCache = '';
  return null;
}

/** 配置在构造期才知道，所以第一次调用时把 config 交进来（可选，仅用于扩展搜索路径） */
export function primeSherpaModels(config = {}) {
  _baseCache = null;
  return resolveModelBase(config);
}

function findModelDir(prefix) {
  const base = resolveModelBase();
  if (!base) return null;
  let hit = null;
  try { hit = readdirSync(base).find(d => d.startsWith(prefix)) || null; } catch { /* ignore */ }
  return hit ? join(base, hit) : null;
}

/** onnx 权重：int8 优先，没有就用全精度（有些模型只发 model.onnx） */
function modelFileOf(dir) {
  if (!dir) return null;
  for (const f of ['model.int8.onnx', 'model.onnx']) {
    if (existsSync(join(dir, f))) return join(dir, f);
  }
  return null;
}

export function getSherpaStatus() {
  const base = resolveModelBase();
  const senseDir = findModelDir('sherpa-onnx-sense-voice');
  const paraDir = findModelDir('sherpa-onnx-paraformer');
  const senseOk = !!(senseDir && modelFileOf(senseDir) && existsSync(join(senseDir, 'tokens.txt')));
  const paraOk = !!(paraDir && modelFileOf(paraDir) && existsSync(join(paraDir, 'tokens.txt')));
  return {
    available: !!(senseOk || paraOk),
    senseVoice: !!senseOk,
    paraformer: !!paraOk,
    senseDir,
    paraDir,
    // 排查用：告诉人到底去哪儿找的模型（找不到时 modelsBase 会是 null）
    modelsBase: base,
    searchedBases: modelSearchBases(),
  };
}

let _recognizer = null;
let _recognizerKind = null;

// 导出给 Worker 用（主线程不再直接 decode，见 SherpaASR.transcribe）
export function createRecognizer() {
  if (_recognizer) return { rec: _recognizer, kind: _recognizerKind };
  const sherpa = loadSherpaSync();
  if (!sherpa) throw new Error('sherpa-onnx-node not found（GLB 未安装？）');
  const st = getSherpaStatus();
  if (!st.available) throw new Error('GLB 语音模型缺失：%APPDATA%/GLB/models 下无 sense-voice/paraformer');

  if (st.senseVoice) {
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: modelFileOf(st.senseDir),
          language: 'auto',
          useInverseTextNormalization: true,
        },
        tokens: join(st.senseDir, 'tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        modelType: 'sense_voice',
      },
    };
    _recognizer = new sherpa.OfflineRecognizer(config);
    _recognizerKind = 'sense-voice';
  } else {
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: modelFileOf(st.paraDir) },
        tokens: join(st.paraDir, 'tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        modelType: 'paraformer',
      },
    };
    _recognizer = new sherpa.OfflineRecognizer(config);
    _recognizerKind = 'paraformer';
  }
  console.log(`[SherpaASR] recognizer ready (${_recognizerKind})`);
  return { rec: _recognizer, kind: _recognizerKind };
}

export const SHERPA_CHUNK_SECONDS = CHUNK_SECONDS;

export class SherpaASR {
  constructor(ffmpegHelper) {
    this.ffmpeg = ffmpegHelper;
  }

  get available() {
    return getSherpaStatus().available && !!this.ffmpeg?.isAvailable;
  }

  /**
   * 转写整个视频，按 60s 切片逐段识别。
   * decode() 是同步 native 调用，一片 60s 音频能卡主线程十几秒，
   * 看板 /api/* 请求会全部排队超时——所以实际解码跑在 Worker 线程，
   * 主线程事件循环全程空闲（转写几小时大文件时看板照常可点）。
   * @returns {Promise<Array<{start:number,end:number,text:string}>>} ms 时间戳
   */
  async transcribe(videoPath, onProgress = null, signal = null) {
    if (signal?.aborted) {
      const e = new Error('转写已取消');
      e.name = 'AbortError';
      e.userCancelled = true;
      throw e;
    }
    const meta = await this.ffmpeg.getMetadata(videoPath);
    const durationSec = parseFloat(meta.format?.duration || 0);
    if (!durationSec || durationSec <= 0) throw new Error('无法读取视频时长');

    // 工作目录必须用纯 ASCII 路径：sherpa-onnx 的 C++ readWave 用 ANSI fopen，
    // 中文路径（如 D:\GLB\...）Node 侧 existsSync 能过、C++ 侧打不开。
    // 视频读取走 ffmpeg（Unicode 正常），只有切片 wav 需要绕行系统 TEMP。
    const safeBase = join(tmpdir(), 'hermes-asr');
    if (!existsSync(safeBase)) mkdirSync(safeBase, { recursive: true });
    /*
 * 2026-10-12：临时目录名加上随机后缀。
 *
 * 原来只有 `sherpa_${Date.now()}` —— 两场转写在同一毫秒启动
 * （调度器 + 手动并发，实践中很容易发生）就会用同一个目录，
 * 双方都写 chunk_0.wav…，而先返回的一方在 finally 里把整棵目录删掉，
 * 另一方后续分片全部走 "wav missing" 分支被静默跳过，
 * 最终返回一份残缺逐字稿并被写进缓存 —— 之后每次都拿这份残稿当结果。
 */
const tmpBase = join(safeBase, `sherpa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpBase, { recursive: true });

    try {
      // HERMES_SHERPA_INLINE=1 强制走主线程（排查用）；默认 Worker
      if (process.env.HERMES_SHERPA_INLINE === '1') {
        return await this._transcribeInline(videoPath, durationSec, tmpBase, onProgress);
      }
      try {
        return await this._transcribeInWorker(videoPath, durationSec, tmpBase, onProgress, signal);
      } catch (err) {
        // 取消不要再回退主线程重跑一次 —— 那是用户明确不要的
        if (err?.name === 'AbortError' || err?.userCancelled) throw err;
        /*
         * 2026-10-12：native 解码死锁（硬超时）**不**回退主线程。
         *
         * 硬超时恰恰是"native 解码已经卡住"这个最危险的信号，
         * 而回退路径是 `_transcribeInline` —— 把**同一份 native 解码**
         * 搬到主线程再跑一遍整场（3 小时素材）。
         * 后果：主线程事件循环被完全阻塞，看板/API 全部排队，
         * 墙钟从 60 分钟变成 60 分钟 + 又一场 inline。
         *
         * 只有"worker 环境本身不支持"（模块加载失败之类）才值得回退，
         * 因为那种情况下 inline 是换条路走，不是重蹈同一个覆辙。
         */
        const isDecodeDeadlock = /硬超时|死锁/.test(String(err?.message || ''));
        if (isDecodeDeadlock) {
          console.error(
            `[SherpaASR] native 解码卡死（${err.message}），已放弃本条转写 ——`
            + ` 不再回退主线程重跑（会把同一份卡死的解码搬进主线程并阻塞整个服务）`
          );
          throw err;
        }
        // Worker 环境异常（如 native 模块在该 Node 下不支持 Worker）时回退主线程，保证不断流
        console.warn(`[SherpaASR] worker failed (${err.message})，回退主线程转写（期间看板可能变慢）`);
        return await this._transcribeInline(videoPath, durationSec, tmpBase, onProgress, signal);
      }
    } finally {
      // 清理整片工作目录（rmSync 递归，替代原来删不掉非空目录的 unlinkSync）
      try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Worker 线程转写：主线程只等消息，事件循环不阻塞。
   */
  _transcribeInWorker(videoPath, durationSec, tmpBase, onProgress = null, signal = null) {
    return new Promise((resolve, reject) => {
      // 关键：取消必须能真的停掉转写。
      //
      // 转写跑在 Worker 线程里（native 解码），主线程只是等消息 ——
      // AbortSignal 打不进 Worker，所以以前点了取消之后，
      // 这一步会一直跑到整场转写结束（3 小时直播实测 281 秒）。
      // 用户看到的是"已取消"，实际 CPU 还在满载、分析状态一直不归位。
      const onAbort = () => {
        done(reject, Object.assign(new Error('转写已取消'), { name: 'AbortError', userCancelled: true }));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      // 2026-10-12：把取消通知给 Worker。
      // Worker 里有一份**独立的** FFmpegHelper（模块实例不同 → ACTIVE_CHILDREN 也是另一份），
      // 所以主线程的 killAllFfmpeg() 一个 worker 内的 ffmpeg 都杀不掉。
      // terminate() 虽然能停掉 native 解码，但它是异步的 —— 不通知的话，
      // 正在跑的那一发 ffmpeg 会一直跑到自己结束（CPU 满载，界面却已显示"已取消"）。
      const notifyWorker = () => {
        try { worker?.postMessage({ type: 'cancel' }); } catch { /* worker 可能已退出 */ }
      };
      if (signal) {
        if (signal.aborted) notifyWorker();
        else signal.addEventListener('abort', notifyWorker, { once: true });
      }

      let worker;
      try {
        worker = new Worker(join(__dirname, 'sherpa-worker.js'), {
          workerData: {
            videoPath,
            durationSec,
            ffmpegPath: this.ffmpeg?.ffmpegPath || null,
            ffprobePath: this.ffmpeg?.ffprobePath || null,
            tmpBase,
          },
        });
      } catch (err) {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
        return;
      }
      const segments = [];
      let settled = false;
      let killer = null;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        if (killer) clearTimeout(killer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
          signal.removeEventListener('abort', notifyWorker);
        }
        // terminate() 会连 Worker 里的 native 解码一起停掉。
        // 以前只清标记不清 Worker，于是取消后它还在后台跑到底。
        try { worker.terminate(); } catch { /* ignore */ }
        fn(val);
      };
      // 2026-09-24 修：原来只监听 message/error/exit。worker 里的 native 解码一旦死锁，
      // 这三个事件都不触发 → Promise 永不 settle → 调用方永久 await，整轮 tick 挂死
      // （_tickRunning 常驻 true，调度器再也不动）。按片长给个宽松硬上限。
      const hardMs = Math.max(5 * 60 * 1000, Math.min(60 * 60 * 1000, Math.round((Number(durationSec) || 0) * 1000 * 2 + 120000)));
      killer = setTimeout(() => {
        done(reject, new Error(`sherpa worker 硬超时 ${Math.round(hardMs / 1000)}s，已强杀（解码可能死锁）`));
      }, hardMs);
      if (killer.unref) killer.unref();
      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'progress') {
          if (onProgress) {
            try { onProgress(msg.done, msg.total); } catch { /* ignore */ }
          }
          console.log(`[SherpaASR] ${basename(videoPath)} chunk ${msg.done}/${msg.total}: ${(msg.text || '(静音)').slice(0, 40)}`);
        } else if (msg.type === 'warn') {
          console.warn(`[SherpaASR] ${msg.msg}`);
        } else if (msg.type === 'done') {
          done(resolve, Array.isArray(msg.segments) ? msg.segments : segments);
        } else if (msg.type === 'error') {
          done(reject, new Error(msg.msg || 'sherpa worker error'));
        }
      });
      worker.on('error', (err) => done(reject, err));
      worker.on('exit', (code) => {
        // 正常 done 后 terminate 的 exit code 为 1，属于主动销毁，直接忽略
        if (settled) return;
        if (code !== 0) done(reject, new Error(`sherpa worker exit ${code}`));
        else done(resolve, segments);
      });
    });
  }

  /**
   * 主线程直转（仅回退/排查用：会阻塞事件循环，大文件转写时看板超时）。
   */
  async _transcribeInline(videoPath, durationSec, tmpBase, onProgress = null, signal = null) {
    // 内联路径同样要能取消：它跑在主线程，分片循环里不查就会一直转到底
    const checkAbort = () => {
      if (signal?.aborted) {
        throw Object.assign(new Error('转写已取消'), { name: 'AbortError', userCancelled: true });
      }
    };
    checkAbort();
    const { rec } = createRecognizer();
    const sherpa = loadSherpaSync();
    const segments = [];
    const n = Math.max(1, Math.ceil(durationSec / CHUNK_SECONDS));
    for (let i = 0; i < n; i++) {
      const startSec = i * CHUNK_SECONDS;
      const lenSec = Math.min(CHUNK_SECONDS, durationSec - startSec);
      const wavPath = join(tmpBase, `chunk_${i}.wav`);
      const ffErr = await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
        '-ss', String(startSec),
        '-t', String(lenSec),
        '-i', videoPath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-y', wavPath,
      ]).then(() => null).catch(err => err.message);
      if (ffErr) {
        console.warn(`[SherpaASR] chunk ${i} ffmpeg failed: ${String(ffErr).slice(0, 300)}`);
        continue;
      }
      // 防御：确认 wav 真的落盘（曾观测到 exit 0 但无文件的个例）
      if (!existsSync(wavPath)) {
        console.warn(`[SherpaASR] chunk ${i} wav missing after ffmpeg exit 0: ${wavPath} (tmpBase exists: ${existsSync(tmpBase)})`);
        continue;
      }
      let wave = null;
      try {
        wave = sherpa.readWave(wavPath);
      } catch (err) {
        console.warn(`[SherpaASR] readWave failed chunk ${i}: ${err.message}`);
        continue;
      }
      try {
        const stream = rec.createStream();
        stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
        rec.decode(stream);
        const result = rec.getResult(stream);
        const text = (result?.text || '').trim();
        if (text) {
          const st = Math.round(startSec * 1000);
          const en = Math.round((startSec + lenSec) * 1000);
          segments.push({
            start: st,
            end: en,
            start_ms: st,
            end_ms: en,
            text,
          });
        }
      } catch (err) {
        console.warn(`[SherpaASR] decode failed chunk ${i}: ${err.message}`);
      }
      try { unlinkSync(wavPath); } catch { /* ignore */ }
      if (onProgress) onProgress(i + 1, n);
      console.log(`[SherpaASR] ${basename(videoPath)} chunk ${i + 1}/${n}: ${(segments[segments.length - 1]?.text || '(静音)').slice(0, 40)}`);
      // 每片之间查一次取消。整场直播几十片，不查的话点了取消还要转完剩下的
      checkAbort();
    }
    return segments;
  }
}

export default SherpaASR;
