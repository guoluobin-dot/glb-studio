#!/usr/bin/env node
/**
 * 归一判定的诊断脚本：打印判给谁、领先次优多少、每一分是怎么来的。
 *
 * 为什么需要它：归一是黑盒。迁移历史主题时，"「发音位置的重要性」
 * 为什么没进气息" 这种问题光看结果答不上来，必须能看到判定过程。
 *
 * 它复用 src/analyzer/theme-taxonomy.js 的实现。早先这里照抄了一份权重，
 * 改了一处就得分叉，两套规则解释同一批数据比没有解释更糟 ——
 * 排查时会被过期的解释带偏。
 *
 * 用法：node scripts/explain-theme-normalize.mjs [主题名] [关键词...]
 */
import { explainThemeMatch, loadThemeTaxonomy } from '../src/analyzer/theme-taxonomy.js';

const cats = loadThemeTaxonomy();
if (!cats) {
  console.error('读不到词表（data/theme-taxonomy.json），先修好词表。');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log('用法: node scripts/explain-theme-normalize.mjs <主题名> [关键词...]\n');
  console.log('词表共 ' + cats.length + ' 类：');
  for (const c of cats) {
    console.log('  ' + c.name.padEnd(12) + ' ' + c.hint);
    console.log('      召回词: ' + c.keywords.join('、'));
  }
  process.exit(0);
}

const [name, ...kws] = argv;
const r = explainThemeMatch(name, kws);

console.log(`【${name}】keywords = ${JSON.stringify(kws)}`);
console.log(`判定 → ${r.hit}    领先次优 ${r.margin === Infinity ? '（唯一候选）' : r.margin}`);
console.log('');
for (const s of r.scored.slice(0, 5)) {
  const score = s.score === Infinity ? ' ∞ ' : s.score.toFixed(1).padStart(5);
  console.log(`  ${score}  ${s.category}`);
  for (const why of s.reasons) console.log(`          ${why}`);
}
if (r.scored.length === 0) {
  console.log('  （一个分类的召回词都没命中 —— 主题名和 keywords 与词表无关）');
}
if (r.hit === name) {
  console.log('\n保留原名：没有证据，或最优和次优咬得太紧分不清。');
}