/**
 * JSON 修复层 —— 专治大模型输出残缺（全项目统一入口）
 *
 * 背景（实测数据支撑）：
 * 本机 qwen3:8b 约 约 69 tok/s(2026-09-30 实测)，生成 1200 tokens 要 28 秒；一旦输出超预算被掐断，
 * 返回的 JSON 是"半截"的（最后一个字符串没闭合引号、数组没闭合中括号）。
 * 此前 live-analyzer 遇到这种情况直接判失败 → 整场直播退化成 90 秒机械等分，
 * 这就是数据库里 143/144 段主题全是"待分类"的直接成因。
 *
 * 2026-09-27 提升为公共层：原先 ollama.js 里有一版 repairTruncatedJson，
 * 但那是"丢掉最后一个残缺元素"的保守做法，最后一个元素哪怕只差一个引号也会被整条丢弃。
 * 本实现会区分断尾类型（值截断 vs key 截断），能多救回内容。
 * src/llm/ollama.js 与 src/llm/deepseek.js 现在都委托到这里，一处升级全链路受益。
 *
 * 做三件事，按顺序尝试，能救回一次昂贵的 LLM 调用就值：
 *   1. 剥离 markdown 围栏 ```json 和标签前后的废话
 *   2. 完整 JSON 直接解析
 *   3. 残缺 JSON 按栈结构补全后重试（补引号/补括号/补 null）
 */

/** 剥离围栏与前后废话，返回可能残缺但起点正确的 JSON 文本 */
function stripNoise(raw) {
  let s = String(raw ?? '').trim();
  // <think>…</think>：推理模型的思考过程混在正文里
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<\/?think>/gi, '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fence) s = fence[1].trim();
  return s.trim();
}

/** 找到第一个未处于字符串内的 { 或 [ */
function findStart(s) {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

/**
 * 扫描括号/字符串配平情况。
 * @returns {{complete:boolean, end?:number, stack?:string[], inStr?:boolean, truncatedAt?:number, mismatch?:boolean}}
 */
function scan(s, start) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let i = start;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) {
        return { complete: false, mismatch: true };
      }
      if (stack.length === 0) return { complete: true, end: i + 1 };
    }
  }
  return { complete: false, stack, inStr, truncatedAt: i };
}

/**
 * 把截断的 JSON 尽量补全成合法 JSON。
 * 三种典型断尾：
 *   {"a":"李老师   → 字符串没闭合
 *   {"segments":[{"a":1},     → 数组/对象没闭合
 *   {"segments":[{"a":1},{"b  → 上面两种情况叠加
 */
function closeUp(s, start, info) {
  let body = s.slice(start);
  const stack = Array.isArray(info.stack) ? [...info.stack] : [];

  if (info.inStr) {
    // 引号没闭合，要分清断在哪：
    //   (a) 值断尾  {"a":"李老        → 补上引号，这段保住了
    //   (b) key 没写完  {"a":1},{"the   → 连同这个半截元素一起丢，抢救前面的
    // 区分办法：回溯到本层最后一个分隔符，看它后面有没有冒号。没有冒号 = 是半截 key。
    const lastSep = Math.max(body.lastIndexOf('{'), body.lastIndexOf('['), body.lastIndexOf(','));
    if (lastSep !== -1 && !body.slice(lastSep + 1).includes(':')) {
      const sepChar = body[lastSep];
      body = body.slice(0, lastSep);
      if (sepChar === '{' || sepChar === '[') stack.pop();
    } else {
      body += '"';
    }
  }

  // 尾部悬空的逗号要去掉，否则补出来的 {"a":1,} 仍然非法
  body = body.replace(/,(\s*)$/, '$1');

  // 悬空的 key（{"a":）必须补一个值，否则 {"a":} 非法
  if (/(^|[,{])\s*"[^"]*"\s*:\s*$/.test(body)) body += 'null';

  // 逆序闭合：最后打开的最先关
  for (let k = stack.length - 1; k >= 0; k--) {
    body += stack[k] === '{' ? '}' : ']';
  }
  return body;
}

/**
 * 主入口。
 * @param {string} raw 大模型原始输出
 * @param {object} [opts] { prefer: 'object'|'array'|null }
 * @returns {{ok:boolean, value:any, repaired:boolean, note:string}}
 */
export function repairJson(raw, opts = {}) {
  const clean = stripNoise(raw);
  if (!clean) return { ok: false, value: null, repaired: false, note: 'empty output' };

  // 1) 直接解析
  try {
    const v = JSON.parse(clean);
    return { ok: true, value: v, repaired: false, note: 'clean' };
  } catch (e) {
    /* 继续尝试修复 */
  }

  const start = findStart(clean);
  if (start === -1) {
    return { ok: false, value: null, repaired: false, note: 'no json start' };
  }

  // 2) 只切掉前缀废话后重试（例如"好的，以下是结果：{...}"）
  const headTrimmed = clean.slice(start);
  try {
    const v = JSON.parse(headTrimmed);
    return { ok: true, value: v, repaired: true, note: 'trimmed prefix' };
  } catch { /* 继续 */ }

  // 3) 补全再试
  const info = scan(headTrimmed, 0);
  if (info.mismatch) {
    return { ok: false, value: null, repaired: false, note: 'bracket mismatch' };
  }
  if (info.complete) {
    // 理论上不该走到这里（上面已 parse 过），兜底再试一次
    try {
      return { ok: true, value: JSON.parse(headTrimmed.slice(0, info.end)), repaired: true, note: 'bounded' };
    } catch (e) {
      return { ok: false, value: null, repaired: false, note: 'unparsable: ' + e.message };
    }
  }

  const repairedText = closeUp(headTrimmed, 0, info);
  try {
    const v = JSON.parse(repairedText);
    return { ok: true, value: v, repaired: true, note: 'repaired truncated json' };
  } catch (e) {
    // 极端情况：最后一个对象本身残缺严重（key:value 都没写完），
    // 退化到"丢掉最后半个元素"，抢救前面已经完整的部分
    try {
      const salvaged = salvagePartial(headTrimmed, info);
      if (salvaged) {
        return { ok: true, value: salvaged, repaired: true, note: 'salvaged partial array' };
      }
    } catch { /* ignore */ }
    return { ok: false, value: null, repaired: false, note: 'repair failed: ' + e.message };
  }
}

/**
 * 抢救数组型输出：丢掉最后一个残缺元素，保留前面完整的。
 * 典型：[{"a":1},{"b":"xxx   → [{"a":1}]
 */
function salvagePartial(s, info) {
  if (!s.startsWith('[')) return null;
  const lastComma = s.lastIndexOf(',');
  if (lastComma === -1) return null;
  const head = s.slice(0, lastComma);
  const dropped = closeUp(head, 0, { stack: ['['], inStr: false });
  const v = JSON.parse(dropped);
  if (!Array.isArray(v) || v.length === 0) return null;
  return v;
}

/**
 * 从任意结构里取 segments 数组，容忍模型把结构套了一层。
 * 支持：{segments:[…]} / {data:{segments:[…]}} / {result:{segments:[…]}} / 裸数组
 */
export function pickSegments(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.segments)) return value.segments;
  for (const k of ['data', 'result', 'output', 'response']) {
    if (value[k] && Array.isArray(value[k].segments)) return value[k].segments;
  }
  return null;
}

export default repairJson;
