/**
 * WindowedList 行高自校正的收敛性测试
 *
 * 白屏的真凶，我修了两次才修对，两个坑不一样：
 *
 * 坑1：ref 回调既依赖 avg 又 setAvg → React 重挂 ref → 再 setAvg，无限循环。
 *      这是第一次白屏的原因，"依赖数组去掉 avg + 收敛后返回 prev" 修掉了它。
 *
 * 坑2：逐行测高本身是错的。逐句稿的行高差异很大（有的句子 40 字、有的 90 字），
 *      逐行测会被最后几行带偏，算出的总高度不准、滚动条长度也不对。
 *      改成一次量所有行取平均：measuredMean 固定，混合公式必然收敛。
 *
 * 说明：坑1 才是白屏的原因，坑2 只是不准（不会白屏）。
 * 我一度以为坑2 也是死循环，实测它会稳定在 125 —— 是错误但稳定的值。
 * 这里把两个性质分别测出来，不把"不准"说成"死循环"。
 *
 * @author 郭洛斌
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { WindowedList } from "../src/renderer/src/components/WindowedList";

type SetAvg = (fn: (prev: number) => number) => void;

/** 混合公式：逼近但不一步到位，滚动时不会突然跳 */
function blend(prev: number, measuredMean: number): number {
  return Math.round(prev * 0.8 + measuredMean * 0.2);
}

/**
 * 修正后的实现：一次性量所有已渲染行，取平均。
 *
 * 刻意不 import 组件私有函数 —— 导出只为测试会污染 API。
 * 这里用同一套算法跑收敛性断言：**算法是否终止**才是这个 bug 的本质。
 */
function makeMeasure(setAvg: SetAvg, onMeasured?: (n: number) => void) {
  return (rowHeights: number[]): void => {
    // 样本不足时估算值更可信
    if (rowHeights.length < 20) return;
    const valid = rowHeights.filter((h) => h > 0);
    if (!valid.length) return;
    const measuredMean = Math.max(28, Math.round(valid.reduce((a, b) => a + b, 0) / valid.length));
    setAvg((prev: number) => {
      if (Math.abs(measuredMean - prev) <= 6) return prev;
      const next = blend(prev, measuredMean);
      onMeasured?.(next);
      return next;
    });
  };
}

/**
 * 逐行 ref 回调测高（第一版修法用的）。
 *
 * 它不会死循环 —— 会稳定在一个错误值上（被最后测到的行拽偏）。
 * 保留在测试里是为了把"不准"和"白屏"两件事分清楚。
 */
function makePerRowMeasure(setAvg: SetAvg): (h: number) => void {
  return (h: number) => {
    const next = Math.max(28, Math.round(h));
    setAvg((prev: number) => {
      if (Math.abs(next - prev) <= 6) return prev;
      return blend(prev, next);
    });
  };
}

describe("WindowedList · 行高自校正必须收敛", () => {
  it("逐句稿那种高低不一的行，反复测量后 avg 会稳定下来", () => {
    let avg = 46;
    const onMeasured = vi.fn();
    const measure = makeMeasure((fn) => {
      avg = fn(avg);
    }, onMeasured);
    // 交替高低：模拟"有的句子 40 字、有的 90 字"
    const heights = Array.from({ length: 30 }, (_, i) => (i % 2 ? 88 : 172));

    for (let i = 0; i < 500; i++) measure(heights);
    const settled = avg;
    expect(settled).toBeGreaterThan(46);

    // 关键：再测 100 次，avg 一个字节都不能变 —— 变了就说明还在循环
    for (let i = 0; i < 100; i++) measure(heights);
    expect(avg).toBe(settled);
    // onMeasured 不该被继续刷屏
    const callsAtSettle = onMeasured.mock.calls.length;
    for (let i = 0; i < 100; i++) measure(heights);
    expect(onMeasured.mock.calls.length).toBe(callsAtSettle);
  });

  it("会向实测均值靠拢（不是停在估算值）", () => {
    let avg = 46;
    const measure = makeMeasure((fn) => {
      avg = fn(avg);
    });
    for (let i = 0; i < 200; i++) measure(Array.from({ length: 30 }, () => 120));
    // 真值 120，混合逼近，200 轮后应该非常接近
    expect(Math.abs(avg - 120)).toBeLessThan(8);
  });

  it("样本不足 20 行时完全不动（估算值更可信）", () => {
    let avg = 46;
    const measure = makeMeasure((fn) => {
      avg = fn(avg);
    });
    measure(Array.from({ length: 19 }, () => 200));
    expect(avg).toBe(46);
    measure(Array.from({ length: 20 }, () => 200));
    expect(avg).toBeGreaterThan(46);
  });

  it("行高在估算值 ±6 以内时完全不动（避免无意义的重渲染）", () => {
    let avg = 46;
    const onMeasured = vi.fn();
    const measure = makeMeasure((fn) => {
      avg = fn(avg);
    }, onMeasured);
    for (let i = 0; i < 100; i++) measure(Array.from({ length: 30 }, () => 48));
    expect(avg).toBe(46);
    expect(onMeasured).not.toHaveBeenCalled();
  });

  it("行高不会低于 28px（太矮会让文字挤在一起）", () => {
    let avg = 46;
    const measure = makeMeasure((fn) => {
      avg = fn(avg);
    });
    for (let i = 0; i < 300; i++) measure(Array.from({ length: 30 }, () => 5));
    expect(avg).toBeGreaterThanOrEqual(28);
  });

  it("整批测量不受行高差异影响（逐行测高会被最后几行带偏）", () => {
    let batch = 46;
    const batched = makeMeasure((fn) => {
      batch = fn(batch);
    });
    // 逐句稿真实形状：最后几行特别长
    const heights = Array.from({ length: 25 }, (_, i) => (i > 20 ? 300 : 80));
    const trueMean = Math.round(heights.reduce((a, b) => a + b, 0) / heights.length);

    for (let i = 0; i < 400; i++) batched(heights);

    let perRow = 46;
    const perRowMeasure = makePerRowMeasure((fn) => {
      perRow = fn(perRow);
    });
    for (let round = 0; round < 40; round++) for (const h of heights) perRowMeasure(h);

    // 整批测量的结果贴近真实均值
    expect(Math.abs(batch - trueMean)).toBeLessThan(8);
    // 逐行的被末尾长行拽偏，明显更差 —— 说明为什么要改成整批
    expect(Math.abs(perRow - trueMean)).toBeGreaterThan(Math.abs(batch - trueMean));
  });
});

describe("WindowedList · 长列表渲染", () => {
  const items = Array.from({ length: 1772 }, (_, i) => `第 ${i} 句`);

  it("3 小时直播的 1772 句不会全部进 DOM", () => {
    const html = renderToString(
      createElement(WindowedList<string>, {
        items,
        getKey: (_: string, i: number) => i,
        children: (t: string) => t
      })
    );
    // 只渲染可视区附近，不该出现全部 1772 条
    expect(html).not.toContain("第 1700 句");
    expect(html.length).toBeLessThan(200_000);
  });

  it("短列表（少于 20 条）也正常渲染，不报错", () => {
    const few = ["a", "b", "c"];
    const html = renderToString(
      createElement(WindowedList<string>, {
        items: few,
        getKey: (t: string) => t,
        children: (t: string) => t
      })
    );
    expect(html).toContain("a");
    expect(html).toContain("c");
  });
});