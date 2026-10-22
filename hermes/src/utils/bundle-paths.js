/**
 * 挪盘自愈：配置里写死的绝对路径（历史版本是 D:/GLB…）在换盘/改名后不存在时，
 * 自动回退到全家桶相对路径，并把兜底目录建出来。
 *
 * 为什么必须单独成文件：
 * 这段逻辑以前内联在 orchestrator/index.js 里，改坏了没有任何测试能碰到它 ——
 * 2026-10-19 用户报「素材扫不出来」，根因就在这里的 `fix()` 带着
 * `existsSync(fallback)` 的条件：换盘后兜底目录也从来没建过，
 * 于是「配置路径不存在 → 想回退」和「兜底不存在 → 不回退」互相卡死，
 * upload.liveDir 永远停在一个空架子目录上，调度器 existsSync 直接 false。
 *
 * @param {object} config    Hermes 配置对象（原地修改并返回）
 * @param {string} bundleRoot 全家桶根目录（含 GLB/ 的那一层）
 */
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export function resolveBundlePaths(config, bundleRoot) {
  try {
    const fallback = {
      outputWatchDir: join(bundleRoot, 'output'),
      transcriptDir: join(bundleRoot, 'output', 'transcripts'),
      highlightDir: join(bundleRoot, 'output', 'highlights'),
      clipDir: join(bundleRoot, 'output', 'clips'),
      exePath: join(bundleRoot, 'GLB', 'GLB.exe'),
      hitsDir: join(bundleRoot, 'Hermes', 'upload', 'hits'),
      liveDir: join(bundleRoot, 'Hermes', 'upload', 'live'),
      tempDir: join(bundleRoot, 'Hermes', 'upload', 'temp'),
      finishedDir: join(bundleRoot, 'output', 'finished'),
      draftDir: join(bundleRoot, 'output', 'draft'),
    };

    // 兜底目录必须先建出来，否则下面的 fix() 没有任何东西可回退到。
    for (const d of [
      fallback.outputWatchDir, fallback.transcriptDir, fallback.highlightDir,
      fallback.clipDir, fallback.hitsDir, fallback.liveDir, fallback.tempDir,
      fallback.finishedDir, fallback.draftDir,
    ]) {
      try { mkdirSync(d, { recursive: true }); } catch { /* 只读介质等，忽略 */ }
    }

    // 目录：配置路径不存在就一律用全家桶内的相对目录。
    // 存在则保留 —— 用户可能真的把成片放在别的盘，那里已经有历史产物时
    // 强行搬走等于把数据变成孤儿。
    const fix = (p, fb) => (!p || !existsSync(p)) ? fb : p;
    // exePath 是文件不是目录，仍然要求兜底真的存在才回退。
    const fixFile = (p, fb) => (!p || !existsSync(p)) && existsSync(fb) ? fb : p;

    if (config?.glb) {
      config.glb.outputWatchDir = fix(config.glb.outputWatchDir, fallback.outputWatchDir);
      config.glb.transcriptDir = fix(config.glb.transcriptDir, fallback.transcriptDir);
      config.glb.highlightDir = fix(config.glb.highlightDir, fallback.highlightDir);
      config.glb.clipDir = fix(config.glb.clipDir, fallback.clipDir);
      config.glb.exePath = fixFile(config.glb.exePath, fallback.exePath);
    }
    if (config?.upload) {
      config.upload.hitsDir = fix(config.upload.hitsDir, fallback.hitsDir);
      config.upload.liveDir = fix(config.upload.liveDir, fallback.liveDir);
      config.upload.tempDir = fix(config.upload.tempDir, fallback.tempDir);
    }
    if (config?.output) {
      config.output.finishedDir = fix(config.output.finishedDir, fallback.finishedDir);
      config.output.draftDir = fix(config.output.draftDir, fallback.draftDir);
    }
  } catch { /* 自愈失败不该拦住启动 */ }
  return config;
}