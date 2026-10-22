/**
 * 写库前的数值夹取：脏值不能进库。
 *
 * 2026-10-12 回归用例。真 bug（散在 5 处，口径各不相同）：
 *   - `value || 0.5` 是 falsy-zero：模型明确给 0（"完全没信心"）被吞成 0.5
 *   - Number("1e999") = Infinity 直接进 INTEGER 列，所有 sum/avg 静默变 NaN
 *   - 字符串 "abc" 进 INTEGER 列会因 affinity 保持 TEXT，下游比较全错
 *   - confidence/intensity 是 0~1 的量程，模型给 5 就该夹到 1
 *   - NOT NULL 列拿到 undefined 绑成 NULL → 整条素材/整场直播分析判 failed
 *
 * 用真实的 MemoryStore（临时库）验证，不复制一份实现 —— 复制就等于没测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { MemoryStore } from '../store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
// dbPath 在 store 里是相对 Hermes 根解析的（生产配置也用相对路径 data/hermes.db），
// 所以这里必须给相对路径 —— 给绝对路径会被拼成 <ROOT><绝对路径>。
const TMP_REL = 'data/.tmp-num-clamp-test.db';
const TMP = join(ROOT, TMP_REL);

function freshStore() {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.memory = { ...(cfg.memory || {}), dbPath: TMP_REL };
  return new MemoryStore(cfg);
}

const cleanup = (store) => {
  store.close();
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
};

const num = MemoryStore.num;

test('NaN / Infinity / "1e999" 一律落到 fallback', () => {
  assert.equal(num(NaN, { fallback: 0.5 }), 0.5);
  assert.equal(num(Infinity, { fallback: 0.5 }), 0.5);
  assert.equal(num(-Infinity, { fallback: 0.5 }), 0.5);
  assert.equal(num('1e999', { fallback: 0.5 }), 0.5);
  assert.equal(num(undefined, { fallback: null }), null);
  assert.equal(num('abc', { fallback: null }), null);
});

test('量程被夹住：负数→min，超量程→max', () => {
  assert.equal(num(-3, { min: 0, fallback: 0.5 }), 0);
  assert.equal(num(5, { min: 0, max: 1, fallback: 0.5 }), 1);
  assert.equal(num(1e12, { min: 0, max: 1e9, integer: true, fallback: null }), 1e9);
});

test('falsy-zero 不再被吞：0 就是 0', () => {
  // 这正是原来 `data.confidence || 0.5` 的 bug
  assert.equal(num(0, { min: 0, max: 1, fallback: 0.5 }), 0);
  assert.equal(num(0, { min: 0, max: 1, fallback: 0.5 }) !== 0.5, true);
});

test('integer 选项确实取整', () => {
  assert.equal(num(3.7, { integer: true, fallback: null }), 4);
  assert.equal(num(3.4, { integer: true, fallback: null }), 3);
});

test('不传 min/max 时不改变正常值', () => {
  assert.equal(num(1234.5, { fallback: null }), 1234.5);
  assert.equal(num('42', { fallback: null }), 42);
});

test('addHighlightPattern：缺时间戳不抛（NOT NULL 列有兜底）', () => {
  const store = freshStore();
  try {
    store.upsertVideo('E:/x/a.mp4', { videoName: 'a.mp4', sourceType: 'hit' });
    // 完全不给 startMs/endMs —— 以前会 NOT NULL constraint failed 抛出去
    const id = store.addHighlightPattern({ videoId: 1 });
    assert.ok(id > 0, '应写入成功而不是抛异常');
    const row = store.db.prepare('SELECT start_ms, end_ms FROM highlight_patterns WHERE id = ?').get(id);
    assert.equal(row.start_ms, 0);
    assert.equal(row.end_ms, 0);
  } finally {
    cleanup(store);
  }
});

test('addHighlightPattern：confidence=0 被保留（不再被 || 0.5 吞掉）', () => {
  const store = freshStore();
  try {
    store.upsertVideo('E:/x/a.mp4', { videoName: 'a.mp4', sourceType: 'hit' });
    const id = store.addHighlightPattern({ videoId: 1, startMs: 0, endMs: 1000, confidence: 0, intensity: 0 });
    const row = store.db.prepare('SELECT confidence, intensity FROM highlight_patterns WHERE id = ?').get(id);
    assert.equal(row.confidence, 0);
    assert.equal(row.intensity, 0);
  } finally {
    cleanup(store);
  }
});

test('upsertHitPrediction：数值列被夹住，而 confidence 是定性文本不能动', () => {
  const store = freshStore();
  try {
    store.upsertHitVideo('E:/x/b.mp4', { videoName: 'b.mp4' });
    store.upsertHitPrediction(1, { viewsLow: '1e999', viewsHigh: 'abc', confidence: '低' });
    const row = store.getHitPrediction(1);
    assert.equal(row.views_low, null, 'Infinity 不能进库');
    assert.equal(row.views_high, null, '"abc" 不能进 INTEGER 列');
    // hit_predictions.confidence 的列类型是 TEXT，线上存的是 '低'/'中'/'高'。
    // 当成 0~1 小数去夹会把真数据抹成 null —— 这条断言就是防这个的。
    assert.equal(row.confidence, '低', '定性 confidence 必须原样保留');
  } finally {
    cleanup(store);
  }
});

test('upsertHitPerformance：Infinity 计数被挡，0 被保留', () => {
  const store = freshStore();
  try {
    store.upsertHitVideo('E:/x/c.mp4', { videoName: 'c.mp4' });
    store.upsertHitPerformance(1, { views: '1e999', likes: 0, comments: -5 });
    const row = store.getHitPerformance(1);
    assert.equal(row.views, null);
    assert.equal(row.likes, 0);
    assert.equal(row.comments, 0, '负数被夹到 0');
  } finally {
    cleanup(store);
  }
});

test('getLiveSegmentsByIds：拒绝 true/null/负数（Number(true)=1 会返回别人的段）', () => {
  const store = freshStore();
  try {
    store.upsertLiveVideo('E:/x/d.mp4', { videoName: 'd.mp4' });
    const sid = store.addLiveSegment({ liveVideoId: 1, segmentIndex: 0, startMs: 0, endMs: 1000 });
    assert.equal(store.getLiveSegmentsByIds([true, null, -1, '', 'abc']).length, 0,
      '垃圾输入不应命中任何段');
    assert.equal(store.getLiveSegmentsByIds([sid]).length, 1);
    assert.equal(store.getLiveSegmentsByIds([String(sid)]).length, 1, '数字字符串仍应可用');
    assert.equal(store.getLiveSegmentsByIds([sid, sid]).length, 1, '重复 id 应去重');
  } finally {
    cleanup(store);
  }
});
