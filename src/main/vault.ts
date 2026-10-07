/**
 * 爆款记忆库(独立数据文件夹)
 *
 * 为什么要单独一个文件夹,而不是继续塞进 Hermes 的 sqlite:
 * - 用户要求"项目里单独开一个文件夹作为数据库",每个 IP 老师一个文件夹,
 *   能创建、能删除、能自己看见里面的东西。sqlite 里做不到这一点。
 * - 素材文件本身必须落在磁盘上(方便定位/二次处理),sqlite 存不了。
 *
 * 目录约定(userData 下):
 *   hits/<ipId>/index.json      该 IP 的爆款条目 + 校准画像
 *   hits/<ipId>/clips/*.json    每条爆款的片段级数据
 *   hits/<ipId>/source/*.mp4    原始素材(可选,引用式不复制)
 *   hits/index.json             IP 名单
 *
 * 校准为什么是"叠加"而不是"覆盖":
 * 每条爆款只贡献一部分证据(钩子句式/节奏/情绪/信息密度),新加的爆款
 * 在旧画像上做增量更新,并保留 contribution 明细 —— 用户要能回答
 * "这个结论是因为哪几条爆款",否则画像没法被质疑,也就没法被修正。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { HitCollection, HitEntry, HitProfile, HitImportResult } from "@shared/api-types";

const MEDIA_EXT = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv"]);

function rootOf(userData: string): string {
  return join(userData, "hits");
}
function indexFile(userData: string): string {
  return join(rootOf(userData), "index.json");
}
function ipDir(userData: string, ipId: string): string {
  // ipId 只允许安全字符:它会被拼进磁盘路径,不能带 ../ 之类
  return join(rootOf(userData), safeSegment(ipId));
}

/** 目录名净化:防路径穿越,这是磁盘结构最外层的防线 */
function safeSegment(name: string): string {
  return String(name)
    .replace(/[^\w一-龥.-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 60) || "_";
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 原子写:先写 tmp 再 rename。直接覆盖的话中途断电会留下半个 JSON,
 *  读的时候 parse 失败 -> fallback -> 用户以为数据被清空了 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/* ------------------------------------------------------------------ *
 * IP 档案
 * ------------------------------------------------------------------ */

export async function listIps(userData: string): Promise<HitCollection[]> {
  const idx = await readJson<{ ips?: HitCollection[] }>(indexFile(userData), { ips: [] });
  return (idx.ips ?? []).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function saveIps(userData: string, ips: HitCollection[]): Promise<void> {
  await mkdir(rootOf(userData), { recursive: true });
  await writeJsonAtomic(indexFile(userData), { ips });
}

export async function createIp(
  userData: string,
  name: string,
  note = ""
): Promise<HitCollection | null> {
  const trimmed = String(name ?? "").trim().slice(0, 40);
  if (!trimmed) return null;
  const ips = await listIps(userData);
  if (ips.some((i) => i.name === trimmed)) return null;

  const now = new Date().toISOString();
  const ip: HitCollection = {
    id: randomUUID(),
    name: trimmed,
    note: String(note ?? "").slice(0, 500),
    entryCount: 0,
    totalSec: 0,
    createdAt: now,
    updatedAt: now
  };
  await mkdir(join(ipDir(userData, ip.id), "clips"), { recursive: true });
  await writeJsonAtomic(join(ipDir(userData, ip.id), "collection.json"), ip);
  await saveIps(userData, [ip, ...ips]);
  return ip;
}

export async function renameIp(
  userData: string,
  ipId: string,
  name: string,
  note?: string
): Promise<HitCollection | null> {
  const trimmed = String(name ?? "").trim().slice(0, 40);
  if (!trimmed) return null;
  const ips = await listIps(userData);
  const hit = ips.find((i) => i.id === ipId);
  if (!hit) return null;
  if (ips.some((i) => i.name === trimmed && i.id !== ipId)) return null;

  hit.name = trimmed;
  if (note !== undefined) hit.note = String(note).slice(0, 500);
  hit.updatedAt = new Date().toISOString();
  await saveIps(userData, ips);
  return hit;
}

/**
 * 删除 IP。
 *
 * 默认连磁盘文件夹一起删 —— 只删索引会留下一堆看不见也删不掉的孤儿目录,
 * 用户下次"导入"时又会看到残留。
 * moveToTrash=true 时改为移到 hits/.trash/,给一次反悔的机会。
 */
export async function deleteIp(
  userData: string,
  ipId: string,
  moveToTrash = false
): Promise<boolean> {
  const ips = await listIps(userData);
  const hit = ips.find((i) => i.id === ipId);
  if (!hit) return false;
  const dir = ipDir(userData, ipId);

  if (moveToTrash) {
    const trash = join(rootOf(userData), ".trash", `${Date.now()}-${safeSegment(hit.name)}`);
    await mkdir(join(rootOf(userData), ".trash"), { recursive: true });
    try {
      await rename(dir, trash);
    } catch {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    await rm(dir, { recursive: true, force: true });
  }

  await saveIps(userData, ips.filter((i) => i.id !== ipId));
  return true;
}

/** 恢复误删的 IP(从 .trash 里找最近一次) */
export async function restoreLastDeletedIp(userData: string): Promise<HitCollection | null> {
  const trashRoot = join(rootOf(userData), ".trash");
  if (!existsSync(trashRoot)) return null;
  const items = (await readdir(trashRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  const newest = items[0];
  if (!newest) return null;

  const dir = join(trashRoot, newest);
  const saved = await readJson<HitCollection | null>(join(dir, "collection.json"), null);
  if (!saved?.id) return null;

  // 目标目录必须先不存在。
  // 以前这里先 mkdir 再 rename,Windows 上 rename 目录进已存在的目录会直接失败,
  // 于是 catch 掉 return null —— 界面表现为"点了恢复没反应",回收站里的东西永远回不来。
  const dest = ipDir(userData, saved.id);
  await rm(dest, { recursive: true, force: true });
  try {
    await rename(dir, dest);
  } catch (err) {
    return null;
  }
  await mkdir(join(dest, "clips"), { recursive: true });
  const ips = await listIps(userData);
  await saveIps(userData, [saved, ...ips.filter((i) => i.id !== saved.id)]);
  return saved;
}

/* ------------------------------------------------------------------ *
 * 爆款条目
 * ------------------------------------------------------------------ */

async function entriesFile(userData: string, ipId: string): Promise<string> {
  return join(ipDir(userData, ipId), "index.json");
}

export async function listEntries(userData: string, ipId: string): Promise<HitEntry[]> {
  const raw = await readJson<{ entries?: HitEntry[] }>(await entriesFile(userData, ipId), { entries: [] });
  return raw.entries ?? [];
}

async function saveEntries(userData: string, ipId: string, entries: HitEntry[]): Promise<void> {
  await mkdir(join(ipDir(userData, ipId), "clips"), { recursive: true });
  await writeJsonAtomic(await entriesFile(userData, ipId), { entries });
}

/** 每条爆款落一个独立文件:单个文件坏了不会带走整份索引 */
async function saveEntryFile(userData: string, ipId: string, entry: HitEntry): Promise<void> {
  const dir = join(ipDir(userData, ipId), "clips");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, `${entry.id}.json`), entry);
}

/**
 * 批量导入爆款素材。
 *
 * "批量"是指一次可以传多条(从 Hermes 同步、或用户一次拖进来多个文件)。
 * 逐条写盘而不是攒到最后一次写:中途失败时前面几条已经落盘,
 * 用户重试不会丢。失败原因逐条返回,不因为一条坏数据整批失败。
 */
export async function importEntries(
  userData: string,
  ipId: string,
  incoming: HitEntry[]
): Promise<HitImportResult> {
  const ips = await listIps(userData);
  const ip = ips.find((i) => i.id === ipId);
  if (!ip) return { ok: false, imported: 0, skipped: 0, errors: ["IP 不存在"], batchId: null };

  const existing = await listEntries(userData, ipId);
  /*
   * 去重键要**归一化**，不能直接拿 sourceKey 原样比。
   *
   * sourceKey 就是视频路径，可 Windows 上同一个文件可能是
   * "D:\a\b.mp4" 也可能是 "D:/a/b.mp4"（Hermes 统一存正斜杠，
   * 本地某些流程存反斜杠）。原样比较的话两条会被当成不同素材，
   * 于是同步会插出重复条目 —— 而重复条目会一起进画像，
   * 把中位数算歪。
   */
  const normKey = (s: unknown): string => String(s ?? "").replace(/\\/g, "/").trim().toLowerCase();
  const seen = new Set(existing.map((e) => normKey(e.sourceKey)).filter(Boolean));

  const batchId = randomUUID();
  const now = new Date().toISOString();
  const added: HitEntry[] = [];
  const errors: string[] = [];
  let skipped = 0;
  /** 已有条目被刷新（不是新增）的条数 */
  let refreshed = 0;

for (const raw of incoming) {
    const sourceKey = String(raw.sourceKey ?? raw.title ?? "").trim();
    if (!sourceKey) {
      errors.push("缺少 sourceKey,已跳过");
      skipped++;
      continue;
    }
    if (seen.has(normKey(sourceKey))) {
      /*
       * 同一条爆款重复导入：不新增条目，但**要把新字段合并进已有那条**。
       *
       * 只跳过是不够的：Hermes 侧后来补了 prediction / performance，
       * 而本地那条是旧的 —— 于是用户点了"从历史爆款库同步"，
       * 界面上的预测永远不更新，看起来像"同步没生效"。
       * 这正是爆款预测加了之后立刻会撞上的问题。
       */
      const prev = existing.find((e) => normKey(e.sourceKey) === normKey(sourceKey));
      if (prev) {
        const merged: HitEntry = {
          ...prev,
          // 新数据优先，但别用 undefined/null 覆盖掉已有的真值
          prediction: raw.prediction ?? prev.prediction ?? null,
          metrics: { ...prev.metrics, ...stripUndefined(raw.metrics) },
          viralPoints: raw.viralPoints ?? prev.viralPoints,
          onScreenTexts: raw.onScreenTexts ?? prev.onScreenTexts,
          emotionCurve: raw.emotionCurve ?? prev.emotionCurve,
          openingScript: raw.openingScript ?? prev.openingScript,
          fullTranscript: raw.fullTranscript ?? prev.fullTranscript,
          segments: prev.segments?.length ? prev.segments : raw.segments,
          /*
           * themes / tags / hooks 也要刷新 —— 早先漏了，症状是
           * "改了词表归一了主题，同步之后老条目还是旧主题名"。
           * 这三个字段都不是原始字段，而是从 Hermes 侧派生出来的：
           *   tags  = themes 的名字 + 结构段统计
           *   hooks = openingScript + patterns 里的 hook
           * 所以只要 Hermes 那边重算过（换词表、重新分析），
           * 本地这条就跟着过期了。openingScript 明明在刷新列表里，
           * hooks 却不刷新 —— 派生关系最容易漏的就是这一层。
           *
           * genre 同理，Hermes 侧改了分类本地不会变。
           * 空数组/空串不算"有值"，否则 Hermes 没给会清掉本地已有的。
           */
          themes: raw.themes?.length ? raw.themes : prev.themes,
          tags: raw.tags?.length ? raw.tags : prev.tags,
          hooks: raw.hooks?.length ? raw.hooks : prev.hooks,
          genre: raw.genre ?? prev.genre,
          updatedAt: now
        };
        added.push(merged);
        try {
          await saveEntryFile(userData, ipId, merged);
          refreshed++;
        } catch (e) {
          errors.push(`${merged.title}:${e instanceof Error ? e.message : String(e)}`);
        }
      }
      skipped++;
      continue;
    }
    seen.add(normKey(sourceKey));

    const entry: HitEntry = {
      ...raw,
      id: raw.id && !added.some((a) => a.id === raw.id) ? raw.id : randomUUID(),
      sourceKey,
      title: String(raw.title ?? sourceKey).slice(0, 120),
      sourcePath: raw.sourcePath ?? "",
      totalSec: Number(raw.totalSec) || 0,
      segments: Array.isArray(raw.segments) ? raw.segments : [],
      metrics: raw.metrics ?? {},
      tags: raw.tags ?? [],
      batchId,
      createdAt: raw.createdAt ?? now,
      updatedAt: now
    };
    added.push(entry);
    try {
      await saveEntryFile(userData, ipId, entry);
    } catch (e) {
      errors.push(`${entry.title}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (added.length > 0) {
    /*
     * 合并时必须按归一化后的 sourceKey 去重。
     * 直接 `[...added, ...existing]` 会把"刷新过的旧条目"和它自己的新版本
     * 都塞进去 —— 同一条素材出现两次，两份都会进画像，把中位数算歪。
     */
    const byKey = new Map<string, HitEntry>();
    for (const e of [...existing, ...added]) {
      const k = normKey(e.sourceKey) || `id:${e.id}`;
      byKey.set(k, e);
    }
    const all = [...byKey.values()];
    await saveEntries(userData, ipId, all);
    ip.entryCount = all.length;
    ip.totalSec = all.reduce((s, e) => s + (Number(e.totalSec) || 0), 0);
    ip.updatedAt = now;
    await saveIps(userData, ips);
    // 新增爆款后重算画像:这是"叠加校准"的触发点
    await rebuildProfile(userData, ipId);
  }

  return {
    ok: errors.length === 0,
    imported: added.length - refreshed,
    skipped,
    errors,
    // refreshed 让 UI 能说清"没有新增，只是把已有条目的预测更新了"，
    // 而不是笼统报"已登记 N 个"，让用户以为同步没生效。
    refreshed,
    batchId: added.length - refreshed > 0 ? batchId : null
  };
}

/** 去掉 undefined/null 的键，避免用空值覆盖掉已有真值 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Partial<T>;
}

/** 撤回一批导入 */
export async function undoBatch(
  userData: string,
  ipId: string,
  batchId: string
): Promise<{ ok: boolean; removed: number; error?: string }> {
  const entries = await listEntries(userData, ipId);
  const doomed = entries.filter((e) => e.batchId === batchId);
  if (doomed.length === 0) return { ok: false, removed: 0, error: "这批导入已经不在了(可能已撤回过)" };

  for (const e of doomed) {
    await rm(join(ipDir(userData, ipId), "clips", `${e.id}.json`), { force: true });
  }
  const rest = entries.filter((e) => e.batchId !== batchId);
  await saveEntries(userData, ipId, rest);

  const ips = await listIps(userData);
  const ip = ips.find((i) => i.id === ipId);
  if (ip) {
    ip.entryCount = rest.length;
    ip.totalSec = rest.reduce((s, e) => s + (Number(e.totalSec) || 0), 0);
    ip.updatedAt = new Date().toISOString();
    await saveIps(userData, ips);
    await rebuildProfile(userData, ipId);
  }
  return { ok: true, removed: doomed.length };
}

export async function deleteEntry(
  userData: string,
  ipId: string,
  entryId: string
): Promise<boolean> {
  const entries = await listEntries(userData, ipId);
  const rest = entries.filter((e) => e.id !== entryId);
  if (rest.length === entries.length) return false;
  await rm(join(ipDir(userData, ipId), "clips", `${entryId}.json`), { force: true });
  await saveEntries(userData, ipId, rest);

  const ips = await listIps(userData);
  const ip = ips.find((i) => i.id === ipId);
  if (ip) {
    ip.entryCount = rest.length;
    ip.totalSec = rest.reduce((s, e) => s + (Number(e.totalSec) || 0), 0);
    ip.updatedAt = new Date().toISOString();
    await saveIps(userData, ips);
    await rebuildProfile(userData, ipId);
  }
  return true;
}

/** 导入批次列表:给 UI 的"撤回"按钮用 */
export async function listBatches(
  userData: string,
  ipId: string
): Promise<Array<{ batchId: string; count: number; at: string; sample: string }>> {
  const entries = await listEntries(userData, ipId);
  const map = new Map<string, { count: number; at: string; sample: string }>();
  for (const e of entries) {
    if (!e.batchId) continue;
    const cur = map.get(e.batchId) ?? { count: 0, at: e.createdAt, sample: e.title };
    cur.count++;
    map.set(e.batchId, cur);
  }
  return [...map.entries()]
    .map(([batchId, v]) => ({ batchId, ...v }))
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

/* ------------------------------------------------------------------ *
 * 校准:从历史爆款反推"爆款感"的构成
 * ------------------------------------------------------------------ */

/**
 * 重建画像。
 *
 * 关键取舍:这里的"权重"全部来自数据,不是我拍脑袋定的行业经验值。
 * 具体做法是按维度算各爆款的表现分,再取中位数 —— 用中位数而不是均值,
 * 因为爆款数据天然长尾(有一条特别猛会把均值拉走,导致画像被单个异常值绑架)。
 *
 * 每维都记 contributing,用户能追到"这条结论来自哪几条"。
 */
export async function rebuildProfile(userData: string, ipId: string): Promise<HitProfile | null> {
  const entries = await listEntries(userData, ipId);
  const ip = (await listIps(userData)).find((i) => i.id === ipId);
  if (!ip) return null;

  if (entries.length === 0) {
    const empty: HitProfile = {
      ipId,
      ipName: ip.name,
      sampleCount: 0,
      updatedAt: new Date().toISOString(),
      dimensions: [],
      topHooks: [],
      topThemes: [],
      pace: null,
      contributions: []
    };
    await writeJsonAtomic(join(ipDir(userData, ipId), "profile.json"), empty);
    return empty;
  }

  // 用中位数而不是均值:爆款数据天然长尾,一条特别猛会把均值拉走,
    // 导致整个画像被单个异常值绑架。
  const median = (nums: number[]): number => {
    const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (s.length === 0) return 0;
    const mid = Math.floor(s.length / 2);
    // 偶数个时取中间两个的平均;用 ?? 0 兜住边界,避免 TS 认为可能越界
    if (s.length % 2 === 1) return s[mid] ?? 0;
    return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  };

  // 每个维度:取值 -> {分数, 贡献条目}
  // 显式列出各维度数组而不是 Record<string, ...>:后者让 TS 认为每个键都可能 undefined,
  // 后面 dims.hookStrength.push(...) 全是报错,而这里它们必然存在。
  const dims = {
    hookStrength: [] as Array<{ score: number; title: string }>,
    pace: [] as Array<{ score: number; title: string }>,
    emotion: [] as Array<{ score: number; title: string }>,
    infoDensity: [] as Array<{ score: number; title: string }>,
    retention: [] as Array<{ score: number; title: string }>
  };
  const hookCount = new Map<string, number>();
  const themeCount = new Map<string, number>();

  for (const e of entries) {
    const m = e.metrics ?? {};
    if (Number.isFinite(Number(m.hookStrength))) dims.hookStrength.push({ score: Number(m.hookStrength), title: e.title });
    if (Number.isFinite(Number(m.emotion))) dims.emotion.push({ score: Number(m.emotion), title: e.title });
    if (Number.isFinite(Number(m.infoDensity))) dims.infoDensity.push({ score: Number(m.infoDensity), title: e.title });
    if (Number.isFinite(Number(m.retention))) dims.retention.push({ score: Number(m.retention), title: e.title });

    const secs = Number(e.totalSec) || 0;
    const cuts = Number(m.cutCount) || 0;
    // 节奏 = 每分钟剪辑点数量。直播切成短视频,切得越碎通常越"紧"。
    if (secs > 0) dims.pace.push({ score: (cuts / secs) * 60, title: e.title });

    for (const h of e.hooks ?? []) {
      const t = String(h).trim();
      if (t) hookCount.set(t, (hookCount.get(t) ?? 0) + 1);
    }
    for (const t of e.tags ?? []) {
      const s = String(t).trim();
      if (s) themeCount.set(s, (themeCount.get(s) ?? 0) + 1);
    }
  }

  const DIM_LABEL: Record<string, string> = {
    hookStrength: "开头钩子强度",
    pace: "剪辑节奏(刀/分钟)",
    emotion: "情绪强度",
    infoDensity: "信息密度",
    retention: "完播表现"
  };

  const dimensions = Object.entries(dims)
    .filter(([, arr]) => arr.length > 0)
    .map(([key, arr]) => {
      const value = median(arr.map((a) => a.score));
      // contributing 只留最贴近中位数的几条,按距离排序
      const contributing = [...arr]
        .sort((a, b) => Math.abs(a.score - value) - Math.abs(b.score - value))
        .slice(0, 5)
        .map((a) => a.title);
      return {
        key,
        label: DIM_LABEL[key] ?? key,
        value: Math.round(value * 1000) / 1000,
        sampleCount: arr.length,
        contributing
      };
    })
    .sort((a, b) => b.value - a.value);

  const top = (m: Map<string, number>, n: number): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);

  const profile: HitProfile = {
    ipId,
    ipName: ip.name,
    sampleCount: entries.length,
    updatedAt: new Date().toISOString(),
    dimensions,
    topHooks: top(hookCount, 12),
    topThemes: top(themeCount, 12),
    pace: dims.pace.length ? Math.round(median(dims.pace.map((a) => a.score)) * 100) / 100 : null,
    contributions: entries.slice(-30).map((e) => ({
      entryId: e.id,
      title: e.title,
      totalSec: Number(e.totalSec) || 0,
      addedAt: e.createdAt
    }))
  };

  await writeJsonAtomic(join(ipDir(userData, ipId), "profile.json"), profile);
  return profile;
}

export async function getProfile(userData: string, ipId: string): Promise<HitProfile | null> {
  return readJson<HitProfile | null>(join(ipDir(userData, ipId), "profile.json"), null);
}

/**
 * 把画像压成一段可直接进 prompt 的文字。
 *
 * Gemini 那边要的就是这种"一进来就懂"的东西,所以这里必须输出成
 * 可直接阅读的结论,而不是原始分数表 —— 模型看原始分数自己推,
 * 每次推出来的还不一样。
 */
export function profileToBrief(p: HitProfile | null): string {
  if (!p || p.sampleCount === 0) return "";
  const lines: string[] = [];
  lines.push(`【${p.ipName} 的爆款画像 · 样本 ${p.sampleCount} 条】`);
  if (p.dimensions.length) {
    lines.push("特征基准(取样本中位数,抗异常值):");
    for (const d of p.dimensions) {
      lines.push(`- ${d.label}: ${d.value}(${d.sampleCount} 条样本)`);
    }
  }
  if (p.pace !== null) lines.push(`- 剪辑节奏基准: ${p.pace} 刀/分钟`);
  if (p.topHooks.length) lines.push(`高频钩子句式: ${p.topHooks.join(" / ")}`);
  if (p.topThemes.length) lines.push(`高频主题: ${p.topThemes.join(" / ")}`);
  lines.push(`(画像更新时间 ${p.updatedAt},新增爆款会自动叠加校准)`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 素材文件登记(只登记引用,不复制大文件)
 * ------------------------------------------------------------------ */

/**
 * 把素材文件登记进 IP 文件夹。
 *
 * 默认"引用"不复制:直播素材动辄几个 GB,复制一份会让磁盘爆掉,
 * 而用户真正要的是能在库里看见并定位。
 * copy=true 时才复制 —— 用于"素材要长期留存、原盘会删"的场景。
 */
export async function attachSources(
  userData: string,
  ipId: string,
  paths: string[],
  copy = false
): Promise<{ ok: boolean; attached: string[]; errors: string[] }> {
  const dir = join(ipDir(userData, ipId), "source");
  await mkdir(dir, { recursive: true });
  const attached: string[] = [];
  const errors: string[] = [];

  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      errors.push(`${basenameSafe(abs)}: 文件不存在`);
      continue;
    }
    if (!MEDIA_EXT.has(extname(abs).toLowerCase())) {
      errors.push(`${basenameSafe(abs)}: 不是视频文件`);
      continue;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        errors.push(`${basenameSafe(abs)}: 不是文件`);
        continue;
      }
      const dest = join(dir, `${Date.now()}-${basenameSafe(abs)}`);
      if (copy) {
        await copyFile(abs, dest);
      }
      await appendFile(
        join(ipDir(userData, ipId), "sources.log"),
        `${new Date().toISOString()}\t${st.size}\t${copy ? dest : abs}\n`,
        "utf8"
      );
      attached.push(copy ? dest : abs);
    } catch (e) {
      errors.push(`${basenameSafe(abs)}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0, attached, errors };
}

function basenameSafe(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
