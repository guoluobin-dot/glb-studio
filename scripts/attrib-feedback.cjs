/**
 * 把 collection=NULL 的历史打回意见归到指定的 IP 老师。
 *
 * 为什么需要：以前桌面端还没和 Hermes 的 activeCollection 联动，
 * addReviewFeedback 回落到 store.activeCollection（当时是 null），
 * 于是所有历史意见都落在 collection=NULL。
 * 结果是"按集合取避免规则"一条都读不到 —— 用户明明说过"钩子不够炸"，
 * 分析时完全不生效。
 *
 * 归到谁：默认全部归到唯一的老师（当前库里只有一位）。
 * 库里有多个集合时必须显式传 ipName，否则脚本直接退出 —— 不猜。
 *
 * 用法：node scripts/attrib-feedback.cjs [ipName] [--apply]
 */
const { DatabaseSync } = require("node:sqlite");

const APPLY = process.argv.includes("--apply");
let ipName = process.argv.slice(2).find((a) => !a.startsWith("--")) || null;

const db = new DatabaseSync("D:/GLB/Hermes/data/hermes.db");

const cols = db.prepare("select name from pragma_table_info(?)").all("hit_videos").map((c) => c.name);
if (!cols.includes("collection")) {
  console.log("hit_videos 没有 collection 列，无法确定该归到谁。退出。");
  process.exit(1);
}

const collections = db.prepare(
  `SELECT collection, COUNT(*) c FROM hit_videos
    WHERE analysis_status='completed' AND collection IS NOT NULL AND collection <> ''
    GROUP BY collection ORDER BY c DESC`
).all();

console.log("=== 库里的集合 ===");
for (const c of collections) console.log(`  ${c.collection}: ${c.c} 条爆款`);

if (!ipName) {
  if (collections.length === 1) {
    console.log(`\n只有一个集合，自动采用: ${collections[0].collection}`);
    ipName = collections[0].collection;
  } else {
    console.log(`\n有 ${collections.length} 个集合，必须显式指定归属。`);
    console.log("用法: node scripts/attrib-feedback.cjs \"集合名\" [--apply]");
    process.exit(1);
  }
}

const known = collections.some((c) => c.collection === ipName);
if (!known) {
  console.log(`指定的集合「${ipName}」在库里没有爆款数据。归过去会让意见挂在一个空集合上。`);
  process.exit(1);
}

const orphans = db.prepare(
  "SELECT id, decision, substr(comment,1,70) c FROM review_feedback WHERE collection IS NULL OR collection = '' ORDER BY id"
).all();

console.log(`\n未归属的打回意见: ${orphans.length} 条`);
for (const r of orphans) console.log(`  id=${r.id} [${r.decision}] ${(r.c || "").replace(/\s+/g, " ")}`);

const already = db.prepare(
  "SELECT COUNT(*) c FROM review_feedback WHERE collection IS NOT NULL AND collection <> ''"
).get().c;
console.log(`\n已归属的意见: ${already} 条`);

if (orphans.length === 0) {
  console.log("\n没有需要归属的意见。");
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n这是干跑。确认后加 --apply 把这 ${orphans.length} 条归到「${ipName}」。`);
  process.exit(0);
}

db.exec("BEGIN");
try {
  const stmt = db.prepare("UPDATE review_feedback SET collection = ? WHERE id = ?");
  for (const r of orphans) stmt.run(ipName, r.id);
  db.exec("COMMIT");
  console.log(`\n已归属 ${orphans.length} 条到「${ipName}」`);
} catch (e) {
  db.exec("ROLLBACK");
  console.log("归属失败，已回滚:", e.message);
  process.exit(1);
}

const after = db.prepare(
  "SELECT collection, COUNT(*) c FROM review_feedback GROUP BY collection ORDER BY c DESC"
).all();
console.log("\n归属后的分布:");
for (const a of after) console.log(`  ${a.collection ?? "(NULL)"}: ${a.c}`);

// 验证 getCollectionAvoidRules 能读到
const rules = db.prepare(
  `SELECT f.comment FROM review_feedback f
    WHERE f.collection = ? AND f.decision = 'recut' AND f.comment IS NOT NULL
    ORDER BY f.id DESC LIMIT 20`
).all(ipName).map((r) => String(r.comment || "").trim()).filter(Boolean);
console.log(`\n「${ipName}」现在能读到 ${rules.length} 条避雷规则:`);
for (const r of rules) console.log(`  · ${r.slice(0, 60)}`);