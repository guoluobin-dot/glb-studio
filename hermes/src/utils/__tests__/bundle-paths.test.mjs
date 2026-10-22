/**
 * 挪盘自愈（bundle paths）的回归测试
 *
 * 真实故障（2026-10-19，用户报「素材扫不出来」）：
 *   config/default.json 里写的是 D:/GLB/Hermes/upload/live，
 *   那是旧机器的安装位置。全家桶搬到 E: 之后这个目录根本不存在，
 *   而自愈逻辑的判据是 `(!p || !existsSync(p)) && existsSync(fallback)` ——
 *   兜底目录 E:…/Hermes/upload/live 也从来没建过，于是条件不成立，
 *   配置永远停在失效的 D: 上。调度器 `_processPendingLives` 第一行
 *   `if (!existsSync(liveDir)) return;` 直接静默返回，
 *   30 秒一轮的「录播监听」永远空转，界面上没有任何报错。
 *
 * 这组测试锁三件事：失效路径必须被换成全家桶内的、兜底目录必须真的被建出来、
 * 用户确实存在的自定义路径不能被动。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBundlePaths } from '../bundle-paths.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'glb-bundle-'));
}

/**
 * 造一份"指向已失效安装位置"的配置。
 *
 * 失效位置必须用 root 底下自己造的一段，而不是真的写 D:/GLB/…：
 * 测试跑在哪台机器上不能影响结果 —— 开发机上 D:\GLB\Hermes\upload\temp
 * 碰巧还留着（上一代安装的残骸），existsSync 为真就不会触发回退，
 * 一台机器绿一台机器红。
 */
function staleConfig(root) {
  const gone = join(root, '__stale_install__');
  return {
    glb: {
      outputWatchDir: join(gone, 'output'),
      transcriptDir: join(gone, 'output/transcripts'),
      highlightDir: join(gone, 'output/highlights'),
      clipDir: join(gone, 'output/clips'),
      exePath: join(gone, 'GLB/GLB.exe'),
    },
    upload: {
      hitsDir: join(gone, 'Hermes/upload/hits'),
      liveDir: join(gone, 'Hermes/upload/live'),
      tempDir: join(gone, 'Hermes/upload/temp'),
    },
    output: {
      finishedDir: join(gone, 'output/finished'),
      draftDir: join(gone, 'output/draft'),
    },
  };
}

test('换盘后所有失效路径都要换到全家桶内，并且目录被建出来', () => {
  const root = freshRoot();
  try {
    const cfg = resolveBundlePaths(staleConfig(root), root);

    assert.equal(cfg.upload.liveDir, join(root, 'Hermes/upload/live'));
    assert.equal(cfg.upload.hitsDir, join(root, 'Hermes/upload/hits'));
    assert.equal(cfg.upload.tempDir, join(root, 'Hermes/upload/temp'));
    assert.equal(cfg.output.finishedDir, join(root, 'output/finished'));
    assert.equal(cfg.output.draftDir, join(root, 'output/draft'));
    assert.equal(cfg.glb.transcriptDir, join(root, 'output/transcripts'));
    assert.equal(cfg.glb.highlightDir, join(root, 'output/highlights'));
    assert.equal(cfg.glb.clipDir, join(root, 'output/clips'));

    // 关键：不只是改了字符串，目录必须真的存在，
    // 否则调度器 existsSync 照样 false，还是「扫不出来」。
    for (const d of [
      cfg.upload.liveDir, cfg.upload.hitsDir, cfg.upload.tempDir,
      cfg.output.finishedDir, cfg.output.draftDir, cfg.glb.outputWatchDir,
      cfg.glb.transcriptDir, cfg.glb.highlightDir, cfg.glb.clipDir,
    ]) {
      assert.ok(existsSync(d), `目录必须被建出来：${d}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('用户真存在的自定义路径不能被动（别把历史成片变成孤儿）', () => {
  const root = freshRoot();
  const custom = join(root, 'my-drafts');
  mkdirSync(custom, { recursive: true });
  try {
    const cfg = staleConfig(root);
    cfg.output.draftDir = custom;
    resolveBundlePaths(cfg, root);
    assert.equal(cfg.output.draftDir, custom, '已经存在的成片目录必须原样保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exePath 是文件：兜底不存在时不许凭空改写', () => {
  const root = freshRoot();
  try {
    const cfg = staleConfig(root);
    const before = cfg.glb.exePath;
    resolveBundlePaths(cfg, root);
    // root/GLB/GLB.exe 不存在，回退条件不成立 → 保持原值，
    // 免得下游拿到一个"看起来对但文件不存在"的路径。
    assert.equal(cfg.glb.exePath, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空配置不能抛', () => {
  const root = freshRoot();
  try {
    assert.doesNotThrow(() => resolveBundlePaths(null, root));
    assert.doesNotThrow(() => resolveBundlePaths({}, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});