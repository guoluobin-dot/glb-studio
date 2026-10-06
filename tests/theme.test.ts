/**
 * 浅色主题的可读性验证。
 *
 * 为什么单独验：颜色是我按经验配的,而"看起来能看清"不等于 WCAG 达标。
 * 浅底上最容易翻车的是次要文字和语义色 —— 深色主题下调亮就够,
 * 浅底上同样的亮度会"发光"、边缘发虚。
 *
 * 这里算 WCAG 2.1 的对比度,正文要求 >= 7:1 (AAA),次要 >= 4.5:1 (AA)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 用 __dirname 定位，不写死绝对路径：
// 写死的话换机器/换目录就找不到文件，测试会以 ENOENT 失败，
// 而报错信息（找不到 "<GLB_NEW>/..."）完全指不到真正的原因。
const css = readFileSync(join(__dirname, "..", "src", "renderer", "src", "styles.css"), "utf8");

/** 取浅色主题块里的变量值 */
function lightVar(name: string): string {
  const block = css.slice(css.indexOf('[data-theme="light"]'));
  const m = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`浅色主题里没有 --color-${name}`);
  return m[1] as string;
}

/** 取深色主题（@theme 块）里的变量值 */
function darkVar(name: string): string {
  const block = css.slice(css.indexOf("@theme"), css.indexOf('[data-theme="light"]'));
  const m = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`深色主题里没有 --color-${name}`);
  return m[1] as string;
}

function hexToRgb(hex: string): number[] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) ?? 0,
    parseInt(h.slice(2, 4), 16) ?? 0,
    parseInt(h.slice(4, 6), 16) ?? 0
  ];
}

/** 相对亮度（WCAG 2.1 定义） */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = hexToRgb(hex).map((v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

describe("浅色主题对比度(WCAG)", () => {
  const ink = lightVar("ink");
  const panel = lightVar("panel");
  const panel2 = lightVar("panel-2");

  it("正文对各级背景 >= 7:1 (AAA)", () => {
    const fg = lightVar("fg");
    const pairs: Array<[string, string]> = [["ink", ink], ["panel", panel], ["panel-2", panel2]];
    for (const [name, bg] of pairs) {
      const c = contrast(fg, bg);
      expect(c, `fg on ${name} = ${r2(c)}`).toBeGreaterThanOrEqual(7);
    }
  });

  it("次要文字 >= 4.5:1 (AA)", () => {
    const names: string[] = ["mut", "mut-2"];
    for (const name of names) {
      const c = contrast(lightVar(name), panel);      expect(c, `${name} on panel = ${r2(c)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("语义色在浅底上 >= 4.5:1 (AA)", () => {
    // 这是浅色主题最容易翻车的地方:深色主题下调亮的 ok/warn/bad
    // 直接搬到浅底会"发光",边缘发虚。
    const names: string[] = ["ok", "warn", "bad", "info", "accent"];
    for (const name of names) {
      const c = contrast(lightVar(name), panel);
      expect(c, `${name} on panel = ${r2(c)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("品牌色在浅底上 >= 3:1 (图形/大字 UI 组件)", () => {
    const names: string[] = ["flame", "ember"];
    for (const name of names) {
      const c = contrast(lightVar(name), panel);
      expect(c, `${name} on panel = ${r2(c)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("边框与背景有可见差异(否则浅色下界面糊成一片)", () => {
    const c = contrast(lightVar("line"), panel);
    expect(c, `line vs panel = ${r2(c)}`).toBeGreaterThan(1.1);
  });

  it("层序关系保持:panel > panel-2 > panel-3", () => {
    // 深色是 ink(最暗) -> panel -> panel-2 -> panel-3(最亮)
    // 浅色要反过来,否则浮层看起来比底层还"沉"
    const lum = (h: string): number => luminance(h);
    expect(lum(panel)).toBeGreaterThan(lum(panel2));
    expect(lum(panel2)).toBeGreaterThan(lum(lightVar("panel-3")));
    expect(lum(panel)).toBeGreaterThan(lum(ink));
  });
});

describe("深色主题没被浅色覆盖污染", () => {
  it("深色变量保持原值", () => {
    // 浅色块写错变量名会导致深色也变浅 —— 那种 bug 极难从代码看出来
    expect(darkVar("ink")).toBe("#08090d");
    expect(darkVar("fg")).toBe("#f2f4f8");
  });

  it("深色正文对比度仍 >= 7:1", () => {
    expect(contrast(darkVar("fg"), darkVar("ink"))).toBeGreaterThanOrEqual(7);
  });
});

describe("主题实现", () => {
  it("必须用 CSS 变量而不是改组件(否则换主题要重编译)", () => {
    expect(css).toMatch(/\[data-theme="light"\]/);
    // 浅色块里必须覆盖全部 12 个语义色，少一个就会出现"半个界面还是深色"
    const block = css.slice(css.indexOf('[data-theme="light"]'), css.indexOf(":root"));
    const vars: string[] = ["ink", "panel", "panel-2", "panel-3", "line", "line-soft",
      "fg", "mut", "mut-2", "flame", "ember", "ok", "warn", "bad", "info", "accent"];
    for (const v of vars) {
      expect(block, `浅色主题缺 --color-${v}`).toMatch(new RegExp(`--color-${v}:`));
    }
  });

  it("必须声明 color-scheme(否则滚动条/表单控件仍是深色)", () => {
    expect(css.slice(css.indexOf('[data-theme="light"]'))).toMatch(/color-scheme:\s*light/);
    expect(css.slice(css.indexOf(":root"))).toMatch(/color-scheme:\s*dark/);
  });
});