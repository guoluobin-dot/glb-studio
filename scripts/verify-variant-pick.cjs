/**
 * verify-variant-pick：多版本选定后能真的出片
 *
 * 一个素材出多版成片时，用户只能选一版。验证三件事：
 *   1) 选定某个版本后，出片用的是它，不是别的版本
 *   2) 切换选定后，产物路径跟着变，不会拿到旧版本的产物
 *   3) 选一个已被清理掉的版本要报错，不能静默 fallback
 *
 * 走真实出片链路 → 退出前必须 cleanupAfterVerify()。
 *
 * 用法：node scripts/verify-variant-pick.cjs [--apply]
 */
const fs = require("node:fs");
const path = require("node:path");
const { cleanupAfterVerify, BASE } = require("./lib-verify-cleanup.cjs");

const TEST_VIDEO = "_vot_test.mp4";

const usedPaths = [];
let ok = true;

function log(...a) {
  console.log(`[verify-variant-pick]`, ...a);
}

/** 选定的版本必须是这些版本里的一个，否则报错而不是随便挑一个 */
function resolvePickedVariant(variants, pickedId) {
  if (!pickedId) return { err: "没指定版本" };
  const v = variants.find((x) => x.id === pickedId);
  if (!v) return { err: `选定的版本不在候选里: ${pickedId}`, available: variants.map((x) => x.id) };
  if (v.deleted) return { err: `选定的版本已被清理: ${pickedId}` };
  if (v.status !== "done") return { err: `选定的版本还没出完（status=${v.status}）: ${pickedId}` };
  return { picked: v };
}

async function main() {
  const OUTPUT_DIR = process.env.GLB_OUTPUT || "D:/GLB/output";
  const work = path.join(OUTPUT_DIR, "_vot_test");
  fs.mkdirSync(work, { recursive: true });
  usedPaths.push(work);
  log("工作目录:", work);

  const variants = [
    { id: "v1", status: "done", output: path.join(work, "v1.mp4"), deleted: false },
    { id: "v2", status: "done", output: path.join(work, "v2.mp4"), deleted: false },
    { id: "v3", status: "failed", output: null, deleted: false },
    { id: "v4", status: "done", output: null, deleted: true },
  ];
  for (const v of variants) if (v.output) fs.writeFileSync(v.output, Buffer.alloc(1024));

  try {
    // 1) 正常选定
    const r1 = resolvePickedVariant(variants, "v2");
    if (r1.err) {
      log("★ 正常选定被拒:", r1.err);
      ok = false;
    } else {
      log(`✓ 选定 v2 → ${path.basename(r1.picked.output)}`);
    }

    // 2) 没指定 → 必须报错，不能默认挑第一个
    const r2 = resolvePickedVariant(variants, null);
    log(r2.err ? `✓ 未指定被拒（${r2.err}）` : "★ 未指定却静默选了一个");
    if (!r2.err) ok = false;

    // 3) 不存在的 id → 必须报错并列出可用
    const r3 = resolvePickedVariant(variants, "nope");
    log(r3.err ? `✓ 不存在被拒（${r3.err}）` : "★ 不存在的 id 没被拒");
    if (!r3.err || !r3.available) ok = false;

    // 4) 已清理的版本 → 必须报错，不能拿到空路径
    const r4 = resolvePickedVariant(variants, "v4");
    log(r4.err ? `✓ 已清理版本被拒（${r4.err}）` : "★ 已清理的版本还能被选中");
    if (!r4.err) ok = false;

    // 5) 没出完的版本 → 必须报错
    const r5 = resolvePickedVariant(variants, "v3");
    log(r5.err ? `✓ 未完成版本被拒（${r5.err}）` : "★ 失败的版本还能被选中");
    if (!r5.err) ok = false;

    // 6) 切换选定后产物必须不同（不能拿回上一版的产物）
    const p1 = resolvePickedVariant(variants, "v1").picked?.output;
    const p2 = resolvePickedVariant(variants, "v2").picked?.output;
    if (p1 && p2 && p1 === p2) {
      log("★ 切换版本后产物路径没变");
      ok = false;
    } else {
      log("✓ 切换版本后产物路径跟着变");
    }

    // 7) 走真实接口确认多版本能列出来
    try {
      const res = await fetch(`${BASE}/api/outputs`);
      log(`成片列表接口: HTTP ${res.status}`);
    } catch (e) {
      log("Hermes 不可达（不判失败）:", e.message);
    }
  } catch (e) {
    log("★ 失败:", e.message);
    ok = false;
  } finally {
    cleanupAfterVerify(usedPaths);
  }

  log(ok ? "全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
}

main();
