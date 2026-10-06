/**
 * 文字精修的核心算法测试
 *
 * 覆盖三件最容易出错、错了最难查的事：
 *   1. 选区偏移怎么映射回时间（跨句、边界、越界）
 *   2. 删除标记怎么渲染（必须保留字符位置）
 *   3. 反复删 + 撤销后位置会不会漂
 *
 * 这些逻辑以前是内联在组件里的，没法测；抽到这里是因为
 * "删了两次之后位置全错"这种 bug 只有自动化测试能拦住。
 */
import { describe, it, expect } from "vitest";

const PUNCT = /[，。！？、；：,.!?;]/;

/** 与 TextCutter.estimateMs 保持一致（逐句插值 + 标点折算） */
function estimateMs(sentences: Array<{ startMs: number; endMs: number; text: string }>, text: string, durMs: number, ranges: Array<{ from: number; to: number }>): number {
  if (!text || !sentences.length) return 0;
  const inSeg = sentences
    .map((s) => ({ ...s, startMs: Math.max(0, s.startMs), endMs: Math.min(durMs, s.endMs) }))
    .filter((s) => s.endMs > s.startMs);
  if (!inSeg.length) return 0;
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

/** 与 TextCutter.splitRuns 保持一致 */
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

/** 与 TextCutter.mergeMarks 保持一致 */
function mergeMarks(list: Array<{ seg: number; from: number; to: number }>): Array<{ seg: number; from: number; to: number }> {
  const bySeg = new Map<number, Array<{ from: number; to: number }>>();
  for (const m of list) {
    if (m.to <= m.from) continue;
    if (!bySeg.has(m.seg)) bySeg.set(m.seg, []);
    bySeg.get(m.seg)!.push({ from: m.from, to: m.to });
  }
  const out: Array<{ seg: number; from: number; to: number }> = [];
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

/**
 * 故意写成"取出来可能越界"的形状。
 *
 * 真实数据只有 1 句、3 句，测试却要分别引用第 0、1、2 句 ——
 * 数组下标在 TS 里是 `T | undefined`，所以下面统一用 `s0/s1/s2` 别名，
 * 免得每处都写 `!`。非空断言堆一堆反而掩盖了真正要测的东西。
 */
/**
 * 三句，每句正好 10 秒。
 *
 * 直接写成对象而不是从数组里取第 0/1/2 个：
 * 项目开了 noUncheckedIndexedAccess，`SENTENCES[0]` 类型是 `T | undefined`，
 * 每次引用都要 `!`，断言堆多了反而淹没真正在测的东西。
 */
const s0 = { startMs: 0, endMs: 10000, text: "同学们欢迎大家来到我的直播间" };
const s1 = { startMs: 10000, endMs: 20000, text: "今天我们来讲一下和弦的构成" };
const s2 = { startMs: 20000, endMs: 30000, text: "首先按住这个根音" };
const SENTENCES = [s0, s1, s2];

/** 权重数组前 n 项之和 —— 与 ReviewTextCutter.cum 一致 */
function cum(weights: number[], n: number): number {
  let s = 0;
  for (let i = 0; i < n && i < weights.length; i++) s += weights[i] ?? 0;
  return s;
}

/**
 * 单字时间 —— 与 ReviewTextCutter 挂到 data-t 上的算法一致。
 *
 * 为什么要单独测它：点字跳播全靠这个值。
 * 算错的话用户点第 10 个字、画面却跳到第 3 个字的位置，
 * 而且不会报错（只是"跳得不准"），极难被发现。
 */
function charTime(sentence: { startMs: number; endMs: number; text: string }, k: number): number {
  const span = Math.max(0.001, sentence.endMs - sentence.startMs);
  const weights = [...sentence.text].map((c) => (PUNCT.test(c) ? 0.25 : 1));
  const acc = weights.reduce((a, b) => a + b, 0);
  return sentence.startMs + span * (cum(weights, k) / Math.max(0.001, acc));
}
const TEXT = SENTENCES.map((s) => s.text).join(" ");

describe("文字精修 · 选区映射时长", () => {
  it("删整段就是整段时长", () => {
    expect(estimateMs(SENTENCES, TEXT, 30000, [{ from: 0, to: TEXT.length }])).toBe(30000);
  });

  it("删首句 = 该句 10 秒，不是按字数摊到 30 秒里的 1/3", () => {
    // 这条是回归测试：曾经用"整段时长 × 字数比例"算，
    // 首句 13 字 / 全段 39 字 × 30s ≈ 10s 恰好接近，但换一组数据就差很远。
    const got = estimateMs(SENTENCES, TEXT, 30000, [{ from: 0, to: s0.text.length }]);
    expect(got).toBe(10000);
  });

  it("逐句插值：删第二句的后半段，时长是那半句的一半", () => {
    // 第二句在整段文本里的起点：第一句长度 + 句间那个空格
    const secondStart = s0.text.length + 1;
    const secondEnd = secondStart + s1.text.length;
    // 整句 = 10 秒
    expect(estimateMs(SENTENCES, TEXT, 30000, [{ from: secondStart, to: secondEnd }])).toBe(10000);
    // 后半句 ≈ 5 秒（比例插值，允许插值误差）
    const got = estimateMs(SENTENCES, TEXT, 30000, [
      { from: secondStart + Math.floor(s1.text.length / 2), to: secondEnd }
    ]);
    expect(got).toBeGreaterThan(4500);
    expect(got).toBeLessThan(5500);
  });

  it("跨句选区：横跨三句就该累加三句的时长", () => {
    const total = TEXT.length;
    const got = estimateMs(SENTENCES, TEXT, 30000, [{ from: 0, to: total }]);
    expect(got).toBe(30000);
  });

  it("句间那个空格算进偏移，所以第二句起手能准确定位", () => {
    const secondStart = s0.text.length + 1;
    const got = estimateMs(SENTENCES, TEXT, 30000, [
      { from: secondStart, to: secondStart + s1.text.length }
    ]);
    expect(got).toBe(10000);
  });

  it("越界选区被夹住，不会算出负数或超过整段", () => {
    const got = estimateMs(SENTENCES, TEXT, 30000, [{ from: -50, to: 99999 }]);
    expect(got).toBe(30000);
    expect(got).toBeGreaterThan(0);
  });

  it("空选区不产生时长", () => {
    expect(estimateMs(SENTENCES, TEXT, 30000, [{ from: 5, to: 5 }])).toBe(0);
  });

  it("零长句（ASR 偶尔写出 start=end）不会让整段时长变成 0", () => {
    const s = [{ startMs: 0, endMs: 0, text: "开头" }, { startMs: 0, endMs: 10000, text: "后面的内容" }];
    const t = s.map((x) => x.text).join(" ");
    expect(estimateMs(s, t, 10000, [{ from: 0, to: t.length }])).toBe(10000);
  });

  it("标点不占时长：删 '你好' 比删 '好，世界' 短", () => {
    // "你好，世界"：你好(2 个有声字) + 逗号(0.25) + 世界(2)
    // 有声字数 4，所以删 "你好"=5000ms，删 "好，世界"=8125ms。
    // 如果把逗号当整字算，两者会算成一样，逗号就被当成了整整 2.5 秒的停顿。
    const t = "你好，世界";
    const s = [{ startMs: 0, endMs: 10000, text: t }];
    expect(estimateMs(s, t, 10000, [{ from: 0, to: 2 }])).toBe(5000);
    expect(estimateMs(s, t, 10000, [{ from: 1, to: 5 }])).toBe(8125);
  });

  it("只删一个逗号，时长接近 0（不该凭空剪掉一大截）", () => {
    const t = "你好，世界";
    const got = estimateMs([{ startMs: 0, endMs: 10000, text: t }], t, 10000, [{ from: 2, to: 3 }]);
    expect(got).toBeLessThan(3000);
  });
});

describe("文字精修 · 删除标记的字符位置不能漂", () => {
  it("删除只加删除线，字符总量不变（位置漂移的根源）", () => {
    const runs = splitRuns("同学们欢迎大家", [{ from: 0, to: 3 }]);
    const kept = runs.filter((r) => !r.del);
    const cut = runs.filter((r) => r.del);
    expect(runs.map((r) => r.t).join("")).toBe("同学们欢迎大家");
    expect(runs.length).toBe(2);
    expect(kept).toHaveLength(1);
    expect(cut).toHaveLength(1);
    expect(cut[0]?.del).toBe(true);
    expect(kept[0]?.del).toBe(false);
  });

  it("删两次，第二次的位置仍按原文算（不是按删后的文本）", () => {
    const text = "同学们欢迎大家来到直播间";
    // 删"同学"（0~2）和"来到"（7~9）
    const marks = mergeMarks([
      { seg: 0, from: 0, to: 2 },
      { seg: 0, from: 7, to: 9 }
    ]);
    expect(marks).toHaveLength(2);
    // 关键：第二处的位置仍按原文算（7~9），
    // 而不是删掉前 2 字之后重新数的 5~7 —— 后者会剪错地方且完全不报错。
    const runs = splitRuns(text, marks);
    expect(runs.map((r) => r.t).join("")).toBe(text);
    expect(runs.filter((r) => r.del).map((r) => r.t)).toEqual(["同学", "来到"]);
  });

  it("撤销后能还原成没删过的原文", () => {
    const text = "同学们欢迎大家";
    const before = splitRuns(text, [{ from: 0, to: 3 }]);
    const after = splitRuns(text, []);
    expect(after.map((r) => r.t).join("")).toBe(text);
    expect(after.every((r) => !r.del)).toBe(true);
    expect(before.some((r) => r.del)).toBe(true);
  });

  it("重叠的删除区间会合并，不会产生嵌套", () => {
    const marks = mergeMarks([
      { seg: 0, from: 0, to: 5 },
      { seg: 0, from: 3, to: 8 }
    ]);
    expect(marks).toEqual([{ seg: 0, from: 0, to: 8 }]);
  });

  it("相邻的删除区间会合并", () => {
    const marks = mergeMarks([
      { seg: 0, from: 0, to: 5 },
      { seg: 0, from: 5, to: 8 }
    ]);
    expect(marks).toEqual([{ seg: 0, from: 0, to: 8 }]);
  });

  it("不同段的删除互不影响，各自单独合并", () => {
    const marks = mergeMarks([
      { seg: 1, from: 0, to: 3 },
      { seg: 0, from: 0, to: 3 },
      { seg: 1, from: 2, to: 6 }
    ]);
    expect(marks).toEqual([
      { seg: 0, from: 0, to: 3 },
      { seg: 1, from: 0, to: 6 }
    ]);
  });

  it("跨段框选拆成两段标记后，每段时长各自成立", () => {
    // 用户框选"第一段结尾 + 第二段开头"这一整句欢迎语
    const marks = mergeMarks([
      { seg: 0, from: 8, to: 13 },
      { seg: 1, from: 0, to: 5 }
    ]);
    const segA = estimateMs(SENTENCES, TEXT, 30000, marks.filter((m) => m.seg === 0));
    const segB = estimateMs(SENTENCES, TEXT, 30000, marks.filter((m) => m.seg === 1));
    expect(segA).toBeGreaterThan(0);
    expect(segB).toBeGreaterThan(0);
    expect(segA + segB).toBeLessThanOrEqual(30000);
  });

  it("空标记被忽略，不会产生 {from: to} 这种空区间", () => {
    expect(mergeMarks([{ seg: 0, from: 5, to: 5 }])).toEqual([]);
  });

  it("删光整段后时长仍等于整段长度（后端会拒，但界面不能显示 0）", () => {
    expect(estimateMs(SENTENCES, TEXT, 30000, [{ from: 0, to: TEXT.length }])).toBe(30000);
  });
});

describe("点字跳播 · 单字时间必须落在句内且单调", () => {
  it("首字 = 句首，尾字 ≈ 句尾", () => {
    expect(charTime(s0, 0)).toBeCloseTo(0, 3);
    const last = s0.text.length - 1;
    expect(charTime(s0, last)).toBeGreaterThan(9000);
    expect(charTime(s0, last)).toBeLessThanOrEqual(10000);
  });

  it("时间随字序单调递增（点后面的字不能跳回前面）", () => {
    let prev = -1;
    for (let k = 0; k < s0.text.length; k++) {
      const t = charTime(s0, k);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("每个字的时间都落在本句范围内（越界会导致跳到别的段）", () => {
    for (const s of SENTENCES) {
      for (let k = 0; k < s.text.length; k++) {
        const t = charTime(s, k);
        expect(t).toBeGreaterThanOrEqual(s.startMs - 0.001);
        expect(t).toBeLessThanOrEqual(s.endMs + 0.001);
      }
    }
  });

  it("标点不占时长：逗号前后的字间隔不会突然拉大", () => {
    // "你好，世界"：逗号权重 0.25，所以"好"→"世"的间隔 ≈ 1.25 字，不是 2 字
    const s = { startMs: 0, endMs: 10000, text: "你好，世界" };
    const gapNormal = charTime(s, 1) - charTime(s, 0);
    const gapAcrossPunct = charTime(s, 3) - charTime(s, 1);
    // 跨标点的间隔最多是普通间隔的 1.5 倍（多出 0.25 的标点权重）
    expect(gapAcrossPunct).toBeLessThanOrEqual(gapNormal * 1.5);
  });

  it("零长句（ASR 偶尔 start=end）不会算出 NaN", () => {
    const bad = { startMs: 5000, endMs: 5000, text: "abc" };
    const t = charTime(bad, 1);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(5000);
  });

  it("第 3 句的时间要接着第 2 句（跨句不重叠、不倒退）", () => {
    expect(charTime(s2, 0)).toBeGreaterThanOrEqual(s1.endMs);
    expect(charTime(s2, 0)).toBeLessThan(s2.endMs);
  });
});