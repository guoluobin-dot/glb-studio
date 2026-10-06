/**
 * 验证脚本的收尾清理（2026-10-06 重建）
 *
 * 为什么要这个模块：verify-opening / verify-wrap / verify-variant-pick /
 * verify-variant-opening-toggle 四个都走真实出片链路，会在生产库里留下
 * clip_project 记录和 output 目录里的文件。成片列表按 id 倒序，
 * 测试记录正好排在最前面 —— 用户打开界面第一批看到的全是测试视频，
 * 其中一个还是 21KB 的彩条，看起来像程序坏了。
 *
 * 所以每个走真实链路的脚本都必须在退出前调用 cleanupAfterVerify()，
 * 把自己的测试产物从库里和磁盘上收干净。
 *
 * 三条硬约束（被 tests/contract.test.ts 钉着）：
 *   1) 只认明确的测试素材名白名单，不能用 /test/ 这种宽匹配
 *   2) 默认干跑，要真删必须显式 --apply
 *   3) 磁盘清理要放过"混了非测试文件"的目录
 */

/** 白名单式的测试素材名。不写 /test/ —— 真实素材名字里带 test 会被连带删掉。 */
const TEST_MATERIAL_RE = /test-live-01|_vo_test|_mv_test|probe_fresh|_verify_slice|_verify_slice2|_ve_test|_vw_test|_vot_test/;

/** 只删这些目录名下的产物，避免误删用户自己的目录 */
const TEST_DIR_RE = /(test-live-01|_vo_test|_mv_test|probe_fresh|_ve_test|_vw_test|_vot_test)/i;

const HERMES_DIR = "D:/GLB/Hermes";
const DB_PATH = `${HERMES_DIR}/data/hermes.db`;
const BASE = "http://127.0.0.1:17841";

/**
 * 收集（不删）这次验证留下的记录 id。
 * @param {string[]} videoPaths 本次验证用到的素材路径
 * @returns {{liveIds:number[], projectIds:number[], files:string[], dirs:string[]}}
 */
function collectTestArtifacts(videoPaths) {
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  const path = require("node:path");

  const out = { liveIds: [], projectIds: [], files: [], dirs: [] };
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
  } catch (e) {
    console.log(`[cleanup] 打开库失败，跳过清理: ${e.message}`);
    return out;
  }

  const paths = videoPaths.filter((p) => p && TEST_MATERIAL_RE.test(p));
  if (paths.length === 0) {
    // 素材名不在白名单里 → 一律不动。宁可留垃圾也不能误删真实素材。
    db.close();
    return out;
  }

  const ph = paths.map(() => "?").join(",");
  try {
    out.liveIds = db
      .prepare(`select id from live_videos where video_path in (${ph})`)
      .all(...paths)
      .map((r) => r.id);

    if (out.liveIds.length) {
      const lh = out.liveIds.map(() => "?").join(",");
      out.projectIds = db
        .prepare(`select id, output_path from clip_projects where live_video_id in (${lh})`)
        .all(...out.liveIds);
      out.projectIds.forEach((p) => {
        if (p.output_path) {
          out.files.push(p.output_path);
          try {
            for (const f of fs.readdirSync(path.dirname(p.output_path))) {
              out.files.push(path.join(path.dirname(p.output_path), f));
            }
          } catch {}
        }
      });
    }
  } catch (e) {
    console.log(`[cleanup] 读取失败: ${e.message}`);
  } finally {
    try { db.close(); } catch {}
  }

  out.dirs = [...new Set(out.files.map((f) => require("node:path").dirname(f)))].filter((d) =>
    TEST_DIR_RE.test(d)
  );
  return out;
}

/**
 * 收尾清理。默认干跑，加 --apply 才真删。
 *
 * @param {string[]} videoPaths 本次验证用到的素材路径
 * @param {{apply?: boolean}} [opts]
 */
function cleanupAfterVerify(videoPaths, opts = {}) {
  const fs = require("node:fs");
  const apply = opts.apply ?? process.argv.includes("--apply");

  const found = collectTestArtifacts(videoPaths);
  if (found.liveIds.length === 0 && found.projectIds.length === 0 && !found.dirs.length) {
    return { removed: 0, skipped: true };
  }

  console.log(
    `[cleanup] 本次验证留下: live=${found.liveIds.length} project=${found.projectIds.length} dir=${found.dirs.length}`
  );

  if (!apply) {
    console.log("[cleanup] 干跑。加 --apply 才真删。");
    return { removed: 0, skipped: false };
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("BEGIN");
    if (found.projectIds.length) {
      const ph = found.projectIds.map(() => "?").join(",");
      for (const t of ["user_queries", "sentence_cuts", "hit_predictions"]) {
        try {
          db.prepare(`delete from "${t}" where clip_project_id in (${ph})`).run(
            ...found.projectIds.map((p) => p.id)
          );
        } catch {}
      }
      db.prepare(`delete from clip_outputs where clip_project_id in (${ph})`).run(
        ...found.projectIds.map((p) => p.id)
      );
      db.prepare(`delete from clip_projects where id in (${ph})`).run(
        ...found.projectIds.map((p) => p.id)
      );
    }
    if (found.liveIds.length) {
      const ph = found.liveIds.map(() => "?").join(",");
      db.prepare(`delete from live_segments where live_video_id in (${ph})`).run(...found.liveIds);
      db.prepare(`delete from live_videos where id in (${ph})`).run(...found.liveIds);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.log(`[cleanup] 数据库清理失败，已回滚: ${e.message}`);
    return { removed: 0, failed: true };
  } finally {
    try { db.close(); } catch {}
  }

  // 磁盘：只看白名单目录，且放过混了非测试文件的目录
  for (const d of found.dirs) {
    if (!TEST_DIR_RE.test(d)) continue;
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue;
    }
    // 目录里混了非测试产物 → 不动，宁可留垃圾
    const foreign = entries.filter((f) => !TEST_DIR_RE.test(f));
    if (foreign.length) {
      console.log(`[cleanup] 跳过 ${d}：混了非测试文件（${foreign.slice(0, 3).join(", ")}）`);
      continue;
    }
    try {
      fs.rmSync(d, { recursive: true, force: true });
      console.log(`[cleanup] 已删目录 ${d}`);
    } catch (e) {
      console.log(`[cleanup] 删目录失败 ${d}: ${e.message}`);
    }
  }

  return { removed: 1, skipped: false };
}

module.exports = { cleanupAfterVerify, collectTestArtifacts, TEST_MATERIAL_RE, BASE, HERMES_DIR };
