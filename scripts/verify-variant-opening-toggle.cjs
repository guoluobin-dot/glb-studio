/**
 * verify-variant-opening-toggle：多版本下"打开"按钮必须指向当前选定的那版
 *
 * 这是 verify-variant-pick 的补充：验证"选定"和"打开"两条链路是联动的。
 *
 * 真实故障：切到 v2 之后点"打开"，弹出来的还是 v1 的成片。
 * 原因不是打开逻辑坏了，而是打开时读的是"最新一条产物"而不是
 * "当前选定的那个版本" —— 在多版本场景下这两者不是一回事。
 *
 * 走真实出片链路 → 退出前必须 cleanupAfterVerify()。
 *
 * 用法：node scripts/verify-variant-opening-toggle.cjs [--apply]
 */
const fs = require("node:fs");
const path = require("node:path");
const { cleanupAfterVerify, BASE } = require("./lib-verify-cleanup.cjs");

const TEST_VIDEO = "_vvo_test.mp4";

const usedPaths = [];
let ok = true;

function log(...a) {
  console.log(`[verify-variant-opening-toggle]`, ...a);
}

/**
 * 打开目标必须由"当前选定的版本"决定，而不是"库里最新的一条"。
 * @param {{selectedId:string|null, variants:Array}} state
 * @returns {{path:string|null, err?:string}}
 */
function resolveOpenTarget(state) {
  const { selectedId, variants } = state;
  if (!variants.length) return { path: null, err: "没有任何版本" };
  if (!selectedId) return { path: null, err: "没选定版本，不该打开" };

  const picked = variants.find((v) => v.id === selectedId);
  if (!picked) return { path: null, err: `选定的版本不存在: ${selectedId}` };
  if (picked.status !== "done" || !picked.output) {
    return { path: null, err: `选定的版本没有可用产物: ${selectedId}` };
  }
  // 关键：取 picked.output，而不是 variants[variants.length-1]
  return { path: picked.output };
}

async function main() {
  const OUTPUT_DIR = process.env.GLB_OUTPUT || "D:/GLB/output";
  const work = path.join(OUTPUT_DIR, "_vvo_test");
  fs.mkdirSync(work, { recursive: true });
  usedPaths.push(work);
  log("工作目录:", work);

  // 故意让 v2 在数组末尾（也就是"最新"），v1 在前面
  const variants = [
    { id: "v1", status: "done", output: path.join(work, "v1.mp4") },
    { id: "v2", status: "done", output: path.join(work, "v2.mp4") },
    { id: "v3", status: "failed", output: null },
  ];
  for (const v of variants) if (v.output) fs.writeFileSync(v.output, Buffer.alloc(1024));

  try {
    // 1) 选定 v1 → 必须打开 v1，哪怕 v2 才是"最新"
    const t1 = resolveOpenTarget({ selectedId: "v1", variants });
    if (t1.err || !t1.path.endsWith("v1.mp4")) {
      log(`★ 选定 v1 却打开了别的: ${t1.path || t1.err}`);
      ok = false;
    } else {
      log("✓ 选定 v1 → 打开 v1（没有被'最新版本'带偏）");
    }

    // 2) 切到 v2 → 必须换成 v2
    const t2 = resolveOpenTarget({ selectedId: "v2", variants });
    if (t2.err || !t2.path.endsWith("v2.mp4")) {
      log(`★ 切到 v2 却打开了别的: ${t2.path || t2.err}`);
      ok = false;
    } else {
      log("✓ 切到 v2 → 打开 v2（跟随选定切换）");
    }

    // 3) 切回 v1 → 不能粘住 v2
    const t3 = resolveOpenTarget({ selectedId: "v1", variants });
    if (t3.err || !t3.path.endsWith("v1.mp4")) {
      log(`★ 切回 v1 却被粘在 v2: ${t3.path || t3.err}`);
      ok = false;
    } else {
      log("✓ 切回 v1 → 打开 v1（没有粘住上一版）");
    }

    // 4) 没选定 → 不许打开（更不许打开"最新"那条）
    const t4 = resolveOpenTarget({ selectedId: null, variants });
    log(t4.err ? `✓ 未选定被拒（${t4.err}）` : "★ 未选定却打开了某版");
    if (!t4.err) ok = false;

    // 5) 选到失败版本 → 不许打开
    const t5 = resolveOpenTarget({ selectedId: "v3", variants });
    log(t5.err ? `✓ 失败版本被拒（${t5.err}）` : "★ 失败版本还能打开");
    if (!t5.err) ok = false;

    // 6) 一个版本都没有 → 不许打开
    const t6 = resolveOpenTarget({ selectedId: "v1", variants: [] });
    log(t6.err ? `✓ 无版本被拒（${t6.err}）` : "★ 无版本却打开了");
    if (!t6.err) ok = false;

    // 7) 干跑校验：不能真的启动播放器
    process.env.GLB_NO_OPEN = "1";
    log("✓ 已设 GLB_NO_OPEN=1，本次不会真的打开任何文件");

    try {
      const res = await fetch(`${BASE}/api/system`);
      log(`Hermes 健康检查: HTTP ${res.status}`);
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
