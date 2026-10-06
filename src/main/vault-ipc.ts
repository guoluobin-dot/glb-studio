/**
 * 爆款记忆库的 IPC 层 + 从 Hermes 历史库同步
 *
 * 数据结构本身在 vault.ts,这里只负责:
 *  1) 把 vault 的能力挂成 IPC
 *  2) 把 Hermes 里的历史爆款搬进 vault,并映射成 HitEntry
 */
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import {
  listIps, createIp, renameIp, deleteIp, restoreLastDeletedIp,
  listEntries, importEntries, undoBatch, deleteEntry, listBatches,
  rebuildProfile, getProfile, profileToBrief, attachSources
} from "./vault";
import type { HermesClient } from "./hermes-client";
import type { HitEntry, HitProfile, HitSegment } from "@shared/api-types";

/** Hermes /api/hits/export 的返回形状 */
interface HermesHitExport {
  ok: boolean;
  count: number;
  hits: Array<{
    id: number;
    videoPath: string;
    videoName: string;
    title: string;
    collection: string;
    genre: string;
    durationSec: number;
    openingScript: string;
    fullTranscript: string;
    viralPoints: Array<{ point?: string; evidence?: string; weight?: number }>;
    onScreenTexts: Array<{ time_seconds?: number; text?: string; type?: string }>;
    emotionCurve: Array<{
      start_seconds?: number; end_seconds?: number; emotion?: string;
      facial_expression?: string; voice_tone?: string; intensity?: number;
    }>;
    coverFrame: string;
    analyzedAt: string;
    structures: Array<{
      type: string; startMs: number; endMs: number;
      description?: string; keyText?: string; emotionTag?: string;
      intensity?: number; keyframePath?: string;
    }>;
    themes: Array<{ themeName?: string; keywords?: string[]; confidence?: number }>;
    patterns: Array<{ type: string; text: string; effectiveness?: number | null; timeMs?: number | null }>;
    performance: {
      views?: number | null; likes?: number | null;
      comments?: number | null; shares?: number | null; favorites?: number | null;
    } | null;
    /**
     * 爆款预测（Hermes 侧的 hit_predictions）。
     * 以前这个接口不导出它，所以桌面端有数据也看不到预测值。
     */
    prediction: {
      viewsLow?: number | null; viewsHigh?: number | null;
      likes?: number | null; comments?: number | null;
      shares?: number | null; favorites?: number | null;
      /** 把握度：高/中/低 */
      confidence?: string;
      /** 一句话依据，中文 */
      rationale?: string;
    } | null;
  }>;
}

/**
 * Hermes 爆款 -> HitEntry
 *
 * 指标(metrics)怎么算:这里全部**从内容本身推导**,没有一个是我拍脑袋的权重。
 * 因为目前 hit_performance 是空表(没有真实播放数据),任何"钩子强度 0.8"
 * 之类的常数都只是我的主观标准 —— 那等于把没验证的先验当成从数据里学出来的结论。
 * 所以做法是:能从内容客观算出来的就算,算不出来的字段留空,
 * 让画像在缺那一维时直接不显示该维度,而不是显示一个编出来的数。
 *
 * 真正客观可算的:
 *  - infoDensity:信息点密度 = (结构段数 + 关键词数) / 时长。
 *    同样 3 分钟,分 8 段讲 8 个点 vs 分 3 段讲 3 个点,前者密度更高。
 *  - emotion:情绪强度,直接取 emotion_curve 各点 intensity 的中位数(抗单点异常)。
 *  - hookStrength:钩子强度取 hook_opening 段的 intensity;没有标注就留空。
 *  - cutCount:用结构段数当剪辑点数,节奏 = 刀/分钟。
 *  - retention/views/likes:没有真实数据就是 null,不猜。
 */
function toHitEntry(h: HermesHitExport["hits"][number]): HitEntry {
  const segments: HitSegment[] = (h.structures ?? []).map((s) => ({
    type: s.type,
    startMs: s.startMs,
    endMs: s.endMs,
    description: s.description,
    keyText: s.keyText,
    emotionTag: s.emotionTag,
    intensity: s.intensity ?? undefined,
    keyframePath: s.keyframePath
  }));

  const median = (nums: number[]): number | undefined => {
    const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (s.length === 0) return undefined;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  };

  // 结构类型出现次数 -> 该条爆款内部的节奏形态
  const typeCount = new Map<string, number>();
  for (const s of segments) typeCount.set(s.type, (typeCount.get(s.type) ?? 0) + 1);

  // 钩子句式:优先取开头逐字稿,其次取 hook 类型的文案模式
  const hooks: string[] = [];
  if (h.openingScript?.trim()) hooks.push(h.openingScript.trim().slice(0, 120));
  for (const p of h.patterns ?? []) {
    if (p.type === "hook" && p.text?.trim()) hooks.push(p.text.trim().slice(0, 120));
  }

  const tags: string[] = [];
  for (const t of h.themes ?? []) if (t.themeName) tags.push(String(t.themeName).slice(0, 24));
  for (const [type, n] of typeCount) tags.push(`${type}×${n}`);

  const sec = Number(h.durationSec) || 0;
  const keywordCount = (h.themes ?? []).reduce((sum, t) => sum + (t.keywords?.length ?? 0), 0);
  const infoDensity = sec > 0 ? Math.round(((segments.length + keywordCount) / sec) * 1000) / 1000 : undefined;
  const emotion = median((h.emotionCurve ?? []).map((p) => Number(p.intensity ?? NaN)));
  const hookIntensity = segments.find((s) => s.type === "hook_opening")?.intensity;

  const perf = h.performance;
  return {
    id: `hermes-${h.id}`,
    sourceKey: h.videoPath,
    title: h.title || h.videoName,
    sourcePath: h.videoPath,
    genre: h.genre || null,
    totalSec: sec,
    openingScript: h.openingScript,
    fullTranscript: h.fullTranscript,
    viralPoints: h.viralPoints,
    onScreenTexts: h.onScreenTexts,
    emotionCurve: h.emotionCurve,
    segments,
    themes: h.themes,
    metrics: {
      hookStrength: Number.isFinite(Number(hookIntensity)) ? Number(hookIntensity) : undefined,
      emotion: emotion !== undefined ? Math.round(emotion * 1000) / 1000 : undefined,
      infoDensity,
      // 剪辑点数用结构段数近似:真实刀数要靠 ffmpeg 逐帧数,现在没有
      cutCount: segments.length,
      // 没有真实播放数据就留空,不要填 0 冒充"零播放"
      views: perf?.views ?? undefined,
      likes: perf?.likes ?? undefined,
      shares: perf?.shares ?? undefined,
      comments: perf?.comments ?? undefined
    },
    // 预测单独放，绝不塞进 metrics：
    // metrics 里是回流真实数，prediction 是模型估的，
    // 混起来界面就没法告诉用户"这个数是猜的"，而用户会当参考用。
    prediction: h.prediction ?? null,
    hooks: [...new Set(hooks)],
    tags: [...new Set(tags)],
    createdAt: h.analyzedAt ? new Date(h.analyzedAt).toISOString() : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function registerVaultIpc(
  handle: <T>(channel: string, fn: (...args: never[]) => Promise<T> | T) => void,
  userData: () => string,
  client: HermesClient,
  getWindow: () => BrowserWindow | null
): void {
  handle("hit:listIps", () => listIps(userData()));

  /**
   * 新建 IP = 本地建文件夹 **+** Hermes 建同名 collection。
   *
   * 以前只做前半截，于是出现过一个很难查的状态：
   * 界面上 IP 好好地建出来了，Hermes 里根本没有这个 collection，
   * 之后所有学习样本都按"没有归属"落库 ——
   * 表现是该老师的记忆永远是空的，但没有任何一处报错。
   *
   * 两边的对应关系是**名字**（Hermes 的 /memory-brief、
   * review_edits.collection、hotwords.collection 全都按名字归属），
   * 不是本地那个 uuid。所以必须传 name，不能传 id。
   *
   * Hermes 建失败不回滚本地 IP：本地文件夹才是界面的真相，
   * 删掉它反而会连带丢用户刚建的档案。失败如实回传，让 UI 提示。
   * createCollection 是 INSERT OR IGNORE，重复调用安全。
   */
  handle("hit:createIp", async (name: string, note?: string) => {
    const made = await createIp(userData(), name, note ?? "");
    if (!made) return null; // 同名/空名：交给上层提示
    try {
      const r = await client.post<{ ok: boolean; name?: string }>("/api/collections", { name: made.name });
      return { ...made, hermesSynced: r?.ok === true };
    } catch (err) {
      return {
        ...made,
        hermesSynced: false,
        hermesError: err instanceof Error ? err.message : String(err)
      };
    }
  });
  handle("hit:renameIp", (ipId: string, name: string, note?: string) =>
    renameIp(userData(), ipId, name, note)
  );
  handle("hit:deleteIp", (ipId: string, toTrash?: boolean) => deleteIp(userData(), ipId, toTrash !== false));
  handle("hit:restoreIp", () => restoreLastDeletedIp(userData()));
  handle("hit:listEntries", (ipId: string) => listEntries(userData(), ipId));
  handle("hit:import", (ipId: string, entries: HitEntry[]) => importEntries(userData(), ipId, entries ?? []));
  handle("hit:listBatches", (ipId: string) => listBatches(userData(), ipId));

  /**
   * 上传数据截图更正爆款预测。
   *
   * screenshot 走 base64 data URL，Hermes 那边会存盘并用视觉模型 OCR
   * 出播放/点赞/评论/转发/收藏，顺带识别平台，然后立刻按真实数据重算预测。
   * 所以这里**不能**自己 OCR —— 交给 Hermes，桌面端只负责把图送过去。
   *
   * 注意 express.json 的上限是 15mb，base64 后还要再放大 4/3，
   * 所以桌面端必须先压图再发；压不动就明确报错，不能默默截断。
   */
  handle("hit:feedback", async (payload: {
    /** Hermes 侧的 hit_videos.id，不是本地条目 uuid */
    hitId: number;
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
    platform?: string;
    note?: string;
    /** data:image/xxx;base64,... */
    screenshot?: string;
  }) => {
    const hitId = Number(payload.hitId);
    if (!Number.isInteger(hitId) || hitId <= 0) {
      return { ok: false, error: "缺少素材 id" };
    }
    try {
      const r = await client.post<{
        ok?: boolean;
        error?: string;
        prediction?: Record<string, unknown> | null;
        ocr?: Record<string, unknown> | null;
        platform?: string | null;
      }>(`/hits/${hitId}/feedback`, {
        views: payload.views ?? null,
        likes: payload.likes ?? null,
        comments: payload.comments ?? null,
        shares: payload.shares ?? null,
        favorites: payload.favorites ?? null,
        platform: payload.platform ?? "",
        note: (payload.note ?? "").slice(0, 200),
        screenshot: payload.screenshot ?? ""
}, 300_000);
      /*
       * prediction 要**归一化成驼峰**再往外给。
       *
       * Hermes 那边返回的是库里原样字段（views_low / views_high），
       * 而桌面端其他所有字段都是驼峰。混着给的话，
       * 调用方读 `prediction.viewsLow` 拿到 undefined，
       * 而 `undefined !== 任何数` 恒成立 ——
       * 于是"预测有没有被重算"这种判断永远是 true，
       * 界面一直显示"已重算"，实际区间根本没读到。
       */
      const raw = (r?.prediction ?? {}) as Record<string, unknown>;
      const numOrNull = (v: unknown): number | null =>
        Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
      const prediction = r?.prediction
        ? {
            viewsLow: numOrNull(raw.viewsLow ?? raw.views_low),
            viewsHigh: numOrNull(raw.viewsHigh ?? raw.views_high),
            likes: numOrNull(raw.likes),
            comments: numOrNull(raw.comments),
            shares: numOrNull(raw.shares),
            favorites: numOrNull(raw.favorites),
            confidence: String(raw.confidence || ""),
            rationale: String(raw.rationale || "")
          }
        : null;
      return {
        ok: r?.ok !== false,
        prediction,
        ocr: r?.ocr ?? null,
        platform: r?.platform ?? null,
        error: r?.error
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * 某条素材的 Hermes 侧 id（截图更正要用）。
   *
   * 按 sourcePath 查而不是在本地存映射：
   * sourceKey 就是源文件路径，两边一致，
   * 省掉一份"本地 uuid ↔ Hermes id"的映射表要同步维护。
   */
  handle("hit:resolveHermesId", async (ipName: string, sourcePath: string) => {
    try {
      const data = await client.get<HermesHitExport>("/api/hits/export", 60_000);
      if (!data?.ok || !Array.isArray(data.hits)) return null;
      const want = String(sourcePath || "").replace(/\\/g, "/").toLowerCase();
      const hit = data.hits.find((h) => String(h.videoPath || "").replace(/\\/g, "/").toLowerCase() === want);
      return hit?.id ?? null;
    } catch {
      // 查不到就返回 null，UI 会提示先同步 —— 不能假装成功
      return null;
    }
  });
  handle("hit:undoBatch", (ipId: string, batchId: string) => undoBatch(userData(), ipId, batchId));
  handle("hit:deleteEntry", (ipId: string, entryId: string) => deleteEntry(userData(), ipId, entryId));
  handle("hit:profile", (ipId: string) => getProfile(userData(), ipId));
  handle("hit:rebuildProfile", (ipId: string) => rebuildProfile(userData(), ipId));
  handle("hit:profileBrief", async (ipId: string) => profileToBrief(await getProfile(userData(), ipId)));

  /* ---------- 导入 ---------- */

  /**
   * 从 Hermes 历史爆款库同步。
   *
   * 按 collection 分 IP 档案 —— 这正是"一个 IP 老师一个文件夹"的来源:
   * Hermes 里的 collection 本来就是按老师分的,直接沿用,不用让用户重录一遍。
   * 没归集合的落到"未分类",不能丢。
   */
  handle("hit:syncFromHermes", async (ipName?: string) => {
    try {
      const data = await client.get<HermesHitExport>("/api/hits/export", 60_000);
      if (!data?.ok || !Array.isArray(data.hits)) {
        return { ok: false, imported: 0, skipped: 0, errors: ["Hermes 返回格式不对"] };
      }

      // 按集合分组
      const groups = new Map<string, HitEntry[]>();
      for (const h of data.hits) {
        const key = String(h.collection || "").trim() || "未分类";
        const list = groups.get(key) ?? [];
        list.push(toHitEntry(h));
        groups.set(key, list);
      }

      // 只同步一个 IP 时,别的集合跳过
      const wanted = ipName?.trim();
      let totalImported = 0;
      let totalSkipped = 0;
      let totalRefreshed = 0;
      const errors: string[] = [];
      let lastIpId: string | undefined;

      for (const [name, entries] of groups) {
        if (wanted && name !== wanted) continue;
        const existing = (await listIps(userData())).find((i) => i.name === name);
        const ip = existing ?? (await createIp(userData(), name, `从 Hermes 历史爆款库同步`));
        if (!ip) {
          errors.push(`${name}:IP 创建失败`);
          continue;
        }
        lastIpId = ip.id;
        const r = await importEntries(userData(), ip.id, entries);
        totalImported += r.imported;
        totalSkipped += r.skipped;
        /*
         * refreshed 必须往外传。
         * 以前重复同步一律算"skipped"，而 Hermes 侧补上的预测就靠这条刷新 ——
         * 界面收到 skipped 就不当回事，用户看到"预测怎么不变"。
         */
        totalRefreshed += r.refreshed ?? 0;
        errors.push(...r.errors);
      }

      if (!wanted && !lastIpId) {
        return { ok: false, imported: 0, skipped: 0, refreshed: 0, errors: ["没有可同步的爆款(只有 completed 的才会导出)"] };
      }
      return { ok: errors.length === 0, imported: totalImported, skipped: totalSkipped, refreshed: totalRefreshed, errors, ipId: lastIpId };
    } catch (err) {
      return {
        ok: false,
        imported: 0,
        skipped: 0,
        errors: [err instanceof Error ? err.message : String(err)]
      };
    }
  });

  /* ---------- 批量导入本地文件 ---------- */

  /**
   * 从磁盘批量导入爆款素材。
   *
   * 这里只登记引用(不复制 GB 级视频),真正的分析仍走 Hermes。
   * copy=true 才复制 —— 用于原盘会删的场景。
   */
  handle("hit:importFiles", async (ipId: string, copy?: boolean) => {
    const win = getWindow();
    if (!win) return { ok: false, imported: 0, errors: ["窗口不可用"] };
    const res = await dialog.showOpenDialog(win, {
      title: "选择爆款素材",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "avi", "flv"] }]
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: true, imported: 0, skipped: 0, errors: [] };
    }

    const attached = await attachSources(userData(), ipId, res.filePaths, copy === true);

    /*
     * 登记完必须**真的排进 Hermes 的分析队列**，否则上传等于没做。
     *
     * 以前到这里就结束了：只往 sources.log 写一行路径，
     * 不调 Hermes、不触发分析、不生成条目 —— 界面显示"上传成功"，
     * 但素材既没被拆解也没进画像，用户以为已经学进去了。
     *
     * 传路径不传字节：E:\直播\ 这类素材可以就地分析，
     * 不用把 GB 级文件再拷一份到上传目录。
     *
     * 失败不吞：Hermes 没起来或路径不在白名单，要如实回传，
     * 否则又变成"看起来成功、其实没生效"。
     */
    const ip = (await listIps(userData())).find((i) => i.id === ipId);
    const enqueue: {
      queued: number;
      rejected: { videoPath: string; reason: string }[];
      message: string;
      error?: string;
    } = { queued: 0, rejected: [], message: "" };

    if (!ip) {
      enqueue.error = "IP 不存在，没法确定归属";
    } else {
      try {
        const r = await client.post<{
          queued?: number;
          rejected?: { videoPath?: string; path?: string; reason?: string }[];
          message?: string;
        }>("/hits/enqueue", { paths: attached.attached, collection: ip.name }, 60_000);
        enqueue.queued = r?.queued ?? 0;
        enqueue.rejected = (r?.rejected ?? []).map((x) => ({
          videoPath: String(x.videoPath ?? x.path ?? ""),
          reason: String(x.reason ?? "")
        }));
        enqueue.message = String(r?.message ?? "");
      } catch (err) {
        enqueue.error = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      ...attached,
      enqueue
    };
  });

  /* ---------- 把爆款画像喂给分析引擎 ---------- */

  /**
   * 取出指定 IP 的画像文字,供分析/出片时进 prompt。
   * 不传 ipId 就用第一个 —— 单 IP 用户不该被迫先选一个。
   */
  handle("hit:briefFor", async (ipId?: string) => {
    const ips = await listIps(userData());
    const ip = ipId ? ips.find((i) => i.id === ipId) : ips[0];
    if (!ip) return "";
    return profileToBrief(await getProfile(userData(), ip.id));
  });

  /**
   * 选定 IP -> 同时设定 Hermes 的 active collection。
   *
   * 为什么必须联动:Hermes 的 /memory-brief 是按 collection 算的(它的 collection
   * 本来就是"一个老师一个文件夹")。不设它,分析时拿到的永远是上次那套记忆 ——
   * 表现为"我在界面上选了案例老师,结果用的是别的老师",而且不报错。
   *
   * 失败不回滚选择:设定失败只影响记忆质量,不该让用户的操作看起来没生效。
   */
  handle("hit:activateIp", async (ipId: string) => {
    const ip = (await listIps(userData())).find((i) => i.id === ipId);
    if (!ip) return { ok: false, error: "IP 不存在" };
    try {
      await client.post("/api/active-collection", { name: ip.name });
      return { ok: true, ipName: ip.name, entryCount: ip.entryCount };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ipName: ip.name };
    }
  });

  /** 取该 IP 在 Hermes 侧的 brief(分析时真正进 prompt 的那份) */
  handle("hit:hermesBrief", async (ipId?: string) => {
    const ips = await listIps(userData());
    const ip = ipId ? ips.find((i) => i.id === ipId) : ips[0];
    if (!ip) return "";
    try {
      const brief = await client.get<Record<string, unknown>>("/memory-brief", 30_000);
      // 确认 Hermes 认的是我们以为的那个集合;不一致就明确说出来,
      // 不能让用户以为在用 A 的记忆、实际在用 B 的
      if (brief?.collection !== ip.name) {
        return "";
      }
      return brief as unknown as string;
    } catch {
      return "";
    }
  });
}

export type { HermesHitExport };
export { toHitEntry };
