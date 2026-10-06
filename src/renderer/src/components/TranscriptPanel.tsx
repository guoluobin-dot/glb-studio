/**
 * 逐句稿
 * © 2026 郭洛斌
 *
 * 定位当前播放头所在句子,并随播放滚动。点句子直接跳画面。
 *
 * 为什么必须有搜索框:3 小时直播有 500+ 句,靠滚动找一句不现实。
 * 用户常常是"我记得讲过那句…找出来看看画面",搜索是这个场景的关键路径。
 * 搜索命中时直接跳到该句并高亮,省掉手动滚动。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LuFileText, LuSearch, LuX } from "react-icons/lu";
import type { Transcript, TranscriptSegment } from "@shared/api-types";
import { cx } from "./ui";
import { WindowedList } from "./WindowedList";

/** 单行估算高度，和 WindowedList 的 estimateHeight 保持一致 */
const ROW_H = 42;

interface Props {
  transcript: Transcript | null;
  currentTime: number;
  onSeek: (sec: number) => void;
}

/**
 * 当前句 = 最后一个开始时间不晚于播放头的句子。
 *
 * 原来是对 1772 句做 reduce 全量遍历。播放时 currentTime 每秒更新好几次，
 * 于是每秒好几次 O(n) 扫描 —— 句子越多越卡，而句子数正随直播时长增长。
 * 时间轴有序，直接二分。
 */
function findActiveIndex(segments: TranscriptSegment[], currentTime: number): number {
  const target = currentTime + 0.25;
  let lo = 0;
  let hi = segments.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (s && s.startSec <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function TranscriptPanel({ transcript, currentTime, onSeek }: Props): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hitIds, setHitIds] = useState<Set<number> | null>(null);

  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);

  // 搜索:命中句子高亮,并按命中顺序给出可跳转列表
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits: TranscriptSegment[] = [];
    for (const s of segments) {
      if (String(s.text || "").toLowerCase().includes(q)) hits.push(s);
      if (hits.length >= 200) break;
    }
    return hits;
  }, [segments, query]);

  useEffect(() => {
    setHitIds(matches ? new Set(matches.map((m) => m.id)) : null);
  }, [matches]);

  // 有搜索词时自动跳到第一处命中
  useEffect(() => {
    const first = matches?.[0];
    if (first && query.trim()) onSeek(first.startSec);
    // 只在"刚形成搜索词"时跳,不要每次 matches 变化都跳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /**
   * 搜索时把命中列表"喂"给窗口化列表。
   *
   * 虚拟化带来一个必须处理的问题：命中行不在可视区时压根没渲染，
   * 用户看到的是一片灰（全部 dim），会以为"搜索没生效"。
   * 不分页时不存在这个问题 —— 命中句一定在 DOM 里。
   *
   * 所以搜索态直接切成"只看命中"：列表换成命中项，高亮一定看得见；
   * 数量本来就有限（上限 200），也就不再需要窗口化。
   */
  const listItems = hitIds ? matches ?? [] : segments;

  // 搜索态下列表换成了命中项，此时"当前句"没有意义
  const activeIndex = hitIds ? -1 : findActiveIndex(segments, currentTime);

  // 跟随滚动：滚到当前句附近。
  //
  // 原来靠 activeRef 拿真实 DOM 节点再 scrollTo。虚拟化之后这一招失效 ——
  // 当前句很可能压根没渲染（不在可视区），activeRef 为 null，
  // 于是"跟随播放"这个功能会静默失效：用户看画面，文字却停在原处。
  // 现在改成按索引估算位置直接设置 scrollTop，不依赖那一行是否已渲染。
  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollTop + list.clientHeight > list.scrollHeight - 80;
    const target = Math.max(0, activeIndex * ROW_H - list.clientHeight / 2 + ROW_H / 2);
    // 不在可视区才动，避免每次 currentTime 微调都平滑滚动（会晕）
    const cur = list.scrollTop;
    const inView = activeIndex * ROW_H > cur + 24 && activeIndex * ROW_H < cur + list.clientHeight - 24;
    if (!inView || nearBottom) {
      list.scrollTo({ top: target, behavior: "smooth" });
    }
  }, [activeIndex]);

  if (segments.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2.5 rounded-xl border border-line bg-panel-2/50 p-6 text-center">
        <LuFileText className="h-6 w-6 text-mut-2" />
        <p className="text-[11.5px] leading-relaxed text-mut-2">
          逐句稿为空。
          <br />
          点「开始转写并找爆点」跑一次分析,逐句稿会随分析一起生成。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel-2/50">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/70 px-3">
        <LuFileText className="h-3.5 w-3.5 shrink-0 text-mut-2" />
        <span className="shrink-0 text-[10.5px] font-bold tracking-wide text-mut-2">逐句稿</span>

        {/* 搜索:500+ 句靠滚动找不到 */}
        <div className="relative ml-1 min-w-0 flex-1">
          <LuSearch className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-mut-2" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              // Enter 跳到下一处命中
              if (e.key === "Enter" && matches && matches.length > 0) {
                const cur = matches.findIndex((m) => m.startSec > currentTime + 0.3);
                const next = matches[cur < 0 ? 0 : cur];
                if (next) onSeek(next.startSec);
              }
            }}
            placeholder="找一句话…"
            className="w-full rounded border border-line bg-panel-3/60 py-0.5 pr-6 pl-7 text-[11px] outline-none placeholder:text-mut-2/55 focus:border-ember/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="清空"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-mut-2 hover:text-fg"
            >
              <LuX className="h-3 w-3" />
            </button>
          )}
        </div>

        <span className="tabular shrink-0 font-mono text-[10px] text-mut-2">
          {matches ? `${matches.length}/${segments.length}` : `${segments.length}`}
        </span>
      </div>

      {/* 搜索态提示：列表内容已经换成"只看命中"，不���说清楚会以为高亮丢了 */}
      {matches && matches.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line/60 bg-ok/8 px-3 py-1 text-[10.5px] text-ok">
          <LuSearch className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            只显示 {matches.length} 处命中（按 Enter 逐处跳转，Esc 退出）
          </span>
        </div>
      )}

      <WindowedList
        items={listItems}
        getKey={(seg, i) => seg.id ?? `${seg.startSec}-${i}`}
        estimateHeight={ROW_H}
        overscan={8}
        scrollRef={listRef}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {(seg, i) => {
          const active = hitIds ? false : i === activeIndex;
          const hit = hitIds?.has(seg.id) ?? false;
          // 搜索态下列表里只有命中项，没有"未命中"需要淡化
          const dim = hitIds !== null && !hit;
          return (
            <button
              type="button"
              onClick={() => onSeek(seg.startSec)}
              title={hit ? "已命中搜索 · 点击跳转" : undefined}
              className={cx(
                "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                active ? "bg-ember/12" : "hover:bg-panel/60",
                dim && "opacity-30",
                hit && !active && "bg-ok/6"
              )}
            >
              <span
                className={cx(
                  "tabular mt-px shrink-0 font-mono text-[10px]",
                  active ? "text-ember" : hit ? "text-ok" : "text-mut-2"
                )}
              >
                {Math.floor(seg.startSec / 60)}:{String(Math.floor(seg.startSec % 60)).padStart(2, "0")}
              </span>
              <span
                className={cx(
                  "text-[11.5px] leading-relaxed",
                  active ? "text-fg" : "text-mut",
                  hit && "text-ok/90"
                )}
              >
                {seg.text || <span className="italic text-mut-2">(该句无文本)</span>}
              </span>
            </button>
          );
        }}
      </WindowedList>

      {matches && matches.length === 0 && (
        <p className="shrink-0 border-t border-line/60 px-3 py-1.5 text-center text-[10.5px] text-mut-2">
          没找到「{query.trim()}」
        </p>
      )}
    </div>
  );
}
