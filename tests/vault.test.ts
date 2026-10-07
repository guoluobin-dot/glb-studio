/**
 * 爆款库 vault 模块的行为测试
 *
 * 用临时目录跑,不动真实用户数据。
 * 重点验三件容易做错的事:
 *  1) 每个 IP 必须是独立文件夹,互相看不见对方的数据
 *  2) 撤回必须真删干净(索引 + 磁盘文件),不能留孤儿
 *  3) 校准必须随数据叠加变化,撤掉后要跟着回去
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIp,
  listIps,
  deleteIp,
  restoreLastDeletedIp,
  renameIp,
  importEntries,
  undoBatch,
  deleteEntry,
  listEntries,
  listBatches,
  rebuildProfile,
  getProfile,
  profileToBrief
} from "../src/main/vault";
import type { HitEntry } from "../src/shared/api-types";

let root = "";

const mkEntry = (n: number, over: Partial<HitEntry> = {}): HitEntry => ({
  id: `e${n}`,
  sourceKey: `hit-${n}`,
  title: `爆款 ${n}`,
  sourcePath: `D:/素材/爆款${n}.mp4`,
  totalSec: 60 + n,
  segments: [
    { type: "hook_opening", startMs: 0, endMs: 8000, keyText: `钩子${n}`, intensity: 0.8 },
    { type: "peak_moment", startMs: 8000, endMs: (60 + n) * 1000, intensity: 0.9 }
  ],
  metrics: { hookStrength: 0.7 + n * 0.05, emotion: 0.6, infoDensity: 0.75, cutCount: 6 + n },
  hooks: [`钩子句式${n}`],
  tags: [`主题${n % 2}`],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vault-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 第一个 IP。测试用例直接解构会被 TS 判可能 undefined,统一走这里断言 */
const ipOf = async (i = 0) => {
  const list = await listIps(root);
  const found = list[i];
  if (!found) throw new Error(`第 ${i} 个 IP 不存在`);
  return found;
};

describe("IP 档案:一个老师一个独立文件夹", () => {
  it("能创建,同名会被拒绝", async () => {
    const a = await createIp(root, "案例老师");
    expect(a).not.toBeNull();
    expect((await createIp(root, "李老师"))).not.toBeNull();
    // 同名拒绝:否则两个文件夹抢同一套记忆,用户选了哪个都不确定
    expect(await createIp(root, "案例老师")).toBeNull();
    expect((await listIps(root)).length).toBe(2);
  });

  it("每个 IP 有自己的文件夹", async () => {
    const a = await ipOf(0);
    const b = await ipOf(1);
    expect(existsSync(join(root, "hits", a.id, "clips"))).toBe(true);
    expect(existsSync(join(root, "hits", b.id))).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it("能重命名", async () => {
    const a = await ipOf();
    expect((await renameIp(root, a.id, "某某老师"))?.name).toBe("某某老师");
  });

  it("IP 之间数据不串", async () => {
    const a = await ipOf(0);
    const b = await ipOf(1);
    await importEntries(root, a.id, [mkEntry(1), mkEntry(2)]);
    expect((await listEntries(root, a.id)).length).toBe(2);
    expect((await listEntries(root, b.id)).length).toBe(0);
  });
});

describe("批量导入", () => {
  it("逐条落盘,单个文件坏不会带走整份索引", async () => {
    const a = await ipOf();
    const r = await importEntries(root, a.id, [mkEntry(3), mkEntry(4), mkEntry(5)]);
    expect(r.imported).toBe(3);
    expect(r.ok).toBe(true);
    const files = readdirSync(join(root, "hits", a.id, "clips")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2 + 3);
  });

  it("重复导入跳过而不是报错(同步历史数据时重跑是正常操作)", async () => {
    const a = await ipOf();
    const r = await importEntries(root, a.id, [mkEntry(3), mkEntry(6)]);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("坏数据不拖垮整批", async () => {
    const a = await ipOf();
    const r = await importEntries(root, a.id, [
      { ...mkEntry(20), sourceKey: "" },
      { ...mkEntry(21), sourceKey: "ok-21" }
    ]);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("重复同步必须刷新派生字段", () => {
  // 回归：早先刷新路径只合 prediction/metrics/viralPoints 等原始字段，
  // 漏了 themes / tags / hooks / genre —— 它们都是从 Hermes 侧**派生**的。
  // 于是 Hermes 那边换词表重算了主题，用户点"把已分析结果写入记忆库"，
  // 老条目还是旧主题名，看起来就像同步没生效。
  // 派生字段最容易漏，因为它们不在原始字段列表里。
  it("themes / tags / hooks / genre 都要跟着刷新", async () => {
    const a = await ipOf();
    const old = mkEntry(30, {
      themes: [{ themeName: "高音技巧教学", keywords: ["高音"], confidence: 0.9 }],
      tags: ["高音技巧教学"],
      hooks: ["旧钩子"],
      genre: "旧分类"
    });
    await importEntries(root, a.id, [old]);

    const fresh = mkEntry(30, {
      themes: [{ themeName: "高音突破", keywords: ["高音", "鼻孔发力"], confidence: 0.95 }],
      tags: ["高音突破", "hook_opening×1"],
      hooks: ["新钩子"],
      genre: "新分类"
    });
    const r = await importEntries(root, a.id, [fresh]);

    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(0);
    expect(r.refreshed).toBe(1);

    const got = (await listEntries(root, a.id)).find((e) => e.sourceKey === "hit-30");
    expect(got?.themes?.[0]?.themeName).toBe("高音突破");
    expect(got?.tags).toContain("高音突破");
    expect(got?.hooks).toEqual(["新钩子"]);
    expect(got?.genre).toBe("新分类");
  });

  it("Hermes 没给新值时不能把本地已有的清空", async () => {
    const a = await ipOf();
    await importEntries(root, a.id, [
      mkEntry(31, { tags: ["本地标签"], hooks: ["本地钩子"], genre: "本地分类" })
    ]);
    // 空数组/空串不算"有值"：Hermes 这次没给主题，不能把本地已有的抹掉
    await importEntries(root, a.id, [
      mkEntry(31, { themes: [], tags: [], hooks: [], genre: null })
    ]);

    const got = (await listEntries(root, a.id)).find((e) => e.sourceKey === "hit-31");
    expect(got?.tags).toEqual(["本地标签"]);
    expect(got?.hooks).toEqual(["本地钩子"]);
    expect(got?.genre).toBe("本地分类");
  });
});

describe("撤回", () => {
  // 撤回后批次就没了,所以这里必须先把 batchId 记下来给下一个用例用
  let undoneBatchId = "";

  it("能按批次撤回,索引和磁盘文件一起清", async () => {
    const a = await ipOf();
    const batches = await listBatches(root, a.id);
    expect(batches.length).toBeGreaterThanOrEqual(2);

    const target = batches.find((x) => x.count === 3);
    expect(target).toBeDefined();
    undoneBatchId = target!.batchId;

    const undone = await undoBatch(root, a.id, undoneBatchId);
    expect(undone.ok).toBe(true);
    expect(undone.removed).toBe(3);

    const left = await listEntries(root, a.id);
    const files = readdirSync(join(root, "hits", a.id, "clips")).filter((f) => f.endsWith(".json"));
    // 索引和磁盘必须一致,否则下次导入会产生重复行
    expect(files.length).toBe(left.length);
  });

  it("重复撤回明确报错,不静默成功", async () => {
    const a = await ipOf();
    const again = await undoBatch(root, a.id, undoneBatchId);
    expect(again.ok).toBe(false);
    expect(again.error).toBeTruthy();
  });

  it("IP 计数跟着更新", async () => {
    const a = await ipOf();
    const ip = (await listIps(root)).find((i) => i.id === a.id);
    expect(ip!.entryCount).toBe((await listEntries(root, a.id)).length);
  });
});

describe("校准随数据叠加", () => {
  it("算出各维度基准与节奏", async () => {
    const ip = await createIp(root, "校准IP");
    await importEntries(root, ip!.id, [mkEntry(30), mkEntry(31), mkEntry(32)]);
    const p = await getProfile(root, ip!.id);
    expect(p!.sampleCount).toBe(3);
    expect(p!.dimensions.some((d) => d.key === "hookStrength")).toBe(true);
    expect(p!.dimensions.some((d) => d.key === "pace")).toBe(true);
    expect(p!.pace).toBeGreaterThan(0);
    expect(p!.topHooks.length).toBeGreaterThan(0);
  });

  it("新增爆款后画像跟着变", async () => {
    const ip = (await listIps(root)).find((i) => i.name === "校准IP")!;
    const before = (await getProfile(root, ip.id))!.dimensions.find((d) => d.key === "hookStrength")!.value;
    await importEntries(root, ip.id, [mkEntry(33)]);
    const p = await getProfile(root, ip.id);
    const after = p!.dimensions.find((d) => d.key === "hookStrength")!.value;
    expect(p!.sampleCount).toBe(4);
    expect(before).not.toBe(after);
  });

  it("结论可追溯到具体爆款(否则用户没法质疑画像)", async () => {
    const ip = (await listIps(root)).find((i) => i.name === "校准IP")!;
    const dim = (await getProfile(root, ip.id))!.dimensions.find((d) => d.key === "hookStrength")!;
    expect(dim.contributing.length).toBeGreaterThan(0);
  });

  it("用中位数而不是均值,单条异常值不能绑架画像", async () => {
    const ip = await createIp(root, "抗异常");
    await importEntries(root, ip!.id, [mkEntry(40), mkEntry(41), mkEntry(42, {
      metrics: { hookStrength: 99, emotion: 0.5, infoDensity: 0.5, cutCount: 6 }
    })]);
    const dim = (await getProfile(root, ip!.id))!.dimensions.find((d) => d.key === "hookStrength")!;
    // 中位数应落在 0.9 附近;均值会被 99 拉到 30 以上
    expect(dim.value).toBeGreaterThan(0.8);
    expect(dim.value).toBeLessThan(5);
  });

  it("空库不编造结论", async () => {
    const ip = await createIp(root, "空IP");
    const p = await rebuildProfile(root, ip!.id);
    expect(p!.sampleCount).toBe(0);
    expect(p!.dimensions.length).toBe(0);
    // null 表示"样本不足",0 会被误读成"节奏为零"
    expect(p!.pace).toBeNull();
  });

  it("brief 能直接进 prompt", async () => {
    const ip = (await listIps(root)).find((i) => i.name === "校准IP")!;
    const brief = profileToBrief(await getProfile(root, ip.id));
    expect(brief).toContain("爆款画像");
    expect(brief).toContain("样本 4 条");
    expect(brief).toContain("高频钩子");
    expect(brief).toContain("叠加校准");
    expect(profileToBrief(null)).toBe("");
  });
});

describe("删除与恢复", () => {
  it("删除进回收站并能恢复", async () => {
    const victim = await createIp(root, "待删除IP");
    expect(await deleteIp(root, victim!.id, true)).toBe(true);
    expect(existsSync(join(root, "hits", victim!.id))).toBe(false);
    expect(existsSync(join(root, "hits", ".trash"))).toBe(true);
    expect((await listIps(root)).some((i) => i.id === victim!.id)).toBe(false);

    const back = await restoreLastDeletedIp(root);
    expect(back?.id).toBe(victim!.id);
    expect(existsSync(join(root, "hits", victim!.id))).toBe(true);
  });

  it("彻底删除不留痕迹", async () => {
    const victim = await createIp(root, "彻底删除");
    expect(await deleteIp(root, victim!.id, false)).toBe(true);
    expect(existsSync(join(root, "hits", victim!.id))).toBe(false);
  });

  it("删除单条", async () => {
    const ip = (await listIps(root)).find((i) => i.name === "校准IP")!;
    const entries = await listEntries(root, ip.id);
    const n = entries.length;
const victim = entries[0];
    expect(victim).toBeDefined();
    expect(await deleteEntry(root, ip.id, victim!.id)).toBe(true);
    expect((await listEntries(root, ip.id)).length).toBe(n - 1);
  });

  it("删除不存在的返回 false 而不是抛错", async () => {
    const ip = (await listIps(root)).find((i) => i.name === "校准IP")!;
    expect(await deleteEntry(root, ip.id, "不存在的id")).toBe(false);
    expect(await undoBatch(root, ip.id, "不存在的批次")).toMatchObject({ ok: false });
    expect(await deleteIp(root, "不存在的id")).toBe(false);
  });
});