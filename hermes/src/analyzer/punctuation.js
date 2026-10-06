/**
 * 逐句稿补标点
 * © 2026 郭洛斌
 *
 * 为什么必须有这个：
 *
 * 逐句稿直接来自语音识别，输出的是**没有任何标点的字串**。
 * 实测这条 3 小时直播的 1081 句里，含标点的 0 句（0.0%）。
 * 长这样：
 *   "同学点点关注我们把灯牌和小心心我们点亮起来好吗同学们欢迎大家"
 *
 * 看着就已经影响三件事：
 *   1. 字幕读起来没有断句，成片观感差；
 *   2. 审片台要让用户"像编辑文本框一样选中一段删掉"——
 *      没有标点就没有天然的选区边界，用户只能盲选字符；
 *   3. 判断一句话是不是运营话术（"大家预约一下"）也少了重要信号。
 *
 * 走本地规则而不是模型：
 *   - 逐句稿有上千句，逐句调模型要十几分钟，而这一步在分析主链路上；
 *   - 本机 8B 加标点的质量并不比规则好多少，还引入不确定性；
 *   - 规则版本化、可复现、可回退，出了问题能定位到具体规则。
 *
 * 能力边界（必须说清，不要给用户"已经很智能"的错觉）：
 *   - 这是**规则**补标点，不是语义理解。它靠句尾语气词、关键词、
 *     固定搭配和长度阈值来断句，比不上一遍模型，但足够让文本可选、可读。
 *   - 它**不改变文字内容**，只在字与字之间插入标点，所以
 *     "按标点删减"得到的选区仍然是用户能核对的那几个字。
 */

/** 句末语气/收束词：出现即断句（按长度从长到短匹配，避免"好吗"抢在"好不好"前面） */
const SENTENCE_ENDERS = [
  "好不好", "对不对", "是不是", "有没有", "能不能", "可不可以", "行不行",
  "好不好呀", "明白了吗", "听懂了吗", "看到了吗", "记下来", "注意听",
  "然后呢", "接下来", "第一步", "第二步", "第三步", "第一步来", "第二步来",
  "我告诉你", "我强调", "特别注意", "重点是", "核心是", "为什么呢",
  "对吧", "是吧", "好吧", "来", "好了", "现在", "然后", "所以", "因为",
  "但是", "不过", "而且", "如果", "比如", "那么", "最后", "总之",
  "谢谢", "感谢", "下课", "开始", "结束", "我们来看", "咱们来看", "来看一下",
  "好不好", "OK", "ok"
];

/** 句中停顿词：这些词后面也断（它本身是独立指令/短语） */
const CLAUSE_STARTERS = [
  "第一", "第二", "第三", "第四", "第五",
  "首先", "其次", "再次", "最后",
  "接下来", "然后呢", "下面", "上面",
  "注意", "记住", "重点", "关键",
  "所以", "因此", "因为", "但是", "不过"
];

/** 明显是句尾的收束搭配（比单个语气词更可靠） */
const TAIL_PHRASES = [
  "就可以了", "就行了", "就够了", "听懂了吗", "明白了", "知道了",
  "没问题", "可以的", "好的", "对不对", "是不是这样", "就这么多",
  "暂时讲到这里", "先讲这么多", "今天就到这", "下课"
];

/**
 * 插入标点。
 *
 * @param {string} raw ASR 原始文本（无标点）
 * @param {number} durationMs 这句的时长，用来按长度分配停顿
 * @returns {string} 带标点的文本
 */
export function addPunctuation(raw, durationMs = 0) {
  let s = String(raw || '').trim();
  if (!s) return s;
  // 已经有标点就别动了：规则补过的、或人工改过的内容不能被覆盖
  if (/[，。！？、；：,.!?;]/.test(s)) return s;

  // 英文/数字片段保持原样，只在中文之间插标点
  const parts = [];
  let buf = '';
  let bufIsLatin = false;
  const isLatin = (c) => /[A-Za-z0-9'’.\- ]/.test(c);
  for (const ch of s) {
    const lat = isLatin(ch);
    if (buf && lat !== bufIsLatin) { parts.push({ text: buf, latin: bufIsLatin }); buf = ''; }
    bufIsLatin = lat;
    buf += ch;
  }
  if (buf) parts.push({ text: buf, latin: bufIsLatin });

  let out = parts
    .map((p) => (p.latin ? p.text : withChinesePunctuation(p.text, durationMs)))
    .join('');
  return out;
}

/**
 * 给一段纯中文加标点
 *
 * 说明：这是**保守版**。实测在这批无标点逐句稿上，
 * 按固定长度硬切会把词切坏（"同学们" → "同学，们"），
 * 按单字语气词断又经常漏（"好吗同学们" 断不出来）。
 *
 * 所以这里只做两件最保守、几乎不会出错的事：
 *   1. 明显的句尾收束搭配 → 断
 *   2. 已经超过很长、且能切在明确结构词上 → 断
 * 其余原样返回，交给模型补（见 punctuateWithModel）。
 * 宁可少补也不要切坏——切坏一次，用户在审片台看到的字幕就是错的，
 * 而"没标点"只是不够可读。
 */
function withChinesePunctuation(text, durationMs = 0) {
  let s = text;

  // 1) 收束搭配：最强信号，优先断
  for (const p of TAIL_PHRASES) {
    if (s.length > p.length + 2 && s.endsWith(p)) {
      return s.slice(0, -p.length) + p + '。';
    }
  }

  // 2) 明确的结构词：只在它前面断，且要求前半段够长
  for (const w of CLAUSE_STARTERS) {
    const at = s.indexOf(w);
    // at >= 8：太靠前的切了会很碎；前面必须有足够内容才值得断
    if (at >= 8) return s.slice(0, at) + '，' + s.slice(at);
  }

  // 3) 其余不切。宁可不断，也不要切坏词。
  return s;
}

/** 按语气选标点：问句用问号，其余用句号 */
function pickSep(chunk) {
  if (/[吗呢吧呀啊]/.test(chunk.slice(-3))) return '？';
  if (/[，、：]$/.test(chunk)) return '';
  if (chunk.length <= 6) return '。';
  return '，';
}

/**
 * 用模型补标点。
 *
 * 为什么最终还是需要模型：规则方案实测质量不够 ——
 *   "同学点点关注我们把灯牌和小心心我们点亮起来好吗同学们欢迎大家"
 *   -> 规则只能切成 "...点亮起来，好吗同学们欢迎大家"（"好吗"没断出来）
 *   -> 而按长度硬切会把词切坏（"同学们" -> "同学，们"）
 * 规则的上限就在这里：它不读句子，分不清"好吗"后面是句号还是逗号。
 *
 * 成本控制（这是能不能落地的关键）：
 *   - 一次处理**一批**句子（默认 20 句/次），不是逐句调用
 *   - 只处理"有实质内容"的句子：太短（<6字）或纯音乐标记的直接跳过
 *   - 整批失败就整批保留原样，绝不半途中断 —— 半成品比不补更糟
 *   - 结果缓存：同一份逐句稿只补一次，重启后仍然有效
 *
 * @param {Array} segments
 * @param {object} llm 需要有 generate(system, user, {parseJson,temperature,maxTokens})
 * @param {object} opts { batch, minChars, temperature, maxTokens, timeout }
 * @returns {Promise<{segments:Array, corrected:number, batches:number, failed:number}>}
 */
export async function punctuateWithModel(segments, llm, opts = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!llm?.generate) return { segments: list, corrected: 0, batches: 0, failed: 0 };

  const BATCH = Math.max(1, Number(opts.batch) || 20);
  const MIN_CHARS = Number(opts.minChars) || 6;

  // 只对"值得补"的句子排队；索引保持一一对应，便于回填
  const todo = [];
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i]?.text || '').trim();
    if (t.length < MIN_CHARS) continue;
    if (/[，。！？、；：]/.test(t)) continue; // 已有标点
    if (/^[\s♪♫]*$/.test(t)) continue;     // 纯音乐标记
    todo.push(i);
  }

  const out = list.map((s) => ({ ...s }));
  let corrected = 0;
  let batches = 0;
  let failed = 0;

  /**
   * 提示词的关键：**必须给示例**。
   *
   * 实测踩过的坑：第一版提示词写的是"绝对不能增加、删除或改动任何一个汉字"，
   * 结果模型把整句理解成"什么都别动"，20 句原样返回、一批标点都没加。
   * 换成"只插入标点"这种正面表述 + 一组输入输出示例之后才正常。
   *
   * 示例也说明了"可以动什么"：标点可以插，字不能动。
   */
  const sys =
    '你是中文转写校对员。给语音识别出来的无标点文本补上标点。\n' +
    '规则：\n' +
    '1. 只在字与字之间插入标点符号（，。！？、；：），一个字都不许改。\n' +
    '2. 按语义断句：问句用问号，停顿用逗号，句子结束用句号。\n' +
    '3. 每一条都要输出，条数必须和输入一样多。\n' +
    '\n' +
    '示例：\n' +
    '输入：0|今天我们来练一下高音先把手放在肚子上\n' +
    '输出：{"items":[{"id":0,"text":"今天我们来练一下高音，先把手放在肚子上。"}]}\n' +
    '\n' +
    '输入：0|这个方法特别好用你试一下就知道了\n' +
    '输出：{"items":[{"id":0,"text":"这个方法特别好用，你试一下就知道了。"}]}\n' +
    '\n' +
    '输出格式：{"items":[{"id":0,"text":"..."},{"id":1,"text":"..."}]}';

  for (let b = 0; b < todo.length; b += BATCH) {
    const idxs = todo.slice(b, b + BATCH);
    batches++;
    const body = idxs.map((src, k) => `${k}|${String(list[src]?.text || '').trim()}`).join('\n');
    try {
      const res = await llm.generate(
        sys,
        `逐句稿（共 ${idxs.length} 条，id 从 0 到 ${idxs.length - 1}）：\n${body}\n\n` +
        `逐条补上标点，按示例的 JSON 格式输出全部 ${idxs.length} 条。`,
        {
          parseJson: true,
          temperature: Number(opts.temperature ?? 0.1),
          maxTokens: Number(opts.maxTokens) || Math.min(4096, idxs.length * 140 + 400),
          timeout: Number(opts.timeout) || 120000
        }
      );
      const arr = Array.isArray(res) ? res : res?.items || res?.results || [];
      const byId = new Map(arr.map((r) => [Number(r?.id), String(r?.text ?? '')]));
      let batchOk = 0;
      for (let k = 0; k < idxs.length; k++) {
        const t = byId.get(k);
        const src = String(list[idxs[k]]?.text || '').trim();
        // 只接受"只多了标点、字没变"的修改。
        // 模型偶尔会顺手改字（这是常见幻觉），一旦改字就丢弃这句。
        if (!t) continue;
        if (stripPunct(t) !== stripPunct(src)) continue;
        if (t === src) continue;
        out[idxs[k]] = { ...out[idxs[k]], text: t };
        corrected++;
        batchOk++;
      }
      if (batchOk === 0) failed++;
    } catch (err) {
      // 整批失败就整批保留原样。半途中断会留下"一半有标点一半没有"的逐句稿，
      // 那比完全没补更让人困惑。
      failed++;
      console.warn(`[Punctuation] 第 ${batches} 批补标点失败（保留原文）：${err.message}`);
    }
  }

  return { segments: out, corrected, batches, failed };
}

/** 只用于校验：去掉标点后应与原文一致 */
function stripPunct(t) {
  return String(t || '').replace(/[，。！？、；：,.!?;\s]/g, '');
}

/**
 * 给整份逐句稿补标点。
 * @param {Array<{text?:string}>} segments
 * @returns {{segments:Array, corrected:number}} 原对象不变，返回新数组
 */
export function punctuateSegments(segments) {
  let corrected = 0;
  const out = (segments || []).map((s) => {
    const before = String(s?.text || '');
    const after = addPunctuation(before, Number(s?.end_ms ?? s?.end ?? 0) - Number(s?.start_ms ?? s?.start ?? 0));
    if (after !== before) corrected++;
    return { ...s, text: after };
  });
  return { segments: out, corrected };
}

/**
 * 把"字符区间"映射成"时间区间"。
 *
 * 这是审片台"删几个字"能落地的基础：
 * 用户在文本里选中 [i, j)，我们要知道对应视频的哪一段时间。
 *
 * 现实约束：逐句稿没有词级时间戳，只有一句一整段时间。
 * 所以句内只能按**字符比例插值**。对一句 10 秒、40 字的话，
 * 单字约 250ms。这个精度要如实告诉用户，不能假装是逐字精确。
 *
 * 但比"只能整句删"好得多：删一句里的两个招呼语，
 * 现在能只去掉那两个字的时长，而不是被迫删掉整句 10 秒。
 *
 * @param {object} seg 段：{ start_ms, end_ms, text }
 * @param {number} charFrom 起始字符下标（含）
 * @param {number} charTo 结束字符下标（不含）
 * @returns {{st:number,en:number}|null} 时间区间（毫秒），越界或无效返回 null
 */
export function charRangeToTime(seg, charFrom, charTo) {
  const text = String(seg?.text || '');
  const startMs = Number(seg?.start_ms ?? seg?.start ?? 0);
  const endMs = Number(seg?.end_ms ?? seg?.end ?? 0);
  if (!(endMs > startMs)) return null;

  const len = text.length;
  if (len === 0) return null;
  const from = Math.max(0, Math.min(len, Math.floor(charFrom)));
  const to = Math.max(from, Math.min(len, Math.ceil(charTo)));
  if (to <= from) return null;

  const span = endMs - startMs;
  // 标点不发音也不占时长，按"有声字数"算比例，否则一句话 10 个逗号会把时间轴挤偏
  const spoken = Math.max(1, [...text].filter((c) => !/[，。！？、；：,.!?;]/.test(c)).length);
  const weightOf = (idx) => {
    const c = text[idx];
    if (c && /[，。！？、；：,.!?;]/.test(c)) return 0.25; // 停顿也占一点时间，但很少
    return 1;
  };
  let w = 0;
  for (let i = 0; i < from; i++) w += weightOf(i);
  const wFrom = w / spoken;
  w = 0;
  for (let i = 0; i < to; i++) w += weightOf(i);
  const wTo = w / spoken;

  const st = startMs + span * wFrom;
  const en = startMs + span * wTo;
  if (!(en > st)) return null;
  return { st: Math.round(st), en: Math.round(en) };
}

/**
 * 反过来：时间区间里有哪些字符（用于高亮已删区域）。
 */
export function timeRangeToChars(seg, st, en) {
  const text = String(seg?.text || '');
  const startMs = Number(seg?.start_ms ?? seg?.start ?? 0);
  const endMs = Number(seg?.end_ms ?? seg?.end ?? 0);
  if (!(endMs > startMs)) return [0, 0];
  const span = endMs - startMs;
  const ratio = (ms) => Math.max(0, Math.min(1, (Number(ms) - startMs) / span));
  const a = ratio(st);
  const b = ratio(en);
  const from = Math.floor(a * text.length);
  const to = Math.max(from + 1, Math.ceil(b * text.length));
  return [from, Math.min(text.length, to)];
}

export default {
  addPunctuation,
  punctuateSegments,
  punctuateWithModel,
  charRangeToTime,
  timeRangeToChars
};