/**
 * 候选列表
 * © 2026 郭洛斌
 *
 * 这是使用频率最高的区域,所以操作能力必须齐:
 * - 搜索:记住一个主题词(比如"发声"),能立刻在 200 段里定位
 * - 筛选:按分数/时长/是否已选缩小范围
 * - 排序:默认按时间(剪辑习惯),可切按分数(找最强爆点)
 * - 批量:全选/反选/只留高分/按当前时长凑
 * - 常驻显示:候选数、已选数、已选总时长(出片前最后一道校验)
 *
 * 高频动作是"扫一眼 → 勾几条 → 出片",所以:
 * - 勾选框放在最左且给足点击面积(6×6),不用瞄小方块
 * - 分数用大号等宽数字 + 分档发光,一眼分出高低
 * - 双击卡面进审阅台做精细调整(标题/钩子/逐句裁剪)
 */
import { useMemo, useState } from "react";
import {
  LuBookmark,
  LuCheck,
  LuChevronDown,
  LuMaximize2,
  LuPlay,
  LuScissorsLineDashed,
  LuSearch,
  LuSlidersHorizontal,
  LuTextSelect,
  LuX
} from "react-icons/lu";
import type { ClipCandidate } from "@shared/api-types";
import { clipDuration, formatClock } from "../lib/format";
import { cx, Dot, Empty } from "./ui";

type SortId = "time" | "score" | "hook" | "duration";

const SORTS: Array<{ id: SortId; label: string }> = [
  { id: "time", label: "按时间" },
  { id: "score", label: "按分数" },
  { id: "hook", label: "按钩子" },
  { id: "duration", label: "按时长" }
];

function scoreTier(score: number): "hot" | "warm" | "cold" {
  if (score >= 85) return "hot";
  if (score >= 70) return "warm";
  return "cold";
}

export function CandidateList({
  candidates,
  selected,
  focusedId,
  currentTime,
  searchRef,
  onFocus,
  onToggle,
  onOpenReview,
  onSetSelection
}: {
  candidates: ClipCandidate[];
  selected: Set<number>;
  focusedId: number | null;
  /** 当前播放头(秒),用于标出"正在播的这一条" */
  currentTime: number;
  /** 搜索框 ref,由父组件用「/」快捷键聚焦 */
  searchRef?: React.RefObject<HTMLInputElement | null>;
  onFocus: (id: number) => void;
  onToggle: (id: number) => void;
  onOpenReview: (id: number) => void;
  onSetSelection: (ids: number[], on: boolean) => void;
}): React.JSX.Element {
  const [showDropped, setShowDropped] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortId>("time");
  const [sortOpen, setSortOpen] = useState(false);
  const [minScore, setMinScore] = useState(0);

  const dropped = useMemo(() => candidates.filter((c) => c.gate === "drop"), [candidates]);
  const base = useMemo(() => candidates.filter((c) => c.gate !== "drop"), [candidates]);

  // 搜索 + 分数门槛
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = base.filter((c) => (c.score || 0) >= minScore);
    if (q) {
      list = list.filter((c) =>
        [c.title, c.text, c.reason, ...(c.keywords ?? [])]
          .filter(Boolean)
          .some((t) => String(t).toLowerCase().includes(q))
      );
    }
    return list;
  }, [base, query, minScore]);

  const rows = useMemo(() => {
    const list = [...filtered];
    if (showDropped) list.push(...dropped);
    switch (sort) {
      case "score":
        list.sort((a, b) => (b.score || 0) - (a.score || 0) || a.startSec - b.startSec);
        break;
      case "hook":
        list.sort((a, b) => (b.hook ?? "").length - (a.hook ?? "").length || a.startSec - b.startSec);
        break;
      case "duration":
        list.sort((a, b) => clipDuration(b) - clipDuration(a));
        break;
      default:
        list.sort((a, b) => a.startSec - b.startSec);
    }
    return list;
  }, [filtered, dropped, showDropped, sort]);

  const keptIds = filtered.map((c) => c.id);
  const allOn = keptIds.length > 0 && keptIds.every((id) => selected.has(id));
  const highIds = filtered.filter((c) => (c.score || 0) >= 80).map((c) => c.id);
  const playingId = candidates.find((c) => currentTime >= c.startSec && currentTime <= c.endSec)?.id;

  // 已选总时长:出片前最后一道校验,避免"勾了 6 条结果 8 分钟"的意外
  const pickedSec = candidates.filter((c) => selected.has(c.id)).reduce((s, c) => s + clipDuration(c), 0);
  const pickedCount = candidates.filter((c) => selected.has(c.id)).length;

  const filtering = query.trim().length > 0 || minScore > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 搜索 + 排序 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line/60 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-mut-2" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜主题/摘要/关键词（按 / 聚焦）"
            className="w-full rounded-lg border border-line bg-panel-2/60 py-1.5 pr-7 pl-8 text-[11.5px] outline-none placeholder:text-mut-2/60 focus:border-ember/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="清空搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-mut-2 hover:text-fg"
            >
              <LuX className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSortOpen((v) => !v)}
            className="flex items-center gap-1 rounded-lg border border-line bg-panel-2/60 px-2 py-1.5 text-[11px] font-semibold text-mut transition-colors hover:text-fg"
          >
            {SORTS.find((s) => s.id === sort)?.label}
            <LuChevronDown className={cx("h-3 w-3 transition-transform", sortOpen && "rotate-180")} />
          </button>
          {sortOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setSortOpen(false)} />
              <div className="pop-in absolute top-full right-0 z-30 mt-1 w-28 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSort(s.id);
                      setSortOpen(false);
                    }}
                    className={cx(
                      "block w-full px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:bg-panel-2",
                      s.id === sort ? "text-ember" : "text-mut"
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 批量条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line/60 px-3.5 py-2 text-[10.5px] select-none">
        <button
          type="button"
          onClick={() => onSetSelection(keptIds, !allOn)}
          disabled={keptIds.length === 0}
          className="font-semibold text-mut transition-colors hover:text-ember disabled:opacity-40"
        >
          {allOn ? "取消全选" : "全选"}
        </button>
        <span className="text-mut-2/40">·</span>
        <button
          type="button"
          onClick={() => onSetSelection(keptIds.filter((id) => !selected.has(id)), true)}
          disabled={keptIds.length === 0}
          className="font-semibold text-mut transition-colors hover:text-ember disabled:opacity-40"
        >
          反选
        </button>
        <span className="text-mut-2/40">·</span>
        {/* 只留高分:200 段里先挑最强的 10 条,比一个个勾快得多 */}
        <button
          type="button"
          onClick={() => onSetSelection(highIds, true)}
          disabled={highIds.length === 0}
          title="只勾 80 分以上的"
          className="font-semibold text-mut transition-colors hover:text-ember disabled:opacity-40"
        >
          只留高分
        </button>

        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMinScore((v) => (v === 0 ? 60 : v === 60 ? 75 : 0))}
            title="分数门槛"
            className={cx(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-semibold transition-colors",
              minScore > 0 ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut-2 hover:text-mut"
            )}
          >
            <LuSlidersHorizontal className="h-3 w-3" />
            {minScore > 0 ? `≥${minScore}` : "门槛"}
          </button>
          {dropped.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDropped((v) => !v)}
              className={cx(
                "rounded-md border px-1.5 py-0.5 font-semibold transition-colors",
                showDropped ? "border-line text-mut" : "border-line/60 text-mut-2/70 hover:text-mut"
              )}
              title={`${dropped.length} 条被判为该丢弃,点开可复查`}
            >
              丢弃 {dropped.length}
            </button>
          )}
        </span>
      </div>

      {/* 统计条 */}
      <div className="tabular flex shrink-0 items-center gap-2 border-b border-line/60 px-3.5 py-1.5 text-[10px] text-mut-2">
        <span>
          {filtering ? `${rows.length}/${candidates.length}` : `${rows.length}`} 条候选
        </span>
        <span className="text-mut-2/40">·</span>
        <span>
          已选 <b className="text-ember">{pickedCount}</b> 条
        </span>
        <span className="text-mut-2/40">·</span>
        <span className={pickedSec > 300 ? "text-warn" : undefined}>
          共 {formatClock(pickedSec)}
        </span>
        {pickedSec > 300 && <span className="text-warn/80">偏长，注意平台时长上限</span>}
      </div>

      {/* 列表 */}
      <div className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5">
        {rows.length === 0 ? (
          <Empty
            title={filtering ? "没有匹配的候选" : "还没有爆点候选"}
            hint={
              filtering
                ? "换个关键词,或把分数门槛调回 0。"
                : "点上方「开始转写并找爆点」。分析完成后这里会列出可剪的片段。"
            }
            icon={<LuSearch className="h-6 w-6" />}
          />
        ) : (
          rows.map((c, i) => {
            const on = selected.has(c.id);
            const focused = c.id === focusedId;
            const playing = c.id === playingId;
            const tier = scoreTier(c.score);
            return (
              <div
                key={c.id}
                className={cx(
                  "candidate-card group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5",
                  on ? "border-ember/30 bg-panel-2/80" : "border-line/70 bg-panel/50 hover:border-line hover:bg-panel-2/50",
                  c.gate === "drop" && "opacity-55",
                  playing && "border-ember/70 bg-ember/6 shadow-[inset_3px_0_0_var(--flame)]"
                )}
                data-checked={on}
                data-focused={focused}
                data-playing={playing}
                style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                onClick={() => onFocus(c.id)}
                onDoubleClick={() => onOpenReview(c.id)}
              >
                <button
                  type="button"
                  aria-label={on ? "取消选中" : "选中"}
                  aria-pressed={on}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(c.id);
                  }}
                  className={cx(
                    "check-box flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border-2",
                    on ? "flame-gradient border-transparent text-white" : "border-line/90 text-transparent hover:border-ember/70"
                  )}
                >
                  <LuCheck className="h-3.5 w-3.5" strokeWidth={3} />
                </button>

                <span
                  data-tier={tier}
                  className={cx(
                    "score-badge tabular flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl border font-mono font-extrabold",
                    tier === "hot"
                      ? "border-ember/40 bg-ember/10 text-ember"
                      : tier === "warm"
                        ? "border-line bg-panel-3 text-fg/90"
                        : "border-line/70 bg-panel-3/50 text-mut"
                  )}
                >
                  <span className="text-[15px] leading-none">{c.score > 0 ? c.score : "—"}</span>
                  {c.score > 0 && <span className="mt-0.5 text-[8px] font-bold opacity-50">SCORE</span>}
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={cx("truncate text-[13px]", focused ? "font-bold text-fg" : "font-semibold text-fg/90")}>
                      {c.title}
                    </span>
                    {c.score === 0 && (
                      <span className="chip inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px]">
                        <LuTextSelect className="h-2.5 w-2.5" />
                        手动
                      </span>
                    )}
                    {c.pieces && c.pieces.length > 1 && (
                      <LuScissorsLineDashed className="h-3.5 w-3.5 shrink-0 text-ember/80" title={`${c.pieces.length} 段拼接`} />
                    )}
                    {c.manualCuts && c.manualCuts.length > 0 && (
                      <span
                        className="chip inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px] text-ember"
                        title={`逐句挑选后保留 ${c.manualCuts.length} 段区间,出片按区间切再拼`}
                      >
                        <LuScissorsLineDashed className="h-2.5 w-2.5" />
                        逐句 {c.manualCuts.length}
                      </span>
                    )}
                    {c.utility && <LuBookmark className="h-3.5 w-3.5 shrink-0 text-info/80" title="值得收藏" />}
                    {playing && (
                      <span className="chip inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px] text-ember">
                        <LuPlay className="h-2.5 w-2.5" />
                        正在播
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular shrink-0 font-mono text-[10.5px] text-mut">
                      {c.startSec.toFixed(1)}s → {c.endSec.toFixed(1)}s
                    </span>
                    <span className="tabular shrink-0 font-mono text-[10px] text-mut-2">
                      {clipDuration(c).toFixed(0)}s
                    </span>
                  </div>
                </div>

                <LuMaximize2 className="h-3.5 w-3.5 shrink-0 text-mut-2/40 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
