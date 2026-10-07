/**
 * GLB Studio 全局类型契约。
 * 主进程、预加载桥、渲染层三方共用的唯一事实来源。
 * 算法能力全部来自本地 Hermes 服务(自研),此处只描述其对外形状。
 */

/** ---------- 媒体与素材 ---------- */

export interface MediaProbe {
  path: string;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  sizeBytes: number;
}

export interface MediaFile extends MediaProbe {
  name: string;
}

/** ---------- 逐句稿(ASR 结果) ---------- */

export interface TranscriptSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  emotion?: string;
  /** 视觉信号: 画面事件/表情/弹幕,来自 Hermes 视觉分析 */
  visual?: string;
  emotionScore?: number;
}

export interface Transcript {
  engine: string;
  durationSec: number;
  language?: string;
  segments: TranscriptSegment[];
  createdAt: string;
}

/** ---------- 爆点候选 ---------- */

export type GateStatus = "publish" | "review" | "drop";

export interface ScoreDimensions {
  hook: number;
  flow: number;
  value: number;
  trend: number;
}

export interface ClipPiece {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ClipCandidate {
  id: number;
  startSec: number;
  endSec: number;
  pieces?: ClipPiece[];
  text: string;
  title: string;
  hook: string;
  score: number;
  reason: string;
  reviewNote: string;
  boundary: string;
  keywords: string[];
  recommended: boolean;
  utility?: boolean;
  gate?: GateStatus;
  gateNotes?: string[];
  scoreDims?: ScoreDimensions;
  manualBounds?: boolean;
  /**
   * 逐字逐句裁剪:用户手动挑中的句子区间(秒)。
   * 非空时出片会按这些区间分别切再拼,段内被剔除的句子(运营话术)真正不会进成片。
   */
  manualCuts?: Array<{ startSec: number; endSec: number }>;
  /**
   * 这条候选来自哪场直播（Hermes 的 live_videos.id）。
   *
   * 记剪辑学习样本时要靠它定位归档到哪位 IP 老师 ——
   * 桌面端手上通常只有文件路径，路径可能被移动过，id 才是稳定依据。
   * 没有它就退回按 video_path 反查。
   */
  liveVideoId?: number | null;
  /** 原素材绝对路径（回退定位用） */
  sourcePath?: string;
  /** 内容定位：hook / body / cta。段落级学习信号靠它 */
  role?: string;
}

/** ---------- 检测与分析 ---------- */

export interface DetectionRequest {
  filePath: string;
  /** 分析引擎: local=本地 qwen3 / cloud=Gemini 长上下文 / auto=由 Hermes 自行选择 */
  engine?: "local" | "cloud" | "auto";
  /** 云端引擎要用的爆款档案 id(学习云端画像) */
  memoryBriefId?: string;
  /**
   * 这条素材归属哪位老师（爆款记忆库名）。
   *
   * Hermes 会把它绑到 live_videos.collection 上，之后按素材自己取记忆，
   * 不再受"界面此刻选中谁"影响。不给 = 用通用记忆。
   */
  collection?: string | null;
  /**
   * 素材时长（秒）。用来按体量给 HTTP 超时 ——
   * 两三小时的直播完整分析要 30~60 分钟，一律 15 分钟会在快跑完时超时。
   */
  durationSec?: number;
}

export interface DetectionStats {
  totalChars: number;
  keptChars: number;
  framesScored?: number;
  peakCount?: number;
  emotionPeakCount?: number;
  eventPeakCount?: number;
  danmakuCount?: number;
  /** 实际生效的引擎与耗时,用于界面显示"谁在思考" */
  engineUsed?: "local" | "cloud";
  elapsedSec?: number;
  error?: string;
}

/** ---------- 出片 ---------- */

export interface RenderOptions {
  vertical: boolean;
  /** 字幕样式: auto=默认描边 / bold=加粗立体边框(短剧知识类更醒目) */
  captionStyle: "auto" | "bold" | "none";
  /**
   * 以下 6 个字段**后端没有实现**，UI 上已移除对应开关。
   * 保留仅为兼容旧项目存档（读旧 checkpoint 时字段要存在）。
   * 不要在 UI 里重新暴露它们 —— 勾了不生效也不报错，比没有更糟。
   * 哪天后端真做了，再从这里删掉并接上。
   */
  /** @deprecated 无实现，UI 已移除 */
  jumpCut?: boolean;
  /** @deprecated 无实现，UI 已移除 */
  cleanFillers?: boolean;
  /** @deprecated 无实现，UI 已移除 */
  cutRetakes?: boolean;
  /** @deprecated 无实现，UI 已移除 */
  flashForward?: boolean;
  /** @deprecated 无实现，UI 已移除 */
  openingHook?: boolean;
  /** @deprecated 无实现，UI 已移除 */
  translate?: boolean;
  /** 冷开场:开头定格首帧,默认 1.2 秒 */
  coldOpen: boolean;
  /**
   * 标题卡:开头插一段带标题的定版画面。
   *
   * 2026-10-02 更正:这里原先标着"从未传给 Hermes,出片无变化",是错的。
   * 链路其实是通的 —— generator/index.js:1017 会真的渲染标题卡,
   * orchestrator:1009 透传,hermes-client:648 也带上了。
   * 写错注释的代价是有人据此把这个功能当成假的删掉。
   * 和 options.title(顶部烧标题横幅)是两件事:一个是定版画面,一个是常驻横幅。
   */
  titleCard?: boolean;
  /** 自动变焦:在情绪/能量峰处轻微推近(幅度刻意做小,推太猛会晕) */
  autoZoom: boolean;
  bgmPath?: string;
  /** 爆点音效(用 ffmpeg 内建提示音,不需要额外素材) */
  sfx: boolean;
  watermark?: string;
  brandStyleId?: string;
  /**
   * 成片包装。
   * 以前这些开关在界面上能勾,却从来没传给 Hermes,出片结果跟没勾一样 ——
   * 所以字段名必须和 Hermes generator 的入参对得上,别再自造。
   */
  /** 烧录字幕(生成 srt 并压进画面) */
  subtitles?: boolean;
  /** 选封面帧 + 烧标题做封面 */
  covers?: boolean;
  /** 顶部烧标题横幅 */
  title?: boolean;
  /** 手写标题文案;给了就用,不再让模型生成 */
  titleText?: string;
  /** 字幕字号(仅 bold 样式生效) */
  captionSize?: number;
  /** BGM 音量 0~1,默认 0.22 */
  bgmVolume?: number;
  /** 人声出现时自动压低 BGM(不压的话人声会被音乐盖住) */
  duckBgm?: boolean;
  /** 冷开场时长(秒),仅 coldOpen=true 时用 */
  coldOpenSeconds?: number;
  /** 标题卡停留时长(秒),仅 titleCard=true 时用 */
  titleCardSeconds?: number;
  /** 音效插入点(秒);不给就按能量峰自动挑 */
  sfxAt?: number[];
  /**
   * 爆款开头前置:从全场挑出钩子最强的一段剪到片头。
   * 与"把已选段排序"不同 —— 它会动用用户没勾选的段落。
   */
  viralOpening?: boolean;
  /** 开头片段长度上限(秒),默认 15 */
  viralOpeningSeconds?: number;
  /** 指定开头原文;给了就优先找这句 */
  openingText?: string;
  /** 指定用哪个 segment_index 当开头 */
  openingSegmentId?: number;

  /* ───────────── 素材库：封面图 / 结尾藏带货 ───────────── */

  /**
   * 上传的封面图设置。
   *
   * 和上面的 covers(从视频里选一帧产出独立封面 jpg)是两件事：
   * 这个是用户自己传图，并且**直接进正片** —— 成片第一帧就是它，
   * 定格 coverImage.seconds 秒。所以图不清楚 = 成片第一眼就糊。
   */
  coverImage?: CoverImageStyle;
  /** 结尾藏带货设置（拼在成片最后） */
  tailVideo?: TailVideoStyle;

  /* ───────────── 字幕 / 标题样式 ───────────── */

  /** 字幕样式。字幕走 ASS force_style，这几项都能直接映射 */
  captionFontStyle?: CaptionStyle;
  /** 标题样式（顶部横幅或标题卡） */
  titleFontStyle?: TitleStyle;
}

/** 字幕样式。字段名对齐 ASS 的 force_style，避免中间再翻译一次 */
export interface CaptionStyle {
  /** 字体名（要系统里真实存在，界面上给出可选列表） */
  font?: string;
  /** 字色，#RRGGBB。默认白 */
  color?: string;
  /** 字号（ASS FontSize，缩放基准是 1080p 高度） */
  size?: number;
  /** 距画面底部的像素：越大越靠上。默认靠底部 */
  marginV?: number;
  /** 描边粗细。0 = 无描边 */
  outline?: number;
  /** 阴影强度。0 = 无阴影 */
  shadow?: number;
  /** 粗体 */
  bold?: boolean;
  /** 底部半透明底条（短剧/知识类常用，压住花哨背景） */
  box?: boolean;
  /** 底条不透明度 0~1 */
  boxOpacity?: number;
}

/** 标题样式。位置用预设 + 微调，而不是让用户填像素 */
export interface TitleStyle {
  font?: string;
  color?: string;
  size?: number;
  /** 垂直位置预设 */
  position?: "top" | "middle" | "bottom";
  /** 在预设基础上的微调（像素，正值向下） */
  offsetY?: number;
  /** 文字阴影强度 */
  shadow?: number;
  /** 背景色板颜色（标题横幅的橙底）。留空 = 不加底板 */
  boxColor?: string;
  /** 底板不透明度 0~1 */
  boxOpacity?: number;
}

/** 素材库里的一条素材（封面图 / 藏带货视频） */
export interface AssetItem {
  id: string;
  /** 素材库内的绝对路径（出片用这个，不依赖用户原位置） */
  path: string;
  /** 原始文件名，界面显示用 */
  name: string;
  size: number;
  addedAt: string;
}

export interface AssetImportResult {
  ok: boolean;
  imported: AssetItem[];
  /** 跳过数（同名同大小视为重复导入） */
  skipped: number;
  errors: string[];
}

export interface AssetDeleteResult {
  ok: boolean;
  deleted: number;
  errors: string[];
}

export interface AssetRestoreResult {
  ok: boolean;
  restored: number;
  errors: string[];
}

/**
 * 用户上传的封面图。
 * usePath 指向素材库里选中的那一张，素材库本身由 asset:* 接口管理。
 */
export interface CoverImageStyle {  /** 要用的封面图绝对路径（素材库里选一张） */
  usePath?: string;
  /** 首帧定格多少秒。0 ≈ 只占 1 帧（看不到），一般给 1~2 */
  seconds?: number;
  /** 文案在图上的纵向位置：0=顶部 1=底部，0.68 ≈ 中下 */
  textY?: number;
  /** 文案字号（相对图高的千分比 —— 用比例而不是绝对像素，不同尺寸的图才不会差太多） */
  textSize?: number;
  /** 文案颜色 */
  textColor?: string;
  /** 文案描边粗细 */
  textOutline?: number;
  /** 给图片压一层暗底。文案在浅色图上看不清时需要 */
  scrim?: number;
}

/** 结尾藏带货。upload 的是视频，出片时拼在正片之后 */
export interface TailVideoStyle {
  /** 选哪个视频；pick=random 时每次出片随机挑一个 */
  usePath?: string;
  /** 选片策略：first=用素材库里第一个 / random=随机挑 */
  pick?: "first" | "last" | "random";
  /** 结尾标签文案（可选，烧在藏带货画面上）。留空 = 不烧 */
  labelText?: string;
  /** 标签字号（相对视频高的千分比） */
  labelSize?: number;
}

export interface ExportRequest {
  /**
   * 复用已有成片工程(多版本"选这版"走这条路)。
   *
   * 为什么需要:多版本每个版本都是独立工程,各自有不同的选段和裁剪。
   * 不带这个字段的话,包装会拿原始勾选重新建一个工程 —— 用户选了
   * "标准版",拿到的却是另一份片子,而且界面不报错,最难查。
   */
  projectId?: number;
  /** Hermes 里 live_videos.id,建片段工程时用(/pipeline/clip 只吃它) */
  liveVideoId: number;
  /** 用户在候选列表勾选的段 segment_index,建片段工程时的真实素材顺序 */
  clipSegmentIds: number[];
  /** 已选候选,含逐句裁剪结果(建片段工程时用) */
  clips: ClipCandidate[];
  options: RenderOptions;
  outDir?: string;
}

export interface ExportProgress {
  stage: "preparing" | "encoding" | "muxing" | "done" | "error";
  clipIndex: number;
  clipTotal: number;
  percent: number;
  message?: string;
  outputPath?: string;
  error?: string;
}

export interface ExportResult {
  ok: boolean;
  outputDir: string;
  files: string[];
  error?: string;
  /** 爆款开头前置的原文(来自原素材),null 表示没有 */
  viralOpening?: string | null;
  /**
   * 粗剪工程 id。审片要用它调 /projects/:id/review ——
   * 没有它，审片意见就写不进 Hermes，等于审了个寂寞。
   */
  projectId?: number;
  /**
   * 粗剪文件路径。
   *
   * 以前它被塞进 files，但只要开了任何包装选项（默认全开）就被
   * wrapped.deliver 整个覆盖，于是界面上永远看不到粗剪 —— 审片无从谈起。
   * 所以单独暴露一个字段，不跟交付物列表混在一起。
   */
  roughcutPath?: string;
  /**
   * 粗剪里各段的映射：段在粗剪里的位置 + 对应原素材的区间。
   * 审片播放器播的是粗剪（时间从 0 开始），而段落信息来自原素材，
   * 两套时间轴必须能对上，否则"点段落跳画面"会跳错地方。
   */
  segmentMap?: ClipSegmentMap[];
}

/** 粗剪里的一段：同时带粗剪坐标与原素材坐标 */
export interface ClipSegmentMap {
  /** 该段在原素材里的 segment_index（对应 live_segments） */
  segmentIndex: number;
  /** 该段在原素材里的 live_segments.id：打回时用它点名拉黑 */
  segmentId?: number | null;
  /** 钩子质量 0~100（来自 live_segments.hook_quality） */
  hookQuality?: number | null;
  /** 主题名，界面上显示 */
  themeName: string;
  role?: string;
  score?: number | null;
  /** 在粗剪里的起点（秒，从 0 开始） */
  roughcutStartSec: number;
  /** 在粗剪里的终点（秒） */
  roughcutEndSec: number;
  /** 在原素材里的起点（秒） */
  sourceStartSec: number;
  /** 在原素材里的终点（秒） */
  sourceEndSec: number;
  /**
   * 可编辑的逐句原文（句间用空格连接）。
   *
   * 为什么审片包要带原文：粗剪里只存了主题名和时间轴，
   * 没有文本就没有"像剪映那样框选几个字删掉"这件事。
   * 空串说明这一段取不到文字（多半是实操教学段），看 textless。
   */
  text?: string;
  /** 逐句明细，每句带相对段首的时间；服务端靠它把字符位置换算成时间 */
  sentences?: Array<{ startMs: number; endMs: number; text: string }>;
  /**
   * 是否属于"实操教学段"：几乎没有文字（现场演示/演唱）。
   * 这种段界面要显示成时间区间块而不是文本框 ——
   * 给它一个空文本框，用户只会以为功能坏了，而它恰恰通常是要保留的核心内容。
   */
  textless?: boolean;
  /** 无文本段的原因说明（中文，直接显示给用户） */
  textlessHint?: string;
  /** 已经剪掉的区间（上一轮打回留下的），相对段首的毫秒 */
  cuts?: Array<{ st: number; en: number }>;
}

/** 审片包：粗剪 + 段映射 + 历史意见 */
export interface ReviewPacket {
  projectId: number;
  /** 工程状态：reviewing=待审 / approved=已通过 / superseded=已被打回重建 */
  status: string;
  liveVideoId: number;
  /** 粗剪文件绝对路径；空字符串表示还没渲染出来，界面要回退到原素材播放 */
  roughcutPath: string;
  /** 粗剪总时长（秒） */
  totalSec: number;
  segments: ClipSegmentMap[];
  feedback: ReviewRecord[];
}

/** 一条审片历史 */
/** 一条剪辑学习样本（桌面端 → Hermes 归档） */
export interface EditRecordInput {
  /**
   * cut   —— 删掉的文字（避雷词）
   * keep  —— 留下的文字（正样本）
   * title —— 标题改写：text 是改后的，oldTitle 是 AI 原标题
   */
  kind: "cut" | "keep" | "title";
  text: string;
  /** 仅 kind=title：AI 原本起的标题，留着才能做对照 */
  oldTitle?: string;
  themeName?: string;
  role?: string;
  segmentId?: number;
  startSec?: number;
  endSec?: number;
  score?: number;
  /** picked = 勾选框认可；edited = 框选/改写 */
  by?: "picked" | "edited";
  /** 这条编辑的理由（用户写的那句话），服务端会一起存 */
  reason?: string;
}

/** 某位 IP 老师的剪辑档案 */
export interface EditArchive {
  collection: string;
  /** empty / thin / warm / rich —— 样本够不够，不够会如实标 thin */
  stage: "empty" | "thin" | "warm" | "rich";
  totalSamples: number;
  summary: {
    cuts: number;
    cutChars: number;
    keeps: number;
    keepChars: number;
    segments: number;
    titles: number;
  };
  /** 最常被删的开头（避雷起手式） */
  cutOpenings: Array<{ opening: string; n: number }>;
  cutPhrases: Array<{ text: string; n: number; last_at: string }>;
  /** 留下的内容形态（正样本） */
  keepSamples: Array<{ text: string; role: string | null; theme_name: string | null; n: number }>;
  /** 段落结构：role + 主题 + 次数 + 均分 + 平均时长 */
  segments: Array<{
    role: string;
    theme_name: string;
    n: number;
    avg_score: number | null;
    avg_sec: number | null;
    last_at: string;
  }>;
  /** role 偏好排序（哪段当开场、哪段是主体） */
  roleOrder: Array<{ role: string; n: number; avg_score: number | null }>;
  /** 认可的 hook 主题 */
  hookThemes: Array<{ theme_name: string; n: number; avg_score: number | null }>;
  /** 标题改写记录：AI 原标题 → 用户改成什么 */
  titleEdits: Array<{ newTitle: string; oldTitle: string | null; reason: string | null; created_at: string }>;
  promptHints: {
    avoid: string[];
    preferHooks: string[];
    structure: string[];
  };
}

export interface EditArchiveListItem {
  name: string;
  samples: number;
  cuts: number;
  keeps: number;
  segments: number;
  last_at: string;
}

/** 一条热词纠正规则 */
export interface HotwordRule {
  id: number;
  /** 归档到哪位 IP 老师；null = 通用，对所有人生效 */
  collection: string | null;
  /** 听错的写法 */
  from: string;
  /** 正确的写法 */
  to: string;
  /** 累计命中次数；长期 0 说明是条没用的规则 */
  hits: number;
}

/** 文本级删除的生效情况（打回时回给界面，让用户知道哪些没剪成） */
export interface ReviewCutReport {
  /** 实际生效的删除处数 */
  applied: number;
  /** 共剪掉多少毫秒 */
  removedMs: number;
  /** 生效的段数 */
  segments: number;
  /** 没生效的地方及原因（实操段无文本、删太多、段不在本次重建范围…） */
  skipped: string[];
}

export interface ReviewRecord {
  id: number;
  /** approve=通过 / recut=打回重剪 */
  decision: string;
  comment: string;
  /** 被点名的段（JSON 字符串） */
  segmentIds: string | null;
  createdAt: string;
  /** 归属哪位老师；null = 通用 */
  collection: string | null;
}

/** ---------- 多版本粗剪 ---------- */

/**
 * 一版粗剪结果。
 * 不同版本之间必须有真实差异(时长档位/开头策略),否则用户挑不出任何东西。
 */
export interface VariantResult {
  id: string;
  label: string;
  hint: string;
  /** 目标时长(秒) */
  targetSec: number | null;
  ok: boolean;
  projectId?: number;
  /** 产出的 mp4 列表 */
  files: string[];
  viralOpening?: string | null;
  /** 实际总时长(秒) */
  totalSec?: number;
  elapsedSec?: number;
  error?: string;
}

/** ---------- 项目持久化 ---------- */

export interface ProjectSummary {
  id: string;
  name: string;
  sourcePath: string;
  durationSec: number;
  hasTranscript: boolean;
  candidateCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface ProjectWorkspace {
  projects: ProjectSummary[];
  activeProjectId: string | null;
}

/** 会话检查点:项目数据的完整快照 */
export interface SessionCheckpoint {
  file: MediaFile;
  transcript: Transcript | null;
  candidates: ClipCandidate[] | null;
  selected: number[];
  savedAt: string;
  /**
   * Hermes live_videos.id —— 出片工程靠它建。
   * 以前检查点里没有它,于是重开项目后 liveVideoId 为空,出片必然失败;
   * 老检查点没这个字段时按 null 处理,由用户重新分析补上。
   */
  liveVideoId?: number | null;
}

/** ---------- 本地栈状态 ---------- */

export interface LocalStackStatus {
  ollama: { ok: boolean; models: string[] };
  hermes: { ok: boolean; version?: string };
}

/** ---------- 录播监听 ---------- */

export interface WatchStatus {
  running: boolean;
  watchDir?: string;
  processed?: number;
}

/** ---------- 爆款记忆库(每个 IP 老师一个独立文件夹) ---------- */

/** 一个 IP 老师 = 一个独立文件夹 */
export interface HitCollection {
  id: string;
  name: string;
  note: string;
  entryCount: number;
  /** 该 IP 全部爆款总时长(秒),UI 用来判断样本量够不够 */
  totalSec: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 爆款结构段:一条爆款拆成 hook_opening / tension_build / peak_moment /
 * resolution_cta / outro 等类型,这是反推"爆款怎么搭"的基本单位。
 */
export interface HitSegment {
  type: string;
  startMs: number;
  endMs: number;
  description?: string;
  keyText?: string;
  emotionTag?: string;
  intensity?: number;
  keyframePath?: string;
}

/** 一条爆款素材的完整内容 */
export interface HitEntry {
  id: string;
  /** 去重键:同一路径重复导入会被跳过 */
  sourceKey: string;
  title: string;
  sourcePath: string;
  genre?: string | null;
  totalSec: number;
  /** 开头逐字文案 —— 钩子原话,校准时权重最高 */
  openingScript?: string;
  fullTranscript?: string;
  viralPoints?: Array<{ point?: string; evidence?: string; weight?: number }>;
  onScreenTexts?: Array<{ time_seconds?: number; text?: string; type?: string }>;
  emotionCurve?: Array<{
    start_seconds?: number; end_seconds?: number;
    emotion?: string; facial_expression?: string; voice_tone?: string; intensity?: number;
  }>;
  segments: HitSegment[];
  themes?: Array<{ themeName?: string; keywords?: string[]; confidence?: number }>;
  /**
   * 爆款预测（播放区间 + 把握度 + 依据）。
   *
   * 与 metrics 里的真实数据严格分开：
   * metrics 是回流的真实数字，prediction 是模型估的。
   * 混在一起的话，界面无法告诉用户"这个数是猜的"，而用户会当参考。
   */
  prediction?: {
    viewsLow?: number | null;
    viewsHigh?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
    /** 把握度：高 / 中 / 低 */
    confidence?: string;
    rationale?: string;
  } | null;
  metrics: {
    hookStrength?: number;
    emotion?: number;
    infoDensity?: number;
    retention?: number;
    /** 剪辑刀数,用来算节奏 */
    cutCount?: number;
    views?: number;
    likes?: number;
    shares?: number;
    comments?: number;
  };
  hooks: string[];
  tags: string[];
  /** 所属导入批次,撤回靠它 */
  batchId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 校准出来的"爆款感"画像 */
export interface HitProfile {
  ipId: string;
  ipName: string;
  sampleCount: number;
  updatedAt: string;
  dimensions: Array<{
    key: string;
    label: string;
    value: number;
    sampleCount: number;
    /** 贡献这条结论的爆款标题 —— 让画像可被质疑 */
    contributing: string[];
  }>;
  topHooks: string[];
  topThemes: string[];
  /** 剪辑节奏基准(刀/分钟),null 表示样本不足 */
  pace: number | null;
  contributions: Array<{ entryId: string; title: string; totalSec: number; addedAt: string }>;
}

export interface HitImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  batchId: string | null;
  /**
   * 已有条目被刷新（不是新增）的条数。
   *
   * 以前重复导入一律静默跳过，于是 Hermes 侧后来补上的
   * 预测/真实数据永远同步不过来 ——
   * 用户点了「从历史爆款库同步」，界面上的预测却一直不变，
   * 看起来像同步没生效。
   */
  refreshed?: number;
}

/**
 * 「继续上传爆款素材」的返回。
 *
 * 关键在 enqueue：登记(source.log)和学进去(Hermes 分析)是两件事，
 * 以前只做前者，界面却报"已登记 N 个素材"，看着像已经学进去了。
 * 把排队结果如实回传，UI 才能区分"排上了"和"只是登记了"。
 */
export interface HitAttachResult {
  ok: boolean;
  attached: string[];
  errors: string[];
  enqueue?: {
    /** 已排队的条数。0 = 一个都没排上，绝不能当成"学会了" */
    queued: number;
    /** 没排上的原因，逐条如实回传 */
    rejected: { videoPath: string; reason: string }[];
    message: string;
    /** Hermes 没起来 / IP 不存在等整体失败 */
    error?: string;
  };
}

/** ---------- 引擎配置(双引擎) ---------- */

export interface EngineSettings {
  /** 默认分析引擎 */
  defaultEngine: "local" | "cloud" | "auto";
  /** 本地引擎 */
  local: { baseUrl: string; model: string };
  /** 云端引擎 */
cloud: { provider: "gemini"; apiKey: string; model: string };
  /**
   * 出网代理地址,形如 http://127.0.0.1:4780。空=自动探测。
   *
   * 为什么需要它：Electron/Node 的 fetch 只认环境变量里的代理，
   * 不读 Windows 的「系统代理」设置。这台机器开着 Clash 却是直连，
   * 于是所有云端请求都超时——表现和"key 失效"一模一样,极易误判。
   * 留空时按 环境变量 > Windows 系统代理 的顺序自动探测。
   */
  proxy: string;
  /**
   * 云端接口协议:gemini-native=Google 官方那套,openai-compatible=中转服务兼容那套。
   * 两者路径和认证方式都不同,配错一个直接 401/404,而且报错里完全看不出是协议选错
   */
  cloudProtocol?: CloudProtocol;
  /** 自定义接口地址。留空 = 用协议对应的官方地址 */
  cloudBaseUrl?: string;
  /** 记忆档案:云端学到的爆款规律 */
  memoryBriefId?: string;
  /** 云端调用预算护栏(单次分析最多调用次数) */
  cloudBudgetPerRun: number;
}

/** 保存引擎设置的结果:附带是否真的同步进了 Hermes */
export interface EngineSettingsSaveResult extends EngineSettings {
  /** 是否已写入 Hermes 配置(不写的话设置面板存了也不生效) */
  hermesSynced: boolean;
  /** 同步失败的原因,null 表示成功 */
  hermesSyncError: string | null;
  /** 实际写给 Hermes 的 provider(面板的 local/cloud/auto 会翻成 ollama/gemini/auto) */
  hermesProvider: string;
}

/**
 * 云端接口协议。
 *
 * 为什么要可选:官方 Gemini 走 Google 原生协议(?key= 认证 + :generateContent 路径),
 * 而第三方中转服务多半走 OpenAI 兼容格式(Bearer 认证 + /chat/completions)。
 * 两者的路径、认证、请求体、响应结构全都不同,猜错的表现是"配了但一直
 * 401/404",而且看不出到底哪里错了。所以交给用户选,并允许自定义地址。
 */
export type CloudProtocol = "gemini-native" | "openai-compatible";

/** 引擎探活:让面板能验证"填的东西到底能不能用" */
export interface EngineTestResult {
  local: { ok: boolean; models: string[] };
  /**
   * `error` 是分级过的：401 明确指向 key、404 指向地址/协议、超时指向代理。
   * 三者的处理办法完全不同，混成一句"不可用"用户就只能靠猜。
   */
  cloud: {
    ok: boolean;
    error?: string;
    /** 服务端实际返回的模型列表，用来发现"模型名填错"这种不报错的错 */
    models?: string[];
    /** 连上了但配置里的模型名不在列表里 */
    modelHint?: string;
    /** 本次探测实际使用的代理地址 */
    proxy?: string | null;
  };
  /** 实际生效的代理（手填或自动探测的结果） */
  proxy?: string | null;
  /** 自动探测到的代理（用于在设置里提示"已识别到系统代理"） */
  proxyDetected?: string | null;
}

/** ---------- 对外 API 形状 ---------- */

export interface StudioApi {
  /* 素材 */
  /**
   * 取拖放文件的真实磁盘路径。
   *
   * 必须走这个,不能读 File.path —— Electron 32 起 File.path 已被移除,
   * 渲染层拿到的 File 只有 name/size/type。读 f.path 会让整个拖拽分支静默失效。
   */
  pathForFile(file: File): string;

  /* ---------- 出片素材库(封面图 / 结尾藏带货) ---------- */

  /** 列素材。kind: "covers"=封面图 "tails"=藏带货视频 */
  assetList(kind: "covers" | "tails"): Promise<AssetItem[]>;
  /** 批量导入(系统对话框多选)。copy=true 复制进素材库,不动用户原文件 */
  assetImport(kind: "covers" | "tails", copy?: boolean): Promise<AssetImportResult>;
  /** 批量删除。进回收站,可用 assetRestore 找回 */
  assetDelete(kind: "covers" | "tails", ids: string[]): Promise<AssetDeleteResult>;
  /** 恢复最近一次删除 */
  assetRestore(kind: "covers" | "tails"): Promise<AssetRestoreResult>;
  /**
   * 出片时实际用哪一条。
   * 必须由主进程决定并回传 —— 渲染层自己随机会导致"用户看到的"和
   * "实际烧进片子的"不是同一张封面,而且完全无感知。
   */
  assetPick(
    kind: "covers" | "tails",
    usePath?: string,
    pick?: "first" | "last" | "random"
  ): Promise<AssetItem | null>;

  selectMedia(): Promise<string | null>;
  probeMedia(path: string): Promise<MediaProbe>;
  listMedia(dir: string): Promise<MediaFile[]>;
  defaultOutDir(): Promise<string>;
  selectOutDir(): Promise<string | null>;
  /** 选 BGM 音频文件 */
  selectAudio(): Promise<string | null>;

  /* 项目 */
  projectWorkspaceGet(): Promise<ProjectWorkspace>;
  projectCreate(checkpoint: SessionCheckpoint): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint } | null>;
  projectOpen(id: string): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint | null } | null>;
  projectClose(): Promise<void>;
  projectSave(id: string, checkpoint: SessionCheckpoint): Promise<boolean>;
  projectDelete(id: string): Promise<boolean>;
  projectRename(id: string, name: string): Promise<ProjectSummary | null>;
  projectRelink(id: string, path: string): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint } | null>;

  /* 转写与检测(走 Hermes) */
  transcribe(filePath: string): Promise<Transcript>;
  /** 读取分析时已生成的逐句稿(点句子跳画面靠它) */
  readTranscript(filePath: string): Promise<Transcript>;
  /** 多版本粗剪:一次出多条不同长度/开头的版本,供用户挑 */
  clipVariants(request: {
    liveVideoId: number;
    clipSegmentIds: number[];
    clips?: ClipCandidate[];
    variants?: string[];
    openingText?: string;
  }): Promise<VariantResult[]>;
  /**
   * 转写 + 爆点检测(Hermes /pipeline/analyze-live 一条链路)。
   * liveVideoId 必须回传:出片工程靠它建,没有它就出不了片。
   */
  detect(request: DetectionRequest): Promise<{
    liveVideoId: number | null;
    candidates: ClipCandidate[];
    stats: DetectionStats;
  }>;
  /**
   * 取消正在跑的分析。
   *
   * 以前「取消」按钮调的是 detect()，也就是"重新分析一遍"——
   * 文案和行为相反，还会让两份分析并发跑、各自删分段。
   */
  cancelDetect(filePath: string): Promise<{ ok: boolean; aborted: boolean }>;
  rerank(fileName: string, durationMode: "short" | "mid" | "long", candidates: ClipCandidate[]): Promise<{ candidates: ClipCandidate[]; summary: string }>;
  /** 拉取审片包：粗剪路径 + 段映射（粗剪坐标 ↔ 原素材坐标）+ 历史意见 */
  reviewPacket(projectId: number): Promise<ReviewPacket>;
  /**
   * 提交审片结论。
   *
   * decision=approve 通过；recut 打回重剪（会把 comment 变成记忆，
   * 下次找爆点时避开同样的问题）。
   */
  submitReview(
    projectId: number,
    payload: {
      decision: "approve" | "recut";
      comment?: string;
      segmentIds?: number[];
      /**
       * 文本级删除：用户像编辑文档一样框选文字删掉的内容。
       *
       * 只传"第几段、哪几个字符"，时间由 Hermes 换算 —— 因为文本是那边拼接的，
       * 让客户端算就得知道拼接规则，规则一变它算的秒数全错而且不报错。
       * 支持跨段：一次框选可以横跨多段，每段各给一个区间。
       */
      textCuts?: Array<{ segmentId: number; ranges: Array<{ from: number; to: number }> }>;
    }
  ): Promise<{
    ok: boolean;
    newProjectId?: number;
    status?: string;
    cuts?: ReviewCutReport;
    /**
     * 实际写入的学习样本条数。
     *
     * 必须有它：整个正样本写入都在服务端的 try 里，抛错时"通过"照样成立，
     * 但一条都没学到。少了这个字段，前端只能无脑显示
     * "下次找爆点会参考这次的意见" —— 失败时说的正好是反的。
     */
    learned?: number;
    /** 写学习样本失败时的原因；非空就表示这次没学到 */
    learnFailed?: string | null;
    /** 作废工程被再次确认时，服务端会回 409 并带上该用哪个工程 */
    supersededBy?: number | null;
  }>;

  /**
   * 把桌面端的剪辑编辑记进对应 IP 老师的档案。
   *
   * 与 submitReview 分开的原因：桌面端审阅台是**逐个候选**改的，
   * 一次出好几条独立信号（改标题、剔句子、框选删字），
   * 没有"打回重剪"这个整体动作，复用 review 会把语义搞混。
   */
  recordEditRecords(payload: {
    liveVideoId?: number | null;
    videoPath?: string;
    collection?: string | null;
    reason?: string;
    edits: EditRecordInput[];
  }): Promise<{ ok: boolean; written: number; collection?: string | null }>;

  /** 读取某位 IP 老师的剪辑档案 */
  editArchive(collection: string): Promise<EditArchive | null>;
  /** 列出所有有剪辑档案的 IP 老师 */
  listEditArchives(): Promise<EditArchiveListItem[]>;

  /**
   * 热词硬纠正：改掉 ASR 听错的词。
   *
   * 归档在 IP 老师名下 —— 同一个人的名字/术语，对不同老师写法不同，
   * 混成通用规则就会互相污染。
   *
   * 加完立刻生效，不用重跑分析（应用点在文本进入会话的唯一出口）。
   */
  listHotwords(collection?: string | null): Promise<HotwordRule[]>;
  addHotword(payload: { collection?: string | null; from: string; to: string }): Promise<{ ok: boolean; id: number; updated: boolean }>;
  removeHotword(id: number): Promise<{ ok: boolean }>;
  /** 纯文本替换，与 Hermes 侧算法一致；渲染层可直接用，不必回主进程 */
  applyHotwordsToTranscript<T extends { segments?: Array<{ text: string }> }>(
    transcript: T | null,
    rules: HotwordRule[]
  ): T | null;

  /* 出片 */
  export(request: ExportRequest): Promise<ExportResult>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;

  /* 栈状态 */
  localStackStatus(): Promise<LocalStackStatus>;
  watchStatus(): Promise<WatchStatus>;

  /* 引擎设置 */
  engineSettings(): Promise<EngineSettings>;
  setEngineSettings(settings: Partial<EngineSettings>): Promise<EngineSettingsSaveResult>;
  testEngines(): Promise<EngineTestResult>;

  /* 记忆 */
  memoryBriefs(): Promise<Array<{ id: string; title: string; createdAt: string; items: number }>>;
  memoryLearn(filePath: string): Promise<{ id: string; title: string; items: number }>;

  /**
   * 预览取流。
   * 主进程先把该文件登记进白名单,再返回 glb-media:// URL;
   * 不用 file:// 是因为 contextIsolation 下渲染层直接引用本地文件会被拦。
   */
  mediaOpen(filePath: string): Promise<string>;
  mediaClose(filePath: string): Promise<void>;

  openUrl(url: string): Promise<void>;

  /**
   * 出片产物的三个动作。
   *
   * 以前出片完只给一行"已输出 N 个文件",想看成片得自己去资源管理器翻目录。
   * 这三个通道让用户能就地预览/打开/定位。
   *
   * 注意:主进程会按扩展名白名单过滤,不是任意路径都能打开 ——
   * shell.openPath 等于让系统执行,不能开成 .exe/.bat/.ps1。
   */
  revealResult(filePath: string): Promise<{ ok: boolean; error?: string }>;
  openResultExternal(filePath: string): Promise<{ ok: boolean; error?: string }>;
  openResultFolder(dirPath: string): Promise<{ ok: boolean; error?: string }>;

  /* ---------- 爆款记忆库(每个 IP 老师一个独立文件夹) ---------- */

  /** IP 列表 */
  hitListIps(): Promise<HitCollection[]>;
  /** 新建 IP 档案;同名返回 null */
  hitCreateIp(name: string, note?: string): Promise<(HitCollection & {
    /** Hermes 侧同名 collection 是否也建好了 */
    hermesSynced?: boolean;
    /** 没建成功时的原因，如实回传给 UI */
    hermesError?: string;
  }) | null>;
  hitRenameIp(ipId: string, name: string, note?: string): Promise<HitCollection | null>;
  /** 删除 IP。toTrash=true 进回收站(可恢复),false 彻底删除 */
  hitDeleteIp(ipId: string, toTrash?: boolean): Promise<boolean>;
  /** 恢复最近一次误删 */
  hitRestoreIp(): Promise<HitCollection | null>;
  hitListRestorableIps(): Promise<HitCollection[]>;

  /** 某 IP 下的爆款条目 */
  hitListEntries(ipId: string): Promise<HitEntry[]>;
  /** 批量导入(直接给条目数据) */
  hitImport(ipId: string, entries: HitEntry[]): Promise<HitImportResult>;
  /** 从磁盘选文件批量登记素材(只登记引用,不复制 GB 级视频) */
    /**
   * 有没有真的排进 Hermes 的分析队列。
   *
   * 缺这一块的话，"上传成功"和"学进去了"会被当成同一件事 ——
   * 而以前它们确实不是一回事：只登记不分析，界面照样显示成功。
   */
  hitImportFiles(ipId: string, copy?: boolean): Promise<{
    ok: boolean;
    attached: string[];
    errors: string[];
    enqueue?: {
      /** 已排队的条数（0 = 一个都没排上，不能当成"学会了"） */
      queued: number;
      /** 没排上的原因，逐条如实回传 */
      rejected: { videoPath: string; reason: string }[];
      message: string;
      /** Hermes 没起来 / IP 不存在等整体失败 */
      error?: string;
    };
  }>;
  /** 导入批次列表(给"撤回"按钮用) */
  hitListBatches(ipId: string): Promise<Array<{ batchId: string; count: number; at: string; sample: string }>>;
  /** 撤回一批导入 */
  hitUndoBatch(ipId: string, batchId: string): Promise<{ ok: boolean; removed: number; error?: string }>;
  hitDeleteEntry(ipId: string, entryId: string): Promise<boolean>;

  /** 某条素材在 Hermes 侧的 id；查不到返回 null（要先去同步） */
  hitResolveHermesId(ipName: string, sourcePath: string): Promise<number | null>;

  /**
   * 上传数据截图 / 手填数字更正爆款预测。
   *
   * 桌面端只负责把图送过去，OCR 与重算都由 Hermes 做 ——
   * 自己再实现一遍 OCR 只会得到两套不一致的读数。
   */
  hitFeedback(payload: {
    hitId: number;
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
    platform?: string;
    note?: string;
    /** data:image/xxx;base64,... —— 桌面端必须先压图，否则会超 15mb 上限 */
    screenshot?: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    /** 更正后重算出的预测 */
    prediction?: Record<string, unknown> | null;
    /** Hermes 从截图里读到的数 */
    ocr?: Record<string, unknown> | null;
    platform?: string | null;
  }>;

  /** 校准画像 */
  hitProfile(ipId: string): Promise<HitProfile | null>;
  /** 强制重算画像 */
  hitRebuildProfile(ipId: string): Promise<HitProfile | null>;
  /** 画像压成可直接进 prompt 的文字 */
  hitProfileBrief(ipId: string): Promise<string>;

  /** 从 Hermes 历史爆款库同步(可指定集合名) */
  hitSyncFromHermes(ipName?: string): Promise<{ ok: boolean; imported: number; skipped: number; errors: string[]; ipId?: string }>;

  /** 选定某位老师:同时把 Hermes 的 active collection 切过去 */
  hitActivateIp(ipId: string): Promise<{ ok: boolean; ipName?: string; entryCount?: number; error?: string }>;
  /** 该 IP 在 Hermes 侧的 brief(分析时真正进 prompt 的那份) */
  hitHermesBrief(ipId?: string): Promise<string>;
}
