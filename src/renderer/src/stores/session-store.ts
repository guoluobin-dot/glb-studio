/**
 * 会话状态
 * © 2026 郭洛斌
 *
 * 素材、逐句稿、候选、勾选都在这里。视图切换不丢结果,
 * 这样用户在任何环节切走再回来,分析成果都还在。
 */
import { create } from "zustand";
import type { ClipCandidate, DetectionStats, MediaFile, ProjectSummary, SessionCheckpoint, Transcript } from "@shared/api-types";

export type Stage = "empty" | "transcribing" | "transcribed" | "detecting" | "ready" | "exporting";

export interface SessionState {
  file: MediaFile | null;
  /** Hermes live_videos.id —— 出片工程靠它建,没有就出不了片 */
  liveVideoId: number | null;
  /** 这条素材归属哪位老师(爆款记忆库);null = 用通用记忆。跟着素材走,不读界面当前选中 */
  collection: string | null;
  transcript: Transcript | null;
  candidates: ClipCandidate[] | null;
  selected: Set<number>;
  focusedId: number | null;
  stats: DetectionStats | null;
  stage: Stage;
  error: string | null;

  /** 进行中的标志:transcribing 与 detecting 各自独立,便于分别渲染 */
  transcribing: boolean;
  detecting: boolean;

  projects: ProjectSummary[];
  activeProjectId: string | null;
  outDir: string;

  setFile: (file: MediaFile, opts?: { collection?: string | null }) => void;
  setCollection: (collection: string | null) => void;
  setLiveVideoId: (id: number | null) => void;
  setTranscript: (transcript: Transcript) => void;
  setCandidates: (candidates: ClipCandidate[], stats?: DetectionStats) => void;
  /**
   * 设置勾选。
   *
   * action 非空 = 用户主动操作,记入撤销历史;action 为空 = 系统行为
   * （重新分析后 AI 重排勾选、打开项目恢复），不进历史 —— 否则用户按撤销
   * 只会退回到"AI 上次怎么排的",而不是"我自己刚才改错了什么"。
   */
  setSelected: (selected: Set<number>, action?: string) => void;
  toggleSelected: (id: number, action?: string) => void;
  setFocusedId: (id: number | null) => void;
  setStage: (stage: Stage) => void;
  setError: (error: string | null) => void;
  setTranscribing: (on: boolean) => void;
  setDetecting: (on: boolean) => void;
  setStats: (stats: DetectionStats | null) => void;
  setProjects: (projects: ProjectSummary[]) => void;
  setActiveProjectId: (id: string | null) => void;
  setOutDir: (dir: string) => void;
  patchCandidate: (id: number, patch: Partial<ClipCandidate>, action?: string) => void;
  restore: (checkpoint: SessionCheckpoint) => void;
  reset: () => void;
  /** 撤销一步 */
  undo: () => void;
  /** 重做一步 */
  redo: () => void;
  /** 清空历史(切换素材/打开项目时调用) */
  clearHistory: () => void;
  /**
   * 记一条历史。由各个会改 selected/candidates 的动作在**改之前**调用。
   * 放显式方法而不是在 setSelected 里自动记 —— 有些 setSelected 是系统行为
   * (重新分析后 AI 重排),自动记会让撤销栈被噪声填满。
   */
  record: (action: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 最近一次可撤销操作的说明,UI 显示"撤销:勾选变化" */
  lastAction: string | null;
  history: { past: EditSnapshot[]; future: EditSnapshot[] };
}

const EMPTY = {
  file: null,
  liveVideoId: null,
  /**
   * 这条素材归属哪位老师(爆款记忆库)。
   *
   * 跟着素材走,而不是读界面当前选中谁 —— 用户导入 A 老师的直播之后
   * 切去整理 B 老师的爆款库是常事,等分析结果出来时早就切走了。
   * 这个值会一路带到 analyze 请求,由 Hermes 落到 live_videos.collection。
   */
  collection: null as string | null,
  transcript: null,
  candidates: null,
  selected: new Set<number>(),
  focusedId: null,
  stats: null,
  stage: "empty" as Stage,
  error: null,
  transcribing: false,
  detecting: false
};

/**
 * 可撤销的编辑状态。
 *
 * 只包含**用户自己的编辑决策**,不含播放位置/焦点/加载状态 ——
 * 把这些塞进历史会让每次点播放都产生一条记录,撤销栈瞬间被噪声填满,
 * 用户按撤销却只看到"焦点变了"这种没意义的回退。
 */
interface EditSnapshot {
  selected: number[];
  /** 候选的裁剪/丢弃/评分等改动 */
  candidates: ClipCandidate[] | null;
}

/** 栈上限:再多也用不到 50 步,留着只会让内存无意义地涨 */
const HISTORY_LIMIT = 50;

/** 浅比较 selected 是否真的变了 —— 每次 set 都要比,不然栈里全是重复状态 */
function sameSelected(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const useSession = create<SessionState>((set, get) => ({
  ...EMPTY,
  projects: [],
  activeProjectId: null,
  outDir: "",
  canUndo: false,
  canRedo: false,
  lastAction: null,
  history: { past: [], future: [] },

  /**
   * 记一条历史。
   *
   * 只在 selected/candidates 真的变了才记 —— 很多操作顺带调 setSelected
   * 但内容没变（比如重新分析后 AI 重排勾选），那种不该进历史，
   * 否则用户连点 10 下就得按 10 次撤销才能回到原样。
   */
  record: (action) => {
    const state = get();
    const h = state.history;
    const snap: EditSnapshot = {
      selected: [...state.selected],
      candidates: state.candidates
    };
    const top = h.past[h.past.length - 1];
    if (
      top &&
      sameSelected(new Set(top.selected), state.selected) &&
      top.candidates === state.candidates
    ) {
      // 内容没变,只更新说明文字(比如连续裁剪同一段)
      set({ lastAction: action });
      return;
    }
    set({
      history: { past: [...h.past, snap].slice(-HISTORY_LIMIT), future: [] },
      canUndo: true,
      canRedo: false,
      lastAction: action
    });
  },

  undo: () => {
    const state = get();
    const { past, future } = state.history;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    if (!prev) return;
    const cur: EditSnapshot = { selected: [...state.selected], candidates: state.candidates };
    set({
      selected: new Set(prev.selected),
      candidates: prev.candidates,
      history: { past: past.slice(0, -1), future: [cur, ...future].slice(0, HISTORY_LIMIT) },
      canUndo: past.length > 1,
      canRedo: true
    });
  },

  redo: () => {
    const state = get();
    const { past, future } = state.history;
    if (future.length === 0) return;
    const nxt = future[0];
    if (!nxt) return;
    const cur: EditSnapshot = { selected: [...state.selected], candidates: state.candidates };
    set({
      selected: new Set(nxt.selected),
      candidates: nxt.candidates,
      history: { past: [...past, cur].slice(-HISTORY_LIMIT), future: future.slice(1) },
      canUndo: true,
      canRedo: future.length > 1
    });
  },

  clearHistory: () =>
    set({ history: { past: [], future: [] }, canUndo: false, canRedo: false, lastAction: null }),

  setFile: (file, opts?: { collection?: string | null }) =>
    // 换素材等于换了一个工作对象,旧历史全部作废
    set({
      ...EMPTY,
      file,
      collection: opts?.collection ?? null,
      history: { past: [], future: [] },
      canUndo: false,
      canRedo: false,
      lastAction: null
    }),

  setCollection: (collection) => set({ collection }),

  setLiveVideoId: (liveVideoId) => set({ liveVideoId }),

  setTranscript: (transcript) =>
    set({ transcript, stage: "transcribed", transcribing: false, error: null }),

  setCandidates: (candidates, stats) =>
    set({
      candidates,
      stats: stats ?? null,
      stage: "ready",
      detecting: false,
      // 默认勾选 AI 判定该发的,用户不必从零选起
      selected: new Set(candidates.filter((c) => c.recommended && c.gate !== "drop").map((c) => c.id)),
      focusedId: candidates[0]?.id ?? null,
      error: null
    }),

  setSelected: (selected, action) => {
    // 历史里存的是"改之前"的状态,所以必须在 set 之前记
    if (action) get().record(action);
    set({ selected });
  },

  toggleSelected: (id, action) => {
    if (action) get().record(action);
    set((state) => {
      const next = new Set(state.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    });
  },

  setFocusedId: (focusedId) => set({ focusedId }),
  setStage: (stage) => set({ stage }),
  setError: (error) => set({ error }),
  setTranscribing: (transcribing) => set({ transcribing, stage: transcribing ? "transcribing" : "transcribed" }),
  setDetecting: (detecting) => set({ detecting, stage: detecting ? "detecting" : "ready" }),
  setStats: (stats) => set({ stats }),
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setOutDir: (outDir) => set({ outDir }),

  patchCandidate: (id, patch, action) => {
    // 历史里存的是"改之前"的候选列表
    if (action) get().record(action);
    set((state) => ({
      candidates: state.candidates?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? null
    }));
  },

  restore: (checkpoint) =>
    // 打开项目等于换了一个工作对象,旧历史全部作废
    set({
      file: checkpoint.file,
      // liveVideoId 必须一起恢复,否则重开项目后出片会因为缺它而失败
      liveVideoId: checkpoint.liveVideoId ?? null,
      transcript: checkpoint.transcript,
      candidates: checkpoint.candidates,
      selected: new Set(checkpoint.selected),
      focusedId: checkpoint.candidates?.[0]?.id ?? null,
      stage: checkpoint.candidates ? "ready" : checkpoint.transcript ? "transcribed" : "empty",
      error: null,
      transcribing: false,
      detecting: false,
      history: { past: [], future: [] },
      canUndo: false,
      canRedo: false,
      lastAction: null
    }),

  reset: () => set({ ...EMPTY, history: { past: [], future: [] }, canUndo: false, canRedo: false, lastAction: null })
}));

/** 导出当前会话为检查点(项目自动保存用)。 */
export function toCheckpoint(state: SessionState): SessionCheckpoint | null {
  if (!state.file) return null;
  return {
    file: state.file,
    transcript: state.transcript,
    candidates: state.candidates,
    selected: [...state.selected],
    savedAt: new Date().toISOString(),
    liveVideoId: state.liveVideoId
  };
}
