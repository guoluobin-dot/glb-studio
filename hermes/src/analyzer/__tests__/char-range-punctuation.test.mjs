/**
 * 标点权重：必须与分母同量纲
 *
 * 原来的 bug：分子给标点 0.25 分，分母 spoken 却把标点**完全排除**。
 * 只要句里有标点，w2/spoken > 1，选整句时
 * en = 句首 + span*(>1) 就越过句子结尾，吃掉下一句的开头
 * （实测 882ms），而用户只选了这一句。
 *
 * 这条必须用**真实数值**验证，不能只读源码 ——
 * 因为它是个数学错误，读代码看不出 0.25/排除 这个组合是错的。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { charRangeToTime } from '../editable-text.js';

/*
 * from/to 是**字符偏移**，必须和 text 的真实长度对齐。
 * 手写汉字长度几乎必错（我第一版就把 10 个字写成 from 0..to 27），
 * 而 charRangeToTime 会据此判断"选区是否落在某句内"——
 * 越界就返回 null，测试会以"必须能算出时间"失败，看着像代码坏了。
 * 所以这里用展开运算符自动算偏移。
 */
const TEXTS = [
  { text: '第一句没有标点纯文字', startMs: 0, endMs: 10_000 },
  { text: '好，同学们注意了啊，今天我们讲三个要点', startMs: 20_000, endMs: 50_000 },
  { text: '第三句用来验证越界', startMs: 50_000, endMs: 70_000 }
];
let cursor = 0;
const SENTS = TEXTS.map((t) => {
  const from = cursor;
  cursor += t.text.length;
  return { from, to: cursor, ...t };
});
const FULL = TEXTS.map((t) => t.text).join('');

test('选整句不能越过这句的结尾', () => {
  // 第二句全文 30s（20000→50000），含多个标点
  const r = charRangeToTime(SENTS, FULL, SENTS[1].from, SENTS[1].to, 0);
  assert.ok(r, '必须算出结果');
  assert.ok(
    r.en <= 50_000,
    `删字范围不得越过句子结尾（句尾 50000），实际 ${r.en}`
  );
  // 而且不能小于句首
  assert.ok(r.st >= 20_000, `不得早于句首，实际 ${r.st}`);
});

test('"选整句 = 整句"这条不变量对每个句子都成立', () => {
  for (const s of SENTS) {
    const r = charRangeToTime(SENTS, FULL, s.from, s.to, 0);
    assert.ok(r, `句子「${s.text.slice(0, 6)}…」必须能算出时间`);
    assert.ok(
      r.en <= s.endMs,
      `句「${s.text.slice(0, 6)}…」越界：算出 ${r.en} > 句尾 ${s.endMs}`
    );
    assert.ok(r.st >= s.startMs, `句「${s.text.slice(0, 6)}…」早于句首`);
  }
});

test('纯标点句不能让比例爆掉', () => {
  /*
   * 退化情形：整句只有标点时，有声字数是 0。
   * 以前 spoken = max(1, 0) = 1，而分子给 6 个标点各 0.25 = 1.5
   * → 10 秒的句子算出 15 秒的删除量。
   */
  const punct = [{ from: 0, to: 6, text: '，。！？、；：', startMs: 0, endMs: 10_000 }];
  const r = charRangeToTime(punct, '，。！？、；：', 0, 6, 0);
  assert.ok(r, '必须能算出结果而不是崩');
  assert.ok(r.en <= 10_000, `不得越过句尾 10000，实际 ${r.en}`);
  assert.ok(r.st >= 0);
});

test('选句首若干字应落在句首附近（比例不能整体偏移）', () => {
  // 第二句前 6 个字（含 1 个逗号）
  const r = charRangeToTime(SENTS, FULL, SENTS[1].from, SENTS[1].from + 6, 0);
  assert.ok(r, '必须算出结果');
  // 前 6/30 字 ≈ 句子的前 20%，容差放宽到 35% 以吸收标点权重
  assert.ok(
    r.en > 20_000 && r.en < 20_000 + 30_000 * 0.35,
    `句首 6 字应落在句首附近，实际落在 ${r.en}（句 20000~50000）`
  );
});

test('非法区间仍返回 null（不能因为修了权重就放松校验）', () => {
  assert.equal(charRangeToTime(SENTS, FULL, SENTS[1].to, SENTS[1].from, 0), null, '倒序');
  assert.equal(charRangeToTime(SENTS, FULL, SENTS[1].from, SENTS[1].from, 0), null, '空区间');
});
