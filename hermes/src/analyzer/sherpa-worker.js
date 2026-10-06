/**
 * Sherpa 转写 Worker（跑在独立线程，由 SherpaASR.transcribe 调度）。
 *
 * 背景：sherpa-onnx 的 rec.decode() 是同步 native 调用，一片 60s 音频能卡住
 * Node 主线程十几秒，期间看板所有 /api/* 请求排队超时（红条+转圈）。
 * 放 Worker 里阻塞的是 Worker 线程，主线程事件循环全程空闲。
 *
 * 输入（workerData）：{ videoPath, durationSec, ffmpegPath, ffprobePath, tmpBase }
 * 输出消息：{type:'progress',done,total,text} / {type:'warn',msg} /
 *           {type:'done',segments} / {type:'error',msg}
 */

import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { FFmpegHelper } from './ffmpeg-helper.js';
import { loadSherpaSync, createRecognizer, SHERPA_CHUNK_SECONDS } from './sherpa-asr.js';

// 兜底值必须和 sherpa-asr.js 一致。以前写 60,一旦主线程那次导入失败
// (比如模块没加载上),worker 会静默退回 60s 分块 —— 正好踩 sense-voice 的 15s 上限,
// 于是整场转写全空,而且没有任何报错。
const CHUNK_SECONDS = SHERPA_CHUNK_SECONDS || 10;

async function main() {
  const { videoPath, durationSec, ffmpegPath, ffprobePath, tmpBase } = workerData || {};
  if (!videoPath || !durationSec) {
    parentPort.postMessage({ type: 'error', msg: 'worker 缺少 videoPath/durationSec' });
    return;
  }

  const ff = new FFmpegHelper();
  if (ffmpegPath) ff.ffmpegPath = ffmpegPath;
  if (ffprobePath) ff.ffprobePath = ffprobePath;
  if (!ff.ffmpegPath) {
    parentPort.postMessage({ type: 'error', msg: 'worker 内无可用 ffmpeg' });
    return;
  }

  let rec;
  let sherpa;
  try {
    ({ rec } = createRecognizer());
    sherpa = loadSherpaSync();
  } catch (err) {
    parentPort.postMessage({ type: 'error', msg: `recognizer 初始化失败: ${err.message}` });
    return;
  }

  if (!existsSync(tmpBase)) mkdirSync(tmpBase, { recursive: true });

  const n = Math.max(1, Math.ceil(durationSec / CHUNK_SECONDS));
  const segments = [];
  for (let i = 0; i < n; i++) {
    const startSec = i * CHUNK_SECONDS;
    const lenSec = Math.min(CHUNK_SECONDS, durationSec - startSec);
    const wavPath = join(tmpBase, `chunk_${i}.wav`);
    try {
      await ff.run(ff.ffmpegPath, [
        '-ss', String(startSec),
        '-t', String(lenSec),
        '-i', videoPath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-y', wavPath,
      ]);
    } catch (err) {
      parentPort.postMessage({ type: 'warn', msg: `chunk ${i} ffmpeg failed: ${String(err.message).slice(0, 200)}` });
      parentPort.postMessage({ type: 'progress', done: i + 1, total: n, text: '' });
      continue;
    }
    if (!existsSync(wavPath)) {
      parentPort.postMessage({ type: 'warn', msg: `chunk ${i} wav missing after ffmpeg exit 0` });
      parentPort.postMessage({ type: 'progress', done: i + 1, total: n, text: '' });
      continue;
    }
    let wave = null;
    try {
      wave = sherpa.readWave(wavPath);
    } catch (err) {
      parentPort.postMessage({ type: 'warn', msg: `chunk ${i} readWave: ${err.message}` });
      parentPort.postMessage({ type: 'progress', done: i + 1, total: n, text: '' });
      continue;
    }
    try {
      // 注意：这行同步阻塞十几秒，但卡的是 Worker 线程，主线程不受影响
      const stream = rec.createStream();
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
      rec.decode(stream);
      const result = rec.getResult(stream);
      const text = (result?.text || '').trim();
      if (text) {
        const st = Math.round(startSec * 1000);
        const en = Math.round((startSec + lenSec) * 1000);
        segments.push({ start: st, end: en, start_ms: st, end_ms: en, text });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'warn', msg: `chunk ${i} decode: ${err.message}` });
    }
    try { unlinkSync(wavPath); } catch { /* ignore */ }
    parentPort.postMessage({
      type: 'progress',
      done: i + 1,
      total: n,
      text: segments.length ? segments[segments.length - 1].text : '',
    });
  }
  parentPort.postMessage({ type: 'done', segments });
}

main().catch((err) => {
  try {
    parentPort.postMessage({ type: 'error', msg: err?.message || String(err) });
  } catch { /* ignore */ }
});
