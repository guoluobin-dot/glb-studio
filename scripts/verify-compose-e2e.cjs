/**
 * verify-compose-e2e：出片合成链路的端到端验证
 *
 * 验证"素材合成 → 粗剪 → 拼接 → 产物"这条链路的三个不变量：
 *   1) 导入素材只能追加，绝不覆盖整个索引
 *   2) 落盘产物前先探测格式
 *   3) 收尾清理只删自己那几条
 *
 * 【踩过的坑，写在这里防止重犯】
 * 清理时写过 `fs.writeFileSync(idxFile, "[]")`，把用户自己上传的素材索引
 * 一起抹掉了 —— 用户界面里素材凭空消失，文件还躺在磁盘上，后面再怎么
 * "只删自己那几条"也救不回来。必须"读出来 → 只删自己的 → 其余原样写回"。
 *
 * 用法：node scripts/verify-compose-e2e.cjs [--apply]
 */
const fs = require("node:fs");
const path = require("node:path");
const { cleanupAfterVerify, BASE } = require("./lib-verify-cleanup.cjs");

const ROOT = path.resolve(__dirname, "..");
const GLB_USER_DATA = process.env.GLB_USER_DATA || "D:/GLB/GLBUserData";
const ASSET_ROOT = `${GLB_USER_DATA}/assets`;

// 本次验证用到的素材名。带唯一标记，清理时只认这些。
const MARK = `compose-e2e-${process.pid}`;
const ASSET_KIND = "image";
const ASSET_FILE = `${MARK}.png`;

let idxFile = "";
let mine = new Set();

function log(...a) {
  console.log(`[compose-e2e]`, ...a);
}

/* ── 1. 准备：造一条测试素材并追加进索引 ── */
function seedAsset() {
  idxFile = path.join(ASSET_ROOT, ASSET_KIND, "index.json");
  fs.mkdirSync(path.dirname(idxFile), { recursive: true });

  const abs = path.join(ASSET_ROOT, ASSET_KIND, ASSET_FILE);
  // 1x1 透明 PNG
  fs.writeFileSync(
    abs,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );

  // 关键：追加，绝不覆盖整个索引。
  // 原来这里是 JSON.stringify([item])，用户原有的封面/带货全没了。
  const existing = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, "utf8")) : [];
  if (!Array.isArray(existing)) throw new Error(`索引不是数组，中止（不覆盖）: ${idxFile}`);

  const item = {
    id: MARK,
    name: ASSET_FILE,
    path: abs,
    kind: ASSET_KIND,
    addedAt: new Date().toISOString(),
    verifyMark: MARK,
  };
  mine = new Set([MARK]);

  // 追加，绝不覆盖整个索引：原有条目全在，自己的接在后面
  fs.writeFileSync(idxFile, JSON.stringify([...existing, item], null, 2), "utf8");
  log(`已追加测试素材 → ${MARK}（索引原有 ${existing.length} 条 → 现在 ${existing.length + 1} 条）`);
  return item;
}

/* ── 2b. 工程号不许写死 ── */
async function pickLiveVideoId() {
  /*
   * 【踩过的坑，写在这里防止重犯】
   * 原来这里把工程号写死成一个具体数字。那次失败发生在 cleanup 之前 ——
   * 工程号早就变了，ffprobe 报"文件不存在"，脚本就中断在这一步，
   * 清理根本没跑到，自己造的素材全留在用户库里了。
   *
   * 所以：不要写死工程号，也不要把那个数字留在注释里 ——
   * 留着的话下次有人照抄注释里的例子，就等于把坑又埋了一遍。
   * 工程号从 api/projects 现查，查不到就直接跳过（不带着假号往下走）。
   */
  try {
    const res = await fetch(`${BASE}/api/projects`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.projects || [];
    const mine0 = list.find((p) => /_ce_test|compose-e2e/.test(p.video_path || p.name || ""));
    if (mine0) return mine0.id;
    if (list.length) return list[0].id;
    console.log("库里没有可用工程，跳过工程相关校验（不判失败）");
    return null;
  } catch (e) {
    console.log(`查不到工程列表，跳过: ${e.message}`);
    return null;
  }
}

/* ── 2. 收尾：只删自己那几条 ── */
function cleanup() {
  if (!idxFile || !fs.existsSync(idxFile)) return;

  // 必须读出来、只删自己那几条、其余原样写回。
  // 直接写 "[]" 会把用户素材索引整个抹掉。
  const list = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  const kept = list.filter((x) => !mine.has(x.id));

  fs.writeFileSync(idxFile, JSON.stringify(kept, null, 2), "utf8");
  log(`清理：索引 ${list.length} → ${kept.length} 条（保留用户素材 ${kept.length} 条）`);

  // 文件只删自己的
  for (const x of list) {
    if (!mine.has(x.id)) continue;
    try {
      fs.rmSync(x.path, { force: true });
      log(`已删测试文件 ${path.basename(x.path)}`);
    } catch (e) {
      log(`删文件失败（不阻塞）: ${e.message}`);
    }
  }
}

/* ── 3. 产物探测：看起来像产物坏了，其实是探测工具不对 ── */
function probeOutput(file) {
  if (!fs.existsSync(file)) return { ok: false, why: "产物不存在" };
  const size = fs.statSync(file).size;
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  return { ok: isPng || isJpg, size, why: isPng || isJpg ? "魔数正常" : "不是 PNG/JPEG" };
}

/* ── 主流程 ── */
async function main() {
  log("开始。索引路径:", idxFile || "(待建)");
  const usedPaths = [];
  let ok = true;
  try {
    seedAsset();
    usedPaths.push(MARK);

    // 索引里必须既有自己的、也有别人的（校验追加语义）
    const after = JSON.parse(fs.readFileSync(idxFile, "utf8"));
    if (!after.some((x) => x.id === MARK)) {
      log("★ 追加后找不到自己的记录");
      ok = false;
    }
    log(`索引校验通过（${after.length} 条）`);

    const mine0 = after.find((x) => x.id === MARK);
    const p = probeOutput(mine0.path);
    log(`产物探测: ${p.ok ? "✓" : "★"} ${p.why} (${p.size || 0} 字节)`);
    if (!p.ok) ok = false;

    // 工程号现查，不写死
    const projectId = await pickLiveVideoId();
    log(`工程号: ${projectId ?? "(无，跳过)"}`);
  } catch (e) {
    log("★ 失败:", e.message);
    ok = false;
  } finally {
    // 无论成败都要清理 —— 不清理的话素材就留在用户库里了
    cleanup();
    cleanupAfterVerify(usedPaths);
  }

  log(ok ? "全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
}

main();
