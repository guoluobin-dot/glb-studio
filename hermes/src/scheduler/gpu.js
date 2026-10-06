/**
 * GPU 忙闲感知：闲时性能拉满，忙时给用户让路。
 * 通过 nvidia-smi 读显卡利用率（10s 缓存，失败则视为空闲，保证不断流）。
 */

import { execFile } from 'child_process';

let _cache = { at: 0, state: null };
const CACHE_MS = 10000;

function querySmi() {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      // 8s 太长：每轮 tick 开头都等它，nvidia-smi 卡住时整个调度被拖住。3s 够了，失败走缓存/空闲
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
        if (!line) return resolve(null);
        const [util, memUsed, memTotal] = line.split(',').map(s => parseFloat(s.trim()));
        if (!Number.isFinite(util)) return resolve(null);
        resolve({ util, memUsed, memTotal });
      });
  });
}

/**
 * Ollama 是否正在推理。
 * nvidia-smi 只报显卡总利用率，分不清"用户在打游戏/剪片"和"Ollama 自己在跑"。
 * 看板手动触发的分析不进调度器的 runningTasks，光看 GPU 利用率会被误判成"用户忙"，
 * 于是自动任务继续插队、和手动任务抢 8G 显存，双双 fetch failed。
 * /api/ps 直接列出当前常驻的模型，问它最准。失败一律返回 false（宁可保守、不停摆）。
 */
async function queryOllamaBusy(config = {}) {
  const base = config.ollama?.baseUrl;
  if (!base) return false;
  try {
    const origin = new URL(base).origin; // http://localhost:11434/v1 -> http://localhost:11434
    const res = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const j = await res.json();
    return Array.isArray(j?.models) && j.models.length > 0;
  } catch {
    return false;
  }
}

export async function getGpuState(config = {}) {
  const now = Date.now();
  if (_cache.state && now - _cache.at < CACHE_MS) return _cache.state;
  const perf = config.performance || {};
  const idleBelow = perf.idleGpuUtil ?? 25;
  const busyAbove = perf.busyGpuUtil ?? 60;
  const smi = await querySmi();
  const ollamaBusy = await queryOllamaBusy(config);
  const state = smi
    ? {
        available: true,
        util: smi.util,
        memUsedMiB: smi.memUsed,
        memTotalMiB: smi.memTotal,
        ollamaBusy,
        // 三档：idle 拉满 / normal 常规 / busy 让路
        mode: smi.util < idleBelow ? 'idle' : (smi.util >= busyAbove ? 'busy' : 'normal'),
      }
    : { available: false, util: -1, mode: 'idle', ollamaBusy };
  _cache = { at: now, state };
  return state;
}

export default getGpuState;
