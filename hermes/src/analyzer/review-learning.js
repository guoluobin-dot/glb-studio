/**
 * 从一次审片里抽出"可学习的剪辑决策"
 * © 2026 郭洛斌
 *
 * ## 为什么不能只学"删掉了什么"
 *
 * 用户删掉的那几句，是显式信号：���明确说"这句不要"。
 * 但**保留下来的部分**同样是信号，而且信息量更大 ——
 * 删掉 3 句只说明那 3 句不行；
 * 留下 15 句才说明了"这位老师的爆款长什么样"。
 *
 * 更麻烦的是"保留"是默认行为：用户什么都不做就等于全留。
 * 所以它必须被**显式记录**，否则数据库里只会有一堆删除记录，
 * 下次找爆点时按"保留了什么"去匹配，一条样本都没有。
 *
 * 要学三类东西：
 *
 *  1. **删掉的原文**（cut）—— 避雷词，下次分析直接跳过这类话术
 *  2. **保留的原文**（keep）—— 正样本，"这种口播结构是有效的"
 *  3. **整段保留的粗剪内容逻辑**（segment）—— 段落级判断：
 *     这段为什么整段留？是开场钩子还是干货主体？
 *     这是最粗但也最稳定的一层信号，比逐字判断抗噪得多。
 *
 * 每条都带 reason（用户写的那句话）和 by（哪些是用户点名、哪些是默认保留）。
 * **不区分这两者就是在学噪声** —— 勾选框打勾 = 用户主动认可；
 * 没动 = 只是没反对，把它当成"用户认为这段好"是过度解读。
 */
import { normalizeRanges } from './editable-text.js';

/**
 * 把一段的最终结果拆成"删掉的片段"和"留下的片段"。
 *
 * 为什么要落到句子级而不是直接存字符区间：
 * 用户删的是"同学们欢迎大家"这种话术，特征在**句子的开头**。
 * 存成句子，下一次分析才能拿"这种起手式"去做匹配；
 * 存字符区间，26 个字 vs 8 个字根本没法比较。
 *
 * @returns {{cuts:Array<{text,startMs,endMs,fromChar,toChar}>, keeps:Array<{text,startMs,endMs}>}}
 */
export function splitByCuts(sentences, fullText, cuts, segStartMs) {
  const spans = [];
  let cursor = 0;
  for (const s of sentences || []) {
    const t = String(s.text || '');
    spans.push({ from: cursor, to: cursor + t.length, text: t, startMs: s.startMs, endMs: s.endMs });
    // 句间那个空格也要算进游标，与 charRangeToTime 一致
    cursor += t.length + 1;
  }

  const cutsOut = [];
  const keepsOut = [];
  for (const sp of spans) {
    const seg = { st: sp.startMs, en: sp.endMs };
    // 这句被任何一处删除区间盖住的部分
    const hit = (cuts || [])
      .filter((c) => c.en > seg.st && c.st < seg.en)
      .map((c) => ({
        st: Math.max(seg.st, c.st - segStartMs),
        en: Math.min(seg.en, c.en - segStartMs)
      }));
    const merged = normalizeRanges(hit);
    if (!merged.length) {
      keepsOut.push({ text: sp.text, startMs: sp.startMs, endMs: sp.endMs });
      continue;
    }
    // 一句里被切碎的，按比例切出保留片段（文本层面近似：按字符数比例）
    const total = Math.max(1, sp.endMs - sp.startMs);
    let prev = 0;
    for (const m of merged) {
      const a = Math.round(((m.st - sp.startMs) / total) * sp.text.length);
      const b = Math.round(((m.en - sp.startMs) / total) * sp.text.length);
      if (a > prev) {
        keepsOut.push({ text: sp.text.slice(prev, a), startMs: sp.startMs + ((prev / sp.text.length) * total), endMs: m.st });
      }
      if (b > a) {
        cutsOut.push({
          text: sp.text.slice(a, b),
          startMs: m.st,
          endMs: m.en,
          fromChar: sp.from + a,
          toChar: sp.from + b
        });
      }
      prev = b;
    }
    if (prev < sp.text.length) {
      keepsOut.push({ text: sp.text.slice(prev), startMs: sp.startMs + ((prev / sp.text.length) * total), endMs: sp.endMs });
    }
  }
  void fullText;
  return { cuts: cutsOut, keeps: keepsOut };
}

/**
 * 归纳"用户点名保留了哪些段" —— 这是整段级的内容逻辑。
 *
 * 为什么要单独记一层：
 * 逐字层的信号细但噪（可能只是这次口误）。
 * 段落层的信号粗但稳：用户勾了 8 段里 6 段，说明这 6 段的内容形态
 * （开场承诺 / 实操演示 / 结论总结）是这位老师爆款的骨架。
 *
 * role（hook / body / cta）是 Hermes 分析时就给的内容定位，
 * 配上 themeName 和实际保留的文本，就是一份可复用的结构样本。
 *
 * @param picked 本次重建实际采用的段
 * @param rejectedIds 用户点名打回的段 id
 */
export function keptSegments(picked, rejectedIds) {
  const rej = new Set((rejectedIds || []).map(Number));
  return picked
    .filter((s) => s && s.id != null && !rej.has(Number(s.id)))
    .map((s) => ({
      segmentId: Number(s.id),
      role: String(s.role || ''),
      themeName: String(s.themeName || ''),
      hookQuality: s.hookQuality != null ? Number(s.hookQuality) : null,
      startSec: Math.round((Number(s.startMs ?? s.start_ms ?? 0) / 1000) * 10) / 10,
      endSec: Math.round((Number(s.endMs ?? s.end_ms ?? 0) / 1000) * 10) / 10,
      // by='picked' 表示用户勾选框打过勾 —— 主动认可。
      // 没勾的段这里不出现（它们只能算"没反对"），避免过度解读。
      by: 'picked'
    }));
}

/**
 * 把一次审片汇总成一条可入库的学习记录。
 *
 * decision 的语义差别很大，不能混：
 *  - approve：用户认可整条粗剪，是最强的正样本
 *  - recut：用户否决了整体，但里面逐句的选择仍然有效
 *
 * @param {object} p
 * @param {Array} p.picked       本次重建采用的段
 * @param {Array<number>} p.rejectedIds 用户点名打回的段
 * @param {Array} p.textCuts     用户框选删除（字符区间）
 * @param {Map<number,{sentences,text}>} p.editableBySeg 段 id → 可编辑文本
 * @param {Map<number,number>} p.segStartById 段 id → 原素材绝对起点（ms）
 * @param {number} p.liveVideoId
 * @param {string} p.comment     用户写的那句话
 */
export function buildLearningRecord(p) {
  const keptSegs = keptSegments(p.picked, p.rejectedIds);
  const keptIds = new Set(keptSegs.map((s) => s.segmentId));
  const rejected = new Set((p.rejectedIds || []).map(Number));

  const cuts = [];
  const keeps = [];
  for (const tc of p.textCuts || []) {
    const id = Number(tc?.segmentId);
    const ed = p.editableBySeg?.get(id);
    if (!ed || !ed.text) continue;
    /**
     * 被点名打回的段，整段文字取舍都不算"用户认可"。
     *
     * 这里不能用 `keptIds.size > 0 && !keptIds.has(id)` 那种条件：
     * keptIds 是"本次采用的段"，规模随重剪结果变化。
     * 一旦整条粗剪都被点名剔光，keptIds 就空了，
     * `size > 0` 不成立 → 反而把所有 keep 都记下来。
     * 而用户的实际意思是"这段我不要" ——
     * 于是系统学到了"用户喜欢自己刚否决的内容"，方向完全反了。
     * 所以直接按 rejected 判定，不依赖 keptIds 的规模。
     */
    if (rejected.has(id)) continue;
    const segStart = Number(p.segStartById?.get(id) ?? 0);
    const r = splitByCuts(
      ed.sentences,
      ed.text,
      // 2026-10-05 修：只记录**真正生效**的删除。
      // 原来把客户端原始 textCuts 自己重算一遍时间就算数，而服务端落库的 cuts 要过一整套
      // 校验（算不出时间就丢、夹到段边界、归一化合并、删超过 90% 整段跳过、短于 200ms 忽略）。
      // 于是被规则拒绝的选区仍被记成 cut 样本 —— 那是"避雷词"，会注入下一次分析提示词：
      // 用户试删一句被拦下，那句话**还在成片里**，系统却已当成"用户讨厌的说法"学走。
      // 反过来更糟：算不出时间的选区会让整段落进 keep，等于教系统"保留"用户想删的内容。
      // 两个方向都是把噪声当规则塞进学习闭环，比不学更坏。必须拿实际落库的 cuts 核对。
      charRangesToTime(tc.ranges || [], ed, segStart, p.appliedCutsBySeg?.get(id)),
      segStart
    );
    cuts.push(...r.cuts.map((c) => ({ segmentId: id, ...c })));
    keeps.push(...r.keeps.map((k) => ({ segmentId: id, ...k })));
  }

  return {
    keptSegments: keptSegs,
    cuts,
    keeps,
    rejectedCount: (p.rejectedIds || []).length
  };
}

/** 字符区间 → 绝对时间区间（与 charRangeToTime 同算法，抽出来避免循环依赖） */
function charRangesToTime(ranges, editable, segStart, appliedCuts) {
  const out = [];
  for (const r of ranges || []) {
    const hit = mapRange(editable, r, segStart);
    if (!hit) continue;
    // 核对是否真的生效：服务端会夹紧/合并/丢掉过短的，
    // 原始选区算出的时间未必还在最终 cuts 里。
    // 只有完全落在某个实际生效区间内的，才算这条学习有效。
    if (Array.isArray(appliedCuts) && appliedCuts.length) {
      const ok = appliedCuts.some((c) => hit.st >= Number(c.st) - 1 && hit.en <= Number(c.en) + 1);
      if (!ok) continue;
    }
    out.push(hit);
  }
  return out;
}

/** 单个字符区间 → 绝对时间（就地实现，逻辑与 editable-text.charRangeToTime 一致） */
function mapRange(editable, r, segStart) {
  const spans = [];
  let cursor = 0;
  for (const s of editable.sentences || []) {
    const t = String(s.text || '');
    spans.push({ from: cursor, to: cursor + t.length, text: t, startMs: s.startMs, endMs: s.endMs });
    cursor += t.length + 1;
  }
  const text = String(editable.text || '');
  const from = Math.max(0, Math.min(text.length, Math.floor(r.from ?? 0)));
  const to = Math.max(from, Math.min(text.length, Math.ceil(r.to ?? 0)));
  if (to <= from) return null;
  const PUNCT = /[，。！？、；：,.!?;]/;
  let st = Infinity;
  let en = -Infinity;
  for (const sp of spans) {
    const a = Math.max(from, sp.from);
    const b = Math.min(to, sp.to);
    if (b <= a) continue;
    const span = Math.max(0, sp.endMs - sp.startMs);
    if (!(span > 0)) continue;
    const spoken = Math.max(1, [...sp.text].filter((c) => !PUNCT.test(c)).length);
    let w = 0;
    for (let i = 0; i < a - sp.from; i++) w += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
    let w2 = 0;
    for (let i = 0; i < b - sp.from; i++) w2 += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
    const x = segStart + sp.startMs + span * (w / spoken);
    const y = segStart + sp.startMs + span * (w2 / spoken);
    st = Math.min(st, x);
    en = Math.max(en, y);
  }
  if (!Number.isFinite(st) || en <= st) return null;
  return { st: Math.round(st), en: Math.round(en) };
}

export default { splitByCuts, keptSegments, buildLearningRecord };
