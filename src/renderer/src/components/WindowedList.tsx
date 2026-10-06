/**
 * 窗口化长列表
 * © 2026 郭洛斌
 *
 * 为什么需要它：3 小时直播的逐句稿有 1772 句。
 * 直接 segments.map() 会创建 1772 个真实 DOM 节点，
 * 再叠加播放时每秒几次的 currentTime 更新，滚动会明显发涩。
 *
 * 为什么自己写而不引 react-window：
 *  - 打包体积（这是 Electron 桌面应用，多一个依赖就是多几 MB）
 *  - 逐句稿的行高不固定（有的句子很长），现成的固定行高虚拟列表处理不好
 *  - 只需要"渲染可视区 + 上下留白"这一个功能，30 行就够
 *
 * 做法：估一个平均行高，只渲染可视区附近的条目，
 * 上下用 padding 撑出总高度，滚动条长度和真实内容一致。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

interface Props<T> {
  items: T[];
  /** 稳定 key：行内容变化但位置不变时不能重排 */
  getKey: (item: T, index: number) => string | number;
  /** 估算行高（像素）。宁可高估 —— 高估只是留白多一点，低估会导致跳动 */
  estimateHeight?: number;
  /** 上下额外渲染几行，避免快速滚动时露白 */
  overscan?: number;
  /** 当前项，滚动定位到它 */
  activeIndex?: number | null;
  /** 行高实测均值，滚动久了会更准 */
  onMeasuredHeight?: (avg: number) => void;
  className?: string;
  /** 转发滚动容器：外部要读 scrollTop/scrollTo（比如跟随播放） */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  children: (item: T, index: number) => ReactNode;
}

export function WindowedList<T>({
  items,
  getKey,
  estimateHeight = 46,
  overscan = 6,
  activeIndex = null,
  onMeasuredHeight,
  className,
  scrollRef: externalScrollRef,
  children
}: Props<T>): React.JSX.Element {
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? innerRef;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [avg, setAvg] = useState(estimateHeight);

  // 高度变化（换素材、搜索过滤）时回到顶部，否则滚动位置会指向旧列表的中段
  useEffect(() => {
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [items.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

/**
   * 实测行高：文字换行多的列表，平均值会比估的高，
   * 不修正的话总高度算小、滚动条会短一截，滚到底也看不到最后几行。
   *
   * 【不要用 ref 回调逐行测高】—— 这个坑我踩了两次，必须写清楚：
   *
   * 1) ref 回调里调 setState，且回调依赖 avg：
   *    setAvg → avg 变 → 回调身份变 → React 重新挂 ref → 再 setAvg …
   *    无限循环，React 报 #185，整页白屏。
   *
   * 2) 逐行测量本身也不对。每一行高度不同（逐句稿有的句子长、有的短），
   *    逐个 ref 跑会被最后测到的行带偏，算出错误的总高度、滚动条长度也不对。
   *    注意它是"不准"而不是"死循环" —— 收敛守卫仍然会让它停在一个错误的值上。
   *
   * 正确做法：一次性量所有已渲染行，取平均，得到一个确定的数。
   * 再用混合公式平滑逼近。avg_new = round(avg*0.8 + measuredMean*0.2)，
   * measuredMean 是固定值，所以数学上必然收敛，几轮就停。
   *
   * 用 useEffect 而不是 useLayoutEffect：前者不在提交阶段跑，
   * 不会在 ref 挂载的同一趟里递归触发 setState。
   */
  const onMeasuredHeightRef = useRef(onMeasuredHeight);
  onMeasuredHeightRef.current = onMeasuredHeight;

  // 已渲染行的容器。给行加 data-wl-row，量高时只挑这些，
  // 不会把上下留白那两块也算进去。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>("[data-wl-row]");
    // 少于 20 行说明还没滚开，样本不足，估算值更可信
    if (rows.length < 20) return;
    let sum = 0;
    let n = 0;
    for (const r of Array.from(rows)) {
      const h = r.offsetHeight;
      if (h > 0) {
        sum += h;
        n += 1;
      }
    }
    if (!n) return;
    const measuredMean = Math.max(28, Math.round(sum / n));
    setAvg((prev) => {
      if (Math.abs(measuredMean - prev) <= 6) return prev;
      const blended = Math.round(prev * 0.8 + measuredMean * 0.2);
      onMeasuredHeightRef.current?.(blended);
      return blended;
    });
  });

  const total = items.length * avg;
  const first = Math.max(0, Math.floor(scrollTop / avg) - overscan);
  const visibleCount = Math.ceil((viewportH || 400) / avg) + overscan * 2;
  const last = Math.min(items.length, first + visibleCount);
  const slice = useMemo(() => items.slice(first, last), [items, first, last]);

  return (
    <div
      ref={scrollRef}
      className={className}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      {/* 上下留白撑出真实总高度，滚动条长度才正确 */}
      <div style={{ height: first * avg }} />
      {slice.map((item, i) => {
        const idx = first + i;
        return (
          <div key={getKey(item, idx)} data-wl-row>
            {children(item, idx)}
          </div>
        );
      })}
      <div style={{ height: Math.max(0, (items.length - last) * avg) }} />
    </div>
  );
}