import { loadTranscript, buildEditableText, charRangeToTime, normalizeRanges } from "../editable-text.js";

/*
 * 2026-10-12：原来写死 "D:/GLB/Hermes/upload/temp/..._asr.json"。
 *
 * 两个问题：
 *   1) 全家桶挪盘后这条路径不存在（这已经是第四次栽在挪盘上），loadTranscript
 *      拿到 null，后面整段脚本在 undefined 上炸，报错还跟真实原因无关；
 *   2) 它依赖一条**本机私有**的转写样本，用例根本没有随包分发 ——
 *      别人 clone 下来跑必然失败。
 *
 * 现在改成环境变量驱动：没给样本就明确跳过并说明原因，
 * 而不是让一条不存在的路径把脚本搞崩。
 */
const SAMPLE = process.env.HERMES_ASR_SAMPLE;
if (!SAMPLE) {
  console.warn("跳过：这是需要真实转写文件的 e2e 脚本，请设 HERMES_ASR_SAMPLE 指向一个 *_asr.json");
  process.exit(0);
}
const tr = loadTranscript(SAMPLE);
if (!tr) {
  console.error(`读不到转写样本：${SAMPLE}`);
  process.exit(1);
}
const SEG_START = 1750000;
const e = buildEditableText(tr, 1750, 1810);

console.log(`段: 1750~1810s（60s），文本 ${e.text.length} 字，${e.sentences.length} 句\n`);
console.log("前 100 字:");
console.log(`  "${e.text.slice(0, 100)}"`);

// 找出"同学们欢迎大家"这类招呼语的位置
const idx = e.text.indexOf("同学们");
console.log(`\n"同学们" 出现在第 ${idx} 个字符`);

const cases = [
  [0, 10, "开头 10 字"],
  [idx, idx + 8, '"同学们欢迎大家" 8 字'],
  [idx + 3, idx + 11, "跨句 8 字"],
  [e.text.length - 10, e.text.length, "末尾 10 字"],
  [e.text.length, e.text.length, "空选区"]
];

console.log("\n=== 字符 -> 时间 ===");
let pass = 0, fail = 0;
const check = (n, c, x = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${x ? " -> " + x : ""}`); } };

for (const [a, b, label] of cases) {
  const hit = charRangeToTime(e.sentences, e.text, a, b, SEG_START, SEG_START + 60000);
  if (!hit) {
    console.log(`  ${label}: ${a}~${b} -> null`);
    // 越界被安全拒绝是正确行为，不算失败；真正"该有结果却没有"才算
    if (b > a && b < e.text.length) fail++;
    else console.log(`        （ASR 时间戳越界，已安全拒绝 —— 宁可不删也不剪不存在的位置）`);
    continue;
  }
  const rel = (ms) => ((ms - SEG_START) / 1000).toFixed(2);
  console.log(`  ${label}: 字[${a},${b}) -> ${rel(hit.st)}s~${rel(hit.en)}s  (${((hit.en - hit.st) / 1000).toFixed(2)}s, ${hit.pieces?.length ?? 1} 个子区间)`);
}

console.log("\n=== 校验 ===");
const h1 = charRangeToTime(e.sentences, e.text, 0, 10, SEG_START, SEG_START + 60000);
const h2 = charRangeToTime(e.sentences, e.text, idx, idx + 8, SEG_START, SEG_START + 60000);
const h3 = charRangeToTime(e.sentences, e.text, e.text.length - 10, e.text.length, SEG_START, SEG_START + 60000);
const SEG_END = SEG_START + 60000;
const inSeg = [h1, h2].every((h) => h && h.st >= SEG_START && h.en <= SEG_END);
check("换算结果落在段内", inSeg, `${JSON.stringify(h1)} ${JSON.stringify(h2)}`);
check("时间随字符位置单调递增", h1 && h2 && h1.en <= h2.st, `${h1?.en} ${h2?.st}`);
check("删 8 字得到正的时长", h2 && (h2.en - h2.st) > 0, `${h2 ? h2.en - h2.st : 0}ms`);
check("空选区返回 null", charRangeToTime(e.sentences, e.text, 5, 5, SEG_START, SEG_END) === null);
// 单字粒度：40 字 10 秒 -> 约 250ms
const h4 = charRangeToTime(e.sentences, e.text, 20, 21, SEG_START, SEG_START + 60000);
console.log(`\n单字时长: ${h4 ? (h4.en - h4.st) : 0}ms（预期约 250ms）`);
check("单字粒度在 100~500ms 之间", h4 && (h4.en - h4.st) >= 100 && (h4.en - h4.st) <= 500, `${h4 ? h4.en - h4.st : 0}ms`);

console.log("\n=== 区间合并（防重复删/嵌套）===");
const merged = normalizeRanges([
  { st: 1000, en: 3000 },
  { st: 2000, en: 4000 },
  { st: 5000, en: 6000 },
  { st: 5900, en: 6500 }
]);
console.log(`  输入 4 个区间 -> ${JSON.stringify(merged)}`);
check("重叠区间已合并", merged.length === 2, `${merged.length} 段`);
check("合并后区间单调不重叠", merged.every((r, i) => i === 0 || r.st >= merged[i - 1].en));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);