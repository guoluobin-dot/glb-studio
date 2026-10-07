import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../', import.meta.url);
const TAX_PATH = join(ROOT.pathname.replace(/^\//, ''), 'data', 'theme-taxonomy.json');
const analyzer = readFileSync(new URL('../hit-analyzer.js', import.meta.url), 'utf8');

/*
 * 主题词表回归（2026-10-06 加）
 *
 * 问题：提示词让模型自由命名主题，16 条素材产出 47 个主题，全是同义变体 ——
 * 「高音技巧教学」/「高音定位训练」/「高音位置衔接」其实是一类。
 * 样本最多的主题只有 3 个，面板上显示成一堆几乎不重复的词，匹配也命不中。
 *
 * 这里钉三件事：词表存在、提示词真的注入了、写库前有归一兜底。
 */

test('主题词表文件必须存在且结构正确', () => {
  assert.ok(existsSync(TAX_PATH), `词表必须在 data/theme-taxonomy.json，实际找 ${TAX_PATH}`);
  const j = JSON.parse(readFileSync(TAX_PATH, 'utf-8'));
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
  const j = JSON.parse(readFileSync(TAX_PATH, 'utf-8'));
  const names = j.categories.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, `有重复分类名: ${names.join(', ')}`);
});

test('提示词必须注入词表，否则模型不知道只能选哪些', () => {
  assert.match(analyzer, /function themeTaxonomyHint/, '必须有生成词表提示的函数');
  assert.match(analyzer, /THEME TAXONOMY/, '提示词里要出现词表说明');
  // 词表必须真的插进 SYSTEM_PROMPT，而不是定义了个函数没人调
  assert.match(
    analyzer,
    /All text can be in Chinese or the language of the transcript\$\{themeTaxonomyHint\(\)\}/,
    'themeTaxonomyHint() 必须拼进 SYSTEM_PROMPT'
  );
});

test('JSON 结构说明里也要写"只能从词表选"', () => {
  // 光在末尾追加说明不够：模型主要看前面的 schema 描述
  assert.match(
    analyzer,
    /"theme_name":\s*"从下方 THEME TAXONOMY 里选一个分类名/,
    'schema 里 theme_name 的描述必须指向词表'
  );
});

test('写库前必须有归一兜底（本地 8B 不一定听话）', () => {
  assert.match(analyzer, /function normalizeThemeName/, '必须有归一函数');
  assert.match(
    analyzer,
    /themeName:\s*normalizeThemeName\(/,
    'addHitTheme 必须用归一后的名字，不能用模型原始输出'
  );
});

test('归一匹配不上时要保留原名（宁可野生也不归错类）', () => {
  // 归错类比不归更坏：它会污染那个分类下的所有样本
  assert.match(
    analyzer,
    /return bestScore > 0 \? best : themeName/,
    '匹配不上的主题必须原样保留'
  );
});

test('词表读失败时退回自由命名，不能让分析整个失败', () => {
  assert.match(analyzer, /主题词表读取失败，退回自由命名/, '要有降级路径');
  // 结构不对（非数组 / 空数组）也必须退回 —— 半截文件是最容易踩的
  assert.match(
    analyzer,
    /if \(!Array\.isArray\(j\.categories\)\s*\|\|\s*j\.categories\.length\s*===\s*0\)\s*return null/,
    '结构不对或为空数组都要退回'
  );
  assert.match(analyzer, /if \(!existsSync\(p\)\) return null/, '文件不存在也要退回');
});