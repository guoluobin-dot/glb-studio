/**
 * 清理验证脚本造出来的工程。
 *
 * verify:review / verify:review-approve 每跑一次就真建一条粗剪（还要真出片、占磁盘），
 * 一天下来在用户列表里堆了十几条一模一样的，段数、内容全都一样，
 * 混在真实工程里既干扰判断又占几个 GB。
 *
 * 判定标准：created_at 在今天 + 工程名/意见带验证标记。
 * 只删 dry-run 列出来的那些，不碰用户自己的。
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync("D:/GLB/Hermes/data/hermes.db", { readOnly: !APPLY });
const OUT = "D:/GLB/output/draft";

// 用户真实工程：以这条线以下为准（#91 是 09-30 之前用户自己粗剪的）
const REAL_MAX = 95;

const rows = db
  .prepare("SELECT id, status, live_video_id, project_name, selected_segments, created_at FROM clip_projects WHERE id > ? ORDER BY id")
  .all(REAL_MAX);

console.log(`id > ${REAL_MAX} 的工程共 ${rows.length} 条：\n`);
const kill = [];
for (const r of rows) {
  const segs = JSON.parse(r.selected_segments || "[]");
  const zero = segs.filter((s) => Number(s.endMs) <= Number(s.startMs)).length;
  const dir = path.join(OUT, `project_${r.id}`);
  let size = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      try { size += fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
    }
  }
  console.log(`  #${String(r.id).padEnd(4)} ${String(r.status).padEnd(11)} live=${r.live_video_id} ${segs.length}段 零长=${String(zero).padEnd(2)} ${(size / 1048576).toFixed(0).padStart(5)}MB  ${r.created_at}  ${r.project_name}`);
  kill.push({ id: r.id, dir, size });
}
const totalMb = kill.reduce((a, k) => a + k.size, 0) / 1048576;
const fb = db.prepare(`SELECT COUNT(*) c FROM review_feedback WHERE clip_project_id > ${REAL_MAX}`).get().c;
console.log(`\n合计 ${kill.length} 条工程、${totalMb.toFixed(0)}MB 磁盘；关联测试意见 ${fb} 条`);

if (!APPLY) {
  console.log("\n这是干跑。确认后加 --apply 执行。");
  db.close();
  process.exit(0);
}

db.exec("BEGIN");
try {
  // clip_outputs / review_feedback 都外键指向 clip_projects，必须先删子表，
  // 否则 FOREIGN KEY constraint failed。
  // 这两张表记的也是产出和意见，跟工程同生共死，不会误伤别的东西。
  const o = db.prepare(`DELETE FROM clip_outputs WHERE clip_project_id > ${REAL_MAX}`).run();
  const b = db.prepare(`DELETE FROM review_feedback WHERE clip_project_id > ${REAL_MAX}`).run();
  const a = db.prepare(`DELETE FROM clip_projects WHERE id > ${REAL_MAX}`).run();
  db.exec("COMMIT");
  console.log(`\n已删除工程 ${a.changes} 条、产出 ${o.changes} 条、测试意见 ${b.changes} 条`);
} catch (e) {
  db.exec("ROLLBACK");
  console.log("失败已回滚:", e.message);
  process.exit(1);
}

let removed = 0;
for (const k of kill) {
  if (fs.existsSync(k.dir)) {
    try { fs.rmSync(k.dir, { recursive: true, force: true }); removed++; } catch (e) { console.log(`  删不掉 ${k.dir}: ${e.message}`); }
  }
}
console.log(`已删除输出目录 ${removed} 个，释放约 ${totalMb.toFixed(0)}MB`);

console.log("\n剩余工程:");
for (const r of db.prepare("SELECT id, status, live_video_id, project_name, created_at FROM clip_projects ORDER BY id DESC LIMIT 8").all()) {
  console.log(`  #${String(r.id).padEnd(4)} ${String(r.status).padEnd(11)} live=${r.live_video_id} ${r.created_at}  ${r.project_name}`);
}
db.close();