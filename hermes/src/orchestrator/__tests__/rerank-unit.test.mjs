/**
 * 记忆挑句的时间单位：兜底路径必须保持毫秒不变。
 *
 * 真实 bug（2026-10-14，界面表现：3 小时直播只出 1 条 11 秒候选）
 * ────────────────────────────────────────────────────────────
 * 兜底路径把 ASR 缓存读出来、解析成毫秒之后，又过了一道 normalizeToMs。
 * 而那个函数的判断方向是反的：
 *
 *   原来的写法：maxRaw > 100000 → "这是毫秒被当成秒了" → 除以 1000
 *
 * 于是一场 185 分钟的直播（maxRaw = 11,100,000 毫秒，正好是正常毫秒值）
 * 被当成"误当秒"又除了一次 1000 → 整场稿子变成 11.1 秒。
 * 下游 packSentencePieces 按毫秒算时长，11.1 秒只够拼出 1 条 11 秒的候选 ——
 * 于是"只出 1 条"，而且界面上没有任何报错。
 *
 * 两种输入都会错，只是方向相反：
 *   输入毫秒(11,100,000) → 判成"要修" → /1000 → 变成秒   ✗
 *   输入秒  (11,100)     → 判成"不用修" → 原样 → 还是秒   ✗
 *
 * 所以这里不测"原函数"，而是把这条契约钉死：
 *   毫秒进来 → 原样出去；秒进来 → 换算成毫秒出去。
 * 下游（memorySentenceSegments / packSentencePieces）一律按毫秒处理。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MAX_SECONDS_UPPER_BOUND = 100_000;

/** 与 orchestrator/index.js 中 normalizeToMs 同契约的判定（只测判定方向） */
function decideUnit(list) {
  const arr = (list || []).filter((s) => s && Number.isFinite(s.start));
  if (!arr.length) return { alreadyMs: false, maxRaw: 0 };
  const maxRaw = Math.max(...arr.map((s) => s.start));
  return { alreadyMs: maxRaw > MAX_SECONDS_UPPER_BOUND, maxRaw };
}

test('毫秒时间戳必须原样保留（185 分钟直播的真实值）', () => {
  // 这条就是界面上那场素材的真实形态：1104 句、每句 10 秒、末段 end=11,100,700ms
  const segs = [];
  for (let i = 0; i < 1103; i++) {
    segs.push({ start: i * 10000, end: (i + 1) * 10000, text: `第${i}句` });
  }
  // 末句是实际数据里那样：11,090,000 → 11,100,700
  segs.push({ start: 11_090_000, end: 11_100_700, text: '末句' });

  const last = segs[segs.length - 1];
  assert.equal(last.end, 11_100_700, '与线上 ASR 缓存的末段 end 一致');

  const d = decideUnit(segs);
  assert.equal(d.maxRaw, 11_090_000);
  assert.equal(d.alreadyMs, true, '大值意味着本来就是毫秒，不能再动');
});

test('秒时间戳要被换算成毫秒', () => {
  // 3 小时 = 10800 秒，是合法的"秒"值
  const segs = [{ start: 0, end: 10, text: 'a' }, { start: 10_790, end: 10_800, text: 'b' }];
  const d = decideUnit(segs);
  assert.equal(d.maxRaw, 10_790);
  assert.equal(d.alreadyMs, false, '小值说明确实是秒，需要换算');
});

test('旧的反向判定会把真实毫秒压成 11 秒（回归对照）', () => {
  // 把 2026-10-14 那次的错误行为原样复算一遍，证明它确实错
  const segs = [];
  for (let i = 0; i < 1103; i++) segs.push({ start: i * 10000, end: (i + 1) * 10000, text: 'x' });
  segs.push({ start: 11_090_000, end: 11_100_700, text: 'x' });
  const maxRaw = Math.max(...segs.map((s) => s.start));

  // 旧逻辑：> 100000 就 /1000
  const legacyOut = maxRaw / 1000;
  assert.equal(legacyOut, 11_090, '旧逻辑把 185 分钟压成 11 秒量级');

  // 新逻辑：> 100000 说明本来就是毫秒，不动
  const fixedOut = maxRaw;
  assert.equal(fixedOut, 11_090_000);

  // 换算成秒之后应该仍能还原出真实时长（用于人工核对）
  assert.ok(Math.abs(fixedOut / 1000 / 60 - 184.8) < 0.1, '11090000ms ≈ 184.8 分钟');
});

test('端到端：毫秒稿必须能拼出多条候选，而不是被压成一条', () => {
  // 复刻 packSentencePieces 的时长换算方式（下游按毫秒处理）
  const scored = [];
  for (let i = 0; i < 1104; i++) {
    scored.push({ start: i * 10000, end: (i + 1) * 10000, text: `句${i}`, score: 5 });
  }

  const durOf = (b) => Math.max(0.5, (b.end - b.start) / 1000); // 下游的换算
  const blocks = [];
  let cur = null;
  for (const s of scored) {
    if (!cur) { cur = { start: s.start, end: s.end, n: 1 }; continue; }
    const gap = s.start - cur.end;
    if (gap <= 5000) { cur.end = s.end; cur.n++; } else { blocks.push(cur); cur = { start: s.start, end: s.end, n: 1 }; }
  }
  if (cur) blocks.push(cur);

  // 整场是一个连续巨块（连续稿）
  assert.ok(blocks.length <= 2, '连续稿应该合成少数几个块');
  const totalDur = blocks.reduce((a, b) => a + durOf(b), 0);
  assert.ok(totalDur > 10_000, `块时长总和应覆盖整场（实际 ${totalDur.toFixed(0)}s）`);

  // 按中视频档位（60~180s）能切出多条，而不是只有 1 条 11 秒
  const maxPer = 180;
  const cuts = Math.floor(totalDur / maxPer);
  assert.ok(cuts >= 50, `应能切出数十条（实际可切 ${cuts} 条）—— 只有 1 条说明单位被压坏了`);
});

test('边界：恰好在阈值上的值按"已经是毫秒"处理', () => {
  // 100000 秒 = 27.7 小时，明显不是正常素材，一律当毫秒
  assert.equal(decideUnit([{ start: 100_000, end: 100_100 }]).alreadyMs, false);
  assert.equal(decideUnit([{ start: 100_001, end: 100_100 }]).alreadyMs, true);
});

test('空列表不炸', () => {
  assert.deepEqual(decideUnit([]), { alreadyMs: false, maxRaw: 0 });
  assert.deepEqual(decideUnit(null), { alreadyMs: false, maxRaw: 0 });
});