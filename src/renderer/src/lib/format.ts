/**
 * 格式化与片段计算小工具
 * © 2026 郭洛斌
 */
import type { ClipCandidate } from "@shared/api-types";

/** 片段时长:有拼接段时按各段之和,否则用首尾差。 */
export function clipDuration(c: ClipCandidate): number {
  if (c.pieces && c.pieces.length > 0) {
    return c.pieces.reduce((sum, p) => sum + Math.max(0, p.endSec - p.startSec), 0);
  }
  return Math.max(0, c.endSec - c.startSec);
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDurationCN(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m > 0) return `${m} 分钟`;
  return `${s} 秒`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** 文件名(去扩展名) */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}
