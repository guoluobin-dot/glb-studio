/**
 * 按时间范围取逐句原文
 * © 2026 郭洛斌
 *
 * 为什么需要它：审片台要让用户像编辑文本框一样框选几个字删掉，
 * 而 raw cut 项目里存的只有主题名和时间轴，**没有任何文本**。
 * 没有文本就没有东西可选，"删到字"这个功能根本无从下手。
 *
 * 数据从哪来：live_videos.asr_path 指向的转写缓存（sherpa 输出）。
 * 它是整个链路里唯一的原文来源，粗剪文案、逐句稿面板、字幕都读它。
 *
 * 为什么不在这里补标点：补标点要调模型、一次几分钟，
 * 不能塞进"读审片包"这种必须秒回的路径。补标点是独立的后台任务，
 * 它的结果直接写回同一个 asr 缓存文件，之后这里自然就拿到带标点的文本。
 */

import { existsSync, readFileSync } from 'fs';
import { applyHotwords } from './hotwords.js';

/**
 * 设置本次要套用的热词规则。
 *
 * 为什么用 setter 而不是每次传参：
 * loadTranscript 被几十处调用（review-packet、分析、字幕、爆点匹配…），
 * 逐个加参数必然漏；而漏一处就意味着"字幕改了、审阅台没改"这种鬼故事。
 * 设置一次、全部读点自动生效，是唯一能保证一致的做法。
 *
 * 用 module 级状态而不是 store：editable-text 是纯函数模块，
 * 不该依赖 store 实例（store 在这里是死循环的引入）。
 */
let activeHotwords = [];
export function setHotwords(rules) {
  activeHotwords = Array.isArray(rules) ? rules : [];
}
export function getHotwords_() {
  return activeHotwords;
}

/**
 * 读这条直播的逐句稿（含起止时间），失败返回空数组
 *
 * @param {string} asrPath 逐句稿路径
 * @param {Array}  [rules] 显式指定热词。**新代码必须传这个。**
 *
 * 为什么要加这个参数：
 * 模块级 activeHotwords 是"上一次 setHotwords 留下的值"，
 * 它对"当前正在读谁的稿子"一无所知。
 * 服务器同时处理两个请求时，A 请求设完规则、B 请求读走，
 * 或者同一个请求里先给 IP-甲 读了稿、紧接着给 IP-乙 读稿，
 * 后一次都会拿到前一次的规则 —— 而且不报错，只是文案悄悄是错的。
 *
 * 保留 setHotwords 只是为了不破坏旧调用点；
 * 规则应该跟着数据走（按 live/project 现取现传），而不是靠全局状态传递。
 */
export function loadTranscript(asrPath, rules) {
  if (!asrPath || !existsSync(asrPath)) return [];
  const active = Array.isArray(rules) ? rules : activeHotwords;
  try {
    const j = JSON.parse(readFileSync(asrPath, 'utf-8'));
    const list = Array.isArray(j) ? j : j.segments || [];
    return list
      .map((s) => ({
        startMs: Number(s.start_ms ?? s.startMs ?? s.start ?? 0),
        endMs: Number(s.end_ms ?? s.endMs ?? s.end ?? 0),
        // 热词在这里生效：错字从出口就被换掉，
        // 于是审片台文案、分析提示词、成片字幕全部拿到纠正后的文本。
        text: applyHotwords(String(s.text || ''), active)
      }))
      .filter((s) => s.endMs > s.startMs);
  } catch {
    return [];
  }
}

/**
 * 取落在时间范围内的句子。
 *
 * 边界处理说明：这里用**有重叠**而不是"完全包含"。
 * 逐句稿的句子边界和分析分段的边界来自两套独立切分，对不齐是常态。
 * 如果要求完全包含，边界上那半句话就会被漏掉，
 * 表现为"字幕里能看到这句话，审片台的编辑区却没有" —— 很难解释。
 *
 * @param {Array} transcript loadTranscript 的结果
 * @param {number} fromSec 起始秒（相对原素材）
 * @param {number} toSec 结束秒
 * @returns {Array<{startMs,endMs,text}>} 相对范围的首尾（便于按比例插值）
 */
export function sentencesInRange(transcript, fromSec, toSec) {
  // 入参是"秒"，转成毫秒再和 ASR 的时间戳比。
  //
  // 这里必须各自独立换算。以前写成 b = Math.max(a, toSec * 1000)，
  // 而 a 已经是毫秒 —— 于是 toSec 又被乘了一次 1000，
  // 60 秒的范围变成 1750 秒，命中 910 句（整场三分之一），
  // 每段文本 6 万字。表现为"每段都返回一大坨文字"。
  const a = Math.max(0, Number(fromSec) || 0) * 1000;
  // 注意括号：* 1000 必须作用在 toSec 上，而不是 Math.max 的结果上。
  // 写成 Math.max(a, toSec || 0) * 1000 会让 a 被再乘一次 1000 ——
  // 60 秒的范围变成 1750 秒，于是命中 910 句（整场三分之一）、每段文本 6 万字。
  // 这个 bug 很隐蔽：数学上"看起来"没问题，只有真数据才暴露。
  const b = Math.max(a, (Number(toSec) || 0) * 1000);
  if (!(b > a)) return [];
  // 防御：换算完如果范围离谱（超过一天），说明入参单位不对，宁可不给也不要整场文本
  if (b - a > 86_400_000) {
    console.warn(`[EditableText] 时间范围异常（${(b - a) / 1000}s），入参单位可能不是秒，已忽略`);
    return [];
  }
  const out = [];
  for (const s of transcript) {
    // 留一点容差：ASR 的时间戳可能有几十毫秒误差，严格相交会漏掉
    const pad = 50;
    if (s.endMs >= a - pad && s.startMs <= b + pad) {
      out.push({
        // 有些 ASR 会把首句写成 start=0/end=0（还没测到真实时长）。
        // 直接照抄的话这段的 span=0，后面按比例插值会整段跳过 ——
        // 而选区常常正好落在开头，于是表现为"开头几个字删不掉"。
        // 这里补一个下限：用后面的句子时长做粗略估计，至少让它可映射。
        startMs: Math.max(s.startMs, a) - a,
        endMs: Math.min(s.endMs, b) - a,
        text: s.text
      });
    }
  }
  return out;
}

/**
 * 把一个原素材时间范围拼成一段可编辑文本。
 *
 * 返回结构刻意做成"每句一条 + 整段纯文本"：
 * 界面上要按句分行显示（这样用户知道哪句是哪句），
 * 但框选又是在整段文本上做的，所以两者都要给。
 *
 * @returns {{text:string, sentences:Array<{text,startMs,endMs}>}}
 */
export function buildEditableText(transcript, fromSec, toSec) {
  const raw = sentencesInRange(transcript, fromSec, toSec);
  if (!raw.length) return { text: '', sentences: [] };

  /**
   * 补零长句的时长。
   *
   * ASR 偶尔把句子的时间戳写成 start=end（首句尤其常见）。
   * 原样保留的话这段 span=0，按字符比例插值时会被跳过 ——
   * 而开头几个字恰恰是用户最想删的（欢迎语、寒暄）。
   * 现象就是"开头删不掉、后面能删"，非常费解。
   *
   * 时长不够就用整段平均句长按比例推算（而不是截断到 0）：
   * 截断会让末尾的句子彻底无法编辑，而末尾同样是内容。
   * 推算值会超过整段长度一点点，调用方会统一做收口。
   */
  const spans = raw.map((s) => s.endMs - s.startMs).filter((v) => v > 0);
  const typical = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 8000;
  const sentences = raw.map((s, i) => {
    if (s.endMs > s.startMs) return s;
    // 按位置均分整段时长：第 i 句大约落在 i/n 的位置
    const n = Math.max(1, raw.length);
    const slot = Math.max(1, Math.round(totalSpan(raw) / n));
    const guess = Math.max(1000, Math.min(typical || 8000, slot));
    return { ...s, endMs: s.startMs + guess };
  });

  // 句与句之间用空格连接。注释里说的那个理由很重要：
  // 插入的分隔符会被"只删不加"的校验当成原文，所以这里必须与
  // charRangeToTime 的偏移累加保持一致（那边也是 len+1）。
  const text = sentences.map((s) => s.text).join(' ');
  return { text, sentences };
}

function totalSpan(sentences) {
  const last = sentences[sentences.length - 1];
  return Math.max(0, (last?.endMs ?? 0) - (sentences[0]?.startMs ?? 0));
}

/**
 * 段里几乎没有文本时，返回一个"这是实操演示"的占位说明。
 *
 * 为什么需要：教学直播里大量片段是老师现场演示、弹琴、唱歌，
 * ASR 只能识别出零星几个字（"好的"、"来"、"一二三"）甚至完全静音。
 * 这种段如果只显示空白，用户会以为功能坏了；
 * 而它恰恰是最该保留的（实操教学通常是爆点核心）。
 *
 * @returns {{textless:boolean, hint:string}} textless=true 时让界面改成时间区间块
 */
export function describeTextless(sentences, spanSec) {
  const chars = sentences.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
  const speech = sentences.reduce((n, s) => n + (s.endMs - s.startMs), 0) / 1000;
  // 判据：字太少，或"说话密度"极低（每分钟不到 4 个字）
  const density = speech > 0 ? chars / (speech / 60) : 0;
  if (chars < 8 || density < 4) {
    return {
      textless: true,
      hint: chars === 0
        ? '这段没有识别到文字，多半是现场演示/演唱'
        : `这段只有 ${chars} 个字（说话很少），多半是现场演示`,
      spanSec: Math.max(0, Math.round(Number(spanSec) || 0))
    };
  }
  return { textless: false, hint: '', chars, speech: Math.round(speech * 10) / 10 };
}

/**
 * 把"某段文本里的字符区间"换算成"原素材的绝对时间区间"。
 *
 * 为什么必须在服务端做：客户端显示的文本是拼接过的（多句用空格连接），
 * 让客户端算时间就等于让它知道拼接规则 —— 一旦拼接方式变了（比如换成换行），
 * 客户端算出来的秒数就全错，而且没有任何报错。
 *
 * 精度说明（必须如实告知用户）：逐句稿没有词级时间戳，只有句级。
 * 句内只能按字符位置在句子时长里做比例插值。
 * 一句 10 秒、40 字的话，单字约 250ms。
 * 也就是说"删掉同学们欢迎大家"能去掉约 2 秒，而不是被迫删掉整句 10 秒。
 *
 * @param {Array<{startMs,endMs,text}>} sentences 该段的句子（相对段首，毫秒）
 * @param {string} fullText 该段拼接后的整段文本
 * @param {number} charFrom 起始字符下标（含）
 * @param {number} charTo 结束字符下标（不含）
 * @param {number} segStartMs 该段在原素材里的起点（绝对毫秒）
 * @returns {{st:number,en:number}|null} 绝对时间区间（毫秒）
 */
export function charRangeToTime(sentences, fullText, charFrom, charTo, segStartMs, segEndMs) {
  if (!Array.isArray(sentences) || !sentences.length) return null;
  const text = String(fullText || '');
  const from = Math.max(0, Math.min(text.length, Math.floor(charFrom)));
  const to = Math.max(from, Math.min(text.length, Math.ceil(charTo)));
  if (to <= from) return null;

  const segStart = Number(segStartMs) || 0;
  const PUNCT = /[，。！？、；：,.!?;]/;

  // 逐句累加字符数，定位选区落在哪几句上
  let cursor = 0;
  const spans = [];
  for (const s of sentences) {
    const len = String(s.text || '').length;
    spans.push({ from: cursor, to: cursor + len, ...s });
    // 拼接时句间有一个空格，字符位置要把它算进去，否则第二句往后的偏移会差 1 字/句
    cursor += len + 1;
  }

  /*
   * 2026-10-05 补：边界必须是有限数。
   *
   * 下面每道校验（b <= a / en > st / to <= from）对 NaN 都是 false，
   * 所以 NaN 边界能一路"通过校验"，最后返回一个由零长碎片拼成的
   * 聚合结果 —— 看上去算出来了，实际是凭空造的。
   *
   * 今天无害只因为调用方还有一道 `if (p.en <= p.st) continue` 兜着，
   * 而那道守卫并不是它看起来在干的事。边界一旦来自
   * JSON.parse 出来的脏数据（文本框算出的 from/to 就是），
   * 迟早会漏。所以在这里就拒掉。
   */
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  // 把 [from,to) 拆成"每句内的那一小段"
  const hits = [];
  for (const sp of spans) {
    const a = Math.max(from, sp.from);
    const b = Math.min(to, sp.to);
    if (b <= a) continue;
    const t = String(sp.text || '');
    const span = Math.max(0, sp.endMs - sp.startMs);
    if (!(span > 0)) continue;
    /*
     * 时间必须按**同一个量纲**摊到句子上。
     *
     * 原来：分母 spoken 完全排除标点，分子却给标点 0.25 分。
     * 只要句子里有标点，w2/spoken 就 >1 —— 选整句时
     * en = 句首 + span*(>1) 会越过句子结尾，吃掉下一句的开头
     * （实测能多吃掉 882ms），而下一句自己的 piece 就从那儿开始。
     *
     * 用户看到的是"我只选了这句话，却把后面的话也剪掉了"。
     *
     * 修法：分子分母用同一套权重。标点占一点时长（0.25），
     * 这样整句选中恰好得到 1.0，严格不越界；
     * 同时保留"标点不该占满时长"的原意 —— 它只是被低估，不是被排除。
     */
    const weight = (ch) => (PUNCT.test(ch) ? 0.25 : 1);
    const totalW = Math.max(
      0.25,
      [...t].reduce((sum, c) => sum + weight(c), 0)
    );
    let w = 0;
    for (let i = 0; i < a - sp.from; i++) w += weight(t[i] ?? '');
    const wFrom = Math.min(1, w / totalW);
    let w2 = 0;
    for (let i = 0; i < b - sp.from; i++) w2 += weight(t[i] ?? '');
    // 夹到 1：既是防御，也保证"选整句 = 整句"这条不变量
    const wTo = Math.min(1, w2 / totalW);
    hits.push({
      st: Math.round(segStart + sp.startMs + span * wFrom),
      en: Math.round(segStart + sp.startMs + span * wTo)
    });
  }
  if (!hits.length) return null;

  // 夹回段内。
  // 补零长句时长可能让最后几句略微超出段尾，不夹的话调用方拿到的
  // 时间会让 ffmpeg 去剪一个不存在的位置（表现为花屏/音画不同步）。
  // 传了 segEndMs 才夹，没传就按实际算出来的范围返回。
  let st = Math.min(...hits.map((h) => h.st));
  let en = Math.max(...hits.map((h) => h.en));
  if (Number.isFinite(Number(segEndMs)) && Number(segEndMs) > 0) {
    const cap = Number(segEndMs);
    st = Math.max(segStart, Math.min(st, cap));
    en = Math.max(st, Math.min(en, cap));
  }
  if (!(en > st)) return null;
  return { st, en, pieces: hits };
}

/**
 * 把字符删除列表合并成互不重叠的区间列表。
 *
 * 用户会反复删、删了又撤销、框选也可能和已有删除部分重叠。
 * 不合并的话，最终的 cuts 会互相嵌套，ffmpeg 会算出负时长或重复删同一段。
 */
export function normalizeRanges(ranges) {
  const list = (ranges || [])
    .map((r) => ({ st: Math.round(Number(r.st) || 0), en: Math.round(Number(r.en) || 0) }))
    .filter((r) => r.en > r.st)
    .sort((a, b) => a.st - b.st);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.st <= last.en) {
      last.en = Math.max(last.en, r.en);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** 一段里被剪掉的总时长（毫秒） */
export function removedMs(ranges) {
  return normalizeRanges(ranges).reduce((n, r) => n + (r.en - r.st), 0);
}

export default {
  loadTranscript,
  sentencesInRange,
  buildEditableText,
  describeTextless,
  charRangeToTime,
  normalizeRanges,
  removedMs
};