#!/usr/bin/env node
/**
 * 把历史爆款主题归一到受控词表。
 *
 * 为什么要单独跑一次（2026-10-06）：
 * 词表只对新分析生效。库里 16 条素材的 50 行主题还是当初自由命名的 47 种叫法，
 * 面板上的「高频主题」因此全是 1~3 次的碎片，谁也看不出这位老师擅长什么。
 * 重跑分析能修，但要重新调 LLM、重新抽帧，代价大且结果会跟词表漂移
 * （模型每次叫法都不一样）。这里只改主题名，不碰其它任何维度。
 *
 * 归一实现复用 src/analyzer/theme-taxonomy.js —— 和运行时同一份代码。
 * 两处各写一遍的话过几个月必然漂移，而且漂移了没人会发现。
 *
 * 用法：
 *   node scripts/normalize-hit-themes.mjs            只看会改什么（不动库）
 *   node scripts/normalize-hit-themes.mjs --apply    真写库（先自动备份）
 *
 * 安全约束：
 *   - 默认 dry-run。不加 --apply 一行都不写。
 *   - --apply 前自动复制一份 .bak-before-theme-normalize-<时间戳>.db
 *   - 归一不上的原样保留，不硬塞分类（归错类会污染该分类下所有样本）
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeThemeName, loadThemeTaxonomy } from '../src/analyzer/theme-taxonomy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DB_PATH 允许用环境变量覆盖：测试要能在一次性库上真跑一遍，
// 验证 dry-run 真的不写库。没有覆盖的话就只能靠人肉 review 守卫还在不在。
const DB_PATH = process.env.DB_PATH_OVERRIDE || join(__dirname, '..', 'data', 'hermes.db');
const APPLY = process.argv.includes('--apply');

const cats = loadThemeTaxonomy();
if (!cats) {
  console.error('读不到主题词表（data/theme-taxonomy.json），先修好词表再跑。');
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error('找不到数据库: ' + DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const rows = db.prepare(
  'SELECT id, hit_video_id, theme_name, keywords FROM hit_themes ORDER BY id'
).all();

/** keywords 存的是 JSON 文本，坏了就当空数组，不让一条脏数据中断整个迁移 */
const parseKeywords = (raw) => {
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
};

const plan = [];
for (const r of rows) {
  const kws = parseKeywords(r.keywords);
  const next = normalizeThemeName(r.theme_name, kws);
  if (next !== r.theme_name) plan.push({ ...r, from: r.theme_name, to: next });
}

// 归一后的种类数：被改的行取新名，没被改的保留原名。
// 别把新旧名一起塞进 Set —— 那算出来的是"改之前 ∪ 改之后"，只会变大，
// 数字会离谱地比原始种类还多，看着像归一失败。
const after = rows.map((r) => plan.find((p) => p.id === r.id)?.to ?? r.theme_name);
const kindsAfter = new Set(after).size;
const kindsBefore = new Set(rows.map((r) => r.theme_name)).size;

console.log('词表 ' + cats.length + ' 类，库内 ' + rows.length + ' 行主题。');
console.log('会改 ' + plan.length + ' 行；主题种类 ' + kindsBefore + ' → ' + kindsAfter + '。\n');

// 逐行明细：迁移归一最怕"看着对其实错"。每行都打出来给人眼过一遍，
// 尤其要看清哪些是"改了"，哪些是"分不清所以没动"。
for (const r of rows) {
  const hit = plan.find((p) => p.id === r.id);
  const kws = parseKeywords(r.keywords);
  console.log(
    (hit ? '  ' + r.theme_name + '  →  ' + hit.to
         : '  ' + r.theme_name + '  （不动）') +
    '   [' + (kws.join('/') || '无 keywords') + ']'
  );
}

// 未归一的：说清楚是"分不清"还是"本来就是标准名"
const stdNames = new Set(cats.map((c) => c.name));
const kept = rows.filter((r) => !plan.some((p) => p.id === r.id));
const keptWild = kept.filter((r) => !stdNames.has(r.theme_name));
if (keptWild.length) {
  console.log('\n分不清而保留原名 ' + keptWild.length + ' 行（这些不会进聚合，' +
    '但硬归的风险更大）：');
  for (const r of keptWild) console.log('  ' + r.theme_name);
}
console.log('');

if (plan.length === 0) {
  console.log('没有需要归一的主题。');
  db.close();
  process.exit(0);
}

if (!APPLY) {
  // 必须在这里就退出：连接要先关掉，说明本轮确实没打算写库。
  // 早先这个守卫被删掉过，结果 dry-run 一路跑到 prepare() 才崩 ——
  // 崩在事务之前所以没改数据，纯属运气，不是设计。
  console.log('这是 dry-run，库没有改动。确认无误后加 --apply 写入。');
  db.close();
  process.exit(0);
}

// ── 写入 ──
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = DB_PATH.replace(/\.db$/, '.bak-before-theme-normalize-' + stamp + '.db');
copyFileSync(DB_PATH, bak);
console.log('\n已备份到 ' + bak);

const upd = db.prepare('UPDATE hit_themes SET theme_name = ? WHERE id = ?');
const tx = db.transaction((items) => {
  for (const p of items) upd.run(p.to, p.id);
});
tx(plan);

const dist = db.prepare(
  'SELECT theme_name, COUNT(*) n FROM hit_themes GROUP BY theme_name ORDER BY n DESC'
).all();
console.log('\n写入完成，现在库里的主题分布：');
for (const r of dist) console.log('  ' + String(r.n).padStart(3) + '  ' + r.theme_name);

db.close();