/**
 * 清理 output 目录下测试素材留下的粗剪产物。
 * 默认干跑,加 --apply 才删。只删文件名匹配测试素材名的目录。
 */
const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");
const DRAFT = "<GLB_OUTPUT>/draft";
const TEST_RE = /test-live-01|_vo_test|_mv_test|probe_fresh|_verify_slice/i;

if (!fs.existsSync(DRAFT)) {
  console.log("draft 目录不存在");
  process.exit(0);
}

let count = 0;
let freed = 0;
const victims = [];

for (const name of fs.readdirSync(DRAFT)) {
  const dir = path.join(DRAFT, name);
  let st;
  try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;

  let files = [];
  try { files = fs.readdirSync(dir); } catch { continue; }
  if (files.length === 0) continue;
  // 目录里全是测试素材产物才删,混了真实素材的一律放过
  const testFiles = files.filter((f) => TEST_RE.test(f));
  if (testFiles.length === 0) continue;
  if (testFiles.length !== files.length) {
    console.log(`  跳过 ${name}(混了非测试文件:${files.filter((f) => !TEST_RE.test(f)).join(",")})`);
    continue;
  }
  let size = 0;
  for (const f of files) {
    try { size += fs.statSync(path.join(dir, f)).size; } catch {}
  }
  victims.push({ name, dir, size, n: files.length });
  count++;
  freed += size;
}

console.log(`${APPLY ? "=== 清理模式 ===" : "=== 干跑 ==="}`);
console.log(`待删目录 ${count} 个,共 ${(freed / 1024 / 1024).toFixed(1)} MB\n`);
for (const v of victims.slice(0, 20)) {
  console.log(`  ${v.name.padStart(14)}  ${(v.size / 1024 / 1024).toFixed(1).padStart(8)}MB  ${v.n} 个文件`);
}
if (victims.length > 20) console.log(`  ... 另 ${victims.length - 20} 个`);

if (!APPLY) {
  console.log("\n这是干跑。确认无误后加 --apply 执行。");
  process.exit(0);
}

let ok = 0;
for (const v of victims) {
  try { fs.rmSync(v.dir, { recursive: true, force: true }); ok++; }
  catch (e) { console.log(`  删失败 ${v.name}: ${e.message}`); }
}
console.log(`\n已删 ${ok} 个目录,释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
console.log(`draft 剩余目录 ${fs.readdirSync(DRAFT).length} 个`);