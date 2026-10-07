/**
 * JSX 注释泄漏检测
 *
 * 在 JSX children 位置裸写的 /* ... *\/ 不是注释，是字面文本，
 * 会被原样渲染到界面上。
 *
 * 真实踩过：爆款记忆库底部栏有一段说明
 *   「文案为什么改成这样（2026-10-06）：原来叫…」写成裸块注释，
 * 结果整段文字出现在 footer 里，占掉全部宽度，
 * 旁边 4 个按钮被 flex 压成每行一个字 —— "返回主界面"竖着排。
 * 编译不报错、typecheck 也过，只有看界面才发现。
 *
 * 判据不能是「JsxText 里有中文」—— 正常界面文案也是 JsxText
 * （<span>模式</span>），那样会几百条误报。
 * 真正的特征是文本里留着注释标记 /* 或 *\/ ：泄漏的注释不会被去掉标记。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const RENDERER = "src/renderer/src";

/** 收集所有 .tsx（JSX 只可能在这些文件里） */
const tsxFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  };
  walk(RENDERER);
  return out;
};

/** JsxText 里出现注释标记 = 泄漏。正常中文文案不会带这两个符号 */
const COMMENT_MARKER = /\/\*|\*\//;

const leaksIn = (text: string, file: string): string[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      if (COMMENT_MARKER.test(raw)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${file}:${line + 1}  ${JSON.stringify(raw.trim().slice(0, 70))}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe("JSX 注释不能泄漏成界面文字", () => {
  const files = tsxFiles();

  it("扫得到 tsx 文件（否则后面的用例是假绿）", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("renderer 里没有泄漏的注释", () => {
    const leaks = files.flatMap((f) => leaksIn(readFileSync(f, "utf8"), f));
    expect(
      leaks,
      "这些注释被当文字渲染了：\n" +
        leaks.join("\n") +
        "\n\n在 JSX children 里裸写的块注释是字面文本，要写成花括号包起来的 JSX 注释"
    ).toEqual([]);
  });

  it("正常中文文案不算泄漏（检测器别过火）", () => {
    const good = `
      export const Demo = () => (
        <div>
          <span>模式</span>
          <button>把已分析结果写入记忆库</button>
        </div>
      );
    `;
    expect(leaksIn(good, "demo.tsx")).toEqual([]);
  });

  it("能抓出裸块注释（拿真实写法做对照，确保检测器本身没坏）", () => {
    const bad = `
      export const Demo = () => (
        <div>
          /* 这段说明会变成界面上的文字 */
          <span>正常</span>
        </div>
      );
    `;
    const found = leaksIn(bad, "demo.tsx");
    expect(found.length, "裸块注释必须被抓出来").toBeGreaterThan(0);
    expect(found[0]).toContain("这段说明会变成界面上的文字");
  });

  it("花括号注释不会被误判", () => {
    const good = `
      export const Demo = () => (
        <div>
          {/* 这段说明是注释，不会显示 */}
          <span>正常</span>
        </div>
      );
    `;
    expect(leaksIn(good, "demo.tsx")).toEqual([]);
  });
});

describe("JSX 开闭标签必须配平", () => {
  // 挪按钮位置时漏掉一个 </div> 就是这么发生的。
  // 漏了以后编译直接报错还算好；真正难查的是「多删了一个闭合标签，
  // 结果把后面的兄弟节点一起吞进上一个 div」—— 界面不报错，
  // 只是某个区域莫名其妙变高或者点不动。
  //
  // 数 JsxOpeningElement 对 JsxClosingElement，不能数 JsxElement：
  // 自闭合元素（<X />）没有闭合标签，混进来必然对不上。
  const files = tsxFiles();

  const balance = (file: string): { open: number; close: number; errors: number } => {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let open = 0;
    let close = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node)) open++;
      if (ts.isJsxClosingElement(node)) close++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    /* 语法错误走公开 API。
       原来读的是 sf.parseDiagnostics —— 那是 TS 的内部字段，压根没进 .d.ts，
       所以类型检查必报 TS2339；而且它是内部实现，改版就可能改名或挪走。
       transpileModule 的 reportDiagnostics 返回的正是纯语法诊断，语义等价且是公开契约。 */
    const errors =
      ts.transpileModule(src, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          jsx: ts.JsxEmit.Preserve,
          target: ts.ScriptTarget.Latest,
          module: ts.ModuleKind.ESNext
        }
      }).diagnostics?.length ?? 0;
    return { open, close, errors };
  };

  it("renderer 里每个 tsx 都配平且没有语法错误", () => {
    const bad: string[] = [];
    for (const f of files) {
      const r = balance(f);
      if (r.open !== r.close || r.errors > 0) {
        bad.push(`${f}  开 ${r.open} / 闭 ${r.close} / 语法错 ${r.errors}`);
      }
    }
    expect(bad, "这些文件的 JSX 开闭不配平").toEqual([]);
  });
});