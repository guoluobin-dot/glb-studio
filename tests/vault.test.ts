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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIp,
  listIps,
  deleteIp,
  restoreLastDeletedIp,
  listTrashItems,
  restoreTrashItem,
  purgeTrashItem,
  emptyTrash,
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

describe("回收站列表要和实际恢复的那一个一致", () => {
  // 界面的悬停提示要靠它告诉用户"现在能恢复谁"。
  // 如果列表顺序和真正恢复的顺序不是同一份实现，
  // 就会提示能恢复 A、点下去恢复出 B，而用户分不清是提示错了还是恢复错了。
  it("列表第一个就是恢复动作会恢复的那一个", async () => {
    const trash = join(root, "hits", ".trash");
    rmSync(trash, { recursive: true, force: true });

    const a = await createIp(root, "先删的老师");
    await new Promise((r) => setTimeout(r, 5));
    const b = await createIp(root, "后删的老师");
    expect(a && b).toBeTruthy();

    await deleteIp(root, a!.id, true);
    await new Promise((r) => setTimeout(r, 5));
    await deleteIp(root, b!.id, true);

    const list = await listTrashItems(root);
    expect(list.length).toBe(2);
    expect(list[0]!.name).toBe("后删的老师");

    const back = await restoreLastDeletedIp(root);
    expect(back?.name).toBe("后删的老师");
    // TrashItem 没有 id（界面靠 trashDir 定位），所以这里比名字和落盘结果
    expect(back?.id).toBe(b!.id);
    expect(existsSync(join(root, "hits", b!.id))).toBe(true);
    // 恢复的正是列表里那一个，不是别的东西
    expect((await listTrashItems(root)).map((i) => i.name)).toEqual(["先删的老师"]);
  });

  it("回收站里最新那项坏了不能连累下面还能恢复的", async () => {
    /*
     * 回归：早先先取最新的目录名、再去读它的 collection.json，
     * 读不到就直接 return null —— 明明下面还有能恢复的，
     * 界面却说"没有可恢复的 IP"，回收站里的东西再也回不来。
     */
    const trash = join(root, "hits", ".trash");
    rmSync(trash, { recursive: true, force: true });

    const good = await createIp(root, "能恢复的老师");
    await new Promise((r) => setTimeout(r, 5));
    const bad = await createIp(root, "资料坏了的老师");
    await deleteIp(root, good!.id, true);
    await new Promise((r) => setTimeout(r, 5));
    await deleteIp(root, bad!.id, true);

    // 破坏"最新那项"的 collection.json
    const newest = readdirSync(trash).sort().reverse()[0]!;
    writeFileSync(join(trash, newest, "collection.json"), "{ 这不是合法 JSON", "utf8");

    const list = await listTrashItems(root);
    expect(list.map((i) => i.name)).toEqual(["能恢复的老师"]);

    const back = await restoreLastDeletedIp(root);
    expect(back?.name).toBe("能恢复的老师");
    expect(existsSync(join(root, "hits", good!.id))).toBe(true);
  });

  it("回收站为空时返回空数组，恢复返回 null", async () => {
    rmSync(join(root, "hits", ".trash"), { recursive: true, force: true });
    expect(await listTrashItems(root)).toEqual([]);
    expect(await restoreLastDeletedIp(root)).toBeNull();
  });

  it("彻底删除的东西不会出现在回收站里（那是不可逆的，得说清）", async () => {
    const trash = join(root, "hits", ".trash");
    rmSync(trash, { recursive: true, force: true });
    const gone = await createIp(root, "不可逆删除");
    await deleteIp(root, gone!.id, false);
    expect(await listTrashItems(root)).toEqual([]);
  });
});

describe("回收站：挑着恢复、彻底删除、清空", () => {
  const seed = async (names: string[]) => {
    rmSync(join(root, "hits", ".trash"), { recursive: true, force: true });
    const ids: string[] = [];
    for (const n of names) {
      const ip = await createIp(root, n);
      ids.push(ip!.id);
      await new Promise((r) => setTimeout(r, 5));
      await deleteIp(root, ip!.id, true);
      await new Promise((r) => setTimeout(r, 5));
    }
    return ids;
  };

  it("能只恢复指定的某一位，不是只能恢复最近那个", async () => {
    await seed(["早的", "中的", "晚的"]);
    const items = await listTrashItems(root);
    expect(items.map((i) => i.name)).toEqual(["晚的", "中的", "早的"]);

    const mid = items[1]!;
    const back = await restoreTrashItem(root, mid.trashDir);
    expect(back?.name).toBe("中的");
    expect(existsSync(join(root, "hits", back!.id))).toBe(true);

    // 恢复走的是"搬回目录"，回收站里就不该再有这一项
    const after = await listTrashItems(root);
    expect(after.map((i) => i.name)).not.toContain("中的");
    expect(after.length).toBe(2);
  });

  it("彻底删除指定项，目录真没了", async () => {
    await seed(["要留着的", "要彻底删的"]);
    // 按名字挑，不靠顺序 —— seed 是先建先删，列表里最新的是最后删的那个
    const items = await listTrashItems(root);
    const target = items.find((i) => i.name === "要彻底删的")!;
    expect(target).toBeDefined();

    expect(await purgeTrashItem(root, target.trashDir)).toBe(true);
    expect(existsSync(join(root, "hits", ".trash", target.trashDir))).toBe(false);
    const left = await listTrashItems(root);
    expect(left.map((i) => i.name)).toEqual(["要留着的"]);
  });

  it("彻底删除不接受越权路径：不能拿它删 hits/ 下的正经档案", async () => {
    rmSync(join(root, "hits", ".trash"), { recursive: true, force: true });
    // 正主必须是在线的 IP（seed 会把建好的都删进回收站，所以这里单独建）
    const live = await createIp(root, "在线的老师");
    expect(live).toBeDefined();
    await seed(["回收站里的"]);

    // 各种想逃出 .trash 的写法
    for (const evil of [
      "..",
      "../" + live!.id,
      "..\\" + live!.id,
      "../../..",
      join("hits", live!.id),
      live!.id,
      "",
      "不存在的目录名"
    ]) {
      expect(await purgeTrashItem(root, evil), `不该允许删: ${evil}`).toBe(false);
    }
    // 正主还好好地在那儿，而且还在 IP 列表里
    expect(existsSync(join(root, "hits", live!.id))).toBe(true);
    expect((await listIps(root)).some((i) => i.id === live!.id)).toBe(true);
  });

  it("清空回收站，连恢复不了的残骸一起扫掉", async () => {
    await seed(["一位", "二位"]);
    // 造一个没有 collection.json 的残骸：恢复不了，但会一直占着盘
    const junk = join(root, "hits", ".trash", "1700000000000-残骸");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "collection.json"), "坏掉", "utf8");

    const n = await emptyTrash(root);
    expect(n).toBe(3);   // 两位老师 + 一份残骸
    expect(await listTrashItems(root)).toEqual([]);
    expect(existsSync(junk)).toBe(false);
  });

  it("清空空回收站不会报错（本来就没东西可清）", async () => {
    rmSync(join(root, "hits", ".trash"), { recursive: true, force: true });
    expect(await emptyTrash(root)).toBe(0);
  });

  it("列表项带 trashDir 和删除时间，界面才能精确定位并说清什么时候删的", async () => {
    await seed(["带信息的"]);
    const item = (await listTrashItems(root))[0]!;
    expect(item.name).toBe("带信息的");
    expect(item.trashDir).toMatch(/^\d+-带信息的$/);
    expect(Number.isFinite(Date.parse(item.deletedAt))).toBe(true);
    expect(typeof item.entryCount).toBe("number");
  });
});