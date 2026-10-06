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
  const a = makeAnalyzer();
  // 24 段 × 20 秒 = 480 秒,只有 ~240 字 -> 0.5 字/秒
  const sparse = (i) => `嗯${i}好`;
  const text = toText(24, sparse);
  const r = a._prescreenChunk(chunkOf(24, sparse), text, { themes: [] });
  assert.equal(r.keep, false);
  assert.match(r.reason, /语速过低|密度不足/);
});

test('循环啰嗦(同一句反复):跳过', () => {
  const a = makeAnalyzer();
  // 真实循环话术是带句末标点的;没有标点就切不出"句子",判重会失效——
  // 所以样本必须忠实还原转写的样子(ASR 输出带。？！)
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
