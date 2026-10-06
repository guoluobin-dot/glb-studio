/**
 * Hermes 客户端:GLB Studio 的算法层唯一入口。
 *
 * 设计要点:
 * 1. 算法(转写/爆点/成片/记忆)全部由本地 Hermes 服务承担,主进程只做编排。
 * 2. 长直播(2-5 小时)逐句稿超出本地模型上下文,Hermes 侧支持云端长上下文引擎;
 *    本层只负责把引擎选择、记忆档案 id 透传下去。
 * 3. 所有调用带超时与错误归一,主进程不因算法失败而崩溃。
 */
import { request } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { applyHotwords } from "@shared/hotwords";

/**
 * 这轮出片到底需不需要走 /pipeline/generate（包装阶段）。
 *
 * 抽成函数是因为原来这个判定在 export() 和 wrapExistingProject() 里各写了一份,
 * 两份都漏过东西 —— 加新选项时改一处忘一处,症状是"点了出片没反应"。
 * 现在只有这一处,加选项只需要改这里。
 *
 * 注意 coverImage/tailVideo 也算：只开"用我上传的封面图"而把
 * 字幕、烧标题、生成封面全关掉时，同样必须走包装阶段，
 * 否则用户勾的东西完全不起作用。
 */
function wantsPackaging(opts: RenderOptions): boolean {
  if (opts.subtitles !== false || opts.covers !== false || opts.title !== false || opts.titleText) {
    return true;
  }
  // 上传的封面图：选了图就要烧文案 + 当首帧
  if (opts.coverImage?.usePath) return true;
  // 结尾藏带货
  if (opts.tailVideo?.usePath) return true;
  // 只要设了样式就说明用户想改字的样子，即便没开烧字也不该静默跳过
  if (opts.captionFontStyle || opts.titleFontStyle) return true;
  return false;
}
import type {
  ClipCandidate,
  ClipSegmentMap,
  DetectionRequest,
  DetectionStats,
  EditArchive,
  EditArchiveListItem,
  EditRecordInput,
  ExportRequest,
  ExportResult,
  HotwordRule,
  LocalStackStatus,
  RenderOptions,
  Transcript,
  VariantResult
} from "@shared/api-types";

const DEFAULT_PORT = 17841;

/**
 * Hermes live-analyzer 的分段行。
 *
 * 注意:两种字段名都出现过,必须都认 ——
 *  - 驼峰:服务端已归一化后的结构(startMs / themeName / hookQuality)
 *  - 下划线:LLM 原始输出(start_seconds / theme_name / hook_quality)
 * 之前只认驼峰,而服务端返回的是下划线,结果 210 条候选全是
 * "未命名片段 / 0.0s→0.0s"。双格式兼容 + 时长兜底,任何一侧出问题都不会静默变空。
 */
interface HermesLiveSegment {
  segmentIndex?: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  themeName?: string;
  themeConfidence?: number;
  hookQuality?: number;
  peakCount?: number;
  transcriptSummary?: string;
  status?: string;
  // 下划线原始字段
  segment_index?: number;
  start_seconds?: number;
  end_seconds?: number;
  theme_name?: string;
  confidence?: number;
  hook_quality?: number;
  matched_themes?: unknown;
  matched_hit_themes?: unknown;
  transcript_summary?: string;
}

/** 取分段起止毫秒,兼容两种字段名;都没有时返回 null 以便报警。 */
function segmentRangeMs(seg: HermesLiveSegment): { startMs: number; endMs: number } | null {
  if (Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs)) {
    return { startMs: Number(seg.startMs), endMs: Number(seg.endMs) };
  }
  if (Number.isFinite(seg.start_seconds) && Number.isFinite(seg.end_seconds)) {
    return {
      startMs: Math.round(Number(seg.start_seconds) * 1000),
      endMs: Math.round(Number(seg.end_seconds) * 1000)
    };
  }
  return null;
}

/** Hermes 分段行 -> 界面候选卡。id 用 segmentIndex,因为出片选段按它索引。 */
function toClipCandidate(seg: HermesLiveSegment, index: number): ClipCandidate {
  const range = segmentRangeMs(seg);
  const startMs = range?.startMs ?? 0;
  const endMs = range?.endMs ?? startMs;
  // 时长兜底:段库里有 duration_ms 时用它,避免两端相等导致"0 秒片段"
  const durMs = endMs > startMs ? endMs - startMs : Number(seg.durationMs ?? 0);
  const summary = seg.transcriptSummary ?? seg.transcript_summary ?? "";
  const theme = seg.themeName || seg.theme_name || "未命名片段";
  const hook = seg.hookQuality ?? seg.hook_quality ?? 0.5;
  const confidence = seg.themeConfidence ?? seg.confidence ?? 0;
  // 分数统一到 0~100。
  //
  // Hermes 给的是 0~1 的 hook_quality,而界面按 0~100 显示与分档(>=85 热、>=70 暖)。
  // 以前两边都没转,结果每条都显示"—",分数分档功能等于没生效。
  const score100 = Math.round(Math.max(0, Math.min(1, hook)) * 100);
  return {
    id: seg.segmentIndex ?? seg.segment_index ?? index,
    startSec: startMs / 1000,
    endSec: (startMs + (durMs || endMs - startMs)) / 1000,
    // Hermes 只给摘要,不给完整逐句稿;text 复用摘要,保证界面有话可说。
    text: summary,
    title: theme,
    hook: summary.slice(0, 20),
    score: score100,
    // 理由如实说明打分来源,不编造 UI 概念(情绪/事件/弹幕等 Hermes 长直播不产出)。
    reason: `钩子分 ${hook.toFixed(2)}｜主题置信度 ${confidence.toFixed(2)}`,
    reviewNote: "",
    boundary: "natural",
    keywords: theme ? [theme] : [],
    recommended: score100 >= 60
  };
}

export interface HermesOptions {
  port?: number;
  timeoutMs?: number;
}

/** 统一错误:带 HTTP 状态或网络原因,便于界面提示。 */
export class HermesError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "HermesError";
  }
}

export class HermesClient {
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: HermesOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 单次 HTTP 调用,带超时;非 2xx 抛 HermesError。 */
  /** 只读 GET 的对外入口。同步历史爆款时主进程要用,但不该给渲染层随意调任意路径的能力。 */
  async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.call<T>("GET", path, undefined, timeoutMs);
  }

  /** POST 的对外入口。只给主进程内部少量确定用途用(比如切 active collection)。 */
  async post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.call<T>("POST", path, body ?? {}, timeoutMs);
  }

  /**
   * 加 DELETE 是因为要能删热词规则。
   * 之前只支持 GET/POST，结果"删除"只能靠改名字绕过 ——
   * 于是"加错了想撤掉"这个最常见的操作做不了。
   */
  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          path,
          method,
          headers: {
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {})
          },
          timeout: timeoutMs ?? this.timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new HermesError(`Hermes ${status}: ${text.slice(0, 200)}`, status));
              return;
            }
            if (!text) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new HermesError(`Hermes 返回非 JSON: ${text.slice(0, 120)}`, status));
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new HermesError("Hermes 调用超时"));
      });
      req.on("error", (err) => reject(new HermesError(`无法连接 Hermes(${this.base}): ${err.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 健康检查:主进程启动时探测,失败时界面给出"请先启动 Hermes"提示。 */
  async health(): Promise<boolean> {
    try {
      const res = await this.call<{ ok?: boolean }>("GET", "/health", undefined, 4000);
      return res?.ok === true;
    } catch {
      return false;
    }
  }

  /** 本地栈状态:Ollama + Hermes 存活情况,供顶栏状态灯。 */
  async stackStatus(ollama: { ok: boolean; models: string[] }): Promise<LocalStackStatus> {
    const ok = await this.health();
    return { ollama, hermes: { ok } };
  }

  /**
   * 语音转写(素材体检)。
   *
   * 关键事实(Hermes 无独立 ASR 端点):ASR 跑在 analyze-live 内部,
   * 逐句稿只落 live_videos.asr_path,不通过 HTTP 直接吐。
   * 所以这里不能在分析前"预转写"——那会把 3 小时 ASR 白跑一遍。
   * 这里只确认素材可进入管线,逐句稿由 detect 一并带回。
   */
  async transcribe(filePath: string): Promise<Transcript> {
    // scan 只做可读性/时长/GPU 体检,不做转写;成功即代表素材能进管线。
    const scan = await this.call<{
      ok?: boolean;
      limited?: boolean;
      why?: string;
      stats?: { durationSec?: number; duration_s?: number };
    }>("POST", "/pipeline/scan", { filePath });

    if (scan?.ok === false) {
      throw new HermesError(scan.why || "素材无法处理(可能是路径不在白名单或格式不支持)");
    }
    // 逐句稿为空是有意为之:Hermes 不提供独立转写端点,
    // 硬造一个空壳会诱使上层以为"转写完成但没内容"。
    // createdAt 仍要给,上层用它做缓存键。
    return {
      engine: "sherpa-asr",
      durationSec: scan.stats?.durationSec ?? scan.stats?.duration_s ?? 0,
      segments: [],
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 爆点检测。
   * engine 决定由哪一侧思考: local=本地模型 / cloud=长上下文云端 / auto=由 Hermes 自行选择。
   * memoryBriefId 让云端引擎带上已学习的爆款规律。
   *
   * 真实契约(Hermes live-analyzer.analyze + /pipeline/analyze-live):
   *   { ok, liveVideoId, segments: LiveSegment[], health }
   * 字段是 segmentIndex/startMs/hookQuality 这类驼峰扁平结构,
   * 不是 candidates —— 之前按 candidates 读会永远拿到空数组。
   */
  /**
   * 回读某条直播已经落库的分析结果。
   *
   * 存在的理由:分析是"HTTP 长连接 + 服务端跑几十分钟"的组合,
   * 客户端超时并不代表服务端失败 —— 服务端会继续跑完并写库。
   * 超时后回读一次,就能把已经算好的结果交给用户,
   * 而不是白等一场还显示"失败"。
   *
   * 返回 null 表示"确实没结果"(没登记 / 还在跑 / 接口不通),
   * 这时才可以报错。
   */
  async fetchLiveResult(
    filePath: string
  ): Promise<{ liveVideoId: number | null; segments: HermesLiveSegment[]; health: { grade?: string; error?: string } | null } | null> {
    try {
      // 回读要快,给 30 秒足够 —— 它只是查一次 sqlite
      const r = await this.call<{
        ok?: boolean;
        liveVideoId?: number | null;
        running?: boolean;
        segmentCount?: number;
        segments?: HermesLiveSegment[];
        health?: { grade?: string; error?: string } | null;
      }>("GET", `/pipeline/live-result?videoPath=${encodeURIComponent(filePath)}`, undefined, 30_000);
      // 还在跑就不给半成品,让调用方决定怎么提示
      if (r.running === true || !r.segments || r.segments.length === 0) return null;
      return { liveVideoId: r.liveVideoId ?? null, segments: r.segments, health: r.health ?? null };
    } catch {
      // 回读接口本身不通(旧版 Hermes 没这个端点)也算拿不到,交给上层报错
      return null;
    }
  }

  async detect(
    request_: DetectionRequest
  ): Promise<{ liveVideoId: number | null; candidates: ClipCandidate[]; stats: DetectionStats }> {
    let res: {
      ok?: boolean;
      error?: string;
      liveVideoId?: number | null;
      segments?: HermesLiveSegment[];
      health?: { grade?: string; error?: string };
    };
    try {
      res = await this.call(
        "POST",
        "/pipeline/analyze-live",
        {
          videoPath: request_.filePath,
          engine: request_.engine ?? "auto",
          memoryBriefId: request_.memoryBriefId,
          // 素材归属哪位老师。Hermes 绑到 live_videos.collection 上,
          // 分析时按它取爆款记忆/避雷词 —— 不给的话就只能用界面当前选中的文件夹。
          ...(request_.collection ? { collection: request_.collection } : {})
        },
        // 超时按素材时长给,而不是一律 15 分钟。
        //
        // 两三小时的直播,完整分析(ASR + 逐段 LLM 分段)本地实测要 30~60 分钟,
        // 一律 15 分钟的话,每个长直播都会在快跑完时超时。
        // 系数 1.6 留足余量;上限 3 小时封顶,免得真挂住时永无止境地等。
        Math.min(3 * 60 * 60_000, Math.max(20 * 60_000, (request_.durationSec ?? 0) * 1.6 * 1000))
      );
    } catch (err) {
      // 超时/断连时先回读:这时候服务端往往已经把结果写好了。
      // 直接报错等于让用户白跑一场(我们踩过:14 分钟跑完却显示"调用超时")。
      const recovered = await this.fetchLiveResult(request_.filePath);
      if (!recovered) throw err;
      console.warn(`[HermesClient] analyze-live 超时，但已从库里取回结果（${recovered.segments.length} 段）`);
      res = {
        ok: true,
        liveVideoId: recovered.liveVideoId,
        segments: recovered.segments,
        health: recovered.health ?? undefined,
        error: "（客户端等待超时，结果取自分析缓存）"
      };
    }

    if (res.ok === false) {
      throw new HermesError(res.error || "爆点分析失败");
    }
    // 分级失败要显式抛出:否则界面会显示"0 个候选"而用户以为是没爆点。
    if (res.health?.grade === "error") {
      throw new HermesError(`分析过程出错: ${res.health.error ?? "未知原因"}`);
    }

    const rawSegments = res.segments ?? [];
    // 丢掉切不出来的段：LLM 偶尔会对连续几段报同一个时间戳(实测 174 里有 9 段
    //  start==end)，它们在界面上是"0 秒"候选，点了没反应 —— 比不给更让人困惑。
    // 丢弃数量要如实告知，不能静默：否则用户会发现"候选比预期少几条"却不知道原因。
    const cuttable = rawSegments.filter((s) => Number(s.endMs ?? 0) > Number(s.startMs ?? 0));
    const droppedZeroLength = rawSegments.length - cuttable.length;
    if (droppedZeroLength > 0) {
      console.warn(
        `[HermesClient] 丢弃 ${droppedZeroLength} 个零长段（起止时间相同，切不出来）`
      );
    }
    const segments = cuttable;
    const candidates = segments.map(toClipCandidate);

    // 契约校验:返回了段但全部缺主题与时长,说明字段名对不上。
    // 这种情况以前会安静地渲染成 210 条"未命名片段 / 0.0s→0.0s",
    // 用户看不出是程序坏了,只会以为分析失败。这里直接抛错。
    const usable = candidates.filter((c) => c.title !== "未命名片段" && c.endSec > c.startSec);
    if (segments.length > 0 && usable.length === 0) {
      throw new HermesError(
        `分析返回了 ${segments.length} 段但字段无法解析(既无主题名也无时长)。` +
          `这是接口契约不一致,不是素材问题 —— 请重跑一次分析。`
      );
    }

    return {
      liveVideoId: res.liveVideoId ?? null,
      candidates,
      // Hermes 长直播链路不产出字数/帧级/耗时统计。
      // 用 -1 明确标记"该口径不适用",避免界面把 0 显示成"分析后 0 字"这种假象。
      stats: {
        totalChars: -1,
        keptChars: -1,
        engineUsed:
          request_.engine === "cloud" ? "cloud" : request_.engine === "local" ? "local" : undefined,
        // res.error 这里承载的是"结果取自缓存"这类提示,不是失败原因
        error:
          res.health?.grade === "warn"
            ? res.health.error
            : droppedZeroLength > 0
              ? `${res.error ? res.error + "；" : ""}已跳过 ${droppedZeroLength} 个零长片段（时间轴异常，切不出来）`
              : res.error
      }
    };
  }

  /**
   * 读取逐句稿。
   *
   * Hermes 不提供"取已转写文本"的 HTTP 端点(ASR 跑在 analyze-live 内部,
   * 结果只落在 Hermes 的 upload\temp\<名>_asr.json),所以这里按素材名去读那个文件。
   * 逐句稿是"点句子跳画面"的地基,缺了它用户只能靠听,所以值得专门取一次。
   */
  /**
 * 取消正在跑的分析。
 *
 * 3 小时直播的分析要跑 30~60 分钟，必须给用户一个真能中断的出口。
 * 服务端用 AbortController 挂在这条 videoPath 上；取消时也会清掉 busy 标记，
 * 否则用户取消后立刻重试会撞 409「正在分析中」。
 */
async cancelDetect(filePath: string): Promise<{ ok: boolean; aborted: boolean }> {
    const res = await this.call<{ ok?: boolean; aborted?: boolean }>(
      "POST",
      "/pipeline/analyze-cancel",
      { videoPath: filePath },
      15000
    );
    return { ok: Boolean(res.ok), aborted: Boolean(res.aborted) };
  }

  async readTranscript(filePath: string): Promise<Transcript> {
    const stem = basename(filePath).replace(/\.[^.]+$/, "");
    const dir = join("D:", "GLB", "Hermes", "upload", "temp");
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(stem) && f.endsWith("_asr.json"));
    } catch {
      files = [];
    }
    // 多个候选时取最新修改的那个
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    const target = files[0];
    if (!target) {
      return { engine: "none", durationSec: 0, segments: [], createdAt: new Date().toISOString() };
    }
    try {
      const raw = JSON.parse(readFileSync(join(dir, target), "utf8")) as {
        source?: string;
        segments?: Array<{ start_ms?: number; end_ms?: number; text?: string }>;
      };
      return {
        engine: raw.source ?? "asr",
        durationSec: 0,
        segments: (raw.segments ?? []).map((s, i) => ({
          id: i,
          startSec: (s.start_ms ?? 0) / 1000,
          endSec: (s.end_ms ?? 0) / 1000,
          text: s.text ?? ""
        })),
        createdAt: new Date().toISOString()
      };
    } catch {
      return { engine: "none", durationSec: 0, segments: [], createdAt: new Date().toISOString() };
    }
  }

  /** 按目标时长重排并拼装:短/中/长三档。 */
  /**
   * 多版本粗剪：一次产出多条不同长度/开头的成片。
   * 与 export() 的区别:export 出成品(带包装),这里出的是"待挑的粗剪"。
   */
  async clipVariants(request_: {
    liveVideoId: number;
    clipSegmentIds: number[];
    clips?: ExportRequest["clips"];
    variants?: string[];
    openingText?: string;
  }): Promise<VariantResult[]> {
    if (!request_.liveVideoId) return [];

    // 逐句裁剪区间同样要带过去,否则多版本会丢掉用户的挑句结果
    const cutsByIndex = (request_.clips ?? [])
      .filter((c) => Array.isArray(c.manualCuts) && c.manualCuts.length > 0)
      .map((c) => ({
        index: c.id,
        cuts: c.manualCuts?.map((r) => ({ st: Math.round(r.startSec * 1000), en: Math.round(r.endSec * 1000) }))
      }));

    const res = await this.call<{
      variants?: Array<{
        id: string;
        label: string;
        hint: string;
        targetSec: number | null;
        ok: boolean;
        projectId?: number;
        files: string[];
        viralOpening?: string | null;
        totalSec?: number;
        elapsedSec?: number;
        error?: string;
      }>;
    }>(
      "POST",
      "/pipeline/clip-variants",
      {
        liveVideoId: request_.liveVideoId,
        segmentIds: request_.clipSegmentIds,
        ...(cutsByIndex.length > 0 ? { cutsByIndex } : {}),
        ...(request_.variants?.length ? { variants: request_.variants } : {}),
        ...(request_.openingText ? { openingText: request_.openingText } : {})
      },
      60 * 60_000
    );
    return res.variants ?? [];
  }

  async rerank(
    fileName: string,
    durationMode: "short" | "mid" | "long",
    candidates: ClipCandidate[]
  ): Promise<{ candidates: ClipCandidate[]; summary: string }> {
    const res = await this.call<{
      modeSegments?: ClipCandidate[];
      reranked?: Array<{ id: number; newScore: number }>;
      summary?: string;
    }>("POST", "/highlight/rerank", {
      videoName: fileName,
      durationMode,
      candidates: candidates.map((c) => ({
        id: c.id,
        title: c.title,
        hook: c.hook,
        score: c.score,
        startSec: c.startSec,
        endSec: c.endSec
      }))
    });
    if (res.modeSegments?.length) return { candidates: res.modeSegments, summary: res.summary ?? "" };
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const order = new Map((res.reranked ?? []).map((r, i) => [r.id, i]));
    const merged = [...byId.values()].map((c) => ({ ...c, score: res.reranked?.find((r) => r.id === c.id)?.newScore ?? c.score }));
    merged.sort(
      (a, b) => (order.has(a.id) ? (order.get(a.id) as number) : 1e9) - (order.has(b.id) ? (order.get(b.id) as number) : 1e9)
    );
    return { candidates: merged, summary: res.summary ?? "" };
  }

  /**
   * 拉取审片包：粗剪路径 + 段映射 + 历史意见。
   *
   * 段映射必须由服务端算：粗剪时间轴从 0 开始，段落信息来自原素材，
   * 两套坐标的换算依赖"按 selected_segments 顺序累加"，自己算早晚和这里不一致。
   */
  async reviewPacket(
    projectId: number
  ): Promise<{
    projectId: number;
    status: string;
    liveVideoId: number;
    roughcutPath: string;
    totalSec: number;
    segments: ClipSegmentMap[];
    feedback: Array<{
      id: number;
      decision: string;
      comment: string;
      segmentIds: string | null;
      createdAt: string;
      collection: string | null;
    }>;
  }> {
    return this.get<{
      ok: boolean;
      projectId: number;
      status: string;
      liveVideoId: number;
      roughcutPath: string;
      totalSec: number;
      segments: ClipSegmentMap[];
      feedback: Array<{
        id: number;
        decision: string;
        comment: string;
        segmentIds: string | null;
        createdAt: string;
        collection: string | null;
      }>;
    }>(`/projects/${projectId}/review-packet`);
  }

  /**
   * 提交审片结论。
   *
   * 断链修复：以前这里打的是 POST /projects/review（无此路由 → 404），
   * 而且 body 契约和 Hermes 端点完全对不上（发的是 videoName/adopted/rejected，
   * 端点要的是 decision/comment/segmentIds + URL 里的 projectId）。
   * 于是每次审片都 404，异常又被界面 .catch 吞掉 ——
   * 桌面上从来没写进过一条 review_feedback，审片意见对下一次出片零影响。
   */
  async submitReview(
    projectId: number,
    payload: {
      decision: "approve" | "recut";
      comment?: string;
      /** 被点名的段（live_segments.id 或 segment_index，Hermes 两种都认） */
      segmentIds?: number[];
    }
  ): Promise<{ ok: boolean; projectId?: number; newProjectId?: number; status?: string; pendingQueries?: unknown[] }> {
    if (!projectId) throw new HermesError("缺少粗剪工程 id，无法提交审片结论");
    return this.call("POST", `/projects/${projectId}/review`, {
      decision: payload.decision,
      comment: payload.comment ?? "",
      segmentIds: payload.segmentIds ?? []
    });
  }

  /**
   * 把桌面端的剪辑编辑记进对应 IP 老师的档案。
   *
   * 为什么单独一个方法而不是复用 submitReview：
   * 桌面端的审阅台是**逐个候选**改的（改标题、调起止、剔句子），
   * 一次审阅出好几条独立编辑信号，而且没有"打回重剪"这个整体动作。
   * 复用 submitReview 会被迫伪造 decision/segmentIds，
   * 还会把"我改了标题"混进"我否决了这条粗剪"的语义里。
   *
   * 注意：写学习失败**不能**让保存失败。粗剪改动已经在本地生效，
   * 因为 Hermes 不可达就告诉用户"保存失败"，会导致反复重试、
   * 甚至以为改动丢了。静默失败 + 记日志。
   */
  async recordEditRecords(payload: {
    liveVideoId?: number | null;
    videoPath?: string;
    collection?: string | null;
    reason?: string;
    edits: Array<{
      kind: "cut" | "keep" | "title";
      text: string;
      oldTitle?: string;
      themeName?: string;
      role?: string;
      segmentId?: number;
      startSec?: number;
      endSec?: number;
      score?: number;
      by?: "picked" | "edited";
    }>;
  }): Promise<{ ok: boolean; written: number; collection?: string | null }> {
    if (!payload.edits?.length) return { ok: true, written: 0 };
    try {
      return await this.call("POST", "/memory/edit-records", {
        liveVideoId: payload.liveVideoId ?? null,
        videoPath: payload.videoPath ?? "",
        collection: payload.collection ?? null,
        reason: payload.reason ?? "",
        edits: payload.edits
      });
    } catch (err) {
      // 见上面的说明：这里刻意不抛。
      console.warn("[EditRecords] 写学习样本失败（不影响本次保存）:", err);
      return { ok: false, written: 0 };
    }
  }

  /** 列出某位老师的热词纠正规则（省略 collection = 通用 + 该老师的） */
  async listHotwords(collection?: string | null): Promise<HotwordRule[]> {
    const q = collection ? `?collection=${encodeURIComponent(collection)}` : "";
    const r = (await this.call("GET", `/memory/hotwords${q}`)) as { ok?: boolean; hotwords?: HotwordRule[] } | {};
    return (r as { hotwords?: HotwordRule[] }).hotwords ?? [];
  }

  /** 加一条热词纠正。updated=true 表示这是改写了已有规则，不是新建。 */
  async addHotword(payload: { collection?: string | null; from: string; to: string }): Promise<{ ok: boolean; id: number; updated: boolean }> {
    return this.call("POST", "/memory/hotwords", {
      collection: payload.collection ?? null,
      from: payload.from,
      to: payload.to
    });
  }

  async removeHotword(id: number): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/memory/hotwords/${id}`);
  }

  /**
   * 把文本里听错的词换掉。
   *
   * 走 shared/hotwords.ts 而不是本地再写一份：preload 也需要同一份实现，
   * 而这段算法必须与 Hermes 侧完全一致 ——
   * 不一致就会出现"审阅台改了、字幕没改"。
   */
  applyHotwordsToTranscript(transcript: Transcript | null, rules: HotwordRule[]): Transcript | null {
    if (!transcript?.segments?.length) return transcript;
    const list = (rules || []).filter((r) => r && r.from && r.to && r.from !== r.to);
    if (!list.length) return transcript;
    return {
      ...transcript,
      segments: transcript.segments.map((s) => ({ ...s, text: applyHotwords(String(s.text ?? ""), list) }))
    };
  }

  /** 读取某位 IP 老师的剪辑档案（避雷词 / 正样本 / 结构偏好 / 标题改写） */
  async editArchive(collection: string): Promise<EditArchive | null> {
    if (!collection?.trim()) return null;
    const r = (await this.call("GET", `/memory/edit-archives?collection=${encodeURIComponent(collection.trim())}`)) as
      | { ok?: boolean; archive?: EditArchive }
      | {};
    return (r as { archive?: EditArchive }).archive ?? null;
  }

  /** 列出所有有剪辑档案的 IP 老师 */
  async listEditArchives(): Promise<Array<{ name: string; samples: number; cuts: number; keeps: number; segments: number; last_at: string }>> {
    const r = (await this.call("GET", "/memory/edit-archives")) as
      | { ok?: boolean; archives?: EditArchiveListItem[] }
      | {};
    return (r as { archives?: EditArchiveListItem[] }).archives ?? [];
  }

  /**
   * 出片。
   *
   * Hermes 的真实契约(2026-09-30 核对 clipper/index.js):
   *   POST /pipeline/clip  { liveVideoId }        -> 建工程 + 自动全量出片
   *   Clipper.createProject(liveVideoId)         -> 内部选段,写 clip_projects.selected_segments
   *   Clipper.clip(projectId)                    -> 读 selected_segments 逐段渲染
   *
   * 用户勾选不能直接传给 /pipeline/clip(它只认 liveVideoId,且会走自己的选段逻辑)。
   * 正确流程:createProject 建工程 → 改写 selected_segments 为用户勾选 → 触发 clip。
   * 这里封装成一步,调用方只需给 liveVideoId + 勾选的片段。
   */
  async export(request_: ExportRequest): Promise<ExportResult> {
    if (!request_.liveVideoId) {
      return { ok: false, outputDir: request_.outDir ?? "", files: [], error: "缺少 liveVideoId,无法出片" };
    }

    // 只给真正做过逐句裁剪的段传 cuts,没裁剪的段走原来的整段行为
    const cutsByIndex = (request_.clips ?? [])
      .filter((c) => Array.isArray(c.manualCuts) && c.manualCuts.length > 0)
      .map((c) => ({
        index: c.id,
        cuts: c.manualCuts?.map((r) => ({ st: Math.round(r.startSec * 1000), en: Math.round(r.endSec * 1000) }))
      }));

    const opts = request_.options;

    // ── 分支 A:复用多版本里选中的那个工程 ──────────────────────────
    //
    // 这一版已经在 /pipeline/clip-variants 里建好工程、粗剪也渲过了。
    // 它的选段和裁剪跟原始勾选不一样,所以绝不能再走建工程那条路 ——
    // 那样会生成另一份片子,而界面不会报错,用户以为"选这版"生效了。
    if (request_.projectId) {
      return this.wrapExistingProject(request_.projectId, opts, request_.outDir);
    }

    // ── 分支 B:按当前勾选新建工程 ────────────────────────────────
    // 1) 建工程 + 渲染。
    //
    // 把 segmentIds / cutsByIndex 一起传给 /pipeline/clip,让服务端跳过自动选段。
    // 以前分两步(先 clip 再 set-selection),可 createProject 内部的
    // "剔除运营话术"一旦判空就直接抛错,用户的勾选根本走不到。
    const created = await this.call<{
      ok?: boolean;
      projectId?: number;
      clipped?: boolean;
      usedUserSelection?: boolean;
      viralOpening?: string | null;
      clipPaths?: string[];
      clips?: string[];
      outputPath?: string;
      roughcutPath?: string;
      error?: string;
    }>(
      "POST",
      "/pipeline/clip",
      {
        liveVideoId: request_.liveVideoId,
        ...(request_.clipSegmentIds?.length
          ? {
              segmentIds: request_.clipSegmentIds,
              ...(cutsByIndex.length > 0 ? { cutsByIndex } : {})
            }
          : {}),
        // 爆款开头前置:默认开启,除非显式关掉。
        // 它会从全场挑钩子最强的一段剪到片头,所以要能关 ——
        // 有些人就想要"我选什么就出什么",不要额外加工。
        ...(request_.options?.viralOpening !== undefined
          ? { viralOpening: request_.options.viralOpening }
          : {}),
        ...(request_.options?.viralOpeningSeconds
          ? { viralOpeningSeconds: request_.options.viralOpeningSeconds }
          : {}),
        ...(request_.options?.openingText ? { openingText: request_.options.openingText } : {}),
        ...(request_.options?.openingSegmentId !== undefined
          ? { openingSegmentId: request_.options.openingSegmentId }
          : {})
      },
      30 * 60_000
    );
    if (!created?.ok || !created.projectId) {
      return { ok: false, outputDir: request_.outDir ?? "", files: [], error: created?.error ?? "建立成片工程失败" };
    }
    const projectId = created.projectId;

    // 兼容:服务端没按用户勾选渲染时(旧版本),补一次选段写入 + 触发渲染
    let rendered = created;
    if (!created.usedUserSelection && !created.clipPaths?.length && request_.clipSegmentIds?.length) {
      const applied = await this.applySelection(projectId, request_.clipSegmentIds, request_.clips);
      if (!applied.ok) {
        return { ok: false, outputDir: request_.outDir ?? "", files: [], error: applied.error ?? "写入勾选失败" };
      }
      rendered = await this.call<{
        ok?: boolean;
        clipPaths?: string[];
        clips?: string[];
        outputPath?: string;
        roughcutPath?: string;
        error?: string;
      }>("POST", "/pipeline/resume-clip", { projectId }, 30 * 60_000);
    }

    // 真实响应字段是 clipPaths(不是 clips)。之前读 clips 永远得到 undefined,
    // 界面就显示"已输出 0 个文件",用户以为成片丢了。
    const files = rendered?.clipPaths ?? rendered?.clips ?? [];
    if (rendered?.roughcutPath) files.push(rendered.roughcutPath);

    // 4) 包装:字幕 / 封面 / 标题 / 上传的封面图 / 结尾藏带货
    //
    // 以前只到第 3 步就返回了,所以界面上 RenderOptions 勾什么都不影响结果。
    // /pipeline/generate 会做:生成 srt → 选封面帧 → 烧标题+字幕 → 合成成片。
    //
    // 判定必须把新选项算进去：只开"上传封面图"而把字幕/烧标题都关掉时，
    // 旧判定会短路直接返回，用户点了出片却什么都没发生 ——
    // 而这类"点了没反应"最难让人想到是判定条件漏了。
    const wantsWrap = Boolean(opts && wantsPackaging(opts));
    if (!wantsWrap) {
      return {
        ok: rendered?.ok !== false,
        outputDir: rendered?.outputPath ?? request_.outDir ?? "",
        files,
        viralOpening: created.viralOpening ?? null,
        error: rendered?.error
      };
    }

    const wrapped = await this.runGenerate(projectId, opts);
    if (!wrapped.ok) {
      return {
        ok: false,
        outputDir: rendered?.outputPath ?? request_.outDir ?? "",
        files,
        viralOpening: created.viralOpening ?? null,
        error: `成片渲染完成但包装失败:${wrapped.error}`
      };
    }

    return {
      ok: true,
      outputDir: wrapped.outputDir ?? rendered?.outputPath ?? request_.outDir ?? "",
      // 包装成功时只报交付物;包装没产出任何东西才退回粗剪列表
      files: wrapped.deliver.length > 0 ? wrapped.deliver : files,
      viralOpening: created.viralOpening ?? null,
      // 审片要用：粗剪工程 id + 粗剪文件本身。
      // 以前粗剪只混在 files 里，包装一开就被 deliver 整个覆盖，
      // 于是界面上永远看不到粗剪，"审片"根本无从下手。
      // 段映射不在这儿给：它依赖 selected_segments 的拼接顺序，
      // 由审片端点现场算（reviewPacket），避免两处逻辑漂移。
      projectId,
      roughcutPath: rendered?.roughcutPath,
      error: undefined
    };
  }

  /**
   * 只做包装(字幕/封面/标题),复用已有工程。
   *
   * 多版本"选这版"走这里:那一版已经在 clip-variants 里建好工程渲过粗剪,
   * 用户要的是给这一版套包装,不是重新选段出片。
   */
  private async wrapExistingProject(
    projectId: number,
    opts: RenderOptions | undefined,
    outDir?: string
  ): Promise<ExportResult> {
    const wantsWrap = Boolean(opts && wantsPackaging(opts));
    // 一个开关都没开也要给结果,否则界面只能显示"失败"
    if (!wantsWrap) {
      return {
        ok: true,
        outputDir: outDir ?? "",
        files: [],
        viralOpening: null,
        error: "包装选项全关,没有可生成的成片"
      };
    }
    const wrapped = await this.runGenerate(projectId, opts);
    return {
      ok: wrapped.ok,
      outputDir: wrapped.outputDir ?? outDir ?? "",
      files: wrapped.deliver,
      viralOpening: null,
      error: wrapped.ok ? undefined : wrapped.error
    };
  }

  /** POST /pipeline/generate,返回交付物与输出目录 */
  private async runGenerate(
    projectId: number,
    opts: RenderOptions | undefined
  ): Promise<{ ok: boolean; outputDir?: string; deliver: string[]; error: string }> {
    const generated = await this.call<{
      ok?: boolean;
      outputDir?: string;
      titles?: Array<{ text?: string }>;
      subtitles?: Array<{ path?: string | null }>;
      covers?: Array<{ path?: string | null }>;
      finalVideos?: Array<{ path?: string | null }>;
      error?: string;
    }>(
      "POST",
      "/pipeline/generate",
      {
        projectId,
        // 字幕/封面/标题
        subtitles: opts?.subtitles !== false,
        covers: opts?.covers !== false,
        title: opts?.title !== false,
        ...(opts?.titleText ? { titleText: opts.titleText } : {}),

        // 画面处理。这些以前根本传不过去 —— 服务端只解构了上面四个，
        // 于是界面上勾"竖屏""水印""BGM"全都不生效。verify-compose 12 组
        // 用例验证了每一项都能改变产物。
        ...(opts?.vertical !== undefined ? { vertical: opts.vertical } : {}),
        ...(opts?.captionStyle ? { captionStyle: opts.captionStyle } : {}),
        ...(opts?.captionSize !== undefined ? { captionSize: opts.captionSize } : {}),
        ...(opts?.coldOpen !== undefined ? { coldOpen: opts.coldOpen } : {}),
        ...(opts?.titleCard !== undefined ? { titleCard: opts.titleCard } : {}),
        ...(opts?.autoZoom !== undefined ? { autoZoom: opts.autoZoom } : {}),
        ...(opts?.watermark ? { watermark: opts.watermark } : {}),

        // 音频
        ...(opts?.bgmPath ? { bgmPath: opts.bgmPath } : {}),
        ...(opts?.bgmVolume !== undefined ? { bgmVolume: opts.bgmVolume } : {}),
        ...(opts?.duckBgm !== undefined ? { duckBgm: opts.duckBgm } : {}),
        ...(opts?.sfx !== undefined ? { sfx: opts.sfx } : {}),

        // 字幕 / 标题样式
        ...(opts?.captionFontStyle ? { captionFontStyle: opts.captionFontStyle } : {}),
        ...(opts?.titleFontStyle ? { titleFontStyle: opts.titleFontStyle } : {}),
        // 这两个以前只存在于 RenderOptions,从来没传给 Hermes,
        // 于是"标题卡停 3 秒""冷开场 2 秒"存了也白存。
        ...(opts?.titleCardSeconds !== undefined ? { titleCardSeconds: opts.titleCardSeconds } : {}),
        ...(opts?.coldOpenSeconds !== undefined ? { coldOpenSeconds: opts.coldOpenSeconds } : {}),

        // 上传的封面图 / 结尾藏带货
        ...(opts?.coverImage ? { coverImage: opts.coverImage } : {}),
        ...(opts?.tailVideo ? { tailVideo: opts.tailVideo } : {})
      },
      40 * 60_000
    );

    if (generated?.ok === false) {
      return { ok: false, deliver: [], error: generated.error ?? "未知原因" };
    }

    // 包装产物优先展示:成片 > 字幕 > 封面,让用户一眼看到最终交付物
    const finals = (generated?.finalVideos ?? [])
      .map((f) => f?.path)
      .filter((p): p is string => Boolean(p));
    const srt = (generated?.subtitles ?? [])
      .map((s) => s?.path)
      .filter((p): p is string => Boolean(p));
    const covers = (generated?.covers ?? [])
      .map((c) => c?.path)
      .filter((p): p is string => Boolean(p));

    return { ok: true, outputDir: generated?.outputDir, deliver: [...finals, ...srt, ...covers], error: "" };
  }

  /**
   * 把用户勾选的分段写入 clip_projects.selected_segments。
   *
   * clips 里若带 manualCuts(逐字逐句裁剪),按段号传 cutsByIndex,
   * 服务端会夹紧到段边界后交给 Clipper 按子区间切再拼。
   */
  private async applySelection(
    projectId: number,
    segmentIds: number[],
    clips?: ExportRequest["clips"]
  ): Promise<{ ok: boolean; error?: string }> {
    // 只给真正做过逐句裁剪的段传 cuts,没裁剪的段走原来的整段行为
    const cutsByIndex = (clips ?? [])
      .filter((c) => Array.isArray(c.manualCuts) && c.manualCuts.length > 0)
      .map((c) => ({
        index: c.id,
        cuts: c.manualCuts?.map((r) => ({ st: Math.round(r.startSec * 1000), en: Math.round(r.endSec * 1000) }))
      }));

    try {
      const res = await this.call<{ ok?: boolean; error?: string }>("POST", "/pipeline/set-selection", {
        projectId,
        segmentIds,
        ...(cutsByIndex.length > 0 ? { cutsByIndex } : {})
      });
      return { ok: res?.ok !== false, error: res?.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 记忆档案列表:云端引擎学到的爆款规律。 */
  async memoryBriefs(): Promise<Array<{ id: string; title: string; createdAt: string; items: number }>> {
    const res = await this.call<{ briefs?: Array<{ id: string; title: string; createdAt: string; items: number }> }>(
      "GET",
      "/memory-brief"
    );
    return res.briefs ?? [];
  }

  /** 触发一次爆款学习:让云端引擎拆解历史爆款,沉淀为本地记忆。 */
  async learnMemory(filePath: string): Promise<{ id: string; title: string; items: number }> {
    return this.call<{ id: string; title: string; items: number }>("POST", "/openings/mine", {
      videoName: filePath.split(/[\\/]/).pop() ?? filePath
    });
  }

  /** 录播监听状态。 */
  async watchStatus(): Promise<{ running: boolean }> {
    try {
      return await this.call<{ running: boolean }>("GET", "/api/system", undefined, 4000);
    } catch {
      return { running: false };
    }
  }
}
