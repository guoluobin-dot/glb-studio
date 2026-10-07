import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeThemeName,
  loadThemeTaxonomy,
  themeTaxonomyHint,
  explainThemeMatch,
  TAXONOMY_PATH,
} from '../theme-taxonomy.js';

const analyzer = readFileSync(new URL('../hit-analyzer.js', import.meta.url), 'utf8');

/*
 * 主题词表回归
 *
 * 问题：提示词让模型自由命名主题，16 条素材产出 47 个主题，全是同义变体 ——
 * 「高音技巧教学」/「高音定位训练」/「高音位置衔接」其实是一类。
 * 样本最多的主题只有 3 个，面板上显示成一堆几乎不重复的词，匹配也命不中。
 *
 * 归一逻辑的测试全部**直接跑函数**、断言返回值。
 * 早先这里是对 hit-analyzer.js 做源码正则匹配，结果归一实现搬到
 * theme-taxonomy.js 之后测试集体失效却没人发现 —— 源码文本匹配测不出
 * 行为错误：函数删了、改名了、正则写宽了，测试都照样绿。
 */

/* ── 词表本身 ── */

test('主题词表文件必须存在且结构正确', () => {
  assert.ok(existsSync(TAXONOMY_PATH), `词表必须在 data/theme-taxonomy.json，实际找 ${TAXONOMY_PATH}`);
  const j = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf-8'));
  assert.ok(Array.isArray(j.categories), '必须有 categories 数组');
  assert.ok(j.categories.length >= 10, `分类太少（${j.categories.length}），聚不起来`);
  for (const c of j.categories) {
    assert.ok(c.name, '每个分类要有 name');
    assert.ok(c.hint, `${c.name} 缺 hint（提示词里要用它说明这个分类管什么）`);
    assert.ok(Array.isArray(c.keywords) && c.keywords.length >= 3,
      `${c.name} 召回词太少，匹配不上`);
  }
});

test('分类名不能重复（重复会让归一变得不确定）', () => {
  const names = loadThemeTaxonomy().map((c) => c.name);
  assert.equal(new Set(names).size, names.length, `有重复分类名: ${names.join(', ')}`);
});

/* ── 提示词接入 ── */

test('提示词必须真的注入了词表', () => {
  const hint = themeTaxonomyHint();
  assert.match(hint, /THEME TAXONOMY/, '提示词里要出现词表说明');
  assert.match(hint, /只能.*从下面这 \d+ 个分类里选/, '要说清只能从词表里选');
  const cats = loadThemeTaxonomy();
  for (const c of cats) {
    assert.ok(hint.includes(c.name), `提示词里必须列出分类「${c.name}」`);
  }
});

test('themeTaxonomyHint() 必须拼进 SYSTEM_PROMPT，不能定义完就没人调', () => {
  assert.match(
    analyzer,
    /All text can be in Chinese or the language of the transcript\$\{themeTaxonomyHint\(\)\}/
  );
});

test('JSON 结构说明里也要写"只能从词表选"', () => {
  // 光在末尾追加说明不够：模型主要看前面的 schema 描述
  assert.match(analyzer, /"theme_name":\s*"从下方 THEME TAXONOMY 里选一个分类名/);
});

test('写库前必须有归一兜底（本地 8B 不一定听话）', () => {
  assert.match(analyzer, /themeName:\s*normalizeThemeName\(/,
    'addHitTheme 必须用归一后的名字，不能用模型原始输出');
});

test('归一逻辑和历史迁移脚本必须共用同一份实现', () => {
  // 两处各写一遍归一逻辑，过几个月必然漂移：迁移按旧规则跑、运行按新规则判，
  // 同一个主题名在两处得到不同分类，而且没人会发现
  assert.match(analyzer, /import \{[^}]*normalizeThemeName[^}]*\} from '\.\/theme-taxonomy\.js'/,
    'hit-analyzer 必须从 theme-taxonomy.js 引入归一，不能自己再写一份');
});

/* ── 归一行为：以下全部断言真实返回值 ── */

test('已经是标准分类名的主题必须原样返回（幂等）', () => {
  for (const c of loadThemeTaxonomy()) {
    assert.equal(normalizeThemeName(c.name, []), c.name, `「${c.name}」归一后不该变`);
  }
});

test('同义变体必须收敛到同一个分类', () => {
  const cases = [
    [['高音技巧教学'], '高音突破'],
    [['高音定位法'], '高音突破'],
    [['高音位置衔接'], '高音突破'],
    [['气息训练'], '气息与腹式呼吸'],
    [['共鸣腔体的使用'], '共鸣与腔体'],
  ];
  for (const [[name], want] of cases) {
    assert.equal(normalizeThemeName(name, []), want, `「${name}」应该归到「${want}」`);
  }
});

test('实打实的专有说法必须压过主题名里的两字泛词', () => {
  // 回归：早先等权计分时，「纠正」「方法」这两个泛词各拿满分，
  // 把 keywords 里的「压喉」盖住了 —— 「发音方法纠正」被判给了错误分类。
  // 分类关键词有多具体，不代表主题名有多具体。
  assert.equal(
    normalizeThemeName('发音方法纠正', ['压喉', '鼻哼', '喉音']),
    '发声位置与喉咙',
    '「压喉」是指名道姓的证据，不该被主题名里的泛词压掉'
  );
});

test('keywords 里的实词要能定分类（主题名没信息时靠它）', () => {
  assert.equal(normalizeThemeName('歌唱技巧教学', ['声音位置', '音色变化']), '发声位置与喉咙');
  assert.equal(normalizeThemeName('歌唱技巧与共鸣', ['共鸣', '哼鸣', '鼻咽腔']), '共鸣与腔体');
});

test('咬得太紧分不清时必须保留原名，不能硬塞', () => {
  // 「吸气」和「腔体」各 2 分打平 —— 这条素材的主题真的两可，
  // 赌一个错分类会污染那一整类样本，比留个野生主题坏得多
  const got = normalizeThemeName('唱歌技巧教学', ['吸气', '腔体', '保持', '发力']);
  assert.equal(got, '唱歌技巧教学', '打平时必须原样返回');

  // 完全无关的主题名和 keywords：一点证据都没有
  assert.equal(normalizeThemeName('完全无关的东西', ['xyzzy']), '完全无关的东西');
});

test('归一只认词表里的分类，不能凭空造一个', () => {
  const std = new Set(loadThemeTaxonomy().map((c) => c.name));
  const samples = [
    ['高音技巧教学', ['高音', '鼻孔发力']],
    ['共鸣腔体的使用', ['共鸣腔体', '鼻咽腔']],
    ['互动教学与练习', ['跟练', '留言']],
    ['课程推广与销售', ['课程', '二维码']],
  ];
  for (const [name, kws] of samples) {
    const got = normalizeThemeName(name, kws);
    if (got !== name) {
      assert.ok(std.has(got), `「${name}」被归成了词表外的「${got}」`);
    }
  }
});

test('空输入和脏输入不能抛异常', () => {
  assert.doesNotThrow(() => normalizeThemeName('', []));
  assert.doesNotThrow(() => normalizeThemeName(null, []));
  assert.doesNotThrow(() => normalizeThemeName('高音', null));
  assert.doesNotThrow(() => normalizeThemeName('高音', undefined));
  assert.doesNotThrow(() => normalizeThemeName('高音', '不是数组'));
  assert.doesNotThrow(() => normalizeThemeName(undefined, [null, undefined, '']));
});

test('keywords 里的空项不能加分（否则空串会命中一切）', () => {
  // '' 会被 every substring 判断命中，如果不做过滤，
  // 一个空 keywords 就能让每个分类都拿到分数，归一结果纯随机
  const got = normalizeThemeName('高音技巧教学', ['', null, undefined]);
  assert.equal(got, '高音突破', '空项必须被过滤掉，结果应只由主题名决定');
});

test('归一必须可解释：要能说出判给谁、凭什么、领先多少', () => {
  const r = explainThemeMatch('发音方法纠正', ['压喉', '鼻哼', '喉音']);
  assert.equal(r.hit, '发声位置与喉咙');
  assert.equal(r.margin, 2, '领先次优 2 分（压喉 4 减去「纠正」的 2）');
  const top = r.scored[0];
  assert.equal(top.category, '发声位置与喉咙');
  assert.ok(top.reasons.some((x) => x.includes('压喉')), '必须指出是哪条证据');

  // 打平的要说清是打平，不是"没证据"
  const tie = explainThemeMatch('唱歌技巧教学', ['吸气', '腔体']);
  assert.equal(tie.hit, '唱歌技巧教学');
  assert.equal(tie.margin, 0);

  // 一点证据都没有
  const none = explainThemeMatch('完全无关', ['xyzzy']);
  assert.deepEqual(none.scored, []);
});

test('explore 出来的得分必须和实际归一结果一致（两者共用同一份实现）', () => {
  const names = loadThemeTaxonomy().map((c) => c.name);
  for (const c of loadThemeTaxonomy()) {
    const r = explainThemeMatch(c.name, ['高音', '共鸣']);
    assert.equal(r.hit, c.name);
    // 标准名直接短路，不该被 keywords 带偏
    assert.ok(names.includes(normalizeThemeName(c.name, ['高音', '共鸣'])));
  }
});

/* ── 降级 ── */

test('词表读失败时退回自由命名，不能让分析整个失败', () => {
  // 通过参数注入坏路径来测真正的降级行为，而不是对源码做正则匹配
  assert.equal(loadThemeTaxonomy(join(process.cwd(), '不存在的词表.json')), null);
});