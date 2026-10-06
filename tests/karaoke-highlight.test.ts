/**
 * 卡拉OK 式高亮（spokenCharsAt）回归测试
 *
 * 需求：播放到哪里，文案就变到哪里 —— 用户能"看着画面读稿"，
 * 顺带知道念到哪个字，删某几个字时不会删错。
 *
 * 两个坑：
 *  1. 用**句级**时间戳插值到字。ASR 没有词级时间戳，只能按字数比例。
 *  2. 句间那个空格要算进字符游标（与 charRangeToTime 一致），
 *     不然第二句往后的偏移会差 1 字/句，高亮会整体偏。
 *
 * @author 郭洛斌
 */

const PUNCT = /[，。！？、；：,.!?;]/;

/** 与 TextCutter.spokenCharsAt 保持一致 */
function spokenCharsAt(
  sentences: Array<{ startMs: number; endMs: number; text: string }>,
  playMs: number
): { from: number; to: number } | null {
  if (!sentences.length || playMs < 0) return null;
  let cursor = 0;
  for (const s of sentences) {
    const t = String(s.text || "");
    const span = Math.max(0, s.endMs - s.startMs);
    if (span > 0 && playMs >= s.startMs && playMs <= s.endMs) {
      const spoken = Math.max(1, [...t].filter((c) => !PUNCT.test(c)).length);
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
  return null;
}

import { describe, it, expect } from "vitest";

const S1 = { startMs: 0, endMs: 10000, text: "同学们欢迎大家" };
const S2 = { startMs: 10000, endMs: 20000, text: "今天讲和弦" };
const ALL = [S1, S2];

describe("卡拉OK 高亮 · 播放进度映射到字", () => {
  it("句首一个字都没念到", () => {
    const r = spokenCharsAt(ALL, 0);
    expect(r).toEqual({ from: 0, to: 0 });
  });

  it("句末整句念完", () => {
    const r = spokenCharsAt(ALL, 10000);
    expect(r?.to).toBe(S1.text.length);
  });

  it("推进是单调的，不会来回跳", () => {
    let last = -1;
    for (let ms = 0; ms <= 20000; ms += 200) {
      const r = spokenCharsAt(ALL, ms);
      const n = r?.to ?? 0;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it("中途大致到句子中点（比例插值）", () => {
    // 5000ms 处是第一句一半，7 个字大约念到第 3~4 个
    const r = spokenCharsAt(ALL, 5000);
    expect(r?.to).toBeGreaterThanOrEqual(3);
    expect(r?.to).toBeLessThanOrEqual(4);
  });

  it("句间空格算进游标：第二句高亮起点要跳过空格", () => {
    // 边界 10000ms 两句都覆盖（判断用的是 >= start && <= end），
    // 先命中第一句，所以它显示整句念完 —— 这是对的，
    // 因为那一刻第一句确实刚说完。
    expect(spokenCharsAt(ALL, 10000)).toEqual({ from: 0, to: S1.text.length });
    // 越过边界后落到第二句，起点必须跳过句间那个空格
    const r = spokenCharsAt(ALL, 10001);
    expect(r?.from).toBe(S1.text.length + 1);
  });

  it("播放头落在句间空隙（没有句子覆盖）时不高亮", () => {
    // 构造一个有空隙的 transcript：句1 到 8000 结束，句2 从 12000 开始
    const gap = [
      { startMs: 0, endMs: 8000, text: "第一句" },
      { startMs: 12000, endMs: 20000, text: "第二句" }
    ];
    expect(spokenCharsAt(gap, 10000)).toBeNull();
  });

  it("标点不占字数（否则一个逗号会让高亮卡半天）", () => {
    const s = [{ startMs: 0, endMs: 10000, text: "你好，世界" }];
    // 5000ms = 2/4 有声字，即"你好"念完，逗号之后还没念
    const r = spokenCharsAt(s, 5000);
    expect(r?.to).toBe(2);
  });

  it("负播放时间不高亮（seek 到开头之前）", () => {
    expect(spokenCharsAt(ALL, -1)).toBeNull();
  });

  it("空句列表不会崩", () => {
    expect(spokenCharsAt([], 5000)).toBeNull();
  });

  it("零长句被跳过（ASR 偶尔写出 start=end）", () => {
    const s = [
      { startMs: 0, endMs: 0, text: "坏的" },
      { startMs: 0, endMs: 10000, text: "好的" }
    ];
    const r = spokenCharsAt(s, 5000);
    // 第一句 span=0 跳过，游标仍要累加（len+1），否则第二句偏移全错
    expect(r).not.toBeNull();
    expect(r?.from).toBe("坏的".length + 1);
  });
});