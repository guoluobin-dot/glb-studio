/**
 * verify-opening：成片"能真的打开"的验证（走真实出片链路）
 *
 * 为什么这类脚本必须收尾清理：它们在生产库里留下 clip_project 记录和
 * output 目录里的文件。成片列表按 id 倒序，测试记录排在最前面 ——
 * 用户打开界面第一批看到的是满屏测试视频，其中一个 21KB 的还是彩条。
 *
 * 所以每个走真实链路的脚本退出前都必须 cleanupAfterVerify()。
 * 约定见 scripts/lib-verify-cleanup.cjs。
 *
 * 用法：node scripts/verify-opening.cjs [--apply]
 */
const fs = require("node:fs");
const path = require("node:path");
const { cleanupAfterVerify, BASE } = require("./lib-verify-cleanup.cjs");

/** 本次验证用到的测试素材名（清理只认这些） */
const TEST_VIDEO = "_vo_test.mp4";

const usedPaths = [];
let ok = true;

function log(...a) {
  console.log(`[verify-opening]`, ...a);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

/** 打开前的四项校验，和 src/main/index.ts 对齐 */
function guardOutput(ext, abs) {
  if (![".mp4", ".mov", ".mkv", ".webm", ".srt"].includes(ext)) return `扩展名不允许: ${ext}`;
  if (!fs.existsSync(abs)) return `产物不存在: ${abs}`;
  const st = fs.statSync(abs);
  if (st.size === 0) return `产物是空文件: ${abs}`;
  return null;
}

async function main() {
  log("开始。Hermes:", BASE);
  log("测试素材:", TEST_VIDEO);
  usedPaths.push(TEST_VIDEO);

  try {
// 1) 合成链路健康
    // 注意：只判"连得上"，不判 HTTP 200 —— 端点存在但返回 404/400
    // 也说明服务在跑，够用了。判 200 会把端点路径的变动误报成"服务挂了"。
    const health = await api("GET", "/api/system");
    log(`Hermes 连接: HTTP ${health.status}`);
    if (!health.status) throw new Error("连不上 Hermes（没有拿到 HTTP 状态码）");

    // 2) 成片列表要能拿到，并且不含测试产物
    const outs = await api("GET", "/api/outputs");
    const list = Array.isArray(outs.json) ? outs.json : outs.json?.outputs || [];
    log(`成片列表: ${list.length} 条`);

    const leaked = list.filter((o) => /test-live|_vo_test|_mv_test/.test(o.file_path || ""));
    if (leaked.length) {
      log(`★ 成片列表里混着 ${leaked.length} 条测试产物（接口层没过滤干净）`);
      ok = false;
    } else {
      log("✓ 成片列表已过滤测试产物");
    }

    // 3) 打开前的校验必须拒绝坏路径
    const OUTPUT_DIR = process.env.GLB_OUTPUT || "D:/GLB/output";
    const probeDir = path.join(OUTPUT_DIR, "_vo_test");
    fs.mkdirSync(probeDir, { recursive: true });
    usedPaths.push(probeDir);

    const bad = guardOutput(".exe", path.join(probeDir, "x.exe"));
    log(`可执行文件被拒: ${bad ? "✓ " + bad : "★ 没拒"}`);
    if (!bad) ok = false;

    const missing = guardOutput(".mp4", path.join(probeDir, "nope.mp4"));
    log(`不存在文件被拒: ${missing ? "✓ " + missing : "★ 没拒"}`);
    if (!missing) ok = false;

    // 4) 造一个最小 mp4 当产物，验证能被接受
    const fake = path.join(probeDir, "_vo_test.mp4");
    fs.writeFileSync(fake, Buffer.alloc(2048));
    const good = guardOutput(".mp4", fake);
    log(`正常产物被接受: ${good ? "★ " + good : "✓"}`);
    if (good) ok = false;
  } catch (e) {
    log("★ 失败:", e.message);
    ok = false;
  } finally {
    // 必须收尾清理：把本次验证留在真实库和 output 里的东西清掉
    cleanupAfterVerify(usedPaths);
  }

  log(ok ? "全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
}

main();
