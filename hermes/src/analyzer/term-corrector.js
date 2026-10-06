/**
 * 转写术语纠错层 —— 唱歌（声乐教学）领域
 *
 * 为什么需要：ASR 是通用模型，听不出"混声""声带"这类专业词，实测证据：
 *   「同学们」被识别成「同友们」（连最高频的称呼都错）
 *   「热烈」被识别成「数烈」
 *   「混声」被识别成「混生」、「声带」被识别成「生带」（老板原话）
 * 这些错字不是只影响字幕——分段、主题匹配、粗剪选段全在同一个错字文本上跑，
 * 理解从源头就歪了。所以纠错必须做在 ASR 出口，而不是出字幕前才救。
 *
 * 为什么用"映射表"而不是让 LLM 改：
 *   8B 本地模型看着词表猜同音字，既慢又不稳（且占一次完整推理）。
 *   精确子串替换是 100% 确定的，零时延、零显存、零 token。
 *   LLM 仍然保留在 generator 层做"上下文级"校对的兜底（对照 SINGING_TERMS）。
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEXICON = join(__dirname, '..', '..', 'config', 'singing-terms.json');

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 5 * 60 * 1000; // 5 分钟热更新：老板改了词表不必重启

/**
 * 读取词表。返回 { enabled, corrections: [[错, 对], ...], terms: string[] }
 * 按错字长度倒序替换：先替长的，避免短词条抢先把长词切坏
 * （例如先替"生带"再替"带"，次序反了会得到错误结果）。
 */
export function loadLexicon(lexiconPath = null) {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;
  const p = lexiconPath || process.env.HERMES_LEXICON || DEFAULT_LEXICON;
  try {
    if (!existsSync(p)) {
      _cache = { enabled: false, corrections: [], terms: [] };
      _cacheAt = now;
      return _cache;
    }
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    const corrections = Object.entries(j.corrections || {})
      .filter(([k, v]) => k && v && k !== v)
      .sort((a, b) => b[0].length - a[0].length); // 长词优先
    _cache = {
      enabled: j.enabled !== false,
      corrections,
      terms: Array.isArray(j.terms) ? j.terms : [],
    };
    _cacheAt = now;
    return _cache;
  } catch (err) {
    console.warn(`[TermCorrector] 词表读取失败（${err.message}），本次跳过术语纠错`);
    _cache = { enabled: false, corrections: [], terms: [] };
    _cacheAt = now;
    return _cache;
  }
}

/** 对外：热重载时可强制清缓存 */
export function resetLexiconCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * 对一段文本做术语纠错。
 * @param {string} text
 * @returns {{text:string, fixes:Array<{from:string,to:string,count:number}>, total:number}}
 */
export function correctTermText(text, lexiconPath = null) {
  const lex = loadLexicon(lexiconPath);
  const empty = { text: text ?? '', fixes: [], total: 0 };
  if (!lex?.enabled || !lex.corrections?.length) return empty;
  if (typeof text !== 'string' || !text) return empty;

  let out = text;
  const fixes = [];
  let total = 0;
  for (const [wrong, right] of lex.corrections) {
    if (!out.includes(wrong)) continue;
    const parts = out.split(wrong);
    const count = parts.length - 1;
    out = parts.join(right);
    total += count;
    fixes.push({ from: wrong, to: right, count });
  }
  return { text: out, fixes, total };
}

/**
 * 对整个转写结果做纠错（就地改 text 字段，时间戳一个不动）。
 * 幂等：已经纠正过的文本再次进入不会产生新的变化（正确词不在错字表里）。
 *
 * @returns {{transcript:Array, stats:{corrected:number, details:Array}}}
 */
export function correctTranscript(transcript, lexiconPath = null) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { transcript: transcript || [], stats: { corrected: 0, details: [] } };
  }
  const details = [];
  let corrected = 0;
  const out = transcript.map((s) => {
    if (!s || typeof s.text !== 'string' || !s.text) return s;
    const r = correctTermText(s.text, lexiconPath);
    if (r.total > 0) {
      corrected += r.total;
      details.push({ start: s.start ?? s.start_ms ?? null, fixes: r.fixes });
      return { ...s, text: r.text };
    }
    return s;
  });
  return { transcript: out, stats: { corrected, details } };
}

/**
 * 错字体检：统计文本里"疑似应该纠正"的残留（用于体检面板的 ASR 质量指标）。
 * 只统计不做修改。
 */
export function countSuspectTerms(text, lexiconPath = null) {
  const lex = loadLexicon(lexiconPath);
  if (!lex?.enabled || !lex.corrections?.length || typeof text !== 'string' || !text) return 0;
  let n = 0;
  for (const [wrong] of lex.corrections) {
    if (text.includes(wrong)) n += text.split(wrong).length - 1;
  }
  return n;
}

export default correctTranscript;
