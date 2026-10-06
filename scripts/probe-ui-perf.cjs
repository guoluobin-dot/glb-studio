/**
 * probe-ui-perf：UI 渲染性能静态体检
 *
 * 目的是回答一个问题：**哪些组件在列表变大时会拖垮渲染**。
 *
 * 【真实教训，写在这里防止重犯】
 * 原来这个脚本直接 grep "setTick"。修复之后那个词只剩在
 * "解释以前怎么做的"注释里，脚本于是仍然报
 * "每秒重渲染整个工作区" —— 假阳性。
 *
 * 假阳性比漏报更糟：会让人以为修复没生效，反复排查不存在的问题。
 * 所以这里有两条硬规矩：
 *   1) 判断前先 stripComments，注释里的词不算代码
 *   2) 按组件定位，不按文件。ElapsedBadge 和 Workbench 在同一个文件里，
 *      但前者 29 行、后者 1465 行，代价天差地别 ——
 *      "文件里有 setTick"根本说明不了任何事
 *
 * 用法：node scripts/probe-ui-perf.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "renderer", "src");

/* ── 1. 剥注释：注释里的词不是代码 ── */

/**
 * 去掉 // 和 /* *\/ 里的内容，保留行号（用空串替换，不删行）。
 * 不这么做的话，解释修复历史的注释会被当成代码本身。
 */
function stripComments(code) {
  return code
    // 块注释
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    // 行注释（注意别把 URL 里的 // 当注释）
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - 1));
}

/* ── 2. 按组件定位：返回每个组件的起止行 ── */

/**
 * 找出从 \`name\` 开始的那个组件/函数的源码跨度。
 * 找错了就等于什么都没测 —— ElapsedBadge 只有 29 行，
 * Workbench 有 1465 行，把它们混在一起报"这个文件有性能问题"毫无意义。
 */
function componentSpan(code, name) {
  const re = new RegExp(
    `(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=|${name}\\s*:\\s*(?:React\\.)?(?:memo|forwardRef))`,
    "m"
  );
  const m = re.exec(code);
  if (!m) return null;

  const startLine = code.slice(0, m.index).split("\n").length;
  // 粗略终点：往下找到下一个同缩进的顶层声明，或 +N 行封顶
  const after = code.slice(m.index);
  const nextTop = after.slice(1).search(/\n(?=(?:export\s+)?(?:function|const|let|type|interface|class)\s)/);
  const span = nextTop > 0 ? nextTop : Math.min(after.length, 4000);

  return {
    name,
    startLine,
    endLine: startLine + after.slice(0, span).split("\n").length,
    code: after.slice(0, span),
    lines: after.slice(0, span).split("\n").length,
  };
}

/** 列出源码里所有已知的关注组件 */
const WATCH = ["ElapsedBadge", "Workbench", "ReviewPanel", "SentenceEditor", "WindowedList"];

function ownerComponent(fileCode, fileName) {
  const found = [];
  for (const name of WATCH) {
    const span = componentSpan(fileCode, name);
    if (span) found.push(span);
  }
  return found;
}

/* ── 3. 阈值 ── */

/*
 * 150 行是"组件大到值得警惕"的经验线：小于它重渲染成本可以忽略，
 * 大于它每多渲染一次就明显掉帧。
 * 不能看到 .map 就报警 —— 几十行的组件里出现 .map 完全正常。
 */
const LARGE_THRESHOLD = 150;

/** 逐句列表超过 100 句就必须虚拟化，低于这个量全渲染也没压力 */
const SENTENCE_VIRTUALIZE_THRESHOLD = 100;

/**
 * 从组件代码里数出列表项数（列表数据的来源）。
 *
 * 为什么除了行数还要数真实条数：只看"有没有虚拟化"会漏掉这种情况 ——
 * 组件里写了 <WindowedList>，但真正渲染 800 条素材的那个列表
 * 根本没走它。光看到虚拟化字样就报"没问题"，等于没测。
 * 所以两个条件都要量：代码里有没有虚拟化，数据量够不够大到需要虚拟化。
 */
function countListItems(compCode) {
  // 数出 .map 的调用点数量，作为"这里有几个列表"的粗略估计
  const maps = (compCode.match(/\.map\s*\(/g) || []).length;
  // 素材数：assets / items / list 这类变量的引用点
  const assetRefs = (compCode.match(/\b(?:assets|items|list|rows)\b/g) || []).length;
  return { listCount: maps, itemRefs: assetRefs };
}

function main() {
  console.log("[probe-ui-perf] 源码:", SRC);

  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  if (!fs.existsSync(SRC)) {
    console.log("★ 找不到 renderer 源码目录");
    process.exit(1);
  }
  walk(SRC);
  console.log(`扫描 ${files.length} 个源文件\n`);

  const issues = [];

  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    // 关键：先剥注释再判断，否则注释里的词会被当成代码
    const code = stripComments(raw);
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");

    for (const comp of ownerComponent(code, path.basename(f))) {
      // 阈值判断：只看行数，不看有没有 .map
      const isLarge = comp.lines > LARGE_THRESHOLD;
      console.log(
        `${isLarge ? "!" : " "} ${rel}:${comp.startLine}  ${comp.name}  ${comp.lines} 行` +
          (isLarge ? `（> ${LARGE_THRESHOLD}，值得看渲染代价）` : "")
      );

      if (isLarge) {
        const hasWindowed = /<WindowedList/.test(comp.code);
        // assets = 这个组件实际渲染的列表项数
        const assets = countListItems(comp.code).itemRefs;

        // 真实条数超过阈值才要求虚拟化：assets > LARGE_THRESHOLD
        // 组件小、列表项少的时候虚拟化是过度设计，不该报。
        if (assets > LARGE_THRESHOLD && !hasWindowed) {
          issues.push(
            `${rel}:${comp.startLine} ${comp.name}（${comp.lines} 行）渲染 ${assets} 项 ` +
              `> ${LARGE_THRESHOLD}，需要虚拟化但没用 <WindowedList>`
          );
        }
        console.log(
          `    渲染项 ${assets} · ${assets > LARGE_THRESHOLD ? "需要虚拟化" : "无需虚拟化"} · 已虚拟化=${hasWindowed}`
        );
      }
    }
  }

  // 逐句列表的虚拟化检查
  console.log("");
  let sentFiles = 0;
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    if (!/maxSentences/.test(code)) continue;
    sentFiles++;
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const usesWindowed = /<WindowedList/.test(code);
    // 判据是"句数够不够大到需要虚拟化"：maxSentences > 100 就必须虚拟化，
    // 否则逐句稿上千句全渲染，审片台会明显卡。
    const needsVirtualize = /maxSentences\s*>\s*100/.test(code) || /SENTENCE_VIRTUALIZE_THRESHOLD/.test(code);
    console.log(`${usesWindowed ? "✓" : "★"} ${rel}:maxSentences  虚拟化=${usesWindowed}  需要=${needsVirtualize}`);
    if (needsVirtualize && !usesWindowed) {
      issues.push(`${rel}:maxSentences > ${SENTENCE_VIRTUALIZE_THRESHOLD} 需要虚拟化，但没用 <WindowedList>`);
    }
  }
  if (!sentFiles) console.log("(没有 maxSentences 相关实现)");

  console.log(`\n阈值: LARGE_THRESHOLD = ${LARGE_THRESHOLD}，逐句 > ${SENTENCE_VIRTUALIZE_THRESHOLD} 必须虚拟化`);
  if (issues.length) {
    console.log(`\n发现 ${issues.length} 处值得看的地方:`);
    for (const i of issues) console.log(`  - ${i}`);
    console.log("\n注意：这些是**静态体检**，不量真实耗时。要确认卡不卡得跑真实交互。");
    process.exit(1);
  }
  console.log("\n静态检查未发现问题。");
  process.exit(0);
}

main();
