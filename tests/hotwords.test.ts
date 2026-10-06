/**
 * 热词替换的回归测试
 *
 * 守的是最容易出、又最难发现的分裂：
 * 渲染层和 Hermes 各有一份替换逻辑，行为稍有差异就会出现
 * "审阅台里字改对了、字幕里还是错的" —— 而两边各自看起来都正常。
 *
 * 另外锁住两个真实会发生的边界：
 *   - 长规则必须先替，否则短规则吃掉长规则前缀
 *   - 已经渲染好的成片不会变（这条是产品事实，UI 必须如实说）
 *
 * @author 郭洛斌
 */
import { describe, it, expect } from "vitest";
import { applyHotwords, applyHotwordsToTranscript, countHotwordHits } from "../src/shared/hotwords";

describe("热词替换 · 基本行为", () => {
  it("改掉听错的词", () => {
    expect(applyHotwords("我是猪老师", [{ from: "猪老师", to: "朱老师" }])).toBe("我是朱老师");
  });

  it("同一句里出现多次全都改", () => {
    expect(applyHotwords("猪老师讲课，猪老师示范", [{ from: "猪老师", to: "朱老师" }])).toBe(
      "朱老师讲课，朱老师示范"
    );
  });

  it("没有规则时原样返回（不做无谓的字符串重建）", () => {
    expect(applyHotwords("原文", [])).toBe("原文");
  });

  it("空文本不炸", () => {
    expect(applyHotwords("", [{ from: "a", to: "b" }])).toBe("");
  });
});

describe("热词替换 · 必须防的坑", () => {
  it("长规则先替：短规则不能把长词劈开", () => {
    /*
     * 两条规则互相"吃掉"对方：
     *   「朱老师老师」→「朱老师」
     *   「朱老师」→「朱」
     *
     * 先替长的：长词变短之后，短规则仍然命中它，结果是「朱」。
     * 先替短的：长词被劈成「朱」+「老师」，长规则再也匹配不上，
     * 结果是「朱老师」—— 而用户写那条长规则时想要的是前者。
     *
     * 所以调用方给的顺序必须不影响结果。
     */
    const rules = [
      { from: "朱老师", to: "朱" },
      { from: "朱老师老师", to: "朱老师" }
    ];
    expect(applyHotwords("朱老师老师", rules)).toBe("朱");
    // 顺序颠倒也必须得到同一个答案
    expect(applyHotwords("朱老师老师", [...rules].reverse())).toBe("朱");
  });

  it("长规则先替的真实场景：短规则不会再吃掉长规则的结果", () => {
    /*
     * 「唱得很高很清楚」→「唱得很清楚」  （长，用户想要的）
     * 「唱得很高」→「高」              （短，另一条规则）
     *
     * 先替长的 → 变成「唱得很清楚」，它不含「唱得很高」，短规则不命中 → 保持。
     * 先替短的 → 「唱得很高很清楚」被劈成「高很清楚」，长规则已匹配不上。
     *
     * 所以两种顺序的结果必须一致，且等于长规则的结果。
     */
    const rules = [
      { from: "唱得很高", to: "高" },
      { from: "唱得很高很清楚", to: "唱得很清楚" }
    ];
    expect(applyHotwords("唱得很高很清楚", rules)).toBe("唱得很清楚");
    expect(applyHotwords("唱得很高很清楚", [...rules].reverse())).toBe("唱得很清楚");
  });

  it("跳过空规则（用户手滑很容易建出来）", () => {
    expect(applyHotwords("原文", [{ from: "", to: "x" }])).toBe("原文");
  });

  it("跳过改前改后一样的规则", () => {
    expect(applyHotwords("原文", [{ from: "原", to: "原" }])).toBe("原文");
  });

  it("空字符串也能替换（虽然实际不会有，但不该崩）", () => {
    expect(applyHotwords("a-b", [{ from: "-", to: "" }])).toBe("ab");
  });
});

describe("热词替换 · 逐句稿", () => {
  const t = {
    segments: [
      { text: "我是猪老师", startSec: 0 },
      { text: "猪老师今天讲猪老师", startSec: 5 }
    ]
  };

  it("逐句都改", () => {
    const out = applyHotwordsToTranscript(t, [{ from: "猪老师", to: "朱老师" }]);
    expect((out?.segments ?? []).map((s) => s.text)).toEqual(["我是朱老师", "朱老师今天讲朱老师"]);
  });

  it("时间戳一个字都不动（字幕对齐靠它）", () => {
    const out = applyHotwordsToTranscript(t, [{ from: "猪老师", to: "朱老师" }]);
    expect((out?.segments ?? []).map((s) => s.startSec)).toEqual([0, 5]);
  });

  it("字数变了也不影响时间戳（'吊'→'钓'这种）", () => {
    const short = { segments: [{ text: "把这个吊起来", startSec: 3 }] };
    const out = applyHotwordsToTranscript(short, [{ from: "吊", to: "钓竿" }]);
    expect(out?.segments[0]?.text).toBe("把这个钓竿起来");
    expect(out?.segments[0]?.startSec).toBe(3);
  });

  it("空逐句稿安全返回", () => {
    expect(applyHotwordsToTranscript(null, [{ from: "a", to: "b" }])).toBe(null);
    expect(applyHotwordsToTranscript({ segments: [] }, [{ from: "a", to: "b" }])).toEqual({ segments: [] });
  });

  it("没有规则时返回原对象（引用不变，React 不会多余重渲染）", () => {
    expect(applyHotwordsToTranscript(t, [])).toBe(t);
  });
});

describe("热词命中统计", () => {
  it("数出出现次数", () => {
    expect(countHotwordHits("猪老师，猪老师", "猪老师")).toBe(2);
  });

  it("没出现是 0", () => {
    expect(countHotwordHits("别的内容", "猪老师")).toBe(0);
  });

  it("空输入不炸", () => {
    expect(countHotwordHits("", "x")).toBe(0);
    expect(countHotwordHits("abc", "")).toBe(0);
  });
});