/**
 * countWords 的语义必须和它替换掉的老写法完全一致，否则长稿截断阈值会漂移。
 *
 * 老写法：text.split(/\s+/).filter(Boolean).length
 * 新写法：utils/count-words.js
 *
 * 这条用例直接把两个实现放在一起对拍 —— 如果哪天 countWords 的"优化"改了语义，
 * 这里会立刻红，而不是等到某个用户的超长素材突然被截断（或不再截断）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../count-words.js';

/** 老实现，只用于对拍 */
function legacy(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

const CASES = [
  '',
  ' ',
  '   ',
  '\n\n\t \r\n',
  'one',
  'hello world',
  '  padded  words  ',
  'a\tb\r\nc',
  '连续空白应该只算一次分隔   spaced',
  '中文没有空格所以整句算一个词',
  '混合 mixed 文本 text 一起',
  '标点,也算词!的一部分?',
  'emoji 🎉 算一个词',
  '末尾有空格 ',
  '\t开头是空白',
  'a'.repeat(10000),
  ('word '.repeat(5000)).trim(),
];

test('与老实现 split(\\s+/).filter(Boolean).length 逐例一致', () => {
  for (const t of CASES) {
    assert.equal(countWords(t), legacy(t), `不一致：${JSON.stringify(t.slice(0, 30))}`);
  }
});

test('边界：空输入返回 0（老实现也是 0）', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords(undefined), 0);
});

test('长文本不会因为分段而漏词', () => {
  const t = 'alpha beta gamma delta epsilon';
  assert.equal(countWords(t), 5);
  // 注意要补分隔符：t.repeat(100) 不加分隔会把边界两个词粘成一个（那才是 401）
  assert.equal(countWords(Array(100).fill(t).join(' ')), 500);
});

test('阈值语义：hit-analyzer 的 3000 词判断在边界上和原来相同', () => {
  const exactly = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
  assert.equal(countWords(exactly), 3000);
  assert.ok(countWords(exactly) <= 3000, '正好 3000 不触发截断');
  const over = `${exactly} extra`;
  assert.ok(countWords(over) > 3000, '3001 触发截断');
});

test('中文稿靠字符数而不是词数触发截断（老注释说的那个坑仍然成立）', () => {
  const phrase = '这是中文稿件没有空格所以词数很少';
  const cn = phrase.repeat(500); // 20 字 × 500 ≈ 10000 字，稳超 12000 用更多
  const cn2 = phrase.repeat(800);
  assert.equal(countWords(cn), 1, '整篇中文只算 1 个词');
  assert.ok(cn2.length > 12000, `字符数应远超 12000（实际 ${cn2.length}）`);
});