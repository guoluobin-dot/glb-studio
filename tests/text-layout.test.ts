/**
 * 字幕/标题位置几何
 *
 * 这一块存在的全部理由：界面上的「位置示意」要和成片一致。
 * 两边公式一旦漂移，预览就成了骗人的东西 —— 用户照着预览调，
 * 出片发现位置不对，而这种问题他自己查不出来（预览"看着挺对"）。
 *
 * 所以下面每条断言都对着服务端 D:\GLB\Hermes\src\generator\index.js
 * 的实际公式写，不是对着"看起来合理"写。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { REF_HEIGHT, titleTopPx, captionBottomPx, layoutFor } from "../src/renderer/src/lib/text-layout";

const hermesGenerator = readFileSync("D:/GLB/Hermes/src/generator/index.js", "utf8");

describe("字幕 / 标题位置几何", () => {
  it("参照高度是 1920，和服务端一致", () => {
    expect(REF_HEIGHT).toBe(1920);
    expect(hermesGenerator).toContain("h0 / 1920");
  });

  describe("标题位置", () => {
    it("三个预设落在预期位置（1920 基准）", () => {
      // 服务端: top=20 / middle=h/2-40 / bottom=h-140
      expect(titleTopPx("top", 0)).toBe(20);
      expect(titleTopPx("middle", 0)).toBe(920);
      expect(titleTopPx("bottom", 0)).toBe(1780);
    });

    it("不选位置时按顶部算", () => {
      expect(titleTopPx(undefined, 0)).toBe(titleTopPx("top", 0));
    });

    it("微调是加法,正数往下", () => {
      expect(titleTopPx("top", 50)).toBe(70);
      expect(titleTopPx("bottom", -100)).toBe(1680);
    });

    it("bottom 必须真的贴近底部 —— 这条是被真实 bug 钉出来的", () => {
      /*
       * 回归：服务端原来写的是 (hRef - 140) * scale，scale 又是 hRef/1920，
       * 等于把画面高度缩放算了两次。720x1280 的素材算出来 y=760，
       * 落在画面 59% 高处，而界面上写着"底部"。
       */
      const h = 1280;
      const scale = h / REF_HEIGHT;
      const y = titleTopPx("bottom", 0) * scale;
      // 应在画面下方（>85%），而不是中间偏上
      expect(y / h).toBeGreaterThan(0.85);
      // 旧算法会给 0.59
      expect((h - 140) * scale / h).toBeLessThan(0.85);
    });

    it("middle 必须在画面中间附近", () => {
      const h = 1280;
      const scale = h / REF_HEIGHT;
      const ratio = (titleTopPx("middle", 0) * scale) / h;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.55);
    });
  });

  describe("字幕位置", () => {
    it("MarginV 是距画面底部,越大越靠上", () => {
      expect(captionBottomPx(0)).toBe(0);
      expect(captionBottomPx(60)).toBe(60);
      expect(captionBottomPx(300)).toBeGreaterThan(captionBottomPx(100));
    });

    it("没填时用默认 60", () => {
      expect(captionBottomPx(undefined)).toBe(60);
    });
  });

  describe("按画面高度缩放", () => {
    it("同一套 px 值在竖屏和横屏上比例不同但相对位置正确", () => {
      for (const h of [1920, 1280, 1080]) {
        const g = layoutFor(h, { marginV: 60, size: 28 }, { position: "bottom", size: 36 });
        // 字幕底边距 = 60 * h/1920
        expect(g.caption.bottomPct).toBeCloseTo(60 * (h / 1920), 5);
        // 字号同理
        expect(g.caption.fontPx).toBeCloseTo(28 * (h / 1920), 5);
        // 标题底部：距画面底部 140*scale，即距顶 h-140*scale
        expect(g.title.topPct).toBeCloseTo((h - 140 * (h / 1920)), 5);
      }
    });

    it("字号缺省时回落到默认值,不出现 0 或 NaN", () => {
      const g = layoutFor(1920, {}, {});
      expect(Number.isFinite(g.caption.fontPx)).toBe(true);
      expect(g.caption.fontPx).toBeGreaterThan(0);
      expect(Number.isFinite(g.title.fontPx)).toBe(true);
      expect(g.title.fontPx).toBeGreaterThan(0);
      expect(Number.isFinite(g.title.topPct)).toBe(true);
    });

    it("脏输入不能让预览崩", () => {
      expect(() =>
        layoutFor(1920,
          { marginV: Number.NaN, size: -5, outline: Number.NaN },
          { position: "乱写" as never, offsetY: Number.NaN })
      ).not.toThrow();
      const g = layoutFor(1920, { marginV: Number.NaN }, { position: "乱写" as never });
      expect(Number.isFinite(g.caption.bottomPct)).toBe(true);
      expect(Number.isFinite(g.title.topPct)).toBe(true);
    });
  });

  it("服务端公式改了，这里要跟着改（防止两边悄悄漂）", () => {
    // 服务端标题位置的三个分支
    expect(hermesGenerator).toMatch(/pos === 'bottom'\) return Math\.round\(hRef - 140 \* scale\)/);
    expect(hermesGenerator).toMatch(/pos === 'middle'\) return Math\.round\(hRef \/ 2 - 40 \* scale\)/);
    // 不能再出现把整个画面高度又乘一遍的写法。
    // 只看代码行 —— 我自己在注释里复述了这个错误公式来说明它的危害，
    // 全文件搜索会把注释也匹配上，断言就变成"注释写了就红"。
    const codeLines = hermesGenerator
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    expect(codeLines).not.toMatch(/\(hRef - 140\) \* scale/);
    expect(codeLines).not.toMatch(/\(hRef \/ 2 - 40\) \* scale/);
    // 字幕 MarginV 同样按画面高度缩放
    expect(hermesGenerator).toMatch(/MarginV=\$\{Math\.round\(Number\(cs\.marginV\) \* \(h0 \/ 1920 \|\| 1\)\)\}/);
  });

  it("预览必须和控件并排，不能叠在控件上方", () => {
    /*
     * 回归：预览原来在整个面板上方，控件在下方。
     * 结果拖"位置"滑块时预览已经滚出屏幕，调完要往上滑一屏才看得到 ——
     * 那就等于没有预览，用户还是不知道字落在哪儿。
     * 反馈"放在这个位置不是很好调"说的正是这个。
     *
     * 判据：预览容器和两个样式面板必须是**兄弟**（flex 的左右两列），
     * 而且预览那一列要 sticky，否则控件一长预览照样会被顶走。
     */
    const src = readFileSync("D:/GLB-NEW/src/renderer/src/components/FontStylePanel.tsx", "utf8");

    // 左右分栏
    expect(src).toMatch(/<div className="flex items-start gap-3">/);
    // 预览列固定宽度 + 粘在顶部
    expect(src).toMatch(/w-\[176px\] shrink-0 self-sticky top-0/);
    // 控件列占据剩余空间
    expect(src).toMatch(/min-w-0 flex-1/);

    // 预览不许再出现在两个 section 之前（那正是原来"叠在上方"的写法）
    const previewAt = src.indexOf("<TextLayoutPreview");
    const captionAt = src.indexOf("字幕样式");
    expect(previewAt).toBeGreaterThan(-1);
    expect(captionAt).toBeGreaterThan(-1);
    // 两者必须在同一个 flex 容器里：预览之后紧跟控件列的开标签
    // （控件列的 class 是 "grid min-w-0 flex-1 ..."，grid 在前）
    expect(src.slice(previewAt, previewAt + 400)).toMatch(
      /<\/div>\s*<div className="grid min-w-0 flex-1/
    );
  });
});