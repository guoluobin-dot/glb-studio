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
 * Ollama 是否**正在推理**。
 *
 * 这里必须区分两件事（2026-10-06 修，症状是队列整体停摆）：
 *   - 模型**加载着**：ollama 把权重留在显存里等下个请求，`/api/ps` 一直非空
 *   - 模型**正在推理**：GPU 利用率被拉高
 *
 * 原来只看 `/api/ps` 是否非空就当 busy，于是"模型加载着但闲着"和"正在推理"
 * 混为一谈。而 scheduler 里 `if (gpu.mode === 'busy' || gpu.ollamaBusy) return`
 * 会让整轮让路 —— 表现就是手动分析跑完一次之后，自动队列再也不会自己动了，
 * 用户看到的是"上传了素材但什么都不学进去"。
 *
 * 判据改成：模型在 + GPU 利用率明显高于闲时阈值 = 真的在推理；
 * 只加载着、GPU 闲着 = 不算 busy（调度器可以干活，只是并发降一档）。
 */
async function queryOllamaBusy(config = {}) {
  const base = config.ollama?.baseUrl;
  if (!base) return false;
  try {
    const origin = new URL(base).origin; // http://localhost:11434/v1 -> http://localhost:11434
    const res = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const j = await res.json();
    const loaded = Array.isArray(j?.models) && j.models.length > 0;
    if (!loaded) return false;
    // 模型在显存里，但要看它是不是真的在算 —— 这个要靠 GPU 利用率，
    // 所以先只报"已加载"，由 getGpuState 结合 smi.util 一起判断。
    return { loaded: true };
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
  const ollamaLoaded = await queryOllamaBusy(config);

  /*
   * "正在推理" = 模型加载着 且 GPU 利用率够高。
   * 只加载着、GPU 闲着 → 不算 busy，否则自动队列永远让路。
   * smi 拿不到时退回"算忙"，宁可保守也不和用户抢显卡。
   */
  let ollamaBusy = false;
  if (ollamaLoaded) {
    ollamaBusy = smi ? smi.util >= idleBelow : true;
  }

  const state = smi
    ? {
        available: true,
        util: smi.util,
        memUsedMiB: smi.memUsed,
        memTotalMiB: smi.memTotal,
        ollamaBusy,
        /** 模型常驻显存（不等于正在推理），看板要显示"为什么不让路"时用 */
        ollamaLoaded: !!ollamaLoaded,
        // 三档：idle 拉满 / normal 常规 / busy 让路
        mode: smi.util < idleBelow ? 'idle' : (smi.util >= busyAbove ? 'busy' : 'normal'),
      }
    : { available: false, util: -1, mode: 'idle', ollamaBusy, ollamaLoaded: !!ollamaLoaded };
  _cache = { at: now, state };
  return state;
}

export default getGpuState;
