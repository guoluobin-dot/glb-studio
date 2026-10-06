/**
 * 粗剪文本精修（智能剪口播）
 * © 2026 郭洛斌
 *
 * 目标：让用户像在文档里编辑文字一样，框选几个字删掉，**而且真的从视频里剪掉**。
 *
 * 和剪映「智能剪口播」的区别要说清楚：
 *   剪映是从原始口播视频里，由 AI 判断哪里该剪；
 *   这里是 **AI 已经挑好了一条粗剪**，用户在这条粗剪上做精修。
 *   所以起点是"已经剪过的成品"，不是原始素材 ——
 *   这也意味着不会破坏 AI 的选段逻辑，只是在它认可的范围里做减法。
 *
 * 三个关键设计：
 *
 * 1. 删掉的字**不从 DOM 里移除**，只加删除线样式。
 *    原因：字符位置一旦变化，后续所有框选的偏移就全错了。
 *    真实后果是"删一次之后，后面全删错位置"，而且极难排查。
 *
 * 2. 支持跨段框选。
 *    用户常常要删的是"上一段结尾 + 下一段开头"这一整句欢迎语，
 *    跨段落选正好覆盖。所以每一段都渲染成独立的 span，
 *    用 data 属性记住它属于哪段、在段内的哪个字符位置。
 *
 * 3. 实操教学段（几乎没有文字）显示成时间区间块，不给文本框。
 *    教学直播里大量片段是现场演示/演唱，ASR 只识别出零星几个字。
 *    给它一个空文本框，用户只会以为功能坏了；而它恰恰通常是要保留的核心。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuClock, LuScissors, LuUndo2 } from "react-icons/lu";
import type { ClipSegmentMap } from "@shared/api-types";
import { cx } from "./ui";

/** 一处删除：段下标 + 段内字符区间 */
interface Mark {
  seg: number;
  from: number;
  to: number;
}

/** 选区命中的一段 */
interface Hit {
  seg: number;
  from: number;
  to: number;
}

const PUNCT = /[，。！？、；：,.!?;]/;

/**
 * 按字符比例把删除区间换算成时长（毫秒），**只用于界面显示**。
 *
 * 真值由 Hermes 的 charRangeToTime 算（打回时生效）。
 * 但这里刻意复刻同一套算法 —— 逐句插值 + 标点折算 —— 而不是图省事
 * 用"整段时长 × 字数比例"：
 *
 * 两种算法结果能差好几倍。一句 10 秒的话在一个 60 秒段里，
 * 整段比例算出来只有 1.7 秒，逐句插值才是 10 秒。
 * 于是界面显示"已删 1.7s"、实际剪掉 10 秒，用户完全对不上账，
 * 下次就不敢用这个功能了。显示和实际必须是同一个答案。
 *
 * 逐句稿的句子边界和分析分段边界来自两套独立切分，所以这里用"有重叠"取句
 * （和服务端 sentencesInRange 一致），保证同一个字在两边落到同一句上。
 */
function estimateMs(seg: ClipSegmentMap, ranges: Array<{ from: number; to: number }>): number {
  const text = String(seg.text || "");
  const sentences = seg.sentences ?? [];
  if (!text || !sentences.length) return 0;
  const durMs = Math.max(0, (seg.roughcutEndSec - seg.roughcutStartSec) * 1000);

  // 取落在本段内的句子，并按段长夹紧 —— 与服务端同样的边界约定
  const inSeg = sentences
    .map((s) => ({ ...s, startMs: Math.max(0, s.startMs), endMs: Math.min(durMs, s.endMs) }))
    .filter((s) => s.endMs > s.startMs);
  if (!inSeg.length) return 0;

  // 每句在整段文本里的字符区间（含句间那个空格），与服务端 cursor 累加一致
  const spans: Array<{ from: number; to: number; text: string; startMs: number; endMs: number }> = [];
  let cursor = 0;
  for (const s of inSeg) {
    const t = String(s.text || "");
    spans.push({ from: cursor, to: cursor + t.length, text: t, startMs: s.startMs, endMs: s.endMs });
    cursor += t.length + 1;
  }

  let ms = 0;
  for (const r of ranges) {
    const from = Math.max(0, Math.min(text.length, Math.floor(r.from)));
    const to = Math.max(from, Math.min(text.length, Math.ceil(r.to)));
    if (to <= from) continue;
    for (const sp of spans) {
      const a = Math.max(from, sp.from);
      const b = Math.min(to, sp.to);
      if (b <= a) continue;
      const span = sp.endMs - sp.startMs;
      const spoken = Math.max(1, [...sp.text].filter((c) => !PUNCT.test(c)).length);
      let w = 0;
      for (let i = 0; i < a - sp.from; i++) w += PUNCT.test(sp.text[i] ?? "") ? 0.25 : 1;
      let w2 = 0;
      for (let i = 0; i < b - sp.from; i++) w2 += PUNCT.test(sp.text[i] ?? "") ? 0.25 : 1;
      ms += (span * (w2 - w)) / spoken;
    }
  }
  return Math.round(Math.min(ms, durMs));
}

/** 把一段文本按删除标记切成"保留/删除"的片段序列 */
function splitRuns(text: string, marks: Array<{ from: number; to: number }>): Array<{ t: string; del: boolean }> {
  const ms = marks
    .map((m) => ({ from: Math.max(0, Math.min(text.length, m.from)), to: Math.max(0, Math.min(text.length, m.to)) }))
    .filter((m) => m.to > m.from)
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const m of ms) {
    const last = merged[merged.length - 1];
    if (last && m.from <= last.to) last.to = Math.max(last.to, m.to);
    else merged.push({ ...m });
  }
  const runs: Array<{ t: string; del: boolean }> = [];
  let cur = 0;
  for (const m of merged) {
    if (m.from > cur) runs.push({ t: text.slice(cur, m.from), del: false });
    runs.push({ t: text.slice(m.from, m.to), del: true });
    cur = m.to;
  }
  if (cur < text.length) runs.push({ t: text.slice(cur), del: false });
  return runs;
}

/** 合并同一段内相邻/重叠的标记 */
function mergeMarks(list: Mark[]): Mark[] {
  const bySeg = new Map<number, Array<{ from: number; to: number }>>();
  for (const m of list) {
    if (m.to <= m.from) continue;
    if (!bySeg.has(m.seg)) bySeg.set(m.seg, []);
    bySeg.get(m.seg)!.push({ from: m.from, to: m.to });
  }
  const out: Mark[] = [];
  for (const [seg, arr] of bySeg) {
    arr.sort((a, b) => a.from - b.from);
    const merged: Array<{ from: number; to: number }> = [];
    for (const m of arr) {
      const last = merged[merged.length - 1];
      if (last && m.from <= last.to) last.to = Math.max(last.to, m.to);
      else merged.push({ ...m });
    }
    for (const m of merged) out.push({ seg, from: m.from, to: m.to });
  }
  return out.sort((a, b) => a.seg - b.seg || a.from - b.from);
}

export function TextCutter({
  segments,
  marks,
  onChange,
  onPreviewRange,
  playTimeSec = null,
  onRequestPause
}: {
  segments: ClipSegmentMap[];
  /** 已标记的删除；由上层持有，这样打回时能直接取用 */
  marks: Mark[];
  onChange: (next: Mark[]) => void;
  /** 点某段时让播放器跳过去 */
  onPreviewRange?: (seg: ClipSegmentMap) => void;
  /** 粗剪时间轴上的当前播放位置（秒），用来做卡拉OK 式变色 */
  playTimeSec?: number | null;
  /**
   * 用户开始框选时请求暂停。
   *
   * 为什么必须暂停：文字在跟着播放头变色推进，而框选要精确按住某个字。
   * 视频继续走的话，播放头每帧都在动 —— 用户刚选好、点删除时高亮已经移走，
   * "删的是哪几个字"就对不上了。所以一按下去就停。
   */
  onRequestPause?: () => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Hit[] | null>(null);
  /** 撤销栈；每次删除前把上一版推进来。用 state 才能让撤销按钮的禁用状态跟着变 */
  const [history, setHistory] = useState<Mark[][]>([]);

  const marksBySeg = useMemo(() => {
    const m = new Map<number, Array<{ from: number; to: number }>>();
    for (const mk of marks) {
      if (!m.has(mk.seg)) m.set(mk.seg, []);
      m.get(mk.seg)!.push({ from: mk.from, to: mk.to });
    }
    return m;
  }, [marks]);

  const removedMs = useMemo(() => {
    let n = 0;
    for (const [segIdx, list] of marksBySeg) {
      const seg = segments[segIdx];
      if (seg) n += estimateMs(seg, list);
    }
    return n;
  }, [marksBySeg, segments]);

  const totalMs = useMemo(
    () => segments.reduce((n, s) => n + Math.max(0, (s.roughcutEndSec - s.roughcutStartSec) * 1000), 0),
    [segments]
  );

  /**
   * 读当前选中，映射成"每段的字符区间"。
   *
   * 关键：跨段框选时 range 会横跨多个 span，
   * 所以要遍历范围内的所有文本节点，逐个算出它在所属段内的偏移。
   * 只取 range 的两个端点是不够的 —— 中间跨过的整段会被漏掉。
   */
  const readSelection = useCallback((): Hit[] | null => {
    const root = rootRef.current;
    const sel0 = window.getSelection();
    if (!root || !sel0 || sel0.rangeCount === 0 || sel0.isCollapsed) return null;
    const range = sel0.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const hits = new Map<number, { from: number; to: number }>();
    // 逐个文本节点走一遍，把落在选区内的部分累加到对应段
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      if (range.intersectsNode(node)) {
        const span = node.parentElement?.closest<HTMLElement>("[data-seg]");
        const off = Number(span?.dataset.off ?? NaN);
        const len = Number(span?.dataset.len ?? NaN);
        const seg = Number(span?.dataset.seg ?? NaN);
        if (Number.isFinite(seg) && Number.isFinite(off) && Number.isFinite(len) && len > 0) {
          const start = range.comparePoint(node, 0);
          const end = range.comparePoint(node, node.length);
          if (end > start) {
            const a = off + Math.max(0, start);
            const b = off + Math.min(node.length, Math.max(0, end));
            const cur = hits.get(seg);
            if (cur) cur.from = Math.min(cur.from, a);
            else hits.set(seg, { from: a, to: b });
            const cur2 = hits.get(seg)!;
            cur2.to = Math.max(cur2.to, b);
          }
        }
      }
      node = walker.nextNode() as Text | null;
    }
    if (!hits.size) return null;
    return [...hits.entries()]
      .map(([seg, r]) => ({ seg, from: r.from, to: r.to }))
      .sort((a, b) => a.seg - b.seg || a.from - b.from);
  }, []);

  const applyDelete = useCallback(() => {
    if (!sel || !sel.length) return;
    setHistory((h) => [...h, marks]);
    onChange(mergeMarks([...marks, ...sel]));
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }, [marks, onChange, sel]);

  /**
   * 在正文区按下鼠标就暂停播放。
   *
   * 只在"真的按在正文上"时暂停：点在标题、播放按钮上不该把视频停掉，
   * 那样用户会莫名其妙发现画面不动了。
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-text-body]")) onRequestPause?.();
    },
    [onRequestPause]
  );

  // 播放头走进另一段时，把那一段滚到可视区。
  // 粗剪上百句，不滚的话用户盯着画面根本不知道文案的哪一段在播 ——
  // 而"边看画面边核对文案"正是这个界面的全部意义。
  const activeSeg = useMemo(() => {
    if (playTimeSec == null) return null;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s && playTimeSec >= s.roughcutStartSec && playTimeSec < s.roughcutEndSec) return i;
    }
    return null;
  }, [segments, playTimeSec]);

  const activeSegRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeSeg === null) return;
    if (activeSegRef.current === activeSeg) return;
    activeSegRef.current = activeSeg;
    const el = segRefs.current.get(activeSeg);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSeg]);

  const segRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      onChange(prev ?? []);
      setSel(null);
      return h.slice(0, -1);
    });
  }, [onChange]);

  const clearAll = useCallback(() => {
    if (!marks.length) return;
    setHistory((h) => [...h, marks]);
    onChange([]);
    setSel(null);
  }, [marks, onChange]);

  // 选区变化时更新"删除选中 N 字"的提示条。
  //
  // 必须用 useEffect 而不是 useMemo：这里要注册事件监听并返回清理函数，
  // useMemo 的返回值不会被当作清理函数执行，监听会随每次渲染重复叠加。
  useEffect(() => {
    const onSelChange = (): void => setSel(readSelection());
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [readSelection]);

  const selChars = sel ? sel.reduce((n, h) => n + (h.to - h.from), 0) : 0;
  const selSegs = sel ? new Set(sel.map((h) => h.seg)).size : 0;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* 顶部：删了多少 + 撤销 */}
      <div className="flex shrink-0 items-center gap-2">
        <LuScissors className="h-3.5 w-3.5 shrink-0 text-mut-2" />
        <span className="text-[11.5px] font-bold text-mut">精修文字</span>
        <span className="text-[10.5px] text-mut-2">
          框选文字按 Delete 删掉（可跨段）
        </span>
        <span className="flex-1" />
        {removedMs > 0 ? (
          <>
            <span className="tabular rounded bg-bad/10 px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-bad">
              已删 {(removedMs / 1000).toFixed(1)}s
            </span>
            <button
              type="button"
              onClick={undo}
              disabled={history.length === 0}
              title="撤销上一次删除"
              className="flex h-6 w-6 items-center justify-center rounded border border-line text-mut transition-colors enabled:hover:border-ember/60 enabled:hover:text-ember disabled:opacity-30"
            >
              <LuUndo2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut transition-colors hover:border-bad/60 hover:text-bad"
            >
              全部还原
            </button>
          </>
        ) : (
          <span className="tabular font-mono text-[10.5px] text-mut-2">
            共 {(totalMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* 可编辑正文 */}
<div
          ref={rootRef}
          data-text-editor
          onPointerDown={onPointerDown}
          className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto rounded-xl border border-line bg-panel-2/40 p-2.5"
        >
        {segments.map((s, idx) => {
          const text = String(s.text || "");
          /**
           * 这段现在是不是正在播。
           *
           * 只有正在播的段才做卡拉OK 高亮：没在播的段全部字一起变亮看着像出bug。
           * 播放头在粗剪时间轴上，所以先换算成段内毫秒。
           */
          const inSegment =
            playTimeSec != null &&
            playTimeSec >= s.roughcutStartSec &&
            playTimeSec < s.roughcutEndSec;
          const playMs = inSegment ? (playTimeSec - s.roughcutStartSec) * 1000 : -1;
          const spoken =
            playMs >= 0 ? spokenCharsAt(s.sentences ?? [], text, playMs) : null;
          const segMarks = marksBySeg.get(idx) ?? [];
          const removedHere = estimateMs(s, segMarks);
          const isTextless = s.textless === true || text.trim().length === 0;

          /**
           * 上一轮已经剪掉的秒数（来自 seg.cuts）。
           *
           * cuts 存的是**原素材绝对时间**（ms），不是相对段首 ——
           * 下游 clipper 是这么收口的，界面必须先减掉段首才对得上。
           * 直接当相对值用会算出一个远大于段长的数，
           * 于是 "已剪 1800 秒" 这种荒谬数字出现在一段 60 秒的段上。
           */
          const cutMs = (s.cuts ?? []).reduce((n, c) => {
            const relSt = Math.max(0, c.st - s.sourceStartSec * 1000);
            const relEn = Math.max(relSt, c.en - s.sourceStartSec * 1000);
            return n + Math.min(relEn, durMsOf(s)) - relSt;
          }, 0);

          /**
           * 已删超过 90% 就不给改了。
           *
           * 整段删掉其实等于"点名打回这一段"，走那条路有记忆、有黑名单；
           * 在这里静默删光只会得到一个空段，语义完全不同。
           * 后端也会拒，所以前端先拦一道，避免用户白等一次重剪。
           */
          const segLen = durMsOf(s);
          const almostAllGone = segLen > 0 && removedHere / segLen > 0.9;

          return (
            <div
              key={`${s.segmentId ?? "x"}-${idx}`}
              ref={(el) => {
                if (el) segRefs.current.set(idx, el);
                else segRefs.current.delete(idx);
              }}
              className={cx(
                "rounded-lg border bg-panel/40 px-2.5 py-2 transition-colors",
                // 正在播的段描边高亮，让"画面在放哪段"和"文案在念哪段"对得上
                activeSeg === idx ? "border-ember/55 bg-ember/5" : "border-line/70"
              )}
            >
              <div className="mb-1 flex items-center gap-1.5">
                {almostAllGone && (
                  <span className="shrink-0 rounded bg-warn/12 px-1 py-0.5 text-[9px] font-bold text-warn">
                    删太多了
                  </span>
                )}
                <span className="tabular font-mono text-[9.5px] text-mut-2">第{s.segmentIndex}段</span>
                <button
                  type="button"
                  onClick={() => onPreviewRange?.(s)}
                  className="truncate text-[11px] font-semibold text-fg transition-colors hover:text-ember"
                  title="点这一行跳到画面"
                >
                  {s.themeName || "未命名片段"}
                </button>
                <span className="tabular shrink-0 font-mono text-[9.5px] text-mut-2">
                  {(s.roughcutEndSec - s.roughcutStartSec).toFixed(1)}s
                </span>
                <span className="flex-1" />
                {removedHere > 0 && (
                  <span className="tabular shrink-0 font-mono text-[9.5px] font-bold text-bad">
                    -{(removedHere / 1000).toFixed(1)}s
                  </span>
                )}
                {cutMs > 0 && (
                  <span
                    className="tabular shrink-0 font-mono text-[9.5px] text-mut-2"
                    title="上一轮打回时已经剪掉的时长（来自 cuts）"
                  >
                    上轮 -{ (cutMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>

              {isTextless ? (
                /* 实操教学段：不给文本框，改成时间区间块 */
                <div className="flex items-center gap-2 rounded border border-dashed border-line bg-panel-2/50 px-2.5 py-2">
                  <LuClock className="h-3.5 w-3.5 shrink-0 text-mut-2" />
                  <span className="tabular font-mono text-[11px] text-mut">
                    {fmtClock(s.roughcutStartSec)} → {fmtClock(s.roughcutEndSec)}
                  </span>
                  <span className="text-[10.5px] text-mut-2">
                    {s.textlessHint || "这段没有识别到文字，多半是现场演示"}
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0 text-[9.5px] text-mut-2">保留整段</span>
                </div>
              ) : (
                <div
                  data-text-body
                  className={cx(
                    "select-text text-[12px] leading-[1.9] text-fg",
                    almostAllGone && "opacity-40"
                  )}
                >
                  {splitRuns(text, segMarks).map((run, i) => {
                    if (run.del) {
                      /* 删除的文字不带 data-off/data-len：
                         它已经不是"原文的一部分"了，再参与选区计算会把偏移带偏。
                         字符位置必须留在保留文字上，才能保证第二次框选依然准确。 */
                      return (
                        <span
                          key={i}
                          className="rounded bg-bad/15 text-bad/70 line-through decoration-bad/70 decoration-1"
                        >
                          {run.t}
                        </span>
                      );
                    }
                    const off = offsetOf(text, segMarks, i);
                    /**
                     * 卡拉OK 高亮：播放头之前念过的字变亮，播放中的字带光晕。
                     *
                     * 逐字渲染才有推进感，整块变色看不出"念到哪"。
                     * 用 CSS transition 做淡入，所以是一路亮过去而不是跳变。
                     */
                    if (!spoken) {
                      return (
                        <span key={i} data-seg={idx} data-off={off} data-len={run.t.length}>
                          {run.t}
                        </span>
                      );
                    }
                    const a = Math.max(0, spoken.from - off);
                    const b = Math.min(run.t.length, spoken.to - off);
                    // 播放头已经走过整块 run（少见：句子边界插值可能提前收口）
                    if (a >= run.t.length) {
                      return (
                        <span key={i} data-seg={idx} data-off={off} data-len={run.t.length} className="text-ember">
                          {run.t}
                        </span>
                      );
                    }
                    const head = run.t.slice(0, a);
                    const nowChar = run.t.slice(a, b);
                    const tail = run.t.slice(b);
                    return (
                      <span key={i} data-seg={idx} data-off={off} data-len={run.t.length}>
                        {head}
                        <span className="text-ember transition-colors duration-150">
                          {[...nowChar].map((c, ci) => (
                            <span
                              key={ci}
                              className="rounded-[2px] font-semibold text-ember transition-all duration-150"
                              style={{
                                background: ci === nowChar.length - 1 ? "color-mix(in oklab, var(--color-ember) 26%, transparent)" : undefined,
                                textShadow: ci === nowChar.length - 1 ? "0 0 12px color-mix(in oklab, var(--color-ember) 45%, transparent)" : undefined
                              }}
                            >
                              {c}
                            </span>
                          ))}
                        </span>
                        {tail}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {segments.length === 0 && (
          <p className="py-6 text-center text-[11.5px] text-mut-2">这条粗剪没有分段信息</p>
        )}
      </div>

      {/* 选中提示条 */}
      {selChars > 0 && (
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-ember/40 bg-ember/8 px-3 py-2">
          <LuScissors className="h-3.5 w-3.5 shrink-0 text-ember" />
          <span className="text-[11.5px] font-semibold text-fg">
            选中 {selChars} 字
            {selSegs > 1 && <span className="text-ember">（跨 {selSegs} 段）</span>}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={applyDelete}
            className="rounded-lg border border-bad/50 px-3 py-1 text-[11.5px] font-bold text-bad transition-colors hover:bg-bad/10"
          >
            删除选中
          </button>
        </div>
      )}

      <p className="shrink-0 text-[10px] leading-relaxed text-mut-2">
        删除只是标记，确认后随「打回重剪」一起生效 —— 可以连续删多处、一次重剪。
        逐句稿没有词级时间戳，句内按字数比例换算，单字约 100~200ms。
      </p>
    </div>
  );
}

/** 某个 run 在整段文本里的起始字符位置 */
/** 一段在粗剪里的时长（毫秒） */
function durMsOf(seg: ClipSegmentMap): number {
  return Math.max(0, (seg.roughcutEndSec - seg.roughcutStartSec) * 1000);
}

/** 某个 run 在整段文本里的起始字符位置 */
function offsetOf(text: string, marks: Array<{ from: number; to: number }>, runIdx: number): number {
  const runs = splitRuns(text, marks);
  let off = 0;
  for (let i = 0; i < runIdx; i++) off += runs[i]?.t.length ?? 0;
  return off;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 播放进度落到某个字符上（卡拉OK 式高亮的锚点）。
 *
 * 为什么要算：粗剪有几十上百句，凭空变色用户不知道"现在念到哪"，
 * 必须跟着播放头走。而 ASR 只有句级时间戳，所以只能插值到字。
 *
 * 返回的是**该句内已念完的字符数**，配合逐字渲染就能做出推进效果。
 */
export function spokenCharsAt(
  sentences: Array<{ startMs: number; endMs: number; text: string }>,
  text: string,
  playMs: number
): { from: number; to: number } | null {
  if (!sentences.length || playMs < 0) return null;
  // 逐句累加字符数，定位播放头落在哪一句（与 charRangeToTime 的游标一致）
  let cursor = 0;
  for (const s of sentences) {
    const t = String(s.text || "");
    const span = Math.max(0, s.endMs - s.startMs);
    if (span > 0 && playMs >= s.startMs && playMs <= s.endMs) {
      const spoken = Math.max(1, [...t].filter((c) => !PUNCT.test(c)).length);
      // 已念到的"有声字数"
      const ratio = (playMs - s.startMs) / span;
      const target = ratio * spoken;
      let acc = 0;
      let n = 0;
      for (let i = 0; i < t.length; i++) {
        acc += PUNCT.test(t[i] ?? "") ? 0.25 : 1;
        if (acc <= target) n = i + 1;
        else break;
      }
      return { from: cursor, to: cursor + n };
    }
    cursor += t.length + 1;
  }
  void text;
  return null;
}

export type { Mark };
export default TextCutter;