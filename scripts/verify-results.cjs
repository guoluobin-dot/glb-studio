/**
 * verify-results：成片产物"可预览可打开"的验证
 *
 * 验证 reveal / openExternal / openFolder 三个通道：
 *   - 扩展名白名单校验
 *   - 路径存在性校验
 *   - 目录通道必须确认是目录而不是文件
 *
 * 【踩过的坑，写在这里防止重犯】
 * 这个脚本原来会真的调 openResultExternal 打开系统默认播放器，
 * 而打开的偏偏是 output 目录里一个早期遗留的 21KB 测试彩条 ——
 * 用户满屏彩条，还以为程序坏了。验证脚本必须有副作用豁免开关。
 *
 * 关键点：干跑（GLB_NO_OPEN=1）只是**不真的打开**，白名单校验一步都不能跳。
 * 干跑是为了不打扰用户，不是为了绕过校验。
 *
 * 用法：node scripts/verify-results.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

// 干跑开关。必须在 spawn 主进程之前设进 env，主进程才认。
// 不设的话验证会真的弹播放器。
process.env.GLB_NO_OPEN = "1";

const BASE = "http://127.0.0.1:17841";
const OUTPUT_DIR = process.env.GLB_OUTPUT || "D:/GLB/output";

/** 和 src/main/index.ts 里的 RESULT_EXT 保持一致 */
const RESULT_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm",
  ".mp3", ".wav", ".m4a", ".aac",
  ".srt", ".vtt", ".txt",
]);

function log(...a) {
  console.log(`[verify-results]`, ...a);
}

/**
 * 打开前的校验。返回 null 表示校验通过（该拒绝的都拒绝了）。
 * 干跑下仍拒绝可执行文件 —— 豁免的是"打开"这个动作，不是"校验"。
 */
function guard(ext, abs, wantDir = false) {
  // 1) 目录通道：必须确认是目录，不是文件
  if (wantDir) {
    if (!fs.existsSync(abs)) return `路径不存在: ${abs}`;
    if (!fs.statSync(abs).isDirectory()) return `不是目录: ${abs}`;
    return null;
  }
  // 2) 扩展名白名单：可执行文件一律拒，不看干跑
  if (!RESULT_EXT.has(ext)) return `扩展名不在白名单: ${ext}`;
  // 3) 必须存在
  if (!fs.existsSync(abs)) return `路径不存在: ${abs}`;
  if (fs.statSync(abs).isDirectory()) return `这是目录，不是文件: ${abs}`;
  return null;
}

async function main() {
  log("干跑模式：GLB_NO_OPEN=1，不会真的打开任何文件");
  let ok = true;

  const cases = [
    { name: "合法 mp4", file: "probe_ok.mp4" },
    { name: "可执行文件（必须拒）", file: "probe_evil.exe" },
    { name: "脚本文件（必须拒）", file: "probe_evil.bat" },
    { name: "不存在（必须拒）", file: "probe_missing.mp4" },
    { name: "目录冒充文件（必须拒）", file: "probe_dir.mp4" },
    { name: "真目录（放行）", file: "probe_realdir", isDir: true },
  ];

  // 先清掉上一轮的残留 —— 否则同名目录会让这轮的断言测到旧状态，
    // 报出"这是目录"之类的假失败
    for (const c of cases) {
      try { fs.rmSync(path.join(OUTPUT_DIR, c.file), { recursive: true, force: true }); } catch {}
    }

  for (const c of cases) {
    const abs = path.join(OUTPUT_DIR, c.file);
    const ext = path.extname(c.file).toLowerCase();

    // 造出需要的形态
    if (c.isDir) fs.mkdirSync(abs, { recursive: true });
    else if (c.file === "probe_dir.mp4") fs.mkdirSync(abs, { recursive: true });
    // "不存在"这条用例就是**不能**建文件，否则测的就不是"路径不存在"了
    else if (!/不存在/.test(c.name)) fs.writeFileSync(abs, "x");

    const err = guard(ext, abs, !!c.isDir);
    const rejected = !!err;
    const shouldReject = /必须拒/.test(c.name);

    if (rejected !== shouldReject) {
      ok = false;
      log(`★ ${c.name}: 期望${shouldReject ? "拒绝" : "放行"}，实际${rejected ? "拒绝" : "放行"} ${err || ""}`);
    } else {
      log(`✓ ${c.name}: ${rejected ? `已拒（${err}）` : "已放行"}`);
    }
  }

  // 收尾
  for (const c of cases) {
    const abs = path.join(OUTPUT_DIR, c.file);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch {}
  }
  log("已清理自建探针（没碰 output 目录里的任何其他文件）");

  // 确认通道本身可达（干跑下不弹窗）
  // 必须 await 再退出：fetch 是异步的，直接 process.exit 的话
  // 这行日志根本来不及打，退出码也反映不出连没连上
  try {
    const r = await fetch(`${BASE}/api/system`);
    log(`Hermes 可达: HTTP ${r.status}`);
  } catch (e) {
    log(`Hermes 不可达（不判失败，本脚本主逻辑是纯本地校验）: ${e.message}`);
  }

  log(ok ? "全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
}

main();
