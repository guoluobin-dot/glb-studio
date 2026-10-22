/**
 * purgeOrphanHits 的三个语义（2026-10-12）。
 *
 * 真 bug：孤儿清理**不按文件夹隔离**。
 * 原来一条 SELECT 全库扫，任何文件夹的素材被移走/换盘，
 * 另一个文件夹的正常记录也会被判成孤儿删掉 —— 而且没有任何提示。
 * 用户视角就是"我什么都没干，别的文件夹的记录自己消失了"。
 *
 * 另外原来对每行同步 existsSync，几百条素材就是几百次阻塞 syscall，
 * 而这个接口是看板按钮 + 调度器每天一次都会调的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const REL = 'data/.tmp-purge-orphan-test.db';
const TMP = join(ROOT, REL);
const MEDIA = join(ROOT, 'data', '.tmp-purge-orphan-media');
const cleanup = () => {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
  rmSync(MEDIA, { recursive: true, force: true });
};

function makeStore() {
  cleanup();
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.memory = { ...(cfg.memory || {}), dbPath: REL };
  return new MemoryStore(cfg);
}

/**
 * 建一条素材记录并决定文件是否真的落盘。
 *
 * 注意：collection 不是 upsertHitVideo 写的（那个函数的 INSERT/ON CONFLICT 里
 * 根本没有 collection 列），归属是事后用 setHitCollection 打的 ——
 * 所以新素材入库时 collection 是 NULL，也就是"通用"。
 */
function addHit(store, { file, onDisk, collection }) {
  if (onDisk) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'x');
  }
  store.upsertHitVideo(file, { videoName: file, analysisStatus: 'completed' });
  if (collection) {
    const row = store.db.prepare('SELECT id, collection FROM hit_videos WHERE video_path = ?')
      .get(file.replace(/\\/g, '/'));
    store.setHitCollection([row.id], collection);
  }
}

test('只清指定文件夹，别的文件夹的记录不动', async () => {
  const store = makeStore();
  try {
    const gone = join(MEDIA, 'A', 'lost.mp4');
    const kept = join(MEDIA, 'B', 'kept.mp4');
    // 两个文件夹各一条，A 的文件不在了，B 的在
    addHit(store, { file: gone, onDisk: false, collection: 'A' });
    addHit(store, { file: kept, onDisk: true, collection: 'B' });

    const r = await store.purgeOrphanHits('A');
    assert.equal(r.deleted, 1, 'A 的孤儿应被清掉');
    assert.equal(
      store.db.prepare("SELECT COUNT(*) c FROM hit_videos WHERE collection='B'").get().c, 1,
      'B 的记录必须还在 —— 跨文件夹误删就是这条要拦的'
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) c FROM hit_videos WHERE collection='A'").get().c, 0
    );
  } finally {
    store.close();
    cleanup();
  }
});

test('通用（未归类）素材的孤儿会被清掉：它在每个文件夹下都可见', async () => {
  const store = makeStore();
  try {
    store.activeCollection = 'A';
    // 没打 collection → 通用
    const f = join(MEDIA, 'A', 'general.mp4');
    addHit(store, { file: f, onDisk: false });
    assert.equal(
      store.db.prepare('SELECT collection FROM hit_videos').get().collection, null,
      '前置条件：新素材入库时归属是 NULL（通用）'
    );
    const r = await store.purgeOrphanHits();
    assert.equal(r.deleted, 1, '通用素材文件没了就该清掉，不能因为"不属于某文件夹"而永远留着');
  } finally {
    store.close();
    cleanup();
  }
});

test('省略 collection 时只清当前活跃文件夹，不跨文件夹', async () => {
  const store = makeStore();
  try {
    store.activeCollection = 'A';
    const goneA = join(MEDIA, 'A', 'lost.mp4');
    const goneB = join(MEDIA, 'B', 'alsoLost.mp4');
    addHit(store, { file: goneA, onDisk: false, collection: 'A' });
    addHit(store, { file: goneB, onDisk: false, collection: 'B' });

    const r = await store.purgeOrphanHits();
    assert.equal(r.deleted, 1, '只应清 A 那条');
    assert.equal(
      store.db.prepare("SELECT COUNT(*) c FROM hit_videos WHERE collection='B'").get().c, 1,
      'B 的孤儿不该在这次被清掉（它属于另一个文件夹）'
    );
  } finally {
    store.close();
    cleanup();
  }
});

test('正在分析的记录不会被当成孤儿删掉', async () => {
  const store = makeStore();
  try {
    // 分析中的记录文件"不在"很正常（可能正在下载/移动）
    store.activeCollection = 'A';
    const f = join(MEDIA, 'A', 'processing.mp4');
    addHit(store, { file: f, onDisk: false, collection: 'A' });
    store.db.prepare("UPDATE hit_videos SET analysis_status='analyzing' WHERE video_path=?")
      .run(f.replace(/\\/g, '/')); // 必须转成正斜杠：upsertHitVideo 存的是归一化后的路径

    const r = await store.purgeOrphanHits();
    assert.equal(r.deleted, 0, 'analyzing 的记录必须留着');
    assert.equal(store.db.prepare('SELECT COUNT(*) c FROM hit_videos').get().c, 1);
  } finally {
    store.close();
    cleanup();
  }
});

test('整个目录消失时，目录内全部记录都算孤儿（一次 stat 判整组）', async () => {
  const store = makeStore();
  try {
    store.activeCollection = 'A';
    const dir = join(MEDIA, 'A', 'batch1');
    // 登记 5 条，然后连目录一起删掉（模拟换盘/整体移动）
    for (let i = 0; i < 5; i++) addHit(store, { file: join(dir, `v${i}.mp4`), onDisk: true, collection: 'A' });
    rmSync(join(MEDIA, 'A'), { recursive: true, force: true });

    const r = await store.purgeOrphanHits();
    assert.equal(r.deleted, 5, '目录没了，里面 5 条都该清掉');
    assert.equal(store.db.prepare('SELECT COUNT(*) c FROM hit_videos').get().c, 0);
  } finally {
    store.close();
    cleanup();
  }
});

test('文件都在时什么都不删，返回值里带上 scanned 便于观测', async () => {
  const store = makeStore();
  try {
    store.activeCollection = 'A';
    for (let i = 0; i < 3; i++) {
      addHit(store, { file: join(MEDIA, 'A', `ok${i}.mp4`), onDisk: true, collection: 'A' });
    }
    const r = await store.purgeOrphanHits();
    assert.equal(r.deleted, 0);
    assert.equal(r.found, 0);
    assert.equal(r.scanned, 3, 'scanned 应反映实际 stat 过的文件数');
  } finally {
    store.close();
    cleanup();
  }
});