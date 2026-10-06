/**
 * 时间轴
 * © 2026 郭洛斌
 *
 * 一条横向轨道同时表达四件事:素材总长、每个爆点的位置与时长、哪些被勾选、
 * 以及当前播放头。用户不用来回对照候选卡就能看出"选中的都分布在哪儿"。
 *
 * 为什么必须有缩放:3 小时直播里 200 段挤在一条线上,每段只有几个像素宽,
 * 根本点不中、也看不出边界。放大到分钟级才能真正"逐句挑选"——
 * 这是支持逐字逐句裁剪的前提,不是锦上添花。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { formatClock } from "../lib/format";
import { cx } from "./ui";

interface Marker {
  id: number;
  startSec: number;
  endSec: number;
  selected: boolean;
  score: number;
  title: string;
}

interface Props {
  duration: number;
  currentTime: number;
  markers: Marker[];
  focusedId: number | null;
  onSeek: (sec: number) => void;
  onFocus: (id: number) => void;
  onToggle: (id: number) => void;
}

/** 分数映射成高度,高分段更醒目 */
function barHeight(score: number, selected: boolean): string {
  const base = 18 + Math.max(0, Math.min(1, score)) * 46;
  return `${selected ? Math.max(base, 34) : base}%`;
}

/** 缩放档位:1 = 全览,数字越大越放大 */
const ZOOMS = [1, 4, 12, 40, 120];

export function Timeline({
  duration,
  currentTime,
  markers,
  focusedId,
  onSeek,
  onFocus,
  onToggle
}: Props): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);
  const [follow, setFollow] = useState(true);

  // 缩放后视窗宽度(秒);zoom=0 时是整个素材
  const viewSec = duration > 0 ? duration / (ZOOMS[zoom] ?? 1) : 0;
  // 跟随播放头:播放头接近右缘时把视窗往前推,否则放大后会"跟丢"
  const [viewStart, setViewStart] = useState(0);

  useMemo(() => {
    if (!follow || viewSec <= 0) return;
    const t = currentTime;
    setViewStart((prev) => {
      // 播放头走出视窗(留 15% 余量)才滚动,否则会抖
      if (t >= prev + viewSec * 0.85 || t < prev) return Math.max(0, t - viewSec * 0.15);
      return prev;
    });
  }, [currentTime, follow, viewSec]);

  const maxStart = Math.max(0, duration - viewSec);
  const clampedStart = Math.min(viewStart, maxStart);
  const viewEnd = clampedStart + viewSec;

  const visible = useMemo(
    () => markers.filter((m) => m.endSec >= clampedStart && m.startSec <= viewEnd),
    [markers, clampedStart, viewEnd]
  );

  const pct = (sec: number): number => (viewSec > 0 ? ((sec - clampedStart) / viewSec) * 100 : 0);

  const seekFromEvent = useCallback(
    (clientX: number): void => {
      const el = trackRef.current;
      if (!el || viewSec <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(duration, clampedStart + ratio * viewSec)));
    },
    [clampedStart, duration, onSeek, viewSec]
  );

  // 只有拖动播放头时才 seek,避免点击段块时抢走选择行为
  const dragging = useRef(false);
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return;
    seekFromEvent(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const selectedInView = visible.filter((m) => m.selected).length;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel-2/60 p-2.5">
      <div className="flex items-center gap-2 text-[10.5px] text-mut-2">
        <span className="font-semibold tracking-wide">时间轴</span>
        {zoom > 0 && (
          <>
            <button
              type="button"
              onClick={() => setFollow((v) => !v)}
              className={cx(
                "rounded border px-1.5 py-0.5 font-semibold transition-colors",
                follow ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut-2 hover:text-mut"
              )}
              title="播放时视窗自动跟随"
            >
              跟随
            </button>
            <span className="tabular font-mono">
              视窗 {formatClock(clampedStart)} – {formatClock(viewEnd)}
            </span>
          </>
        )}
        <span className="flex-1" />
        <span className="tabular font-mono">
          {formatClock(currentTime)} / {formatClock(duration)} · 本窗已选{" "}
          <b className="text-ember">{selectedInView}</b>
        </span>
        {/* 缩放:长直播必需,否则段太密点不中 */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={zoom === 0}
            onClick={() => setZoom((z) => Math.max(0, z - 1))}
            title="缩小"
            className="flex h-5 w-5 items-center justify-center rounded border border-line text-mut transition-colors hover:text-ember disabled:opacity-35"
          >
            <LuMinus className="h-3 w-3" />
          </button>
          <span className="tabular w-9 text-center font-mono text-[9.5px]">
            {zoom === 0 ? "全览" : `${ZOOMS[zoom]}×`}
          </span>
          <button
            type="button"
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
            title="放大（3 小时直播逐句挑选必需）"
            className="flex h-5 w-5 items-center justify-center rounded border border-line text-mut transition-colors hover:text-ember disabled:opacity-35"
          >
            <LuPlus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={
          // 滚轮缩放:剪辑时的肌肉记忆
          (e) => {
            if (!e.ctrlKey && !e.shiftKey) return;
            e.preventDefault();
            setZoom((z) => Math.max(0, Math.min(ZOOMS.length - 1, z + (e.deltaY < 0 ? 1 : -1))));
          }
        }
        className="relative h-16 w-full cursor-pointer select-none rounded-lg bg-black/40"
        title="拖动定位播放头 · Ctrl+滚轮缩放"
      >
        {/* 刻度:缩放越大,刻度间隔越细 */}
        {viewSec > 0 &&
          Array.from({ length: 9 }, (_, i) => {
            const t = clampedStart + (viewSec / 8) * i;
            return (
              <span key={i}>
                <span
                  className="absolute top-0 h-1.5 w-px bg-line"
                  style={{ left: `${(i / 8) * 100}%` }}
                />
                {i % 2 === 0 && (
                  <span
                    className="tabular absolute top-2 font-mono text-[8px] text-mut-2/70"
                    style={{ left: `${(i / 8) * 100}%`, transform: "translateX(2px)" }}
                  >
                    {formatClock(t)}
                  </span>
                )}
              </span>
            );
          })}

        {/* 段块 */}
        {viewSec > 0 &&
          visible.map((m) => {
            const left = pct(m.startSec);
            const width = Math.max(0.4, ((m.endSec - m.startSec) / viewSec) * 100);
            const isFocus = m.id === focusedId;
            return (
              <button
                key={m.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onToggle(m.id)}
                onDoubleClick={() => onFocus(m.id)}
                title={`${m.title} · ${formatClock(m.startSec)} → ${formatClock(m.endSec)}${m.selected ? " · 已选" : ""}`}
                className={cx(
                  "absolute bottom-0.5 rounded-sm border transition-colors",
                  m.selected
                    ? "border-ember/70 bg-ember/45"
                    : "border-line/70 bg-panel/60 hover:border-ember/50",
                  isFocus && "ring-1 ring-ember"
                )}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  height: barHeight(m.score, m.selected)
                }}
              >
                {isFocus && <span className="absolute inset-x-0 -top-0.5 h-0.5 rounded-full bg-ember" />}
              </button>
            );
          })}

        {/* 播放头 */}
        {viewSec > 0 && clampedStart <= currentTime && currentTime <= viewEnd && (
          <span className="pointer-events-none absolute top-0 bottom-0 w-px bg-ember" style={{ left: `${pct(currentTime)}%` }}>
            <span className="absolute -top-0.5 -left-[3px] h-1.5 w-1.5 rounded-full bg-ember" />
          </span>
        )}
      </div>

      <p className="text-[10px] text-mut-2">
        单击段块 = 勾选/取消 · 双击段块 = 跳到该段 · 拖动轨道 = 定位播放头 · Ctrl+滚轮 = 缩放
      </p>
    </div>
  );
}
