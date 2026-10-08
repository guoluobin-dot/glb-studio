/**
 * 热词硬纠正
 * © 2026 郭洛斌
 *
 * ## 为什么必须"硬性"而不是"提示模型注意"
 *
 * 人名、术语、课程名是口播里最容易被 ASR 听错的部分，
 * 而这些恰恰是判断内容价值的核心信息：
 *   「朱老师」听成「猪老师」→ 字幕错、正文错、检索也错
 *   「中音」听成「中音/童音」→ 讲的是同一门课，检索却不匹配
 *
 * 提示模型"注意发音"是没用的 —— 错字已经写进逐句稿，
 * 后面所有环节（粗剪文案、字幕、爆点匹配）都在错的基础上工作。
 * 所以必须在校正发生的地方**替换掉**。
 *
 * ## 在哪一层改
 *
 * 唯一入口：`loadTranscript`。
 * 因为它是所有逐句稿读出的唯一出口 —— review 学习样本的正文、
 * 分析提示词、成片字幕，全部经由它。
 * 改一处就全覆盖，这是唯一不会漏的做法。
 *
 * ## 为什么不动时间戳
 *
 * 替换只改 text，不碰 start/end。
 * ASR 的时间戳是**句级**的，与句内字数无关；
 * 「猪老师」→「朱老师」字数不变；
 * 就算字数变了（如「吊」→「钓」），
 * 时间戳仍指向那一句话的起止，字幕对齐不会错。
 *
 * @author 郭洛斌
 */

/**
 * 对一段文本应用全部热词纠正。
 *
 * 为什么要按"长的先替换"：
 * 同时存在「朱老师→朱」和「朱老师老师→朱老师」时，
 * 先替短的会把长词里的前半段吃掉，结果不可预期。
 *
 * @param {string} text
 * @param {Array<{from:string,to:string}>} hotwords
 * @returns {string}
 */
export function applyHotwords(text, hotwords) {
  if (!text) return text ?? '';
  const rules = (hotwords || [])
    .filter((h) => h && typeof h.from === 'string' && typeof h.to === 'string')
    .map((h) => ({ from: h.from, to: h.to }))
    // 跳过空词和"改前改后一样"：前者会让 replace 变成空操作，
    // 后者毫无意义；而这两种规则用户手滑很容易建出来
    .filter((h) => h.from.length > 0 && h.from !== h.to)
    // 长的先替，避免短规则吃掉长规则的前缀
    .sort((a, b) => b.from.length - a.from.length);

  let out = String(text);
  for (const r of rules) out = out.split(r.from).join(r.to);
  return out;
}

/**
 * 统计一条热词在文本里会出现几次（给 UI 做「命中 N 次」提示）
 * @returns {number}
 */
export function countHits(text, word) {
  if (!text || !word) return 0;
  return String(text).split(word).length - 1;
}

/**
 * 找出可能听错的词，供「自动建议」用。
 *
 * 刻意只报**重复出现**的疑似错词（同一段里"X老师"出现多次），
 * 而不是去找生僻字 —— 判断不了生僻字就是错的，
 * 误报一堆没法确认的东西，用户会直接放弃这个功能。
 *
 * @returns {Array<{word:string,n:number}>}
 */
export function suggestFromTranscript(sentences, { minRepeat = 2 } = {}) {
  const freq = new Map();
  for (const s of sentences || []) {
    const t = String(s.text || '');
    // 抓「X老师 / X哥 / X姐」这类称谓，以及书名号/引号里的专名
    for (const m of t.matchAll(/[一-龥]{1,3}(?:老师|教练|导师|哥|姐)/g)) {
      freq.set(m[0], (freq.get(m[0]) || 0) + 1);
    }
    for (const m of t.matchAll(/[《【]([^》】]{2,12})[》】]/g)) {
      freq.set(m[1], (freq.get(m[1]) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= minRepeat)
    .map(([word, n]) => ({ word, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
}