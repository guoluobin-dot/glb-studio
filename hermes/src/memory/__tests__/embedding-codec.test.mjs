/**
 * 向量存取的对齐/类型安全（2026-10-12）。
 *
 * 真 bug：写和读各写一份实现，两份都脆。
 *
 *   写 Buffer.from(new Float32Array(x).buffer)
 *     x 是 Buffer 时，`new Float32Array(buf)` 按**数组**迭代它 → 逐字节当元素，
 *     3 维向量存成 12 维字节垃圾。
 *
 *   读 new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
 *     byteOffset 非 4 倍数 → "start offset of Float32Array should be a multiple of 4" 直接抛；
 *     长度非 4 倍数 → 取整，静默丢尾部。
 *
 * 后果都是相似度检索静默失准 —— 命中错的话术比查不到更糟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const REL = 'data/.tmp-embedding-test.db';
const TMP = join(ROOT, REL);
const cleanup = () => { for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true }); };

function makeStore() {
  cleanup();
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.memory = { ...(cfg.memory || {}), dbPath: REL };
  const s = new MemoryStore(cfg);
  s.similarityThreshold = -2; // 默认阈值会滤掉相似度低的用例，这里只要排序
  return s;
}

/** 走真实写库/读库路径，避免"测了一份副本实现" */
function roundTrip(store, embedding) {
  const id = store.addCopywritingPattern({
    patternType: 'hook', textContent: 'x', text: 'x', embedding,
  });
  return store.db.prepare('SELECT embedding FROM copywriting_patterns WHERE id = ?').get(id).embedding;
}

test('number[] 原样往返', () => {
  const store = makeStore();
  try {
    const buf = roundTrip(store, [0.25, -0.5, 0.75]);
    assert.equal(buf.length, 12, '3 个 float32 = 12 字节');
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    assert.deepEqual(back, [0.25, -0.5, 0.75]);
  } finally { store.close(); cleanup(); }
});

test('传 Buffer 不会被当成"数组的字节"（原来会存成 12 维垃圾）', () => {
  const store = makeStore();
  try {
    const original = [0.1, 0.2, 0.3];
    const asBuf = Buffer.from(new Float32Array(original).buffer);
    const buf = roundTrip(store, asBuf);
    assert.equal(buf.length, 12, '应仍是 3 维（12 字节），不是 12 维（48 字节）');
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    // 比 float32 精度：0.1 在 float32 里存不下，误差是固有的，不算 bug
    const expected = Array.from(new Float32Array(original));
    assert.equal(back.length, 3);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - expected[i]) < 1e-6);
  } finally { store.close(); cleanup(); }
});

test('传 Float32Array 能正确往返', () => {
  const store = makeStore();
  try {
    const buf = roundTrip(store, Float32Array.from([1.5, 2.5]));
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    assert.deepEqual(back, [1.5, 2.5]);
  } finally { store.close(); cleanup(); }
});

test('NaN / Infinity 不会进库（会让所有余弦相似度变成 NaN）', () => {
  const store = makeStore();
  try {
    const buf = roundTrip(store, [NaN, Infinity, -Infinity, 1]);
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    for (const v of back) assert.ok(Number.isFinite(v), `不该出现非有限值：${v}`);
    assert.equal(back[3], 1, '正常值要原样保留');
  } finally { store.close(); cleanup(); }
});

test('写入的字节一定是 4 的倍数且 byteOffset 为 0（读回来不会踩对齐）', () => {
  const store = makeStore();
  try {
    for (const v of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4, 5, 6, 7]]) {
      const buf = roundTrip(store, v);
      assert.equal(buf.length % 4, 0, `长度 ${buf.length} 不是 4 的倍数`);
      assert.equal(buf.byteOffset, 0, `byteOffset ${buf.byteOffset} 应为 0`);
      // 关键：不抛 RangeError
      assert.doesNotThrow(() => new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    }
  } finally { store.close(); cleanup(); }
});

test('无法解释的输入返回 null 而不是写坏数据', () => {
  const store = makeStore();
  try {
    assert.equal(roundTrip(store, null), null);
    assert.equal(roundTrip(store, undefined), null);
    assert.equal(roundTrip(store, []), null);
    assert.equal(roundTrip(store, 'abc'), null);
    assert.equal(roundTrip(store, 123), null);
    // 字节数不是 4 的倍数的 Buffer：拒绝，而不是读出垃圾
    assert.equal(roundTrip(store, Buffer.from([1, 2, 3, 4, 5])), null);
  } finally { store.close(); cleanup(); }
});

test('searchSimilarCopywriting 对齐异常的旧数据会跳过而不是整体崩掉', () => {
  const store = makeStore();
  try {
    store.addCopywritingPattern({ patternType: 'hook', textContent: 'good', embedding: [1, 0, 0] });
    // 人为塞一条"字节数不是 4 的倍数"的脏数据（老库/外部导入可能就有）
    const id = store.addCopywritingPattern({ patternType: 'hook', textContent: 'bad', embedding: [0, 1, 0] });
    store.db.prepare('UPDATE copywriting_patterns SET embedding = ? WHERE id = ?')
      .run(Buffer.from([1, 2, 3, 4, 5]), id);

    // 以前这里会抛 RangeError，整个检索 500 /api 报错
    const r = store.searchSimilarCopywriting([1, 0, 0], 5);
    assert.ok(Array.isArray(r), '应正常返回数组而不是抛异常');
    assert.ok(r.some((x) => x.row.text_content === 'good'), '正常那条要能被检索到');
  } finally { store.close(); cleanup(); }
});

test('检索排序仍然正确（写入路径的改动没破坏语义）', () => {
  const store = makeStore();
  try {
    store.addCopywritingPattern({ patternType: 'hook', textContent: 'same', embedding: [1, 0, 0] });
    store.addCopywritingPattern({ patternType: 'hook', textContent: 'orth', embedding: [0, 1, 0] });
    const r = store.searchSimilarCopywriting([1, 0, 0], 5);
    assert.equal(r[0].row.text_content, 'same', '完全同向的应排第一');
    assert.ok(r[0].similarity > r[1].similarity);
    assert.ok(Math.abs(r[0].similarity - 1) < 1e-6, '相似度应约为 1');
  } finally { store.close(); cleanup(); }
});

test('speaker_profiles 走同一套编解码', () => {
  const store = makeStore();
  try {
    store.upsertSpeaker({ speakerLabel: 'S1', embedding: [0.5, 0.25] });
    const buf = store.db.prepare("SELECT embedding FROM speaker_profiles WHERE speaker_label='S1'").get().embedding;
    assert.equal(buf.length, 8);
    const back = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    assert.deepEqual(back, [0.5, 0.25]);
  } finally { store.close(); cleanup(); }
});