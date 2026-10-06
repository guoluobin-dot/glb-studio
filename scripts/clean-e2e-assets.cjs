/**
 * 清掉 e2e 验证脚本遗留在素材库里的条目（id 以 e2e- 开头）。
 * 只删本脚本自己造的，不碰用户素材。
 */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = `${process.env.APPDATA}/glb/assets`;

let total = 0;
for (const kind of ["covers", "tails"]) {
  const dir = path.join(ROOT, kind);
  const idxFile = path.join(dir, "index.json");
  if (!fs.existsSync(idxFile)) continue;
  const list = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  const keep = [];
  for (const it of list) {
    const mine = String(it.id || "").startsWith("e2e-");
    if (mine) {
      try { fs.rmSync(String(it.path).replace(/\//g, path.sep), { force: true }); } catch { /* ignore */ }
      total++;
      console.log(`  删除 ${kind}/${it.id}  ${it.name}`);
    } else {
      keep.push(it);
    }
  }
  fs.writeFileSync(idxFile, JSON.stringify(keep, null, 2), "utf8");
  console.log(`${kind}: 索引 ${list.length} -> ${keep.length}`);
}
console.log(total ? `\n已清理 ${total} 条 e2e 残留` : "没有 e2e 残留");