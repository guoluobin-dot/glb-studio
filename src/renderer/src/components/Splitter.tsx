/**
 * 可拖拽分隔条
 * © 2026 郭洛斌
 *
 * 为什么需要:面板宽度写死时,小屏幕上播放器被挤成一条缝,
 * 大屏幕上又浪费空间。用户应该能按自己的屏幕和习惯调。
 *
 * 交互要点:
 * - 拖动时用 overlay 光标,避免鼠标在元素间"跳"导致拖拽中断
 * - 双击复位到默认宽度
 * - 宽度持久化到 localStorage,重启后还在
 * - 键盘可调(← →),无障碍与精细调整都靠它
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface SplitterProps {
  /** 当前比例(0~1) */
  value: number;
  onChange: (v: number) => void;
  /** 方向:vertical = 左右分隔(竖条),horizontal = 上下分隔(横条) */
  orientation?: "vertical" | "horizontal";
  min?: number;
  max?: number;
  /** 双击复位目标 */
  resetTo?: number;
  storageKey?: string;
  label?: string;
}

const DEFAULTS = { min: 0.24, max: 0.66, resetTo: 0.42 };

export function Splitter({
  value,
  onChange,
  orientation = "vertical",
  min = DEFAULTS.min,
  max = DEFAULTS.max,
  resetTo = DEFAULTS.resetTo,
  storageKey,
  label = "拖动调整面板大小"
}: SplitterProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pos: number; value: number }>({ pos: 0, value: 0 });

  // 从 localStorage 恢复
  useEffect(() => {
    if (!storageKey) return;
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) onChange(saved);
    // 只在挂载时读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const commit = useCallback(
    (v: number): void => {
      const clamped = Math.max(min, Math.min(max, v));
      onChange(clamped);
      if (storageKey) window.localStorage.setItem(storageKey, String(clamped));
    },
    [max, min, onChange, storageKey]
  );

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { pos: orientation === "vertical" ? e.clientX : e.clientY, value };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging) return;
    const delta = (orientation === "vertical" ? e.clientX : e.clientY) - startRef.current.pos;
    const total = orientation === "vertical" ? window.innerWidth : window.innerHeight;
    commit(startRef.current.value + delta / total);
  };

  const end = (e: React.PointerEvent): void => {
    if (!dragging) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 0.06 : 0.02;
    if (orientation === "vertical") {
      if (e.key === "ArrowLeft") { e.preventDefault(); commit(value - step); }
      if (e.key === "ArrowRight") { e.preventDefault(); commit(value + step); }
    } else {
      if (e.key === "ArrowUp") { e.preventDefault(); commit(value - step); }
      if (e.key === "ArrowDown") { e.preventDefault(); commit(value + step); }
    }
  };

  const vertical = orientation === "vertical";

  return (
    <>
      {/* 拖拽期间覆盖一层,让光标在整个区域保持一致,否则元素边界处会断 */}
      {dragging && (
        <div
          className="fixed inset-0 z-50"
          style={{ cursor: vertical ? "col-resize" : "row-resize" }}
        />
      )}
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label={label}
        aria-valuenow={Math.round(value * 100)}
        tabIndex={0}
        title={`${label}（双击复位）`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => commit(resetTo)}
        onKeyDown={onKeyDown}
        className={
          vertical
            ? "group relative z-10 w-1 shrink-0 cursor-col-resize"
            : "group relative z-10 h-1 shrink-0 cursor-row-resize"
        }
      >
        <div
          className={
            vertical
              ? "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:bg-ember/60"
              : "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line transition-colors group-hover:bg-ember/60"
          }
        />
        {/* 悬停时给一个可抓握的视觉提示 */}
        <div
          className={
            vertical
              ? "absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100"
              : "absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100"
          }
        />
      </div>
    </>
  );
}
