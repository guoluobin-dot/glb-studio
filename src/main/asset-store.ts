/**
 * 出片素材库:封面图 + 结尾藏带货视频。
 *
 * 为什么要有素材库(而不是每次选完就完事):
 * 直播切片是**反复出片**的 —— 同一批候选可能要出三四版,每版都重新选一次
 * 封面、重新指一次藏带货视频,几天下来没人愿意用。所以图片/视频进来先入库,
 * 出片时只引用其中一条。
 *
 * 目录约定(userData 下,与爆款库 hits/ 同级):
 *   assets/covers/index.json   封面图清单
 *   assets/covers/files/*      图片本体(复制进来,不动用户原图)
 *   assets/tails/index.json    藏带货视频清单
 *   assets/tails/files/*       视频本体
 *
 * 复制而不是引用原路径:用户原图可能在网盘同步目录、可能在移动硬盘、
 * 名字还可能改。素材库的价值就是"三个月后还能出片"。
 * 代价是占磁盘,所以删图时会把磁盘文件一起删(走回收站,误删可恢复)。
 */
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/** 封面图允许的格式。png/jpg 之外还收 webp(体积小),但拒绝 gif(动图当封面没意义) */
const COVER_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
/** 藏带货是视频,做成片尾巴用,所以只收 ffmpeg 稳解的容器 */
const TAIL_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);

/** 单文件上限:藏带货是整段视频,给个上限免得误传 4K 母带把磁盘塞满 */
const MAX_TAIL_BYTES = 512 * 1024 * 1024;

export type AssetKind = "covers" | "tails";

export interface AssetItem {
  id: string;
  /** 素材库内的绝对路径(出片时用这个,不依赖用户原位置) */
  path: string;
  /** 原始文件名,用于界面显示 */
  name: string;
  size: number;
  addedAt: string;
}

/* ────────────────── 路径 ────────────────── */

function rootOf(userData: string, kind: AssetKind): string {
  return join(userData, "assets", kind);
}
function indexFile(userData: string, kind: AssetKind): string {
  return join(rootOf(userData, kind), "index.json");
}
function filesDir(userData: string, kind: AssetKind): string {
  return join(rootOf(userData, kind), "files");
}
function trashDir(userData: string, kind: AssetKind): string {
  return join(userData, "assets", ".trash", kind);
}

/**
 * 目录名净化。素材 id 会被拼进磁盘路径,必须是安全字符 ——
 * 这是防路径穿越最外层的防线,不能省。
 */
function safeSegment(name: string): string {
  return (
    String(name)
      .replace(/[^\w一-龥.-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 60) || "_"
  );
}

/* ────────────────── 读写 ────────────────── */

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * 原子写:先写 tmp 再 rename。
 * 直接覆盖的话中途断电会留下半个 JSON,读时 parse 失败 -> fallback ->
 * 用户以为素材全被清空了,还没法恢复。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/* ────────────────── 对外接口 ────────────────── */

/**
 * 读素材清单，顺带把索引和磁盘对齐。
 *
 * 两个方向都要处理，只做一个方向会丢素材：
 *  - 索引有、磁盘没了（用户手动删了文件）→ 从索引移除，
 *    否则界面上出现打不开的缩略图，点了才报错。
 *  - 磁盘有、索引没了（索引被某个流程整体覆盖成 []）→ 补回索引。
 *    **只处理前一个方向的后果**：用户上传的素材永久失联 ——
 *    文件明明在磁盘上，界面却空空如也，而"重新上传"是唯一的出路。
 *    这个坑真实发生过（索引被清空，4 张封面 + 4 段视频失联）。
 */
export async function listAssets(userData: string, kind: AssetKind): Promise<AssetItem[]> {
  const items = await readJson<AssetItem[]>(indexFile(userData, kind), []);
  const dir = filesDir(userData, kind);

  // 索引有但文件已不存在 → 剔除
  const alive = items.filter((it) => it?.path && existsSync(it.path));

  // 磁盘有但索引没有 → 补回。文件名形如 "<时间戳>-<随机>.<ext>"，
  // 后半段就是入库时记录的原始文件名，据此还原 id 和 name。
  let known: Set<string>;
  try {
    known = new Set(alive.map((x) => String(x.path).replace(/\\/g, "/")));
  } catch {
    known = new Set();
  }
  const recovered: AssetItem[] = [];
  let onDisk: string[] = [];
  try {
    onDisk = (await readdir(dir)).filter((f) => !f.startsWith("."));
  } catch {
    onDisk = [];
  }
  for (const f of onDisk) {
    const abs = join(dir, f).replace(/\\/g, "/");
    if (known.has(abs)) continue;
    const ext = extname(f);
    const stem = basename(f, ext);
    const m = /^(\d+)-([a-z0-9]+)$/.exec(stem);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue; // 刚被删掉，跳过
    }
    recovered.push({
      id: m ? `${m[1]}-${m[2]}` : stem,
      path: abs,
      name: m ? stem.slice(`${m[1]}-`.length) + ext : f,
      size,
      addedAt: new Date().toISOString()
    });
  }

  const merged = [...alive, ...recovered];
  if (merged.length !== items.length || recovered.length > 0) {
    await writeJsonAtomic(indexFile(userData, kind), merged);
    if (recovered.length > 0) {
      console.log(`[素材库] ${kind}: 从磁盘恢复了 ${recovered.length} 个未登记的素材`);
    }
  }
  return merged;
}

export interface ImportResult {
  ok: boolean;
  imported: AssetItem[];
  skipped: number;
  errors: string[];
}

/**
 * 批量导入。复制进素材库而不是记原路径 —— 见文件头说明。
 * 重复的(同名同大小)直接跳过,免得连点两次导入就多出两张一样的图。
 */
export async function importAssets(
  userData: string,
  kind: AssetKind,
  srcPaths: string[],
  copy = true
): Promise<ImportResult> {
  const allowed = kind === "covers" ? COVER_EXT : TAIL_EXT;
  const dir = filesDir(userData, kind);
  await mkdir(dir, { recursive: true });

  const existing = await listAssets(userData, kind);
  const imported: AssetItem[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const raw of srcPaths) {
    const abs = String(raw || "").trim();
    if (!abs) continue;
    if (!existsSync(abs)) {
      errors.push(`${basename(abs)}: 文件不存在`);
      continue;
    }
    const ext = extname(abs).toLowerCase();
    if (!allowed.has(ext)) {
      errors.push(`${basename(abs)}: ${kind === "covers" ? "不是图片" : "不是视频"}（支持 ${[...allowed].join(" ")}）`);
      continue;
    }
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      errors.push(`${basename(abs)}: 读不到（${(err as Error).message}）`);
      continue;
    }
    if (kind === "tails" && st.size > MAX_TAIL_BYTES) {
      errors.push(`${basename(abs)}: 超过 ${Math.round(MAX_TAIL_BYTES / 1024 / 1024)}MB，藏带货片段不该这么大`);
      continue;
    }
    const name = basename(abs);
    if (existing.some((x) => x.name === name && x.size === st.size)) {
      skipped++;
      continue;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dest = join(dir, `${id}${ext}`);
    try {
      if (copy) {
        await copyFile(abs, dest);
      } else {
        await writeFile(dest, await readFile(abs));
      }
    } catch (err) {
      errors.push(`${name}: 复制失败（${(err as Error).message}）`);
      continue;
    }
    const item: AssetItem = { id, path: dest, name, size: st.size, addedAt: new Date().toISOString() };
    imported.push(item);
  }

  if (imported.length > 0) {
    await writeJsonAtomic(indexFile(userData, kind), [...existing, ...imported]);
  }
  return { ok: true, imported, skipped, errors };
}

/**
 * 删除素材。先进回收站再删清单 ——
 * 误删一批封面图是件很烦人的事(要重新导),能一键恢复就还好。
 */
export async function deleteAssets(
  userData: string,
  kind: AssetKind,
  ids: string[]
): Promise<{ ok: boolean; deleted: number; errors: string[] }> {
  const items = await listAssets(userData, kind);
  const want = new Set(ids.map(String));
  const keep = items.filter((x) => !want.has(x.id));
  const removed = items.filter((x) => want.has(x.id));
  if (removed.length === 0) return { ok: true, deleted: 0, errors: [] };

  const trash = join(trashDir(userData, kind), `${Date.now()}`);
  await mkdir(trash, { recursive: true });
  const errors: string[] = [];
  let deleted = 0;
  const stillReferenced: string[] = [];

  for (const it of removed) {
    try {
      await mkdir(trash, { recursive: true });
      // 同名会撞车(两批素材可能同名),所以带上 id 前缀
      await rename(it.path, join(trash, `${it.id}-${safeSegment(it.name)}`));
      deleted++;
    } catch (err) {
      errors.push(`${it.name}: 移入回收站失败（${(err as Error).message}）`);
      stillReferenced.push(it.id);
    }
  }

  await writeJsonAtomic(indexFile(userData, kind), keep.filter((x) => !stillReferenced.includes(x.id)));
  return { ok: true, deleted, errors };
}

/** 恢复最近一次删除。素材库小,只保留最近 5 批回收站 */
export async function restoreAssets(userData: string, kind: AssetKind): Promise<{
  ok: boolean;
  restored: number;
  errors: string[];
}> {
  const trashRoot = trashDir(userData, kind);
  let batches: string[];
  try {
    batches = (await readdir(trashRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return { ok: true, restored: 0, errors: [] };
  }
  if (batches.length === 0) return { ok: true, restored: 0, errors: [] };

  const batch = batches[0];
  if (!batch) return { ok: true, restored: 0, errors: [] };
  const from = join(trashRoot, batch);
  const dir = filesDir(userData, kind);
  await mkdir(dir, { recursive: true });
  const items = await listAssets(userData, kind);
  const errors: string[] = [];
  let restored = 0;

  for (const f of await readdir(from)) {
    const src = join(from, f);
    const ext = extname(f).toLowerCase();
    // 文件名是 "<id>-<原名>",拆回来
    const id = f.split("-").slice(0, 2).join("-");
    const name = safeSegment(f.slice(id.length + 1));
    const dest = join(dir, f);
    try {
      await rename(src, dest);
      let size = 0;
      try {
        size = (await stat(dest)).size;
      } catch {
        /* 大小拿不到就填 0,不影响使用 */
      }
      if (!items.some((x) => x.id === id)) {
        items.push({ id, path: dest, name, size, addedAt: new Date().toISOString() });
      }
      restored++;
    } catch (err) {
      errors.push(`${f}: 恢复失败（${(err as Error).message}）`);
    }
  }

  await writeJsonAtomic(indexFile(userData, kind), items);
  try {
    await unlink(from).catch(() => undefined);
  } catch {
    /* 目录非空(有恢复失败的)就留着,别删 */
  }
  // 只留最近 5 批
  const keep = batches.slice(0, 5);
  for (const b of batches.slice(5)) {
    await unlink(join(trashRoot, b)).catch(() => undefined);
  }
  void keep;
  return { ok: true, restored, errors };
}

/**
 * 选一条素材。random 是这里做的,不用主进程随机、渲染层随机 ——
 * 那样"这次选中了什么"就没法在界面上回显,用户会以为设置没生效。
 * @returns 选中的素材;没有可用素材时返回 null
 */
export async function pickAsset(
  userData: string,
  kind: AssetKind,
  usePath: string | undefined,
  pick: "first" | "last" | "random" | undefined
): Promise<AssetItem | null> {
  const items = await listAssets(userData, kind);
  if (items.length === 0) return null;
  // 指定了路径就用它(哪怕已经不在库里也不静默换人 ——
  // 静默换一张会让用户烧进片子的封面变成另一张,而且完全无感知)
  if (usePath) {
    const hit = items.find((x) => x.path === usePath);
    if (hit) return hit;
  }
  if (items.length === 1) return items[0] ?? null;
  const mode = pick || "first";
  if (mode === "last") return items[items.length - 1] ?? null;
  if (mode === "random") return items[Math.floor(Math.random() * items.length)] ?? null;
  return items[0] ?? null;
}
