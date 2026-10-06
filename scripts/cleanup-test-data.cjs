/**
 * 一次性清理:验证脚本在真实库里留下的测试数据
 *
 * 默认干跑(只报告不删)。加 --apply 才真的删。
 * 删三类:
 *   1) 测试素材的 live_videos 行(分段/信号/工程/成片记录级联)
 *   2) 它们名下的 clip_projects / clip_outputs
 *   3) output 目录里对应的产物文件
 *
 * 为什么必须清:成片列表按 id 倒序,这些测试记录排在最前面,
 * 用户打开界面看到的就是满屏测试视频 —— 而 21KB 的那个是彩条测试图,
 * 看起来像程序坏了。
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");
const DB = "D:/GLB/Hermes/data/hermes.db";

// 只匹配明确的测试素材名,不碰任何真实素材。
// _verify_slice / _verify_slice2 也是验证脚本留下的(verify-trimmer 早期用),
// 漏掉它们的话成片列表里还会剩两条测试记录。
const TEST_RE = /test-live-01|_vo_test|_mv_test|probe_fresh|_verify_slice|(^|\/)edge\.mp4$|up-test/i;

const db = new DatabaseSync(DB);

console.log(APPLY ? "=== 清理模式(会真删)===" : "=== 干跑(只报告,加 --apply 才删)===");

// 1) 找出测试 live_videos
const allLive = db.prepare("select id, video_path, analysis_status from live_videos").all();
const testLive = allLive.filter((r) => TEST_RE.test(r.video_path));
const testIds = testLive.map((r) => r.id);
console.log(`\n测试素材 live_videos: ${testIds.length} 个`);
for (const r of testLive) console.log(`  id=${r.id}  ${r.analysis_status}  ${r.video_path}`);

if (testIds.length === 0) {
  console.log("没有测试素材,退出");
  process.exit(0);
}

// 2) 它们名下的工程与成片
const ph = testIds.map(() => "?").join(",");
const projects = db.prepare(`select id, project_name, status, output_path from clip_projects where live_video_id in (${ph})`).all(...testIds);
console.log(`\nclip_projects: ${projects.length} 个`);

const outputs = db.prepare(`select o.id, o.file_path from clip_outputs o where o.clip_project_id in (select id from clip_projects where live_video_id in (${ph}))`).all(...testIds);
console.log(`clip_outputs: ${outputs.length} 条`);

// 3) 其他挂在这些工程上的表
const childTables = ["user_queries", "sentence_cuts", "hit_predictions"];
for (const t of childTables) {
  try {
    const cols = db.prepare("select name from pragma_table_info(?)").all(t).map((c) => c.name);
    if (!cols.includes("clip_project_id")) { console.log(`${t}: 无 clip_project_id 列,跳过`); continue; }
    const n = db.prepare(`select count(*) c from "${t}" where clip_project_id in (select id from clip_projects where live_video_id in (${ph}))`).get(...testIds).c;
    console.log(`${t}: ${n} 条`);
  } catch (e) {
    console.log(`${t}: ${e.message}`);
  }
}
const segN = db.prepare(`select count(*) c from live_segments where live_video_id in (${ph})`).get(...testIds).c;
console.log(`live_segments: ${segN} 条`);
const retN = db.prepare(`select count(*) c from retention_signals where video_id in (select id from video_records where video_path in (select video_path from live_videos where id in (${ph})))`).get(...testIds).c;
console.log(`retention_signals: ${retN} 条`);

// 4) 磁盘产物
const files = new Set();
for (const o of outputs) if (o.file_path) files.add(o.file_path);
for (const p of projects) if (p.output_path) files.add(p.output_path);
for (const p of projects) {
  const d = p.output_path ? path.dirname(p.output_path) : null;
  if (d) {
    try {
      for (const f of fs.readdirSync(d)) files.add(path.join(d, f));
    } catch {}
  }
}
const realFiles = [...files].filter((f) => fs.existsSync(f));
let freed = 0;
for (const f of realFiles) {
  try { freed += fs.statSync(f).size; } catch {}
}
console.log(`\n磁盘产物: ${realFiles.length} 个文件, 共 ${(freed / 1024 / 1024).toFixed(1)} MB`);
// 只删测试素材名下的目录
const dirs = new Set();
for (const f of realFiles) {
  const d = path.dirname(f);
  if (/(test-live-01|_vo_test|_mv_test|probe_fresh)/i.test(d)) dirs.add(d);
}
for (const d of dirs) console.log(`  目录 ${d}`);

// 5) 保留哪些
const keepLive = allLive.filter((r) => !TEST_RE.test(r.video_path));
console.log(`\n保留真实 live_videos: ${keepLive.length} 个`);
for (const r of keepLive) console.log(`  id=${r.id}  ${r.video_path}`);

if (!APPLY) {
  console.log("\n这是干跑。确认无误后加 --apply 执行。");
  process.exit(0);
}

// ── 真删 ──
db.exec("BEGIN");
try {
  for (const t of ["user_queries", "sentence_cuts", "hit_predictions"]) {
    try {
      db.prepare(`delete from "${t}" where clip_project_id in (select id from clip_projects where live_video_id in (${ph}))`).run(...testIds);
    } catch (e) { console.log(`${t} 跳过: ${e.message}`); }
  }
  db.prepare(`delete from clip_outputs where clip_project_id in (select id from clip_projects where live_video_id in (${ph}))`).run(...testIds);
  db.prepare(`delete from clip_projects where live_video_id in (${ph})`).run(...testIds);
  db.prepare(`delete from live_segments where live_video_id in (${ph})`).run(...testIds);
  db.prepare(`delete from retention_signals where video_id in (select id from video_records where video_path in (select video_path from live_videos where id in (${ph})))`).run(...testIds);
  // 清理指向已删成片的 video_records(它们的源文件是测试产物)
  db.prepare(`delete from video_records where video_path in (select video_path from live_videos where id in (${ph}))`).run(...testIds);
  db.prepare(`delete from copywriting_patterns where video_id not in (select id from video_records)`).run();
  db.prepare(`delete from live_videos where id in (${ph})`).run(...testIds);
  db.exec("COMMIT");
  console.log("\n数据库已清理");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("清理失败,已回滚:", e.message);
  process.exit(1);
}

for (const d of dirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); console.log(`已删目录 ${d}`); }
  catch (e) { console.log(`删目录失败 ${d}: ${e.message}`); }
}

console.log(`\n完成。live_videos 剩 ${db.prepare("select count(*) c from live_videos").get().c} 条`);
console.log(`clip_projects 剩 ${db.prepare("select count(*) c from clip_projects").get().c} 条`);
console.log(`clip_outputs 剩 ${db.prepare("select count(*) c from clip_outputs").get().c} 条`);