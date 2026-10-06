/**
 * 清掉验证脚本留在 review_feedback / review_lessons 里的测试意见。
 *
 * 这些意见会被记忆注入读进下一次分析（"这个 IP 的老师不喜欢欢迎语"），
 * 留着等于把我自己编的测试反馈当成用户偏好喂给模型。
 */
const { DatabaseSync } = require("node:sqlite");
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync("D:/GLB/Hermes/data/hermes.db", { readOnly: !APPLY });

const patterns = ["审片链路验证%", "审片通过验证%"];
const where = patterns.map(() => "comment LIKE ?").join(" OR ");

const fb = db.prepare(`SELECT id, clip_project_id, decision, substr(comment,1,40) c FROM review_feedback WHERE ${where}`).all(...patterns);

console.log(`review_feedback 命中 ${fb.length} 条:`);
for (const r of fb) console.log(`  #${r.id} 工程#${r.clip_project_id ?? "-"} [${r.decision}] "${r.c}"`);

if (!APPLY) {
  console.log("\n这是干跑。确认后加 --apply 执行。");
  db.close();
  process.exit(0);
}

db.exec("BEGIN");
try {
  const a = db.prepare(`DELETE FROM review_feedback WHERE ${where}`).run(...patterns);
  db.exec("COMMIT");
  console.log(`\n已删除 feedback ${a.changes} 条`);
} catch (e) {
  db.exec("ROLLBACK");
  console.log("失败已回滚:", e.message);
  process.exit(1);
}

const left = db.prepare(`SELECT COUNT(*) n FROM review_feedback WHERE ${where}`).get(...patterns).n;
console.log(`剩余测试意见: ${left}`);
console.log("\n保留的真实意见:");
for (const r of db.prepare("SELECT id, clip_project_id, decision, substr(comment,1,44) c FROM review_feedback ORDER BY id DESC LIMIT 8").all()) {
  console.log(`  #${r.id} 工程#${r.clip_project_id ?? "-"} [${r.decision}] "${r.c}"`);
}
db.close();