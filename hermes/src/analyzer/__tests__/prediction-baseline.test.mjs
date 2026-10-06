/**
 * 爆款预测基准的隔离性测试
 *
 * 守的是一条产品决定：**基准只看这位老师自己的数据，绝不混别人。**
 *
 * 以前 getPerformanceBaseline 只按 genre(题材) 过滤、完全不看 collection，
 * 于是案例老师的爆款感标准会被其他老师的同题材数据稀释 ——
 * 而"这位老师自己的爆款感"正是这个功能存在的理由。
 * 更糟的是它不报错：样本少的时候掺进别人的数据，看起来有参照，
 * 其实参照的是别人的标准，会系统性地把预测带偏。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { MemoryStore } from '../../memory/store.js';

/*
 * dbPath 必须给**相对路径**（相对 Hermes 根目录）。
 * MemoryStore 内部是 join(root, dbPath)，传绝对路径会拼成
 * "<GLB_ROOT>/Hermes\C:\Users\...\xxx" 这种废路径，mkdir 直接 ENOENT。
 */
const dbPath = 'data/hermes-test-baseline.db';
const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
cfg.memory = { ...cfg.memory, dbPath };
const store = new MemoryStore(cfg);

function seed(collection, genre, views, platform = 'douyin') {
  const id = store.upsertHitVideo(`/tmp/${collection}-${views}-${Math.random().toString(36).slice(2, 7)}.mp4`, {
    videoName: 'x.mp4',
    analysisStatus: 'completed'
  });
  /*
   * upsertHitVideo 返回的是**裸 id**（store.js:915 `return row?.id`），不是整行对象。
   * 之前这里当对象用，于是 setHitCollection([undefined]) 和
   * upsertHitPerformance(undefined) 全都静默失败 ——
   * 而表现是"基准算出来是 null"，看着像隔离逻辑写错了。
   */
  assert.ok(Number.isInteger(id), `upsertHitVideo 必须返回 id，实际 ${JSON.stringify(id)}`);
  store.setHitCollection([id], collection);
  if (genre) store.db.prepare('UPDATE hit_videos SET genre = ? WHERE id = ?').run(genre, id);
  const perf = store.upsertHitPerformance(id, { views, likes: 100, comments: 10, shares: 20, favorites: 30, platform, source: 'manual' });
  assert.ok(perf && perf.views === views, '真实数据必须真的写进 hit_performance');
  return id;
}

test('指定 IP 时只用这位老师自己的数据', () => {
  seed('案例老师', '唱歌', 50000);
  seed('王老师', '唱歌', 900000);   // 同题材，但别人的数据，差 18 倍
  const b = store.getPerformanceBaseline('唱歌', 'douyin', '案例老师');
  assert.equal(b?.views, 50000, '必须只取案例老师自己的中位数');
  assert.equal(b?.scopedTo, '案例老师');
});

test('绝不混入其他老师的数据（这是本次改动的核心）', () => {
  seed('李老师', '唱歌', 50000);
  seed('张老师', '唱歌', 5000000);
  const b = store.getPerformanceBaseline('唱歌', 'douyin', '李老师');
  // 混算的话这里会是几百万量级
  assert.ok(b.views < 100000, `不该被别人的数据带偏，实际 ${b.views}`);
  assert.equal(b.count, 1);
});

test('该 IP 没有任何真实数据时返回 null，而不是拿别人的凑', () => {
  seed('赵老师', '唱歌', 777777);
  const b = store.getPerformanceBaseline('唱歌', 'douyin', '没有数据的老师');
  assert.equal(b, null, '没有就是没有，不许兜底到全库');
});

test('指定 IP 时同平台优先，仍只在该 IP 内', () => {
  seed('案例老师', '唱歌', 111111, 'douyin');
  seed('案例老师', '唱歌', 222222, 'xiaohongshu');
  seed('王老师', '唱歌', 888888, 'douyin');
  const b = store.getPerformanceBaseline('唱歌', 'douyin', '案例老师');
  assert.equal(b.views, 111111);
  assert.equal(b.platform, 'douyin');
  // 平台没有就退回该 IP 的全平台，仍不越界
  const b2 = store.getPerformanceBaseline('唱歌', 'kuaishou', '案例老师');
  assert.equal(b2.platform, null);
  assert.ok(b2.views === 111111 || b2.views === 222222, '只能取到案例老师自己的数');
});

test('不指定 IP 时保持原来的题材口径（通用素材不能没有基准）', () => {
  seed('通用甲', '唱歌', 5000);
  const b = store.getPerformanceBaseline('唱歌', null, null);
  assert.ok(b && b.views > 0, '通用素材仍按题材算');
  assert.equal(b.scopedTo, null);
});

test('collection 传 null 和不传行为一致（都走题材口径）', () => {
  seed('通用乙', '唱歌', 6000);
  assert.deepEqual(
    store.getPerformanceBaseline('唱歌', null, null),
    store.getPerformanceBaseline('唱歌', null)
  );
});

test.after(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(process.cwd(), 'data', `hermes-test-baseline.db${suffix}`), { force: true });
  }
});