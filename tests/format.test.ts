/**
 * 片段计算与格式化 单元测试
 * © 2026 郭洛斌
 *
 * clipDuration 决定出片统计和重排凑时长,算错会让用户拿到长度不对的成片,
 * 所以拼接段求和、单段差值、边界都要钉死。
 */
import { describe, it, expect } from "vitest";
import { clipDuration, formatClock, formatDurationCN, formatSize, fileStem } from "../src/renderer/src/lib/format";
import type { ClipCandidate } from "@shared/api-types";

function candidate(patch: Partial<ClipCandidate> = {}): ClipCandidate {
  return {
    id: 1,
    startSec: 10,
    endSec: 40,
    text: "",
    title: "",
    hook: "",
    score: 0,
    reason: "",
    reviewNote: "",
    boundary: "segment",
    keywords: [],
    recommended: false,
    ...patch
  };
}

describe("clipDuration", () => {
  it("无拼接段时用首尾差", () => {
    expect(clipDuration(candidate({ startSec: 10, endSec: 40 }))).toBe(30);
  });

  it("有拼接段时按各段之和(不是首尾差)", () => {
    const c = candidate({
      startSec: 10,
      endSec: 50,
      pieces: [
        { startSec: 10, endSec: 20, text: "a" },
        { startSec: 30, endSec: 36, text: "b" },
        { startSec: 45, endSec: 50, text: "c" }
      ]
    });
    // 10 + 6 + 5 = 21,而首尾差是 40 —— 拼接段必须求和,否则统计会虚高
    expect(clipDuration(c)).toBe(21);
  });

  it("单元素拼接段等于该段长度", () => {
    const c = candidate({ pieces: [{ startSec: 5, endSec: 12, text: "x" }] });
    expect(clipDuration(c)).toBe(7);
  });

  it("空拼接段数组退回首尾差", () => {
    expect(clipDuration(candidate({ startSec: 3, endSec: 9, pieces: [] }))).toBe(6);
  });

  it("倒挂边界返回 0 而非负数", () => {
    expect(clipDuration(candidate({ startSec: 30, endSec: 10 }))).toBe(0);
  });
});

describe("格式化", () => {
  it("formatClock 少于 1 小时用 mm:ss", () => {
    expect(formatClock(65)).toBe("01:05");
    expect(formatClock(0)).toBe("00:00");
  });

  it("formatClock 超过 1 小时用 h:mm:ss", () => {
    expect(formatClock(3725)).toBe("1:02:05");
  });

  it("formatDurationCN 用中文单位", () => {
    expect(formatDurationCN(45)).toBe("45 秒");
    expect(formatDurationCN(120)).toBe("2 分钟");
    expect(formatDurationCN(7200)).toBe("2 小时");
  });

  it("formatSize 按量级切换单位", () => {
    expect(formatSize(500)).toBe("0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSize(2 * 1024 ** 3)).toBe("2.0 GB");
  });

  it("fileStem 去扩展名且兼容两种分隔符", () => {
    expect(fileStem("D:\\videos\\直播回放.mp4")).toBe("直播回放");
    expect(fileStem("C:/media/lecture.mkv")).toBe("lecture");
    expect(fileStem("noext")).toBe("noext");
  });
});
