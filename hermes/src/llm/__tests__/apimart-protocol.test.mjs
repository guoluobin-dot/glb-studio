/**
 * APIMart 接入的回归测试
 *
 * 背景（2026-10-05）：按 APIMart 官方文档核对后，发现接入有一处致命不一致 ——
 *
 *   文档里的成功响应是**套了一层信封**的：
 *     Gemini 原生： { "code": 200, "data": { "candidates": [...] } }
 *     OpenAI 兼容： { "code": 200, "data": { "choices": [...] } }
 *
 *   而代码直接读顶层：data?.candidates / data?.choices → 永远 undefined。
 *
 * 这个 bug 极其隐蔽：不会报"字段错"，只是取内容拿到 undefined，
 * 最后抛一句"未返回内容"，看起来像"模型没说话"，实际是取错了层级。
 * 也就是说 key 再对、模型再对，每一次云端调用都会失败。
 *
 * 另外两处：
 *   - 模型名写死且不在服务商列表里（配的是 gemini-3.5-flash-lite，
 *     而文档只提供 gemini-3.5-flash / gemini-3.1-pro-preview /
 *     gemini-3-pro-preview / gemini-2.5-pro）→ 每次调用 404
 *   - 认证方式：APIMart 的 Gemini 原生用 Authorization: Bearer，
 *     而 Google 官方原生用 ?key=。协议和认证是两个维度，不能混。
 *
 * 本文件里的报文全部照抄文档的 ResponseExample，用来锁住这三件事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeminiClient } from '../gemini.js';

const src = readFileSync(join(process.cwd(), 'src/llm/gemini.js'), 'utf8');

/** 按配置造一个客户端 */
const mk = (gemini) => new GeminiClient({ gemini: { apiKey: 'k', ...gemini } });

// ── 文档里的真实报文（逐字照抄 ResponseExample）──
const DOC_GEMINI_ENVELOPED = {
  code: 200,
  data: {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: '你好！很高兴能向你介绍我自己。' }]
        },
        finishReason: 'STOP',
        index: 0,
        safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }]
      }
    ],
    promptFeedback: { safetyRatings: [] }
  },
  usageMetadata: {
    promptTokenCount: 4,
    candidatesTokenCount: 611,
    totalTokenCount: 2422,
    thoughtsTokenCount: 1807
  }
};

// 官方 Google 原生：不套信封。两种都得能解。
const DOC_GEMINI_BARE = {
  candidates: [{ content: { role: 'model', parts: [{ text: '原生响应' }] } }]
};

// OpenAI 兼容 + 信封（文档截图里的 /v1/chat/completions 200）
const DOC_OAI_ENVELOPED = {
  code: 200,
  data: {
    id: 'chatcmpl-9876543210',
    object: 'chat.completion',
    created: 1677652288,
    model: 'gpt-5',
    choices: [{ index: 0, message: { role: 'assistant', content: '人工智能的发展历史' } }]
  }
};

test('能剥掉 {code,data} 信封取到 Gemini 正文', () => {
  // 用真实的类方法验证，而不是只匹配源码文本 —— 报文才是关键
  const c = mk({ protocol: 'gemini-native', auth: 'bearer', baseUrl: 'https://x/v1beta', model: 'gemini-3.5-flash' });
  assert.equal(c._extractText(DOC_GEMINI_ENVELOPED), '你好！很高兴能向你介绍我自己。');
});

test('官方无信封的响应不能被误剥', () => {
  const c = mk({ protocol: 'gemini-native', baseUrl: 'https://x/v1beta' });
  // 这是回归的重点：剥信封不能变成"无脑剥一层"
  assert.equal(c._extractText(DOC_GEMINI_BARE), '原生响应');
});

test('OpenAI 兼容 + 信封也要能取到 choices[0].message.content', () => {
  const c = mk({ protocol: 'openai-compatible', baseUrl: 'https://api.apimart.ai/v1' });
  assert.equal(c._extractText(DOC_OAI_ENVELOPED), '人工智能的发展历史');
});

test('模型自己的 data 字段不能被当成信封剥掉', () => {
  const c = mk({ protocol: 'gemini-native', baseUrl: 'https://x/v1beta' });
  // 内层既没有 candidates 也没有 choices → 判定不是信封，原样返回
  const payload = { candidates: [{ content: { parts: [{ text: 'x' }] } }], data: { note: '字段叫 data 但不是信封' } };
  assert.equal(c._extractText(payload), 'x');
});

test('usage 能穿过信封读到，且 thoughtsTokenCount 不丢', () => {
  const c = mk({ protocol: 'gemini-native', baseUrl: 'https://x/v1beta' });
  const u = c._usage(DOC_GEMINI_ENVELOPED);
  assert.equal(u.total, 2422);
  assert.equal(u.prompt, 4);
  assert.equal(u.completion, 611);
  assert.equal(u.thoughts, 1807);
});

test('认证方式与协议解耦：APIMart 原生走 Bearer，不带 ?key=', () => {
  const c = mk({
    apiKey: 'SECRET', protocol: 'gemini-native', auth: 'bearer',
    baseUrl: 'https://api.apimart.ai/v1beta', model: 'gemini-2.5-pro'
  });
  const r = c._request('models/gemini-2.5-pro:generateContent');
  assert.equal(r.url, 'https://api.apimart.ai/v1beta/models/gemini-2.5-pro:generateContent');
  assert.equal(r.headers.Authorization, 'Bearer SECRET');
  assert.ok(!r.url.includes('key='), 'Bearer 模式下绝不能把 key 拼进 query');
  assert.ok(!r.url.includes('SECRET'), '任何模式下都不能把 key 泄进 URL');
});

test('不写 auth 时按协议给默认，不影响已在跑的接入', () => {
  // Google 官方原生：默认仍是 ?key=
  const g = mk({ protocol: 'gemini-native' });
  assert.equal(g.auth, 'query-key');
  assert.ok(g._request('models/x:generateContent').url.includes('key=k'));
  // OpenAI 兼容：默认 Bearer
  const o = mk({ protocol: 'openai-compatible' });
  assert.equal(o.auth, 'bearer');
});

test('重试只给"重试有可能变好"的错误', () => {
  const c = mk({ protocol: 'openai-compatible' });
  // 可重试：限流 + 服务端临时故障
  assert.equal(c._isRetryable('被限流或额度用尽（HTTP 429 / RESOURCE_EXHAUSTED）'), true);
  assert.equal(c._isRetryable('云端服务异常（HTTP 503）：网关错误'), true);
  assert.equal(c._isRetryable('云端服务异常（HTTP 502）'), true);
  assert.equal(c._isRetryable('fetch failed'), true);
  // 不可重试：重试只是白花钱或白等
  assert.equal(c._isRetryable('云端账户余额不足（HTTP 402 / PAYMENT_REQUIRED）'), false);
  assert.equal(c._isRetryable('云端没有这个模型（HTTP 404 / NOT_FOUND）'), false);
  assert.equal(c._isRetryable('云端拒绝了鉴权（HTTP 401）'), false);
  assert.equal(c._isRetryable('请求参数不对（HTTP 400）'), false);
});

test('health 必须校验配置里的模型是否真实存在', () => {
  // 以前 health 只报"连上了 + 有几个模型"，模型名写错也看不出来，
  // 结果是界面一切正常、每次调用都 404。
  assert.match(src, /配置里的模型/, 'health 必须核对模型名');
  const i = src.indexOf('async health()');
  const seg = src.slice(i, i + 2200);
  assert.match(seg, /models\.includes\(this\.model\)/, '必须真的比对模型列表');
  assert.match(seg, /_unwrapEnvelope\(data\)/, '模型列表也要剥信封');
});

test('看图失败必须留日志，不能静默', () => {
  // 以前 catch { return null } 把所有原因都吞了，
  // 中转站不支持图片模型时只表现为"视觉分析没结果"，无从查起。
  const i = src.indexOf('async describe(');
  const j = src.indexOf('async embed(', i);          // 到下一个方法为止，别越界
  assert.ok(i > 0 && j > i, '要能框出 describe 的函数体');
  const seg = src.slice(i, j);
  assert.doesNotMatch(seg, /\}\s*catch\s*\{\s*return null/, 'describe 不能空 catch');
  assert.match(seg, /_visionWarned/, '要复用只警告一次的开关');
  assert.match(seg, /console\.warn/, '失败必须留下可查的日志');
  assert.match(seg, /回落/, '日志要说清回落到哪');
});

test('模型名不许是凭空猜的：要么文档列了，要么这个 key 真能调通', () => {
  /*
   * 这里的教训是：光靠文档那份清单会漏。
   * APIMart 文档的"Path Parameters"只列了 gemini-3.5-flash / gemini-3.1-pro-preview /
   * gemini-3-pro-preview / gemini-2.5-pro，但我实测这个账号的授权模型列表里
   * **还有** gemini-3.5-flash-lite（控制台也显示限制的是 -lite）。
   * 也就是说"文档没写"不等于"不存在"，改名后的型号也可能只在账号授权里出现。
   *
   * 所以这里只锁两件事：
   *   1. 模型名不能为空 / 不能是占位符
   *   2. health() 必须拿账号的真实模型列表做校验（见上面那条）
   * 至于某个具体型号对不对，取决于你的账号授权 —— 那是配置问题，不是代码问题，
   * 真配错了 health() 会直接把可用列表报出来。
   */
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config/default.json'), 'utf8'));
  const m = cfg.gemini?.model;
  assert.ok(typeof m === 'string' && m.trim().length > 0, '必须配了模型名');
  assert.doesNotMatch(m, /your[-_ ]?key|xxx|changeme|模型名/i, '不能是占位符');
  assert.match(m, /^gemini-[\w.\-]+$/, `模型名不像一个 gemini 型号：${m}`);
});

test('生产配置不得再有明文 key', () => {
  const cfg = readFileSync(join(process.cwd(), 'config/default.json'), 'utf8');
  assert.doesNotMatch(cfg, /sk-[A-Za-z0-9]{20,}/, 'config 里不能有明文 key');
});
// ── 第三个坑：默认流式（SSE）──
// APIMart 的"通用对话接口"文档标题就写着**默认流式**。
// 不显式传 stream:false，它就返回 SSE 文本（每行 data: {...}），
// res.json() 直接抛：
//     Unexpected token 'd', "data: {"id"... is not valid JSON
// 这个报错完全看不出是协议没配对，很容易被当成 key 或模型的问题去查。
test('OpenAI 兼容请求必须显式声明非流式', () => {
  const i = src.indexOf('const isOai = this.protocol');
  const seg = src.slice(i, i + 1400);
  assert.match(seg, /stream:\s*false/, '必须带 stream:false，否则服务端按默认流式返回');
});

test('真的收到流式(SSE)响应也要能拼出正文', () => {
  const c = mk({ protocol: 'openai-compatible', baseUrl: 'https://api.apimart.ai/v1' });
  // 按 SSE 格式拼的流式响应（APIMart 默认流式时的真实形状）
  const sse = [
    'data: {"id":"chatcmpl-1","model":"gemini-3.5-flash-lite","choices":[{"index":0,"delta":{"content":"声乐"}}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"gemini-3.5-flash-lite","choices":[{"index":0,"delta":{"content":"演唱"}}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"gemini-3.5-flash-lite","choices":[{"index":0,"delta":{"content":"技巧"}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const parsed = c._parseBody(sse);
  assert.equal(c._extractText(parsed), '声乐演唱技巧');
});

test('正常 JSON 响应不受影响，且 [DONE] 不会混进结果', () => {
  const c = mk({ protocol: 'openai-compatible', baseUrl: 'https://api.apimart.ai/v1' });
  assert.equal(c._extractText(c._parseBody(JSON.stringify(DOC_OAI_ENVELOPED))), '人工智能的发展历史');
  // 完整对象式流（有些网关只发一次完整体）也要认
  const once = 'data: ' + JSON.stringify({ choices: [{ message: { content: '完整体' } }] }) + '\n\ndata: [DONE]';
  assert.equal(c._extractText(c._parseBody(once)), '完整体');
});

test('既不是 JSON 也不是 SSE 时要说清，不能静默', () => {
  const c = mk({ protocol: 'openai-compatible' });
  assert.throws(() => c._parseBody('<html>502 Bad Gateway</html>'), /不是合法 JSON|流式/);
});