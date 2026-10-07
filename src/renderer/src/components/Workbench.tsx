/**
 * 工作台:左导航 + 中央工作区 + 右侧出片台
 * © 2026 郭洛斌
 *
 * 主流程:转写 → 找爆点 → 选片 → 出片,四步都在视线内完成,不用跳页。
 * 每一步的状态在顶栏管线灯上一眼可见,任何时刻都能回上一步且不丢结果。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuBrain,
  LuCheck,
  LuClock,
  LuFilePlus2,
  LuFolderSearch,
  LuFolderOpen,
  LuKeyboard,
  LuUndo2,
  LuRedo2,
  LuSun,
  LuMoon,
  LuLayers,
  LuLoaderCircle,
  LuPlay,
  LuSearch,
  LuSettings,
  LuSparkles,
  LuCornerUpLeft,
  LuUpload,
  LuX
} from "react-icons/lu";
import { bridge, call } from "../lib/bridge";
import { useSession } from "../stores/session-store";
import type {
  ClipCandidate,
  EditRecordInput,
  EngineSettings,
  Transcript,
  TranscriptSegment
} from "@shared/api-types";
import { CandidateList } from "./CandidateList";
import { ExportDock } from "./ExportDock";
import { PreviewPlayer, type PlaybackApi } from "./PreviewPlayer";
import { ProjectLibrary } from "./ProjectLibrary";
import { EditArchivePanel } from "./EditArchivePanel";
import { ReviewTextCutter as TextCutter } from "./ReviewTextCutter";
import { Timeline } from "./Timeline";
import { HotwordPanel } from "./HotwordPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { ReviewPanel as RoughcutReviewPanel } from "./ReviewPanel";
import { HitVaultPanel } from "./HitVaultPanel";
import type { ExportArtifacts } from "./ResultList";
import { ShortcutHelp } from "./ShortcutHelp";
import { Splitter } from "./Splitter";
import { useShortcuts } from "../hooks/useShortcuts";
import { useTheme } from "../hooks/useTheme";
import { DEFAULT_RENDER, RenderOptionsPanel } from "./RenderOptions";
import { cx, Dot, Empty, Modal, Progress } from "./ui";
import { fileStem } from "../lib/format";
import type { RenderOptions } from "@shared/api-types";

/**
 * 转写 / 找爆点 两个长任务用同一个占位面板。
 *
 * 为什么要显示"已用时间 + 阶段"：长直播分析要几分钟到几十分钟，
 * 只有一个转圈的图标时用户完全不知道程序是在干活还是卡死 ——
 * 之前就是这样（elapsed() 写了却从没被调用），反馈缺失本身就成了"界面在闪"的观感来源。
 */
function TaskPanel({
  title,
  hint,
  percent,
  elapsedSec,
  steps
}: {
  title: string;
  hint?: string;
  percent: number | null;
  /** 已用秒数，由父组件每秒推进 */
  elapsedSec?: number;
  /** 当前阶段说明（按素材时长与实测速度给量级预期） */
  steps?: string[];
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="icon-tile flex h-14 w-14 items-center justify-center rounded-2xl">
        <LuLoaderCircle className="h-7 w-7 spin-slow" />
      </div>
      <div className="text-center">
        <p className="shimmer text-[13.5px] font-bold">{title}</p>
        {hint && <p className="mt-1.5 max-w-md text-[11.5px] leading-relaxed text-mut-2">{hint}</p>}
      </div>
      <div className="w-full max-w-sm">
        <Progress percent={percent} />
      </div>

      {/* 已用时间:证明程序还活着。长时间任务没有它就像卡死。 */}
      {elapsedSec !== undefined && elapsedSec > 0 && (
        <p className="tabular font-mono text-[11.5px] text-mut-2">
          已用 {formatElapsed(elapsedSec)}
          {percent === null && <span className="ml-2 text-mut-2/70">处理中,耗时取决于素材长度</span>}
        </p>
      )}

      {/* 阶段说明:让用户知道要经历哪几步、大概多久 */}
      {steps && steps.length > 0 && (
        <ol className="mt-1 w-full max-w-sm space-y-1">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed text-mut-2/80">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ember/60" />
              {s}
            </li>
          ))}
        </ol>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-mut-2">
        <LuBrain className="h-3.5 w-3.5" />
        全程本地推理,素材不出本机
      </p>
    </div>
  );
}

/** 秒 -> 1分05秒 / 12分30秒 */
/**
 * "已用 N 分 M 秒"。
 *
 * 单独抽成一个组件，是为了把每秒的重渲染范围限制在这几行文字里。
 * 以前计时器写在 Workbench 里，每秒 setTick 一次，
 * 于是 1772 句逐句稿 + 全部候选卡每秒重建一次 —— 分析期间界面必然卡。
 */
function ElapsedBadge({
  running,
  prefix = "已用 "
}: {
  running: boolean;
  prefix?: string;
}): React.JSX.Element | null {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!running) {
      setSec(0);
      return;
    }
    setSec(0);
    const id = setInterval(() => setSec((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!running) return null;
  return <>{prefix}{formatElapsed(sec)}</>;
}

function formatElapsed(sec: number): string {
  const s = Math.floor(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/**
 * 阶段说明。
 * 给出量级预期是关键:长直播分析要几十分钟,不给预期用户会以为卡死,
 * 转而去反复点按钮 —— 那才是真的把界面搞闪。
 */
const TRANSCIBE_STEPS = [
  "语音识别(本地):按 20 秒切片逐段转写,3 小时素材约 5 分钟",
  "主题分段:本地模型按片段归类并给钩子分",
  "记忆匹配:对照历史爆款主题库打分",
  "写库:生成候选列表(全程在本机完成)"
];

const DETECT_STEPS = [
  "按素材形态自动分派:短片段本地逐条打分,长直播走长上下文",
  "清洗与去重,剔除运营话术",
  "生成候选列表"
];

/**
 * 分隔条比例必须夹在合理区间。
 *
 * 为什么需要:比例存在 localStorage 里,旧版本或者手改过的值可能是
 * 0、负数、5 这种离谱值。原样使用会让某个面板拿到远超容器的高度,
 * 于是压到兄弟面板上(表现就是两块内容叠在一起)。
 * 这里双向夹紧,NaN 也一并归到默认值 —— NaN 传给 flex-basis 会被忽略,
 * 面板高度变成 0,又是一种"看起来消失"的怪问题。
 */
function clampRatio(r: number, min = 0.12, max = 0.8): number {
  return Number.isFinite(r) ? Math.min(max, Math.max(min, r)) : 0.38;
}

/** 左侧导航 */
function SideNav({
  onImport,
  onOpenWatch,
  onOpenProjects,
  onOpenVault,
  onOpenSettings,
  onChangeOutDir,
  onOpenProject,
  outDir,
  memoryIpName
}: {
  onImport: () => void;
  onOpenWatch: () => void;
  onOpenProjects: () => void;
  onOpenVault: () => void;
  onOpenSettings: () => void;
  onChangeOutDir: () => void;
  onOpenProject: (id: string) => void;
  outDir: string;
  /** 当前用哪位老师的记忆,显示在按钮上让用户随时知道 */
  memoryIpName?: string | null;
}): React.JSX.Element {
  const { file, projects } = useSession();
  const outDirName = outDir ? outDir.split(/[\\/]/).filter(Boolean).pop() ?? outDir : "";
  return (
    <nav className="flex w-[212px] shrink-0 flex-col border-r border-line/70 bg-panel/45">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line/60 px-3.5">
        <span className="flame-gradient flex h-5 w-5 items-center justify-center rounded text-[11px] font-black text-white">
          G
        </span>
        <span className="text-[12.5px] font-extrabold tracking-tight">GLB Studio</span>
      </div>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2.5">
        <button
          type="button"
          onClick={onImport}
          // 以前这个按钮直接 session.reset() 且不提示：看着像"再加一个素材"，
          // 实际把刚分析出来的成果全丢掉，所以没人敢点，出片台成了死胡同。
          // 现在它走 requestLeave：有成果会先问，进行中会先拦。
          title="回到上传/导入素材界面（当前素材的分析成果会被清掉）"
          className="btn-flame group flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-bold text-white"
        >
          <LuFilePlus2 className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
          上传新素材
        </button>

        {file && (
          <section className="pane-in-left flex flex-col gap-1.5">
            <div className="px-1 text-[10px] font-bold tracking-[1.4px] text-mut-2">当前素材</div>
            <div className="rounded-xl border border-ember/25 bg-panel-2/70 p-2.5">
              <p className="text-[11.5px] leading-snug font-semibold break-all" title={file.path}>
                {file.name}
              </p>
              <div className="tabular mt-1.5 font-mono text-[10px] text-mut">
                {file.width > 0 ? `${file.width}×${file.height} · ` : ""}
                {file.hasVideo ? "视频" : "音频"}
              </div>
              {/* 卡片里再给一个出口：素材卡片本身就是"当前正在处理的东西"，
                  在它旁边放"换素材"最符合直觉，也不用去顶栏找 */}
              <button
                type="button"
                onClick={onImport}
                title="回到上传/导入素材界面，换一段素材"
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[11px] font-semibold text-mut transition-colors hover:border-ember/40 hover:text-fg"
              >
                <LuCornerUpLeft className="h-3 w-3" />
                回上传页 / 换素材
              </button>
            </div>
          </section>
        )}

        {projects.length > 0 && (
          <section className="flex flex-col gap-1">
            <div className="px-1 text-[10px] font-bold tracking-[1.4px] text-mut-2">最近项目</div>
            <ul className="flex flex-col gap-0.5">
              {projects.slice(0, 6).map((project, i) => (
                <li key={project.id} className="list-in" style={{ "--i": i } as React.CSSProperties}>
                  {/* 以前是 <span>,点了没反应 —— 看着像入口,其实不能点 */}
                  <button
                    type="button"
                    onClick={() => onOpenProject(project.id)}
                    className="nav-item flex w-full flex-col gap-0.5 rounded-lg py-1.5 pr-2 pl-3 text-left transition-colors hover:bg-panel-2/60"
                    title={`打开项目 ${project.name}`}
                  >
                    <span className="truncate text-[11.5px] font-semibold text-fg/85">{project.name}</span>
                    <span className="flex items-center gap-1.5 text-[9.5px] text-mut-2">
                      <LuClock className="h-2.5 w-2.5" />
                      {relativeTime(project.lastOpenedAt || project.updatedAt)}
                      {project.candidateCount > 0 && <span className="tabular">· {project.candidateCount} 条</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex-1" />
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-line/60 p-2.5">
        <button
          type="button"
          onClick={onOpenWatch}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:bg-panel-2/60 hover:text-fg"
        >
          <LuFolderSearch className="h-4 w-4" />
          录播监听
        </button>
        <button
          type="button"
          onClick={onOpenProjects}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:bg-panel-2/60 hover:text-fg"
        >
          <LuLayers className="h-4 w-4" />
          项目库
          {projects.length > 0 && <span className="tabular ml-auto font-mono text-[10px] opacity-60">{projects.length}</span>}
        </button>
        <button
          type="button"
          onClick={onOpenVault}
          title="爆款记忆库:每位老师一个独立文件夹,新增爆款会叠加校准"
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:bg-panel-2/60 hover:text-fg"
        >
          <LuBrain className="h-4 w-4" />
          爆款库
          {memoryIpName && (
            <span className="ml-auto truncate text-[10px] font-normal opacity-70">{memoryIpName}</span>
          )}
        </button>
        {/* 设置入口。顶栏虽然也有一个「引擎」按钮,但那是启动页的装饰,
            进了剪辑台就够不着了 —— 而改引擎、换模型、配 Key 都是剪辑前要做的事。
            在侧栏常驻,免得用户为此退回上一步。 */}
        <button
          type="button"
          onClick={onOpenSettings}
          title="设置:分析引擎 / Gemini Key / 出片参数"
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:bg-panel-2/60 hover:text-fg"
        >
          <LuSettings className="h-4 w-4" />
          设置
        </button>
        <button
          type="button"
          onClick={onChangeOutDir}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-mut transition-colors hover:bg-panel-2/60 hover:text-fg"
          title={outDir ? `当前：${outDir}` : "点击选择出片目录"}
        >
          <LuFolderOpen className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">输出目录</span>
          {outDir && <span className="tabular ml-auto max-w-[92px] truncate font-mono text-[9.5px] opacity-60">{outDirName}</span>}
        </button>
      </div>
    </nav>
  );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 3_600_000) return "刚刚";
  if (diff < day) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < day * 2) return "昨天";
  if (diff < day * 30) return `${Math.round(diff / day)} 天前`;
  return new Date(then).toLocaleDateString();
}

/** 顶栏管线灯 */
function PipeChip({ label, state, extra }: { label: string; state: "done" | "busy" | "idle"; extra?: string }): React.JSX.Element {
  return (
    <span
      className={cx(
        "flex h-6.5 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] whitespace-nowrap",
        state === "busy" ? "border-ember/50 bg-ember/10 text-ember" : "border-line bg-white/3 text-mut"
      )}
    >
      {state === "done" ? (
        <LuCheck className="h-3 w-3 text-ok" strokeWidth={3} />
      ) : state === "busy" ? (
        <Dot tone="busy" />
      ) : (
        <Dot tone="idle" />
      )}
      {label}
      {extra && <span className="tabular font-mono text-[10px] opacity-80">{extra}</span>}
    </span>
  );
}

export function Workbench({ engine, onOpenSettings }: { engine: EngineSettings | null; onOpenSettings: () => void }): React.JSX.Element {
  const session = useSession();
  const { file, transcript, candidates, detecting, transcribing, error, stage, stats } = session;
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [renderOptions, setRenderOptions] = useState<RenderOptions>(DEFAULT_RENDER);
  const [exportMsg, setExportMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  /** 出片产物清单:出片完成后能直接预览/打开/定位 */
  const [artifacts, setArtifacts] = useState<ExportArtifacts | null>(null);
  const { theme, toggle: toggleTheme } = useTheme();
  const [panelMsg, setPanelMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
/** 回上传页前的二次确认：真的会丢分析成果时才弹 */
const [leaveAskOpen, setLeaveAskOpen] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showVault, setShowVault] = useState(false);
  /**
   * 审片状态。
   *
   * projectId 和 roughcutPath 都来自出片结果。以前粗剪只混在 files 里，
   * 而 files 一旦有包装产物就被整个覆盖 —— 于是界面上永远看不到粗剪，
   * "审片"这个环节根本不存在。现在单独存，审片才有得可审。
   */
  const [clipProjectId, setClipProjectId] = useState<number | null>(null);
  const [roughcutPath, setRoughcutPath] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [reviewMsg, setReviewMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  /** 当前用哪位老师的爆款记忆。null = 不指定(用库里的第一套) */
  const [memoryIpId, setMemoryIpId] = useState<string | null>(null);
  // 名字要从库里查,不能只存 id —— 按钮上要直接显示"用的是谁的记忆"
  const [memoryIpName, setMemoryIpName] = useState<string | null>(null);
  const [showWatch, setShowWatch] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // 面板宽度:写死 42% 时小屏播放器被挤没,大屏又浪费。用户应能自己调。
  const [leftRatio, setLeftRatio] = useState(0.42);
  // 逐句稿面板高度同理
  const [trRatio, setTrRatio] = useState(0.38);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 用户是否点了取消。用于防止取消后迟到的结果覆盖界面 */
  const cancelledRef = useRef(false);

  /* ---- 播放状态:播放器是唯一真相,时间轴/逐句稿/候选卡都从它取当前秒 ---- */
  const [playTime, setPlayTime] = useState(0);
  const [playDuration, setPlayDuration] = useState(0);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const playbackRef = useRef<PlaybackApi | null>(null);
  const registerApi = useCallback((api: PlaybackApi | null): void => {
    playbackRef.current = api;
  }, []);

  // 切素材就把播放状态清零,否则会带着上一条的秒数渲染时间轴
  useEffect(() => {
    setPlayTime(0);
    setPlayDuration(0);
    setSeekTo(null);
  }, [file?.path]);

  const onTime = useCallback((sec: number): void => setPlayTime(sec), []);
  const onDuration = useCallback((sec: number): void => setPlayDuration(sec), []);

  /** 从候选卡/逐句稿跳过来:设 seekTo 触发播放器定位 */
  const jumpTo = useCallback((sec: number): void => setSeekTo(sec), []);

  // 空格播放/暂停。选片段时手不离键盘是高频动作,
  // 但输入框里按空格必须照常打空格,所以要先排除表单元素。

    /** 在候选之间移动焦点,并让画面跟着跳 */
  const moveFocus = useCallback(
    (delta: number): void => {
      const list = candidates ?? [];
      if (list.length === 0) return;
      const sorted = [...list].sort((a, b) => a.startSec - b.startSec);
      const cur = sorted.findIndex((c) => c.id === session.focusedId);
      const next = cur < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, cur + delta));
      const target = sorted[next];
      if (!target) return;
      session.setFocusedId(target.id);
      jumpTo(target.startSec);
    },
    [candidates, jumpTo, session]
  );

  /** 跳到上/下一段的开头 */
  const jumpSegment = useCallback(
    (dir: -1 | 1): void => {
      const list = [...(candidates ?? [])].sort((a, b) => a.startSec - b.startSec);
      // TS 不认 length 判断能推出索引安全,这里显式取值
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (dir === 1) {
        const nxt = list.find((c) => c.startSec > playTime + 0.3);
        jumpTo(nxt ? nxt.startSec : last.startSec);
      } else {
        const prev = [...list].reverse().find((c) => c.startSec < playTime - 0.3);
        jumpTo(prev ? prev.startSec : first.startSec);
      }
    },
    [candidates, jumpTo, playTime]
  );

  const setSelection = useCallback(
    (ids: number[], on: boolean, action?: string): void => {
      const next = new Set(session.selected);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      session.setSelected(next, action);
    },
    [session]
  );

  useShortcuts({
    // 审片台打开时把键盘让出去：它自己接管 空格/[/]/,/./Esc。
    // 不让的话按空格暂停的是背后这个播放器，画面不动，像坏了；
    // 而 A/D 会误触全选/反选，把选片结果改掉。
    enabled: !showReview,
    onPlayToggle: () => playbackRef.current?.toggle(),
    onNext: () => moveFocus(1),
    onPrev: () => moveFocus(-1),
    onToggleCurrent: () => {
      if (session.focusedId !== null) session.toggleSelected(session.focusedId);
    },
    onSelectAll: () => setSelection((candidates ?? []).map((c) => c.id), true, "全选"),
    onInvert: () =>
      setSelection(
        (candidates ?? []).filter((c) => !session.selected.has(c.id)).map((c) => c.id),
        true,
        "反选"
      ),
    onKeepHigh: () =>
      setSelection(
        (candidates ?? []).filter((c) => (c.score || 0) >= 80).map((c) => c.id),
        true,
        "只留高分"
      ),
    onUndo: () => session.undo(),
    onRedo: () => session.redo(),
    onPrevSegment: () => jumpSegment(-1),
    onNextSegment: () => jumpSegment(1),
    onBack5: () => jumpTo(Math.max(0, playTime - 5)),
    onFwd5: () => jumpTo(playTime + 5),
    onExport: () => {
      if (session.selected.size > 0 && !(transcribing || detecting)) void runExport();
    },
    onFocusSearch: () => searchRef.current?.focus(),
    onShowHelp: () => setShowHelp(true),
    onEscape: () => {
      if (showHelp) setShowHelp(false);
      else if (leaveAskOpen) setLeaveAskOpen(false);
      else if (showVault) setShowVault(false);
      else if (showOptions) setShowOptions(false);
      else if (showProjects) setShowProjects(false);
      else if (reviewId !== null) setReviewId(null);
    }
  });

  /* ---------- 侧栏入口 ---------- */

  /** 打开项目:恢复它的素材、逐句稿、候选与勾选 */
  const openProject = useCallback(
    async (projectId: string): Promise<void> => {
      setPanelMsg(null);
      try {
        const opened = await call((api) => api.projectOpen(projectId));
        if (!opened?.project) {
          setPanelMsg({ tone: "warn", text: "这条项目已经不在了" });
          return;
        }
        const { project, checkpoint } = opened;
        if (checkpoint?.file) {
          // 有检查点:完整恢复素材/逐句稿/候选/勾选/liveVideoId
          session.restore(checkpoint);
          session.setActiveProjectId(project.id);
          session.setLiveVideoId(checkpoint.liveVideoId ?? null);
          setPlayTime(0);
          setPlayDuration(0);
          setSeekTo(null);
          setShowProjects(false);
          setPanelMsg({ tone: "ok", text: `已打开「${project.name}」` });
          return;
        }
        // 老项目只有索引没有检查点:至少把素材显示出来,别让用户以为点了没反应
        const sourcePath = project.sourcePath;
        if (!sourcePath) {
          setPanelMsg({ tone: "warn", text: "这条项目里没有记录素材路径" });
          return;
        }
        const probe = await call((api) => api.probeMedia(sourcePath));
        // probeMedia 只给探测信息,会话要的是 MediaFile(含 name),这里补齐。
        // 素材被移走时要给出可读原因,而不是崩在解析 ffmpeg 输出上。
        if (!probe || probe.durationSec <= 0) {
          setPanelMsg({
            tone: "warn",
            text: `素材读不出来了:${sourcePath}。可能已被移动或删除,重新导入一次即可。`
          });
          return;
        }
        session.setFile({
          ...probe,
          // MediaFile = MediaProbe + name
          name: sourcePath.split(/[\\/]/).pop() ?? sourcePath
        });
        session.setActiveProjectId(project.id);
        setPlayTime(0);
        setPlayDuration(0);
        setSeekTo(null);
        setPanelMsg({
          tone: "warn",
          text: `已打开素材「${project.name}」。这条老项目没保存分析结果,需要重新跑一次「找爆点」。`
        });
      } catch (err) {
        setPanelMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
      }
    },
    [session]
  );

  /** 打开项目库 */
  const openProjects = useCallback((): void => {
    setShowWatch(false);
    setShowProjects((v) => !v);
    setPanelMsg(null);
  }, []);

  /** 打开爆款记忆库 */
  const openVault = useCallback((): void => {
    setShowWatch(false);
    setShowProjects(false);
    setShowVault((v) => !v);
    setPanelMsg(null);
  }, []);

  /** 打开设置。引擎面板由 App 顶层持有(它要能改 App 的 engine 状态),所以这里只往外抛 */
  const openSettings = useCallback((): void => {
    onOpenSettings();
  }, [onOpenSettings]);

  /** 切换出片目录 */
  const changeOutDir = useCallback(async (): Promise<void> => {
    try {
      const dir = await call((api) => api.selectOutDir());
      if (dir) {
        session.setOutDir(dir);
        setPanelMsg({ tone: "ok", text: `出片目录已改为 ${dir}` });
      }
    } catch (err) {
      setPanelMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    }
  }, [session]);

/**
 * 回到上传/导入素材界面。
 *
 * 为什么要专门写这个函数，而不是到处直接 session.reset()：
 *   - session.reset() 会连带清掉 transcript / candidates / 勾选 / 撤销历史。
 *     以前唯一的入口是左边那个橙色「导入素材」按钮，它直接 reset 且不提示，
 *     用户看着像"再加一个素材"，实际是把刚分析出来的成果全丢掉 ——
 *     所以没人敢点，表现就是"没有返回上传页的入口"。
 *   - 这里先把"会不会丢东西"讲清楚，真要丢才问一句。
 *
 * 进行中的任务不能直接丢：那些结果只在内存里，一 reset 就得从头再跑。
 */
const requestLeave = (): void => {
  if (transcribing || detecting || session.stage === "exporting") {
    setPanelMsg({
      tone: "warn",
      text: `正在${transcribing ? "转写" : detecting ? "检测爆点" : "出片"},`
        + `现在回上传页会中断且进度不保留。等它跑完再回去。`
    });
    return;
  }
  const hasWork = Boolean(session.candidates?.length) || session.selected.size > 0;
  if (hasWork) {
    setLeaveAskOpen(true);
    return;
  }
  session.reset();
};
const doLeaveNow = (): void => {
  setLeaveAskOpen(false);
  session.reset();
};

/** 录播监听:真实拉一次状态,不再是个空按钮 */
const openWatch = useCallback(async (): Promise<void> => {
    setShowProjects(false);
    setShowWatch((v) => !v);
    setPanelMsg(null);
    if (!showWatch) {
      try {
        const st = await call((api) => api.watchStatus());
        setPanelMsg(
          st.running
            ? { tone: "ok", text: "录播监听运行中:直播落到素材目录后会自动转写并分析。" }
            : { tone: "warn", text: "录播监听当前未运行。素材需要手动导入;要开启自动监听请启动 Hermes 守护进程。" }
        );
      } catch (err) {
        setPanelMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [showWatch]);

  // 计时：以前是 setTick 每秒推进一次，强制 Workbench 整树重渲染。
  //
  // 而这棵树里有 1772 句逐句稿（全部是真实 DOM，无虚拟化）、全部候选卡、
  // 逐句稿命中高亮。分析一场 3 小时直播要几十分钟 ——
  // 也就是这几十分钟里界面每秒重建上千个 DOM 节点，
  // 表现为"卡、界面僵、鼠标拖不动"。
  //
  // 现在计时只重渲染 ElapsedBadge 自己那几行文字。
  const [elapsedRunning, setElapsedRunning] = useState(false);
  useEffect(() => {
    setElapsedRunning(transcribing || detecting);
  }, [transcribing, detecting]);

  const runTranscribe = useCallback(async (): Promise<void> => {
    if (!file) return;
    session.setTranscribing(true);
    session.setError(null);
    cancelledRef.current = false;
    try {
      // transcribe 只做素材体检(Hermes 无独立 ASR 端点,ASR 在 analyze-live 内部),
      // 返回的 transcript.segments 必然为空。绝不能 setTranscript——那会让界面
      // 以为"转写已完成",于是跳过分析、逐句稿面板一直空着。
await call((api) => api.transcribe(file.path));
      const result = await call((api) =>
        api.detect({
          filePath: file.path,
          engine: "auto",
          collection: session.collection,
          // 时长用来按体量给超时;不给的话一律按默认上限,长直播会超时
          durationSec: file.durationSec
        })
      );
      // 用户在转写阶段点过"取消"，迟到的结果就别写进来了
      if (cancelledRef.current) return;
      session.setLiveVideoId(result.liveVideoId);
      session.setCandidates(result.candidates, result.stats);
      // 逐句稿是分析副产物,取它只为"点句子跳画面",失败不能影响主流程
      void call((api) => api.readTranscript(file.path))
        .then((tr) => {
          if (cancelledRef.current) return;
          if (tr.segments.length > 0) session.setTranscript(tr);
        })
        .catch(() => undefined);
    } catch (err) {
      if (cancelledRef.current) return;
      session.setError(err instanceof Error ? err.message : String(err));
    } finally {
      session.setTranscribing(false);
      session.setDetecting(false);
    }
  }, [file, session]);

const runDetect = useCallback(async (): Promise<void> => {
    if (!file) return;
    session.setDetecting(true);
    session.setError(null);
    cancelledRef.current = false;
    try {
      const result = await call((api) =>
        api.detect({
          filePath: file.path,
          engine: "auto",
          collection: session.collection,
          // 时长用来按体量给超时;不给的话一律按默认上限,长直播会超时
          durationSec: file.durationSec
        })
      );
      // 用户点过"取消"就别再写结果了：
      // 否则取消后那一瞬间返回的数据还会覆盖掉用户已经看到的界面。
      if (cancelledRef.current) return;
      session.setLiveVideoId(result.liveVideoId);
      session.setCandidates(result.candidates, result.stats);
      void call((api) => api.readTranscript(file.path))
        .then((tr) => {
          if (cancelledRef.current) return;
          if (tr.segments.length > 0) session.setTranscript(tr);
        })
        .catch(() => undefined);
    } catch (err) {
      if (cancelledRef.current) return;
      session.setError(err instanceof Error ? err.message : String(err));
    } finally {
      // 无论正常结束、报错还是被取消，都要把 detecting 收回去，
      // 否则界面会永远卡在"正在找爆点…"。
      session.setDetecting(false);
    }
  }, [file, session]);

  /**
   * 真的取消分析。
   *
   * 以前这个按钮调的是 runDetect()——也就是"重新分析一遍"。
   * 文案和行为正好相反，而且服务端还在对同一个 videoPath 跑着，
   * 于是要么撞 409「正在分析中」，要么两份分析并发跑、各自删分段互相覆盖。
   */
  const cancelDetect = useCallback(async (): Promise<void> => {
    if (!file) return;
    cancelledRef.current = true;
    session.setDetecting(false);
    session.setTranscribing(false);
    try {
      await call((api) => api.cancelDetect(file.path));
    } catch {
      // 取消失败不该拦住用户：他已经看到界面回到可操作状态了。
      // 服务端 busy 标记会在任务真正结束时清掉。
    }
  }, [file, session]);

  const runRerank = useCallback(
    async (tier: "short" | "mid" | "long"): Promise<string> => {
      if (!file || !candidates) return "";
      const { candidates: next, summary } = await call((api) =>
        api.rerank(fileStem(file.path), tier, candidates as ClipCandidate[])
      );
      if (next.length > 0) {
        session.setCandidates(next as ClipCandidate[], stats ?? undefined);
      }
      return summary || `已按 ${tier} 档重排 ${next.length} 条`;
    },
    [candidates, file, session, stats]
  );

  // 旧版在这里还有第二个 keydown 监听(↑↓ 切候选 / Ctrl+A 全选)。
  // 与 useShortcuts 重复,且它切候选时不跟随画面跳转,两个监听会互相打架。
  // 已统一收敛到 useShortcuts。

  /** 出片:把已选片段交给 Hermes 渲染 */
  const runExport = useCallback(async (): Promise<void> => {
    if (!file || !candidates) return;
    const picked = candidates.filter((c) => session.selected.has(c.id));
    if (picked.length === 0) return;
    if (session.liveVideoId === null) {
      setExportMsg({ tone: "warn", text: "这条素材还没有分析记录(缺少 liveVideoId),请先跑一次「找爆点」" });
      return;
    }
    session.setStage("exporting");
    setExportMsg(null);
    // 订阅进度(出片可能跑几分钟,期间要能看到状态)
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = bridge().onExportProgress((p) => {
        if (p.stage === "error") setExportMsg({ tone: "warn", text: p.error ?? "出片失败" });
      });
    } catch {
      /* 桥不可用时忽略,主流程仍可完成 */
    }
    try {
      // 出片前把"这次到底用哪张封面/哪个藏带货视频"定下来。
      // 随机策略只能在这里落定 —— 用户选了"随机"，但必须能看到这次实际用了哪条，
      // 否则界面上显示的和烧进片子的是两个不同的东西，且完全无感知。
      let resolvedOptions = renderOptions;
      let coverNote = "";
      let tailNote = "";
      if (renderOptions.coverImage?.usePath || renderOptions.tailVideo?.usePath) {
        const [cover, tail] = await Promise.all([
          renderOptions.coverImage?.usePath
            ? call((api) => api.assetPick("covers", renderOptions.coverImage?.usePath, "first"))
            : Promise.resolve(null),
          renderOptions.tailVideo?.usePath
            ? call((api) =>
                api.assetPick(
                  "tails",
                  renderOptions.tailVideo?.usePath,
                  renderOptions.tailVideo?.pick ?? "first"
                )
              )
            : Promise.resolve(null)
        ]);
        if (cover?.path) coverNote = ` · 封面首帧「${cover.name}」`;
        if (tail?.path) tailNote = ` · 结尾藏带货「${tail.name}」`;
        resolvedOptions = {
          ...renderOptions,
          coverImage: cover?.path ? { ...renderOptions.coverImage, usePath: cover.path } : undefined,
          tailVideo: tail?.path ? { ...renderOptions.tailVideo, usePath: tail.path } : undefined
        };
        // 素材已被删掉的情况要说明,不能静默出一片没封面的片子
        if (renderOptions.coverImage?.usePath && !cover) coverNote = " · 封面图已不存在，本次没加首帧";
        if (renderOptions.tailVideo?.usePath && !tail) tailNote = " · 藏带货视频已不存在，本次没加尾巴";
      }

      const result = await call((api) =>
        api.export({
          liveVideoId: session.liveVideoId as number,
          // Hermes 的 selected_segments 用 segment_index,这里的候选 id 就是它
          clipSegmentIds: picked.map((c) => c.id),
          clips: picked,
          options: resolvedOptions,
          outDir: session.outDir || undefined
        })
      );
      if (result.ok) {
        const trimmed = picked.filter((c) => (c.manualCuts?.length ?? 0) > 0).length;
        setExportMsg({
          tone: coverNote.includes("已不存在") || tailNote.includes("已不存在") ? "warn" : "ok",
          text:
            (result.files.length
              ? `已输出 ${result.files.length} 个文件`
              : `已提交出片,完成后在 ${result.outputDir || "输出目录"} 查看`) +
            (trimmed > 0 ? `（含 ${trimmed} 段逐句裁剪）` : "") +
            // 爆款开头前置:告诉用户片头是哪来的,否则他看不到自己勾的段被改动了
            (result.viralOpening ? ` · 开头已前置（${result.viralOpening}）` : "") +
            coverNote +
            tailNote
        });
        // 产物清单:有文件才展示,否则下面那句"去目录里看"就是唯一的线索
        setArtifacts(
          result.files.length > 0 ? { files: result.files, outputDir: result.outputDir ?? "" } : null
        );
        // 记住粗剪工程 id 和粗剪文件，审片要用。
        // 以前粗剪只混在 files 里，包装一开就被交付物覆盖，界面上根本看不到。
        if (result.projectId) setClipProjectId(result.projectId);
        if (result.roughcutPath) setRoughcutPath(result.roughcutPath);
        setReviewMsg(null);
      } else {
        setExportMsg({ tone: "warn", text: result.error ?? "出片失败" });
        setArtifacts(null);
      }
    } catch (err) {
      setExportMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      unsubscribe?.();
      session.setStage("ready");
    }
  }, [candidates, file, renderOptions, session, transcript]);

  if (!file) return <></>;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 项目库 / 录播监听 / 目录提示 —— 侧栏入口以前全绑在空函数上,
          看着像能点、点了毫无反应。这里给它们真实内容。 */}
      {panelMsg && !showProjects && (
        <div className="absolute bottom-4 left-[224px] z-40 max-w-sm rounded-xl border border-line bg-panel/95 px-3.5 py-2.5 shadow-lg backdrop-blur">
          <p className={cx("text-[11.5px] leading-relaxed", panelMsg.tone === "ok" ? "text-ok" : "text-warn")}>
            {panelMsg.text}
          </p>
          <button
            type="button"
            onClick={() => setPanelMsg(null)}
            className="mt-1 text-[10.5px] font-semibold text-mut-2 hover:text-mut"
          >
            知道了
          </button>
        </div>
      )}

      {showVault && (
        <HitVaultPanel
          activeIpId={memoryIpId}
          onPickIp={async (ip) => {
            setMemoryIpId(ip.id);
            setMemoryIpName(ip.name);
            // 通知 App：打开老项目时要按这个 IP 取热词。
            // 不通知的话，App 那边永远读到 null，
            // 老项目打开时套的是"通用热词"，而用户刚选的是某位具体老师。
            window.dispatchEvent(new CustomEvent("glb:ip-picked", { detail: ip.id }));
            // 关键:不切 Hermes 的 active collection,分析时还会用上次那套记忆。
            // 界面显示已经换了,实际没换 —— 这是最难查的一类不一致。
            const r = await call((api) => api.hitActivateIp(ip.id));
            setPanelMsg(
              r.ok
                ? { tone: "ok", text: `接下来用「${ip.name}」的爆款记忆（${ip.entryCount} 条样本）` }
                : { tone: "warn", text: `已切换界面选择,但记忆同步失败：${r.error ?? "未知原因"}。分析时可能还用旧记忆。` }
            );
          }}
          onClose={() => setShowVault(false)}
          // 从爆款库直接跳设置，不用先关弹窗再在左侧导航里找
          onOpenSettings={() => {
            setShowVault(false);
            onOpenSettings();
          }}
        />
      )}

      {/* 回上传页的二次确认：只在真的会丢东西时弹 */}
      {leaveAskOpen && (
        <Modal
          title="回到上传页会清掉当前分析成果"
          subtitle="这些只存在内存里，回去之后要重新转写、重新分析"
          onClose={() => setLeaveAskOpen(false)}
          width="max-w-md"
          footer={
            <>
              <button
                type="button"
                onClick={() => setLeaveAskOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:text-fg"
              >
                留在出片台
              </button>
              <button
                type="button"
                onClick={doLeaveNow}
                className="btn-flame rounded-lg px-4 py-2 text-[12.5px] font-bold text-white"
              >
                清掉并回上传页
              </button>
            </>
          }
        >
          <ul className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-mut">
            <li>· 已勾选的 {session.selected.size} 个片段</li>
            <li>· {session.candidates?.length ?? 0} 条爆点候选</li>
            <li>· 逐句稿与撤销历史</li>
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-mut-2">
            已经保存成项目的不会丢,在左边「最近项目」里还能打开。
          </p>
        </Modal>
      )}

      {showProjects && (
        <ProjectLibrary
          projects={session.projects}
          activeId={session.activeProjectId}
          onClose={() => setShowProjects(false)}
          onOpen={(id) => void openProject(id)}
          onRename={async (id, name) => {
            await call((api) => api.projectRename(id, name));
            setPanelMsg({ tone: "ok", text: "已重命名" });
          }}
          onDelete={async (id) => {
            await call((api) => api.projectDelete(id));
            setPanelMsg({ tone: "ok", text: "已删除" });
          }}
        />
      )}
      <SideNav
        onImport={requestLeave}
        onOpenWatch={() => void openWatch()}
        onOpenProjects={openProjects}
        onOpenVault={openVault}
        onOpenSettings={openSettings}
        onChangeOutDir={() => void changeOutDir()}
        onOpenProject={(id) => void openProject(id)}
        outDir={session.outDir}
        memoryIpName={memoryIpName}
      />

{/* 中央 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 操作���*/}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line/60 px-3.5">
          {/*
            显式的"回上传页"入口。
            以前唯一能回去的是左边那个橙色「导入素材」按钮，可它长得像
            "再加一个文件"，而不是"回到上传界面"，用户根本不会想到去点它 ——
            于是出片台就成了没有出口的死胡同。
            放在顶栏最左边，因为它跟"开始转写"是同一级的流程动作。
          */}
          <button
            type="button"
            onClick={requestLeave}
            title="回到上传/导入素材界面（当前素材的分析成果会被清掉）"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-mut transition-colors hover:border-ember/40 hover:bg-panel-2/60 hover:text-fg"
          >
            <LuCornerUpLeft className="h-3.5 w-3.5" />
            回上传页
          </button>
          {!candidates ? (
            <button
              type="button"
              onClick={() => void runTranscribe()}
              disabled={transcribing || detecting}
              className="btn-flame flex items-center gap-2 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
            >
              {transcribing ? <Dot tone="busy" /> : <LuPlay className="h-3.5 w-3.5" />}
              {transcribing ? "转写并分析中…" : "开始转写并找爆点"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void runDetect()}
                disabled={detecting || transcribing}
                className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:border-ember/60 hover:text-ember disabled:opacity-50"
              >
                {detecting ? <Dot tone="busy" /> : <LuSearch className="h-3.5 w-3.5" />}
                {detecting ? "分析中…" : "重新找爆点"}
              </button>
              <span className="tabular hidden text-[11px] text-mut-2 lg:block">
                候选 {candidates.length} 条
                {stats?.engineUsed ? ` · ${stats.engineUsed === "cloud" ? "长上下文引擎" : "本地引擎"}` : ""}
              </span>
            </>
          )}
          <span className="flex-1" />
          {transcript && transcript.segments.length > 0 && (
            <span className="tabular text-[11px] text-mut-2">
              逐句稿 {transcript.segments.length} 句 · {transcript.engine}
            </span>
          )}
          {/* 主题切换
              深色是剪辑台的默认（长时间盯画面不刺眼），但审阅/写文案时
              浅色更舒服 —— 所以做成可切换而不是只给深色。 */}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? "切到浅色(适合白天/写文案)" : "切到深色(适合剪辑)"}
            className="flex items-center rounded-md border border-line px-2 py-1 text-mut transition-colors hover:border-ember/60 hover:text-ember"
          >
            {theme === "dark" ? <LuSun className="h-3.5 w-3.5" /> : <LuMoon className="h-3.5 w-3.5" />}
          </button>
          {/* 撤销/重做
              放在顶栏常驻:剪辑时按错是高频操作,藏进右键菜单等于没有。
              disabled 时保留位置(不隐藏) —— 按钮忽然出现/消失会让用户
              以为自己记错了快捷键的位置。 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => session.undo()}
              disabled={!session.canUndo}
              title={
                session.canUndo && session.lastAction
                  ? `撤销:${session.lastAction}(Ctrl+Z)`
                  : "没有可撤销的操作(Ctrl+Z)"
              }
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mut transition-colors enabled:hover:border-ember/60 enabled:hover:text-ember disabled:opacity-30"
            >
              <LuUndo2 className="h-3 w-3" />
              撤销
            </button>
            <button
              type="button"
              onClick={() => session.redo()}
              disabled={!session.canRedo}
              title="重做(Ctrl+Shift+Z)"
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mut transition-colors enabled:hover:border-ember/60 enabled:hover:text-ember disabled:opacity-30"
            >
              <LuRedo2 className="h-3 w-3" />
              重做
            </button>
          </div>
          {/* 快捷键入口:不能只藏在文档里,用户不一定知道有 */}
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            title="快捷键说明（?）"
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mut transition-colors hover:border-ember/60 hover:text-ember"
          >
            <LuKeyboard className="h-3 w-3" />
            快捷键
          </button>
        </div>

        {/* 主体 */}
        {error && !file ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8">
            <Empty title="这一步没跑完" hint={error} icon={<Dot tone="bad" />} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void (candidates ? runDetect() : runTranscribe())}
                className="btn-flame rounded-lg px-4 py-2 text-[12.5px] font-bold text-white"
              >
                重试
              </button>
              <button
                type="button"
                onClick={() => session.setError(null)}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut hover:text-fg"
              >
                关闭
              </button>
            </div>
          </div>
        ) : !file ? (
          /* 素材一导入就能看片、能拖时间轴。
             这里只有"还没有素材"才占满整屏;一旦有素材,工作区常驻,
             分析中的进度条降级成播放区上方的悬浮条 —— 见下方 else 分支。

             之前这里是 `error ? ... : transcribing || detecting ? <TaskPanel/> : <工作区>`,
             结果分析一启动整屏就只剩 TaskPanel,播放器/时间轴/逐句稿全部消失,
             7 分钟等待里什么都做不了。而"分析中的悬浮条"写在了 else 分支里,
             永远渲染不到 —— 注释描述的设计和代码实际行为相反。 */
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8">
            <Empty title="先导入素材" hint="把直播或短视频拖进来，就能看片、拖时间轴、逐句对照。" icon={<LuUpload className="h-6 w-6" />} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
            {/* 失败提示也要用悬浮条,不能顶掉整个工作区。
                否则一次失败之后,用户既看不到播放器,也不知道为什么失败,
                只能重启 —— 而原因就写在上面一行字里。 */}
            {error && (
              <div className="flex shrink-0 items-center gap-3 rounded-xl border border-bad/40 bg-bad/8 px-3.5 py-2.5">
                <Dot tone="bad" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-bold text-bad">这一步没跑完</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-mut">{error}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void (candidates ? runDetect() : runTranscribe())}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-semibold text-fg transition-colors hover:border-bad/60 hover:text-bad"
                >
                  重试
                </button>
                <button
                  type="button"
                  onClick={() => session.setError(null)}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-semibold text-mut transition-colors hover:text-fg"
                >
                  关闭
                </button>
              </div>
            )}

            {/* 分析中的悬浮条:不遮挡下方工作区 */}
            {(transcribing || detecting) && (
              <div className="flex shrink-0 items-center gap-3 rounded-xl border border-ember/25 bg-ember/8 px-3.5 py-2.5">
                <LuLoaderCircle className="h-4 w-4 shrink-0 spin-slow text-ember" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-bold text-fg">
                    {transcribing ? "正在转写并分析…" : "正在找爆点…"}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-mut-2">
                    <ElapsedBadge running={elapsedRunning} /> ·{" "}
                    {transcribing ? TRANSCIBE_STEPS[0] : DETECT_STEPS[0]}
                  </p>
                </div>
                <Progress percent={null} />
                <button
                  type="button"
                  onClick={() => void cancelDetect()}
                  title="中断当前分析（3 小时直播可能要跑很久）"
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-semibold text-mut transition-colors hover:text-ember"
                >
                  取消
                </button>
              </div>
            )}

            <div className="flex min-h-0 flex-1 gap-0">
              {/* 左栏宽度可拖拽调整,并记住用户的选择 */}
              <div
                className="flex min-h-0 shrink-0 flex-col gap-2.5"
                style={{ width: `${leftRatio * 100}%` }}
              >
                <PreviewPlayer
                  filePath={file.path}
                  seekTo={seekTo}
                  focusedId={session.focusedId}
                  markers={(candidates ?? []).map((c) => ({
                    id: c.id,
                    startSec: c.startSec,
                    endSec: c.endSec,
                    selected: session.selected.has(c.id),
                    score: c.score
                  }))}
                  onTime={onTime}
                  onDuration={onDuration}
                  registerApi={registerApi}
                />
                <div className="shrink-0">
                  <Timeline
                    duration={playDuration}
                    currentTime={playTime}
                    markers={(candidates ?? []).map((c) => ({
                      id: c.id,
                      startSec: c.startSec,
                      endSec: c.endSec,
                      selected: session.selected.has(c.id),
                      score: c.score,
                      title: c.title
                    }))}
                    focusedId={session.focusedId}
                    onSeek={jumpTo}
                    onFocus={(id) => {
                      const c = candidates?.find((x) => x.id === id);
                      session.setFocusedId(id);
                      if (c) jumpTo(c.startSec);
                    }}
                    onToggle={(id) => session.toggleSelected(id, "勾选变化")}
                  />
                </div>
              </div>

              <Splitter
                value={leftRatio}
                onChange={setLeftRatio}
                storageKey="glb.layout.leftRatio"
                label="拖动调整播放器宽度"
              />

              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
                {/* 这个包装层必须是 flex 容器。
                    CandidateList 根元素写着 `flex min-h-0 flex-1`，但 flex-1 只在
                    flex 容器里才生效 —— 父层少了 flex 类，它就退化成普通 block，
                    高度按内容算（258 张卡片 = 18104px），overflow-hidden 裁的是
                    自己的绘制区、裁不掉那么大的盒子，于是整个列表往下溢出，
                    盖在逐句稿上。两层半透明内容叠在一起，就是用户看到的效果。
                    实测：加 flex 后列表高度 394px（等于包装盒），溢出 0。 */}
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  {candidates && candidates.length > 0 ? (
                    <CandidateList
                      candidates={candidates}
                      selected={session.selected}
                      focusedId={session.focusedId}
                      currentTime={playTime}
                      searchRef={searchRef}
                      onFocus={(id) => {
                        const c = candidates.find((x) => x.id === id);
                        session.setFocusedId(id);
                        if (c) jumpTo(c.startSec);
                      }}
                      onToggle={(id) => session.toggleSelected(id, "勾选变化")}
                      onOpenReview={setReviewId}
                      onSetSelection={(ids, on) => {
                        const next = new Set(session.selected);
                        for (const id of ids) {
                          if (on) next.add(id);
                          else next.delete(id);
                        }
                        session.setSelected(next);
                      }}
                    />
                  ) : (
                    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 rounded-xl border border-line bg-panel-2/40 p-6 text-center">
                      {detecting || transcribing ? (
                        <>
                          <LuLoaderCircle className="h-6 w-6 spin-slow text-ember" />
                          <p className="text-[12.5px] font-semibold text-fg">正在找爆点…</p>
                          <p className="max-w-xs text-[11px] leading-relaxed text-mut-2">
                            左边可以先看素材、拖时间轴。爆点出来后这里会列出候选,并自动标出该发的。
                          </p>
                        </>
                      ) : (
                        <>
                          <LuSparkles className="h-6 w-6 text-mut-2" />
                          <p className="text-[12.5px] font-semibold text-fg">还没有爆点候选</p>
                          <p className="max-w-xs text-[11px] leading-relaxed text-mut-2">
                            点上方「开始转写并找爆点」。左侧播放器与时间轴现在就能用 ——
                            分析期间也能反复看素材、确认要剪哪一段。
                          </p>
                          <button
                            type="button"
                            onClick={() => void runTranscribe()}
                            className="btn-flame mt-1 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white"
                          >
                            开始转写并找爆点
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <Splitter
                  value={trRatio}
                  onChange={setTrRatio}
                  orientation="horizontal"
                  min={0.18}
                  max={0.75}
                  resetTo={0.38}
                  storageKey="glb.layout.transcriptRatio"
                  label="拖动调整逐句稿高度"
                />
                {/* 逐句稿的高度。
                    这里原来写的是 `height: X%` + `shrink-0`，那个组合会重叠：
                    height 百分比在 flex item 里只是"期望高度"，而 shrink-0 禁止收缩 ——
                    一旦它加兄弟元素超过容器高度，它不让位、直接压在候选列表上，
                    两层半透明内容叠在一起（用户截图里就是这个效果）。

                    改成 flex-basis + 允许收缩之后，flex 算法保证两者不重叠：
                    basis 大的先按 basis 分配，空间不够时允许它收缩到 min-h。
                    overflow-hidden 是最后一道保险 —— 任何情况下内容都不会溢出到外面。 */}
                <div
                  className="flex min-h-[120px] shrink overflow-hidden"
                  style={{
                    flexBasis: `${clampRatio(trRatio) * 100}%`,
                    flexGrow: 0,
                    flexShrink: 1
                  }}
                >
                  <TranscriptPanel transcript={transcript} currentTime={playTime} onSeek={jumpTo} />
                </div>

                {/*
                 * 热词更正放在逐句稿正下方。
                 *
                 * 它是"干活时的工具"，不是档案：
                 * 用户正在看文案、准备粗剪出片，看到错字当场改，
                 * 改完这一片的文案和粗剪立刻用纠正后的文本。
                 * 放在爆款记忆库里等于让人翻档案去改字，
                 * 而且那边没有文案可对照，改完也看不出效果。
                 *
                 * 归档仍然按 IP 老师走（Hermes 侧 hotwords.collection），
                 * 所以"下次再出现同样的错字自动更正"这个记忆能力没丢 ——
                 * 挪的只是编辑入口。
                 * sampleText 传当前逐句稿全文，用来显示命中次数。
                 */}
                <HotwordPanel
                  collection={memoryIpName ?? null}
                  sampleText={(transcript?.segments ?? []).map((s) => s.text || "").join("")}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 出片台常驻:没候选时禁用出片按钮,但出片参数随时可调。
          以前要分析完才出现,用户想先配好字幕/开头策略就只能干等。 */}
      <ExportDock
        engine={engine}
        message={exportMsg}
        artifacts={artifacts}
        onCloseArtifacts={() => setArtifacts(null)}
        disabled={!candidates || candidates.length === 0}
        onOpenOptions={() => setShowOptions(true)}
        onRunExport={runExport}
        onRerank={runRerank}
        clipProjectId={clipProjectId}
        onOpenReview={() => setShowReview(true)}
        reviewHint={reviewMsg?.tone === "ok" ? "已提交" : null}
      />

      {showReview && clipProjectId && (
        <RoughcutReviewPanel
          projectId={clipProjectId}
          roughcutPath={roughcutPath}
          fallbackPath={file.path}
          onClose={() => setShowReview(false)}
          onRecutDone={(newId, newRoughcutPath) => {
            if (newId) setClipProjectId(newId);
            // 也要换粗剪路径：工程换��、文件还是上一版的，
            // 下次点开审片就会"审新工程、播旧粗剪"，点名也对不上画面。
            setRoughcutPath(newRoughcutPath ?? null);
          }}
        />
      )}

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}

      {showOptions && (
        <RenderOptionsPanel options={renderOptions} onChange={setRenderOptions} onClose={() => setShowOptions(false)} />
      )}

      {reviewId !== null && candidates && (
        <ReviewPanel
          clip={candidates.find((c) => c.id === reviewId) ?? null}
          transcript={transcript}
          sourcePath={file.path}
          onClose={() => setReviewId(null)}
          onPreview={jumpTo}
          onSave={(patch) => {
            session.patchCandidate(reviewId, patch, "修改候选");
            setReviewId(null);
          }}
        />
      )}
    </div>
  );
}

/** 审阅台:精细调标题/钩子/边界,并逐字逐句挑 */
function ReviewPanel({
  clip,
  transcript,
  sourcePath,
  onClose,
  onSave,
  onPreview
}: {
  clip: ClipCandidate | null;
  transcript: Transcript | null;
  /** 原素材路径：弹窗内要放一个能播的预览器 */
  sourcePath: string;
  onClose: () => void;
  onSave: (patch: Partial<ClipCandidate>) => void;
  onPreview: (sec: number) => void;
}): React.JSX.Element | null {
  const [title, setTitle] = useState(clip?.title ?? "");
  const [hook, setHook] = useState(clip?.hook ?? "");
  const [startSec, setStartSec] = useState(clip?.startSec ?? 0);
  const [endSec, setEndSec] = useState(clip?.endSec ?? 0);
  const [reason, setReason] = useState(clip?.reason ?? "");
  // 逐句裁剪结果独立暂存,点"保存"才写回候选,
  // 否则用户改到一半点关闭就会丢
  const [cuts, setCuts] = useState<Array<{ startSec: number; endSec: number }> | undefined>(
    clip?.manualCuts
  );
  // 批注同样要暂存,点"保存"才写回。
  // 以前 textarea 的 onChange 直接调 onSave,而 onSave 里带 setReviewId(null) ——
  // 于是打第一个字弹窗就消失了,批注根本写不完。
  const [note, setNote] = useState(clip?.reviewNote ?? "");

  /**
   * 弹窗内自己一个播放器。
   *
   * 为什么不用外层那个：外层的播放头是"整场素材"的时间轴，
   * 而这里用户只关心这一段（起点→终点）。共用一个会把边界推到几小时外，
   * 按空格播放会从头播起，与"精修这一段"完全对不上。
   *
   * 变量名带 review 前缀，避免和上面的 startSec/endSec（候选的起止）混淆。
   */
  const reviewPlayback = useRef<PlaybackApi | null>(null);
  /** 弹窗内播放头（秒）。逐句高亮靠它，所以要跟着播放回调更新 */
  const [reviewPlaySec, setReviewPlaySec] = useState(0);
  /** 起止被改过之后要把播放头拉回新起点，否则画面停在已删掉的区间上 */
  const seekedBounds = useRef<string>("");
  const boundsKey = `${startSec.toFixed(1)}-${endSec.toFixed(1)}`;
  useEffect(() => {
    if (!clip) return;
    if (seekedBounds.current === boundsKey) return;
    seekedBounds.current = boundsKey;
    reviewPlayback.current?.seek(startSec);
  }, [clip, boundsKey, startSec]);

  // 选区/框选时暂停：文字在跟着播放头高亮，
  // 视频继续走的话，用户选好按下删除时高亮已经移走，删的就不是选中的那几个字。
  const requestPause = useCallback((): void => {
    reviewPlayback.current?.pause();
  }, []);

  useEffect(() => {
    setTitle(clip?.title ?? "");
    setHook(clip?.hook ?? "");
    setStartSec(clip?.startSec ?? 0);
    setEndSec(clip?.endSec ?? 0);
    setReason(clip?.reason ?? "");
    setCuts(clip?.manualCuts);
    setNote(clip?.reviewNote ?? "");
  }, [clip?.id, clip?.title, clip?.hook, clip?.startSec, clip?.endSec, clip?.reason, clip?.manualCuts, clip?.reviewNote]);

  if (!clip) return null;

  /*
   * 落在这一段内的句子（供框选删字用）。
   *
   * 这里用**严格相交**，不用 SentenceTrimmer 那套"放宽 0.5s"。
   *
   * 原因不是美观，是正确性：截图里这段是 4864→4923，
   * 而逐句稿第一句是 4860→4864 —— 整句都在段外。
   * 放宽 0.5s 会把它收进来，于是框选框里第一屏全是**剪不掉的字**：
   * 框几个字 → 换算成时间落在 4860~4864 → 段外 → 区间被夹成 0 →
   * 删除线画出来了但"已删 0.0s"、manualCuts 也写不进去，
   * 而且不报任何错。用户只会觉得"这功能坏了"。
   *
   * 严格相交保证每句都在段内，框选删字换算出的时间必然落在段内。
   * 代价是边界可能少半句，但少半句好过给一段假内容。
   */
  const sentencesInClip = useMemo(
    () => (transcript?.segments ?? []).filter((s) => s.endSec > startSec && s.startSec < endSec),
    [transcript, startSec, endSec]
  );

  /*
   * 点句子/点字 → 跳播。
   *
   * 必须跳**弹窗自己那个播放器**，不能调外层的 jumpTo。
   * 外层那个是主工作台的播放器，被 modal 盖着、而且多半是暂停的 ——
   * 之前 SentenceTrimmer 的 onPreview 就是直接传的外层 jumpTo，
   * 于是"点句子跳转"看着毫无反应，画面纹丝不动。
   * 弹窗有独立播放器（reviewPlayback）就是为了不干扰工作台，这里必须用它。
   */
  const seekInDialog = useCallback((sec: number): void => {
    const api = reviewPlayback.current;
    if (api) api.seek(sec);
    else onPreview(sec);
  }, [onPreview]);

  /*
   * 把这一轮的编辑同步到该 IP 老师的档案。
   *
   * 关键点：
   * 1. 只在**用户真的改了**时才记。没改标题就别记一条"标题没变" ——
   *    那种样本会稀释信号，还让"改过几次标题"这个计数虚高。
   * 2. 删/留都以句子为单位。逐字粒度对桌面端这条链路没有意义
   *    （出片是按时间区间切的，不是按字）。
   * 3. 整段被剔光时只记 cut、不记 keep —— 否则会学到"用户喜欢自己刚删的内容"。
   */
  const recordEdits = useCallback(
    (
      clipBefore: ClipCandidate,
      patch: Partial<ClipCandidate>,
      segs: TranscriptSegment[],
      cutsNow: Array<{ startSec: number; endSec: number }> | undefined,
      reason: string
    ) => {
      const edits: EditRecordInput[] = [];
      const newTitle = (patch.title ?? "").trim();
      const oldTitle = (clipBefore.title ?? "").trim();
      // ① 标题改写
      if (newTitle && oldTitle && newTitle !== oldTitle) {
        edits.push({ kind: "title", text: newTitle, oldTitle, by: "edited", reason });
      }
      // ② 删掉的句子 / ③ 留下的句子
      const kept = (s: TranscriptSegment): boolean =>
        !cutsNow || cutsNow.length === 0 || !cutsNow.some((r) => s.endSec > r.startSec - 0.05 && s.startSec < r.endSec + 0.05);
      for (const s of segs) {
        const text = (s.text || "").trim();
        if (!text) continue;
        const base = {
          text,
          role: clipBefore.role,
          startSec: s.startSec,
          endSec: s.endSec,
          score: clipBefore.score
        };
        if (kept(s)) edits.push({ ...base, kind: "keep", by: "picked" });
        else edits.push({ ...base, kind: "cut", by: "picked", reason });
      }
      if (!edits.length) return;
      // 走 call() 而不是直接用 preload 的 api：统一走桥接的排队/错误处理
      void call((api) =>
        api.recordEditRecords({
          liveVideoId: clipBefore.liveVideoId ?? null,
// 必须用弹窗拿到的真实素材路径，不能用 clipBefore.sourcePath ——
          // 候选对象里根本没这个字段（是 undefined），
          // 于是端点按路径反查直播失败 → collection 退化成"通用" →
          // 这位老师的剪辑样本被记成对所有人生效。功能看着正常，只有查库才发现。
          videoPath: sourcePath,
          reason,
          edits
        })
      ).catch((err) => {
        // 刻意吞掉：粗剪改动已经落地，不能因为归档失败就说"保存失败"
        console.warn("[EditRecords] 写归档失败（不影响本次保存）:", err);
      });
    },
    []
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="pop-in flex max-h-[86vh] w-full max-w-[min(1400px,96vw)] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line/70 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-extrabold">审阅台</h2>
            <p className="tabular mt-1 font-mono text-[11px] text-mut-2">
              #{clip.id} · {startSec.toFixed(1)}s → {endSec.toFixed(1)}s · 评分 {clip.score || "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut hover:text-fg"
          >
            <LuX className="h-3.5 w-3.5" />
          </button>
        </header>

        {/*
         * 左画面 / 右表单。
         *
         * 原来是单栏滚动，标题、钩子、起止点、逐句列表一路往下排，
         * 右边空着一大片 —— 而"这条片段画面上到底是什么"恰恰是这个弹窗
         * 要回答的问题。改标题钩子时不看画面等于闭着眼睛调。
         *
         * 两栏各自滚：画面固定在左边，调边界时眼睛不用来回找。
         */}
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
          {/* 左：画面 + 这一段的区间信息 */}
          <div className="flex min-h-0 w-[44%] shrink-0 flex-col gap-2.5">
            <PreviewPlayer
              filePath={sourcePath}
              onTime={setReviewPlaySec}
              heightClass="h-[min(46vh,440px)] min-h-[200px]"
              registerApi={(api) => {
                reviewPlayback.current = api;
              }}
            />
            <div className="shrink-0 rounded-lg border border-line bg-panel-2/60 px-3 py-2">
              <div className="mb-1 text-[11px] font-bold text-mut-2">这一段</div>
              <p className="tabular font-mono text-[11.5px] text-mut">
                {startSec.toFixed(1)}s → {endSec.toFixed(1)}s
                <span className="ml-1.5 text-mut-2">（{Math.max(0, endSec - startSec).toFixed(1)}s）</span>
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-mut-2">
                空格播放/暂停。改下面的起点终点，画面会自动跳到新起点。
              </p>
            </div>
          </div>

          {/* 右：原有的表单，窄栏独立滚 */}
          <div className="scroll-thin min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-mut-2">标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[13px] outline-none focus:border-ember/60"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-mut-2">钩子(开场前 3 秒说什么)</span>
            <input
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[13px] outline-none focus:border-ember/60"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-mut-2">起点(秒)</span>
              <input
                type="number"
                step="0.1"
                value={startSec}
                onChange={(e) => setStartSec(Number(e.target.value))}
                className="tabular rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] outline-none focus:border-ember/60"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-mut-2">终点(秒)</span>
              <input
                type="number"
                step="0.1"
                value={endSec}
                onChange={(e) => setEndSec(Number(e.target.value))}
                className="tabular rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] outline-none focus:border-ember/60"
              />
            </label>
          </div>
          {/*
           * 文字精修：框选文字删掉，和左边画面联动。
           *
           * 为什么换掉原来的"逐句打勾"列表：
           * 用户要的是"像剪映那样框几个字删掉"的体验。
           * 逐句勾选只能整句去留，删不掉"同学们欢迎大家"里的那 7 个字 ——
           * 而这恰恰是最常见的诉求（去掉开场寒暄，保留后面的干货）。
           *
           * 两种操作并存，各管一件事：
           *   逐句勾选 —— 精确剔除整句，写在 manualCuts 里
           *   框选删字 —— 精细去掉话术，写在 manualCuts 里（合并后）
           * 两者都是"这段不要了"，语义一致，可以共存。
           */}
          <TextCutter
            sentences={sentencesInClip}
            startSec={startSec}
            endSec={endSec}
            value={cuts}
            onChange={setCuts}
            playSec={reviewPlaySec}
            onSeek={seekInDialog}
            onRequestPause={requestPause}
          />
          {clip.text && (
            <div className="rounded-lg border border-line bg-panel-2/60 p-3">
              <div className="mb-1.5 text-[11px] font-bold text-mut-2">原文</div>
              <p className="text-[12px] leading-relaxed text-fg/85">{clip.text}</p>
            </div>
          )}
          {reason && (
            <div className="rounded-lg border border-line bg-panel-2/60 p-3">
              <div className="mb-1.5 text-[11px] font-bold text-mut-2">引擎判断理由</div>
              <p className="text-[11.5px] leading-relaxed text-mut">{reason}</p>
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-mut-2">我的批注</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] outline-none focus:border-ember/60"
            />
          </label>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line/70 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              const patch: Partial<ClipCandidate> = {
                title: title.trim() || clip.title,
                hook: hook.trim(),
                startSec: Math.max(0, Math.min(startSec, endSec - 0.5)),
                endSec: Math.max(startSec + 0.5, endSec),
                manualBounds: true,
                // 有裁剪就带上去,出片时按区间分别切再拼
                manualCuts: cuts && cuts.length > 0 ? cuts : undefined,
                // 批注跟着保存一起提交（以前是在 onChange 里就提交，连带把弹窗关掉了）
                reviewNote: note
              };
              /*
               * 记学习样本：这一轮改了什么，全部同步到该 IP 老师的档案。
               *
               * 三类信号，缺一不可：
               *   ① 标题改写 —— 最直接的爆款感正向示范（AI 起了什么、用户改成什么）
               *   ② 删掉的句子 —— 避雷词
               *   ③ 留下的句子 —— 正样本
               *
               * 刻意不 await：写学习失败不该让"保存"看起来失败 ——
               * 粗剪改动已经落地了，因为归档不可达就报错会让用户反复重试、
               * 甚至以为改动丢了。失败会在 console 里留痕。
               */
              void recordEdits(clip, patch, sentencesInClip, cuts, note.trim());
              onSave(patch);
            }}
            className="btn-flame rounded-lg px-5 py-2 text-[12.5px] font-bold text-white"
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
