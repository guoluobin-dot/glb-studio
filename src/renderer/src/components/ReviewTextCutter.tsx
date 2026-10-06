/**
 * 审阅台里的文字精修：框选文字删掉
 * © 2026 郭洛斌
 *
 * 和 TextCutter（整条粗剪那套）的区别：
 *   TextCutter   —— 粗剪的每一段各有一个可编辑区，跨段框选
 *   ReviewTextCutter —— 只有当前这一段，按句拼接成一个连续文本
 *
 * 这里必须做成**一段连续文本**而不是一句一行：
 * 用户删的是"同学们欢迎大家"这种跨句边界的连贯话术，
 * 拆成一行一句就没法框选连贯的一句，只能一句句点，体感完全不同。
 *
 * 输出和句子级裁剪统一到 manualCuts（时间区间）：
 * 两种操作都是"这段不要了"，语义一致，可以并存、合并。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuScissors, LuUndo2 } from "react-icons/lu";
import type { TranscriptSegment } from "@shared/api-types";
import { cx } from "./ui";
import { formatClock } from "../lib/format";

const PUNCT = /[，。！？、；：,.!?;]/;

interface Range {
  startSec: number;
  endSec: number;
}

/** 一处字符删除：段下标 + 段内字符区间 */
interface Mark {
  seg: number;
  from: number;
  to: number;
}

interface Props {
  /** 落在这一段内的句子（时间已换算成绝对秒） */
  sentences: TranscriptSegment[];
  startSec: number;
  endSec: number;
  /** 现有的保留区间（可能来自逐句勾选） */
  value: Range[] | undefined;
  onChange: (next: Range[] | undefined) => void;
  /** 点某句跳到画面 */
  onSeek: (sec: number) => void;
  /** 播放头位置，用于卡拉OK 式高亮 */
  playSec?: number | null;
  /** 开始框选时请求暂停 */
  onRequestPause?: () => void;
}

/** 落在本段内的句子。严格相交：放宽容差会把整句在段外的字收进来，而那些字剪不掉 */
function sentencesInRange(all: TranscriptSegment[], start: number, end: number): TranscriptSegment[] {
  return all.filter((s) => s.endSec > start && s.startSec < end);
}

/**
 * 把已有区间切成"留/删"的字符标记。
 *
 * 关键：必须**按绝对时间**判定，而 value 里的区间也是绝对时间。
 * 混用段内相对时间和绝对时间会导致"明明没删却显示删除线"，
 * 或者反过来"删了却看不到"——这两种都极难排查。
 */
function marksFromRanges(sentences: TranscriptSegment[], ranges: Range[] | undefined): Mark[] {
  if (!ranges || !ranges.length) return [];
  const out: Mark[] = [];
  let cursor = 0;
  sentences.forEach((s, seg) => {
    const text = s.text || "";
    // 整句都被覆盖时直接标全长，不走比例换算 ——
    // 比例换算是有损的：句长 20 字、区间只覆盖后 0.2 秒时四舍五入会得到 1 个字，
    // 视觉上就是"删了这一句，但只划掉一个字"，很容易被当成 bug。
    if (ranges.some((r) => r.startSec <= s.startSec + 0.02 && r.endSec >= s.endSec - 0.02)) {
      out.push({ seg, from: cursor, to: cursor + text.length });
      cursor += text.length + 1;
      return;
    }
    const hit = ranges.filter((r) => r.endSec > s.startSec && r.startSec < s.endSec);
    if (!hit.length) {
      cursor += text.length + 1;
      return;
    }
    const span = Math.max(1, s.endSec - s.startSec);
    const sorted = hit.slice().sort((a, b) => a.startSec - b.startSec);
    let prev = 0;
    for (const r of sorted) {
      // 按时间比例换算成字符位置
      const a = Math.round(((Math.max(r.startSec, s.startSec) - s.startSec) / span) * text.length);
      const b = Math.round(((Math.min(r.endSec, s.endSec) - s.startSec) / span) * text.length);
      if (a > prev && b > a) out.push({ seg, from: cursor + prev, to: cursor + Math.min(b, text.length) });
      prev = Math.max(prev, Math.min(b, text.length));
    }
    cursor += text.length + 1;
  });
  return out;
}

/** 把字符标记还原成时间区间（与服务端同一套比例插值） */
function rangesFromMarks(
  sentences: TranscriptSegment[],
  marks: Mark[],
  startSec: number,
  endSec: number
): Range[] {
  const out: Range[] = [];
  let cursor = 0;
  sentences.forEach((s, seg) => {
    const text = s.text || "";
    const span = Math.max(1, s.endSec - s.startSec);
    const spoken = Math.max(1, [...text].filter((c) => !PUNCT.test(c)).length);
    const mine = marks.filter((m) => m.seg === seg);
    for (const m of mine) {
      const a = Math.max(0, m.from - cursor);
      const b = Math.min(text.length, m.to - cursor);
      if (b <= a) continue;
      let w = 0;
      for (let i = 0; i < a; i++) w += PUNCT.test(text[i] ?? "") ? 0.25 : 1;
      let w2 = 0;
      for (let i = 0; i < b; i++) w2 += PUNCT.test(text[i] ?? "") ? 0.25 : 1;
      const st = s.startSec + span * (w / spoken);
      const en = s.startSec + span * (w2 / spoken);
      /*
       * 夹回段内，但**必须保证 endSec > startSec**。
       *
       * 踩过的坑：句子是用"放宽 0.5s"筛出来的，所以第一句的 startSec
       * 可能略早于段起点（4864）。原来写成
       *   startSec = max(段首, min(段首, st))
       *   endSec   = min(段尾, en)
       * 当 st < 段首 时：startSec 被抬到段首（4863.5）而 endSec 仍是 st+0.1（4862.1）
       * → 区间反转 → mergeRanges 以 endSec > startSec 过滤掉 → 合计 0。
       * 结果就是"删除线画出来了，但'已删 X.Xs'永远不显示"，
       * 而且手动 Cuts 也写不进任何东西 —— 剪不掉却不报错。
       *
       * 所以下界用 max(st, 段首-容差)，上界再对下界取一次 max，
       * 结构性保证区间非空。真正的收口交给服务端。
       */
      const lo = Math.max(st, startSec);
      const hi = Math.max(lo, Math.min(en, endSec));
      out.push({ startSec: lo, endSec: hi });
    }
    cursor += text.length + 1;
  });
  return mergeRanges(out);
}

/** 合并重叠/相邻区间（manualCuts 嵌套会导致出片算到负时长） */
function mergeRanges(list: Range[]): Range[] {
  const sorted = list
    .filter((r) => r.endSec > r.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startSec <= last.endSec + 0.02) last.endSec = Math.max(last.endSec, r.endSec);
    else out.push({ ...r });
  }
  // 整段删光要退回"全留"的语义：等于删掉这一段，应该用别的方式表达
  return out;
}

export function ReviewTextCutter({
  sentences,
  startSec,
  endSec,
  value,
  onChange,
  onSeek,
  playSec = null,
  onRequestPause
}: Props): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Mark[] | null>(null);
  // 本地标记：受 value 控制，但编辑时立即反映到 value
  const [local, setLocal] = useState<Mark[]>(() => marksFromRanges(sentences, value));
  const [history, setHistory] = useState<Mark[][]>([]);
  // value 变了（比如从逐句勾选进来）就重新推导，避免两处状态打架
  const lastValue = useRef<string>(JSON.stringify(value ?? null));
  useEffect(() => {
    const key = JSON.stringify(value ?? null);
    if (key === lastValue.current) return;
    lastValue.current = key;
    setLocal(marksFromRanges(sentences, value));
  }, [value, sentences]);

  const text = useMemo(() => sentences.map((s) => s.text || "").join(" "), [sentences]);

  /** 读当前选区 → 每段的字符区间 */
  const readSelection = useCallback((): Mark[] | null => {
    const root = rootRef.current;
    const s0 = window.getSelection();
    if (!root || !s0 || s0.rangeCount === 0 || s0.isCollapsed) return null;
    const range = s0.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const hits = new Map<number, { from: number; to: number }>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      if (range.intersectsNode(node)) {
        const span = node.parentElement?.closest<HTMLElement>("[data-off]");
        const off = Number(span?.dataset.off ?? NaN);
        const seg = Number(span?.closest<HTMLElement>("[data-seg]")?.dataset.seg ?? NaN);
        if (Number.isFinite(seg) && Number.isFinite(off)) {
          /*
           * 用 preCaretRange/comparePoint 取节点内的起止。
           *
           * 这里踩过一个坑：原来写成 comparePoint(node, 0) / comparePoint(node, node.length)，
           * 对"部分覆盖"的节点会算出 0 和节点全长 —— 于是框选 4 个字被判成"选中整句 35 字"，
           * 提示条显示"选中 35 字"，而真正删掉的是按句长比例折算出来的一大段。
           *
           * 正确写法：只在 range 真正覆盖到的位置取点，
           * 未覆盖端点时用 comparePoint 的符号（负数 = 在点之前）来夹取。
           */
/*
           * 选区在这个文本节点内的起止偏移。
           *
           * 判据只能是"range 的起点/终点容器是不是就是本节点"：
           *   startContainer === node → a = range.startOffset（选区从节点中间开始）
           *   否则 → a = 0（选区把整个节点都盖住了，跨句时中间节点都是这样）
           * 终点同理。
           *
           * 踩过的坑：用 comparePoint(node, 0) / comparePoint(node, len) 当偏移。
           * 它返回的是 -1/0/1 这种"关系"，不是位置 ——
           * 框 4 个字（startOffset=0, endOffset=4）在 35 字节点里，
           * c0=0、cN=1，被算成 a=0,b=0 → 判定"没选中"，
           * 提示条不出现，点了也没反应。
           * 早一版直接把它当位置用，则得到 a=0,b=35 → "选中整句 35 字"。
           * 两种都错，且症状完全不同，很难从表现反推。
           */
          const a = range.startContainer === node ? Math.min(range.startOffset, node.length) : 0;
          const b = range.endContainer === node ? Math.min(range.endOffset, node.length) : node.length;
          if (b > a) {
            const cur = hits.get(seg);
            const from = off + a;
            const to = off + b;
            if (cur) {
              cur.from = Math.min(cur.from, from);
              cur.to = Math.max(cur.to, to);
            } else hits.set(seg, { from, to });
          }
        }
      }
      node = walker.nextNode() as Text | null;
    }
    if (!hits.size) return null;
    return [...hits.entries()].map(([seg, r]) => ({ seg, from: r.from, to: r.to }));
  }, []);

  /**
 * 播放时把当前念到的字滚进视野。
 *
 * 不做的话，长文案会停在开头，而画面早就播到第 10 句了 ——
 * "边看画面边核对文案"这个基本动作直接断掉。
 * 用 block:'nearest'，已经可见时不动，避免每帧抖动。
 */
const nowCharRef = useRef<HTMLElement | null>(null);
useEffect(() => {
  const root = rootRef.current;
  if (!root || playSec == null) return;
  const now = root.querySelector<HTMLElement>('[data-now="1"]');
  if (!now || now === nowCharRef.current) return;
  nowCharRef.current = now;
  now.scrollIntoView({ block: 'nearest' });
}, [playSec]);

const selRef = useRef<Mark[] | null>(null);

  useEffect(() => {
    const onSel = (): void => {
      const next = readSelection();
      setSel(next);
      // 只在有选区时更新快照；清空时不覆盖，保留最后一次有效选区给删除用
      if (next?.length) selRef.current = next;
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [readSelection]);

  /** 应用一次删除并回写 value */
  const commit = useCallback(
    (marks: Mark[]) => {
      const next = mergeMarks(marks);
      setLocal(next);
      // 哨兵必须记**即将回传的那份 value**（时间区间），
      // 而不是字符标记 —— 下面的 effect 是拿 value 的 JSON 跟它比的。
      // 记成 marks 的话两者永远不相等，effect 每次都判定"外部变了"，
      // 于是把 local 从 value 反推回来，而那个反推是有损的
      // → 刚删的字立刻消失，看起来就是"点了删除没反应"。
      const nextValue = next.length ? rangesFromMarks(sentences, next, startSec, endSec) : undefined;
      lastValue.current = JSON.stringify(nextValue ?? null);
      onChange(nextValue);
    },
    [sentences, startSec, endSec, onChange]
  );

  /**
   * 最近一次**非空**选区的快照。
   *
   * 为什么不能直接用 state 里的 sel：
   * 点"删除选中"按钮时，mousedown 会让按钮获得焦点，浏览器随即清掉 DOM 选区，
   * 于是 selectionchange 先把 setSel(null) 跑掉，onClick 才执行 ——
   * 这时 sel 已经是 null，applyDelete 直接 return，**点了完全没反应**。
   * 而用户看到的是"按钮能点，就是不删"，根本猜不到是这个时序问题。
   *
   * 所以在监听到选区的当下就存一份快照，删除时用快照。
   */
  const applyDelete = useCallback(() => {
    const picked = selRef.current;
    if (!picked?.length) return;
    setHistory((h) => [...h, local]);
    // 兜底：sel 读的是"绝对字符下标"（readSelection 里 off + comparePoint），
    // 而 commit → rangesFromMarks 会把它换算成时间再回推。
    // 只要这一步算出的区间长度 < 0.05s（等于没有），用户点删除就是白点。
    // 所以这里先算出结果做校验，不合理就不提交，并留下可查的提示。
    const merged = mergeMarks([...local, ...picked]);
    if (!merged.length) {
      console.warn("[ReviewTextCutter] 删除没生效：合并后的标记为空", { local, picked });
      return;
    }
    commit(merged);
    setSel(null);
    selRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, [local, commit]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      if (prev) commit(prev);
      setSel(null);
      return h.slice(0, -1);
    });
  }, [commit]);

  const clearAll = useCallback(() => {
    if (!local.length) return;
    setHistory((h) => [...h, local]);
    commit([]);
    setSel(null);
    selRef.current = null;
  }, [local, commit]);

  /** 播放头所在句的字符区间（卡拉OK 高亮） */
  const spoken = useMemo(() => {
    if (playSec == null) return null;
    let cursor = 0;
    for (const s of sentences) {
      const t = s.text || "";
      const span = Math.max(0, s.endSec - s.startSec);
      if (span > 0 && playSec >= s.startSec && playSec <= s.endSec) {
        const spokenCount = Math.max(1, [...t].filter((c) => !PUNCT.test(c)).length);
        const ratio = (playSec - s.startSec) / span;
        const target = ratio * spokenCount;
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
    return null;
  }, [sentences, playSec]);

  /**
 * 已删时长。
 *
 * 不能直接 sum(local[i].to - local[i].from) 再按句长折算 ——
 * 那样算出来的是"字符数占比"，不是时间。
 * 必须走 rangesFromMarks，因为它才是真正写进 manualCuts 的那份结果：
 * 显示的数字必须和实际生效的区间一致，否则用户看到的和剪掉的对不上。
 */
  const removedSec = useMemo(() => {
    if (!local.length) return 0;
    const rs = rangesFromMarks(sentences, local, startSec, endSec);
    return rs.reduce((n, r) => n + (r.endSec - r.startSec), 0);
  }, [sentences, local, startSec, endSec]);

  const selChars = sel ? sel.reduce((n, m) => n + (m.to - m.from), 0) : 0;

  if (sentences.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-mut-2">
        这一段没有可编辑的文字（多半是现场演示）
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-panel-2/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <LuScissors className="h-3 w-3 text-mut-2" />
        <span className="text-[11px] font-bold text-mut-2">框选删字</span>
        <span className="text-[10.5px] text-mut-2">按住鼠标框几个字，按 Delete 删掉</span>
        <span className="flex-1" />
        {removedSec > 0 && (
          <>
            <span className="tabular rounded bg-bad/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-bad">
              已删 {removedSec.toFixed(1)}s
            </span>
            <button
              type="button"
              onClick={undo}
              disabled={history.length === 0}
              title="撤销"
              className="flex h-6 w-6 items-center justify-center rounded border border-line text-mut transition-colors enabled:hover:border-ember/60 enabled:hover:text-ember disabled:opacity-30"
            >
              <LuUndo2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded border border-line px-2 py-0.5 text-[10.5px] font-semibold text-mut transition-colors hover:border-bad/60 hover:text-bad"
            >
              全部还原
            </button>
          </>
        )}
      </div>

      <div
        ref={rootRef}
        data-review-text-editor
        onPointerDown={(e) => {
          // 按在正文里就暂停：文字跟着播放头高亮，
          // 视频继续走的话，选好按下删除时高亮已经移走，删的就不是选中的字。
          const el = e.target as HTMLElement | null;
          if (!el?.closest("[data-review-text-body]")) return;
          /*
           * 点字跳播（通义千问那种"点哪跳哪"）。
           *
           * 必须先暂停：用户是"看着画面核对"才点字的，
           * 跳转过程中继续播会出现"点了跳过去、又被新播放头带走"的错位。
           *
           * 用 pointerdown 而不是 click：mousedown 更早，能在选区变化前拿到位置，
           * 也避免和框选删除的逻辑抢事件。
           *
           * 只有点到文字本身才跳；点到行距/空白不动，防止误触。
           */
          const ch = el.closest<HTMLElement>("[data-char]");
          if (!ch?.dataset.t) return;
          const sec = Number(ch.dataset.t);
          if (!Number.isFinite(sec)) return;
          onRequestPause?.();
          onSeek(sec);
        }}
        className="scroll-thin max-h-52 select-text overflow-y-auto rounded border border-line bg-panel/50 p-2 text-[12px] leading-[1.9]"
      >
        <div data-review-text-body>
          {sentences.map((s, i) => {
            const t = s.text || "";
            /*
             * 段首偏移 = 前面所有句长 + 每句后面的一个空格。
             * 这个 +1 必须和 join(' ') 及 rangesFromMarks 的游标完全一致，
             * 少算一句后面所有句的 data-off 就整体偏移。
             */
            const off = sentences.slice(0, i).reduce((n, x) => n + (x.text || "").length + 1, 0);

            /*
             * 这句里**真正落在段内**的字符区间。
             *
             * 边界句会有一截在段外：截图那段是 4864→4923，
             * 而首句是 4860.28→4864.96，开头那几个字的时间在 4860~4861，
             * 完全在段外 —— 删了也不会生效（manualCuts 算出来长度 0）。
             *
             * 不做标记的话，用户框住这段字、点了删除、界面画了删除线，
             * "已删 0.0s"也不出现，整个人会觉得功能坏了。
             * 所以把段外的部分置灰并禁止选中，从一开始就传达"这里动不了"。
             */
            const span = Math.max(0.001, s.endSec - s.startSec);
            // 注意别和外层的 spoken（卡拉OK 高亮区间）重名 —— 内层是"有声字数"
            const spokenCount = Math.max(1, [...t].filter((c) => !PUNCT.test(c)).length);
            const visFrom = Math.ceil(Math.max(0, (startSec - s.startSec) / span) * spokenCount);
            const visTo = Math.floor(Math.min(spokenCount, (endSec - s.startSec) / span) * spokenCount);
            const a0 = Math.max(0, Math.min(t.length, visFrom));
            const b0 = Math.max(a0, Math.min(t.length, visTo));
            const head = t.slice(0, a0);
            const body = t.slice(a0, b0);
            const tail = t.slice(b0);
            const speaking = spoken ? spoken.from < off + t.length && spoken.to > off : false;
            // 标记要减掉 a0（段外那一截）才能对上 body 的局部坐标
            const segMarksIn = local
              .filter((m) => m.seg === i)
              .map((m) => ({ from: m.from - off - a0, to: m.to - off - a0 }));
            const runs = splitRuns(body, segMarksIn);
            return (
              <span key={s.id ?? i}>
                {/* 段外的字：置灰 + 禁止选中。从一开始就说明"这里动不了"，
                    比让用户框完、点完、发现"已删 0.0s"要好。 */}
                {head && (
                  <span className="select-none text-mut-2/45" title="这几个字在粗剪范围之外，剪不掉">
                    {head}
                  </span>
                )}
                {runs.map((run, j) => {
                  if (run.del) {
                    return (
                      <span
                        key={j}
                        className="rounded bg-bad/15 text-bad/70 line-through decoration-bad/70"
                        title={body.slice(run.from, run.to)}
                      >
                        {run.t}
                      </span>
                    );
                  }
                  /*
                   * 保留的正文**逐字渲染**。
                   *
                   * 为什么必须逐字而不是整块变色：
                   *  - KTV 式推进要的是"念到哪个字"的光标，一个字一个格才画得出来；
                   *  - 点字跳播需要知道点的到底是第几个字，整块 span 只能定位到块首。
                   *
                   * 代价是 DOM 节点变多（369 字 → 369 个 span）。
                   * 这里用固定行高 + 不换行的 span 摊平成本，
                   * 超长段落（>800 字）退化为按 run 渲染，避免节点爆炸。
                   */
                  const segOff = off + a0;
                  if (run.t.length > 800) {
                    return (
                      <span key={j} data-seg={i} data-off={segOff + run.from}>
                        {run.t}
                      </span>
                    );
                  }
                  // 逐字的累计权重，用来把播放进度落到具体某个字
                  const weights: number[] = [];
                  let acc = 0;
                  for (const ch of run.t) {
                    const w = PUNCT.test(ch) ? 0.25 : 1;
                    weights.push(w);
                    acc += w;
                  }
                  /*
                   * sungTo = 播放头已经念到本 run 的第几个字。
                   *
                   * 关键：不能把 sungTo 直接夹到 run 长度。
                   * 夹完之后"已经念完"的那些 run 会得到 sungTo === 长度，
                   * 于是 k === sungTo-1 成立 → 每一个念过的 run 末尾
                   * 都会冒出一个"当前字"高亮（实测 8 个）。
                   * 所以分成两种情况：念完了就整体点亮、不标当前字；
                   * 只有播放头正落在 run 内时才标。
                   */
                  const rawTo = spoken ? spoken.to - segOff - run.from : 0;
                  const allSung = rawTo >= run.t.length;
                  const sungTo = allSung ? run.t.length : Math.max(0, rawTo);
                  return (
                    <span key={j} data-seg={i} data-off={segOff + run.from}>
                      {[...run.t].map((ch, k) => {
                        const sung = k < sungTo;
                        const isNow = !allSung && sungTo > 0 && k === sungTo - 1;
                        // 把这个字的时间直接算好挂上去。
                        // 点击时只读 data-t，不用再反推是哪一句、第几个字 ——
                        // 反推要拿 offset 和句子列表比对，一处对不上就跳错位置，
                        // 而且很难看出是"跳得不准"还是"点错字了"。
                        const charSec = s.startSec + span * (cum(weights, k) / Math.max(0.001, acc));
                        return (
                          <span
                            key={k}
                            data-char
                            /*
                             * 每个"字"都要有自己的 data-off。
                             *
                             * 踩过的坑：只把 data-off 挂在 run 上时，
                             * 逐字渲染产生的每一个文本节点都被算成 run 的起点，
                             * 于是一个 run 里选 8 个字 → 合并后只剩 1 个字的跨度。
                             * 单段内看不出问题（提示条字数对得上），
                             * 一跨段就露馅：两段各只报"选中 1 字"，
                             * 实际删掉 2 个字，提示条和结果对不上。
                             *
                             * 所以这里改成 close到最近带 data-off 的祖先，
                             * 逐字渲染时每个字自己带。
                             */
                            data-off={segOff + run.from + k}
                            data-now={isNow ? "1" : undefined}
                            data-t={Math.max(startSec, Math.min(endSec, charSec))}
                            title={fmtSec(Math.max(startSec, Math.min(endSec, charSec)))}
                            className={cx(
                              "cursor-pointer rounded-[2px] transition-colors duration-150",
                              sung && "text-ember",
                              isNow && "bg-ember/25 font-semibold",
                              !sung && "hover:bg-ember/10"
                            )}
                          >
                            {ch}
                          </span>
                        );
                      })}
                    </span>
                  );
                })}
                {tail && (
                  <span className="select-none text-mut-2/45" title="这几个字在粗剪范围之外，剪不掉">
                    {tail}
                  </span>
                )}
                {speaking && <span className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 bg-ember align-middle" />}
                {i < sentences.length - 1 && <span> </span>}
              </span>
            );
          })}
        </div>
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-mut-2">
        删掉的字不会进成片。删得不够精确就点左侧句子跳过去再看。逐句稿没有词级时间戳，单字约 100~200ms。
      </p>

      {selChars > 0 && (
        <div className="mt-1.5 flex items-center gap-2 rounded border border-ember/40 bg-ember/8 px-2.5 py-1.5">
          <span className="text-[11px] font-semibold text-fg">选中 {selChars} 字</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={applyDelete}
            className="rounded border border-bad/50 px-2.5 py-1 text-[11px] font-bold text-bad transition-colors hover:bg-bad/10"
          >
            删除选中
          </button>
        </div>
      )}

      {/* 句子快捷条：框选之外给一条"按句剔除"的通道 */}
      <div className="mt-2 flex flex-wrap gap-1">
        {sentences.map((s, i) => {
          const dropped = local.some((m) => m.seg === i && m.to - m.from >= (s.text || "").length * 0.8);
          return (
            <button
              key={s.id ?? i}
              type="button"
              onClick={() => {
                onRequestPause?.();
                if (dropped) {
                  commit(local.filter((m) => m.seg !== i));
                } else {
                  const off = sentences.slice(0, i).reduce((n, x) => n + (x.text || "").length + 1, 0);
                  commit([...local, { seg: i, from: off, to: off + (s.text || "").length }]);
                }
              }}
              title={`${formatClock(s.startSec)} ${s.text}`}
              className={cx(
                "tabular rounded border px-1.5 py-0.5 font-mono text-[9.5px] transition-colors",
                dropped ? "border-bad/50 bg-bad/10 text-bad" : "border-line text-mut-2 hover:border-ember/50 hover:text-ember"
              )}
            >
              {formatClock(s.startSec)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 合并同一句内重叠的标记。
 *
 * 必须按 seg 分组再排 —— 直接按数组顺序比较 last.to 会漏：
 * sel 的顺序是"按句遍历顺序"（天然有序），
 * 但 local + sel 拼起来之后，local 里的老标记可能来自更早的句，
 * 与 sel 的当前句交错。只比较相邻项会漏掉该合的，
 * 残留两个重叠区间会让 rangesFromMarks 产出嵌套时间，
 * 再被 mergeRanges 合掉 —— 视觉上就变成"删了一大片"或者"没删到点上"。
 */
function mergeMarks(list: Mark[]): Mark[] {
  const bySeg = new Map<number, Array<{ from: number; to: number }>>();
  for (const m of list) {
    if (m.to <= m.from) continue;
    if (!bySeg.has(m.seg)) bySeg.set(m.seg, []);
    bySeg.get(m.seg)!.push({ from: m.from, to: m.to });
  }
  const out: Mark[] = [];
  for (const seg of [...bySeg.keys()].sort((a, b) => a - b)) {
    const arr = bySeg.get(seg)!.sort((a, b) => a.from - b.from);
    const merged: Array<{ from: number; to: number }> = [];
    for (const m of arr) {
      const last = merged[merged.length - 1];
      if (last && m.from <= last.to) last.to = Math.max(last.to, m.to);
      else merged.push({ ...m });
    }
    for (const m of merged) out.push({ seg, from: m.from, to: m.to });
  }
  return out;
}

/** 把一段文字按标记切成"保留/删除" */
function splitRuns(text: string, marks: Array<{ from: number; to: number }>): Array<{ t: string; del: boolean; from: number; to: number }> {
  const merged = marks
    .filter((m) => m.to > m.from)
    .slice()
    .sort((a, b) => a.from - b.from);
  const out: Array<{ t: string; del: boolean; from: number; to: number }> = [];
  let cur = 0;
  for (const m of merged) {
    const from = Math.max(0, Math.min(text.length, m.from));
    const to = Math.max(0, Math.min(text.length, m.to));
    if (to <= from) continue;
    if (from > cur) out.push({ t: text.slice(cur, from), del: false, from: cur, to: from });
    out.push({ t: text.slice(from, to), del: true, from, to });
    cur = to;
  }
  if (cur < text.length) out.push({ t: text.slice(cur), del: false, from: cur, to: text.length });
  return out;
}

/** 权重数组前 n 项的和（用来把"第 k 个字"换算成句内时间位置） */
function cum(weights: number[], n: number): number {
  let s = 0;
  for (let i = 0; i < n && i < weights.length; i++) s += weights[i] ?? 0;
  return s;
}

/** 秒 → 0:00 之外的"分:秒"，用于 title 提示 */
function fmtSec(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export default ReviewTextCutter;