/**
 * 预筛器单元测试
 * © 2026 郭洛斌
 *
 * 预筛决定哪些块不用送 GPU。判错方向不对称:
 * 漏放一块只是慢一点(可接受),错跳一块就是丢掉爆点(不可接受)。
 *
 * 三个已踩过的坑(固化防回归):
 * 1) 真实转写是空格连接的一整行,没换行 -> 重复度必须按标点切句
 * 2) 不能按"是否命中爆款关键词"过滤 -> 实测会误杀 84% 内容(记忆词表覆盖不了口语)
 * 3) 测试样本的语速必须接近真实直播(3~5 字/秒),
 *    造得太稀疏会被"语速过低"判据正确拦下,那是测试写错,不是代码错
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveAnalyzer } from '../live-analyzer.js';

function makeAnalyzer(overrides = {}) {
  const a = Object.create(LiveAnalyzer.prototype);
  a.prescreen = true;
  a.prescreenMinChars = overrides.minChars ?? 260;
  a.prescreenMinDensity = overrides.minDensity ?? 1.6;
  return a;
}

/**
 * 造一段真实语速的转写(~4 字/秒)。
 * @param {number} segCount 段数,每段 20 秒
 * @param {(i:number)=>string} textAt 每段文本
 */
function chunkOf(segCount, textAt) {
  return Array.from({ length: segCount }, (_, i) => ({
    start: i * 20000,
    end: i * 20000 + 20000,
    text: textAt(i)
  }));
}
function toText(segCount, textAt) {
  return Array.from({ length: segCount }, (_, i) => textAt(i)).join(' ');
}

/** 真实语速的句子:约 80 字/段 = 4 字/秒 */
const dense = (i) => `第${i}个要点我们讲家庭教育的第${i}种具体情形家长应该怎么处理才有效`;
// 造一个跨度约 `sec` 秒的块（每段固定 20 秒）
const chunkSpan = (sec, textAt = () => '') => chunkOf(Math.max(1, Math.round(sec / 20)), textAt);

test('真实语速的正常讲解:必须放行', () => {
  const a = makeAnalyzer();
  const text = toText(20, dense);
  const r = a._prescreenChunk(chunkOf(20, dense), text, { themes: [] });
  assert.ok(r.density > 1.6, `样本自身应达到阈值,实际 ${r.density.toFixed(2)}`);
  assert.equal(r.keep, true, '正常内容不该被跳');
});

test('文本太少(冷场/等待):跳过', () => {
  const a = makeAnalyzer();
  const textAt = () => '嗯对';
  const text = toText(3, textAt);
  const r = a._prescreenChunk(chunkOf(3, textAt), text, { themes: [] });
  assert.equal(r.keep, false);
  assert.match(r.reason, /密度不足/);
});

test('语速过低(长时间沉默):跳过', () => {
  // 24 段 × 20 秒 = 480 秒,只有 ~240 字 -> 0.5 字/秒
  const a = makeAnalyzer();
  const sparse = (i) => `嗯${i}好`;
  const text = toText(24, sparse);
  const r = a._prescreenChunk(chunkOf(24, sparse), text, { themes: [] });
  assert.equal(r.keep, false);
  assert.match(r.reason, /语速过低|密度不足/);
});

test('循环啰嗦(同一句反复):跳过', () => {
  // 真实循环话术是带句末标点的;没有标点就切不出"句子",判重会失效——
  // 所以样本必须忠实还原转写的样子(ASR 输出带。？！)
  const a = makeAnalyzer();
  const loop = () => '刚才那个问题我们再说一遍好不好?';
  const text = toText(20, loop);
  const r = a._prescreenChunk(chunkOf(20, loop), text, { themes: [] });
  assert.equal(r.keep, false);
  assert.match(r.reason, /重复/, '应判为循环啰嗦');
});

test('内容各不相同的高密度长内容:不误杀', () => {
  const a = makeAnalyzer();
  const text = toText(24, dense);
  const r = a._prescreenChunk(chunkOf(24, dense), text, { themes: [] });
  assert.equal(r.keep, true, '非重复的高密度内容不能被误杀');
});

test('命中爆款主题关键词:放行且记录命中数', () => {
  const a = makeAnalyzer();
  const mem = { themes: [{ name: '家庭教育', keywords: ['家庭教育', '孩子'] }] };
  const text = toText(20, dense);
  const r = a._prescreenChunk(chunkOf(20, dense), text, mem);
  assert.equal(r.keep, true);
  assert.ok(r.hits >= 1, '命中数应被记录');
});

test('【回归】主题库充足但零命中也必须放行——绝不能按关键词杀内容', () => {
  // 2026-09-30 实测教训:曾按"未命中爆款关键词"过滤,43 块跳掉 33 块(84%)。
  // 记忆库词表覆盖不了真实口语,那不是省时间,是在丢爆点。
  const a = makeAnalyzer();
  const mem = {
    themes: [
      { name: 'a', keywords: ['绝不可能出现甲'] },
      { name: 'b', keywords: ['绝不可能出现乙'] },
      { name: 'c', keywords: ['绝不可能出现丙'] },
      { name: 'd', keywords: ['绝不可能出现丁'] }
    ]
  };
  // 语速要够(否则会被"语速过低"抢先拦下,测的就不是关键词判据了)
  const unrelated = (i) => `第${i}部分讲的是另一个领域的内容和爆款主题毫无关系但是内容非常充实饱满`;
  const text = toText(20, unrelated);
  const r = a._prescreenChunk(chunkOf(20, unrelated), text, mem);
  assert.ok(r.density > 1.6, `样本语速需达标,实际 ${r.density.toFixed(2)}`);
  assert.equal(r.keep, true, '零命中只是记录,绝不是跳过理由');
});

test('无记忆库:只看密度,不误杀', () => {
  const a = makeAnalyzer();
  const text = toText(20, dense);
  const r = a._prescreenChunk(chunkOf(20, dense), text, null);
  assert.equal(r.keep, true);
});

test('边界:密度刚好达标时放行', () => {
  const a = makeAnalyzer({ minDensity: 1.6, minChars: 10 });
  const text = toText(24, dense);
  const r = a._prescreenChunk(chunkOf(24, dense), text, { themes: [] });
  assert.ok(r.density >= 1.6, `密度应达标,实际 ${r.density.toFixed(2)}`);
  assert.equal(r.keep, true);
});

/*
 * 练声类教学不许被当成"循环啰嗦/语速过缓"筛掉（2026-10-06）
 * ────────────────────────────────────────────────────────────
 * 这三类内容以前整类学不进记忆库：不是学得差，是压根没被送去学。
 * 用户原话："答答答答属于练声类教学，要让记忆功能记起来"。
 *
 * 下面每条用例都刻意构造成"三条筛除规则全踩"：
 * 重复度 > 0.45、语速远低于 1.6 字/秒、字数偏少。
 * 只要 detectVocalTraining 认出来，就必须放行。
 */
test('【练声】长音"啊啊啊"反复几十遍必须放行（以前被当循环啰嗦）', () => {
  const a = makeAnalyzer();
  const text = '啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。啊啊啊。';
  const r = a._prescreenChunk(chunkSpan(600), text, { themes: [] });
  assert.equal(r.keep, true, '练声长音反复是教学内容，不该被筛掉');
  assert.equal(r.vocal, true);
});

test('【练声】慢唱 + 重复 + 字少，三条规则全踩也必须放行', () => {
  // 1000 秒里只有 ~200 字（0.2 字/秒，远低于 1.6），且几乎全是同一句
  const a = makeAnalyzer();
  const text = '我们先来练一下开声。啊啊啊。喔喔喔。啊啊啊。喔喔喔。练声很重要。';
  const r = a._prescreenChunk(chunkSpan(1000), text, { themes: [] });
  assert.equal(r.keep, true, '语速慢+重复是练声的固有形态，不能据此判死');
  assert.equal(r.vocal, true);
});

test('【练声】指令词命中即放行：跟唱、气息、五音、技巧', () => {
  const a = makeAnalyzer();
  const cases = [
    ['跟我唱一遍，这个音往上了', '跟唱指令'],
    ['气息支撑一定要找到，横膈膜往下沉', '发声要领'],
    ['我们练一下唇齿舌牙喉，这五个字', '五音练习'],
    ['接下来是音阶练习，从低到高', '技巧训练'],
  ];
  for (const [text, expect] of cases) {
    const r = a._prescreenChunk(chunkSpan(900), text + '啊啊啊。啊啊啊。啊啊啊。', { themes: [] });
    assert.equal(r.keep, true, `「${text}」应放行`);
    assert.equal(r.vocal, true, `「${text}」应识别为练声`);
    assert.match(r.reason, new RegExp(expect));
  }
});

test('【非练声】真的循环废话仍然要被筛掉（不能把闸门全开）', () => {
  // 反例：喂喂喂在吗，听到没有 —— 同样是大量重复，但没有练声信号
  const a = makeAnalyzer();
  const text = '喂喂喂。喂喂喂。在吗。在吗。听得到吗。听得到吗。喂喂喂。在吗。听得到吗。';
  const r = a._prescreenChunk(chunkSpan(300), text, { themes: [] });
  assert.equal(r.keep, false, '没有练声信号的重复废话仍应被筛掉');
});

test('【非练声】真讲解的重复口误不该被误判成练声', () => {
  const a = makeAnalyzer();
  const text = '这个位置要沉下去。我们再说一遍，这个位置要沉下去。对，记住要沉下去。';
  const r = a._prescreenChunk(chunkSpan(20), text, { themes: [] });
  assert.notEqual(r.vocal, true, '"再说一遍"在非练声语境下不该判成练声');
});
