/**
 * 云端协议适配：gemini-native 与 openai-compatible。
 *
 * 为什么必须测这个:两套协议的路径、认证头、请求体、响应结构完全不同。
 * 只改 baseUrl 去接中转是行不通的 —— 请求会打到不存在的路径上，
 * 表现为 401/404，而报错完全看不出是协议不对。
 *
 * 用假 fetch 捕获真实请求，逐项断言；不需要网络和 key。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GeminiClient } from "../../llm/gemini.js";

/**
 * 装一个假 fetch，捕获请求并返回指定响应。
 *
 * 必须是 async：里面要 await 被测的 chat()，而 finally 里恢复 fetch 也要等
 * 这次调用真正结束 —— 否则会出现"fetch 已经被换回去了"或
 * "Promise 在测试结束后才 reject"这种看不懂的报错。
 */
async function withFetch(response, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok !== false,
      status: response.status ?? 200,
      json: async () => response.json,
      text: async () => JSON.stringify(response.json)
    };
  };
  try {
    const value = await fn();
    return { calls, result: value };
  } catch (err) {
    return { calls, result: undefined, error: err };
  } finally {
    globalThis.fetch = orig;
  }
}

const cfgNative = {
  gemini: { apiKey: "KEY-NATIVE", model: "gemini-3.5-flash-lite", protocol: "gemini-native", baseUrl: "" }
};
const cfgOai = {
  gemini: {
    apiKey: "KEY-OAI",
    model: "gemini-3.5-flash-lite",
    protocol: "openai-compatible",
    baseUrl: "https://api.apimart.ai/v1"
  }
};

test("gemini-native: ?key= 认证 + :generateContent 路径", async () => {
  const client = new GeminiClient(cfgNative);
  const { calls } = await withFetch({ json: { candidates: [{ content: { parts: [{ text: "原生回复" }] } }] } }, () =>
    client.chat([{ role: "user", content: "你好" }])
  );
  const call = calls[0];
  assert.match(call.url, /generativelanguage\.googleapis\.com/);
  assert.match(call.url, /models\/gemini-3\.5-flash-lite:generateContent\?key=KEY-NATIVE/);
  // 原生协议不用 Authorization 头
  assert.equal(call.init.headers.Authorization, undefined);
  const body = JSON.parse(call.init.body);
  assert.ok(Array.isArray(body.contents), "原生协议用 contents");
  assert.equal(body.generationConfig.maxOutputTokens > 0, true);
});

test("openai-compatible: Bearer 认证 + /chat/completions 路径", async () => {
  const client = new GeminiClient(cfgOai);
  const { calls } = await withFetch({ json: { choices: [{ message: { content: "中转回复" } }] } }, () =>
    client.chat([{ role: "user", content: "你好" }])
  );
  const call = calls[0];
  assert.match(call.url, /^https:\/\/api\.apimart\.ai\/v1\/chat\/completions/);
  // 关键差异：key 走 Authorization 头，不是查询参数
  assert.equal(call.init.headers.Authorization, "Bearer KEY-OAI");
  assert.equal(/[?&]key=/.test(call.url), false, "OpenAI 兼容不能把 key 放查询串里");
  const body = JSON.parse(call.init.body);
  assert.ok(Array.isArray(body.messages), "OpenAI 兼容用 messages");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.max_tokens > 0, true, "maxOutputTokens 要映射成 max_tokens");
});

test("system 消息在两种协议里都要落到正确位置", async () => {
  const native = new GeminiClient(cfgNative);
  const r1 = await withFetch({ json: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }, () =>
    native.chat([{ role: "system", content: "你是助手" }, { role: "user", content: "问题" }])
  );
  const b1 = JSON.parse(r1.calls[0].init.body);
  assert.ok(b1.systemInstruction, "原生协议用 systemInstruction");
  assert.equal(b1.contents.length, 1, "system 不应混进 contents");

  const oai = new GeminiClient(cfgOai);
  const r2 = await withFetch({ json: { choices: [{ message: { content: "ok" } }] } }, () =>
    oai.chat([{ role: "system", content: "你是助手" }, { role: "user", content: "问题" }])
  );
  const b2 = JSON.parse(r2.calls[0].init.body);
  assert.equal(b2.messages[0].role, "system");
  assert.equal(b2.messages[1].role, "user");
});

test("空回复要报错并带上协议名（不然看不出是协议不对还是 key 不对）", async () => {
  const oai = new GeminiClient(cfgOai);
  const r = await withFetch({ json: { choices: [{ message: { content: "" } }] } }, () =>
    oai.chat([{ role: "user", content: "hi" }])
  );
  assert.ok(r.error, "空回复应该抛错");
  assert.match(r.error.message, /openai-compatible/);
});

test("HTTP 错误要把状态码和协议一起报出来", async () => {
  const oai = new GeminiClient(cfgOai);
  const r = await withFetch({ ok: false, status: 401, json: { error: "invalid key" } }, () =>
    oai.chat([{ role: "user", content: "hi" }])
  );
  assert.ok(r.error, "非 2xx 应该抛错");
  assert.match(r.error.message, /401/);
  assert.match(r.error.message, /openai-compatible/);
});

test("看图:两种协议的图片格式不同", async () => {
  const native = new GeminiClient(cfgNative);
  const r1 = await withFetch({ json: { candidates: [{ content: { parts: [{ text: "图里有只猫" }] } }] } }, () =>
    native.describe([{ base64: "QUJD", mimeType: "image/png" }], "这是什么")
  );
  const b1 = JSON.parse(r1.calls[0].init.body);
  assert.ok(b1.contents[0].parts.some((p) => p.inlineData), "原生用 inlineData");

  const oai = new GeminiClient(cfgOai);
  const r2 = await withFetch({ json: { choices: [{ message: { content: "图里有只猫" } }] } }, () =>
    oai.describe([{ base64: "QUJD", mimeType: "image/png" }], "这是什么")
  );
  const b2 = JSON.parse(r2.calls[0].init.body);
  const content = b2.messages[0].content;
  assert.ok(Array.isArray(content), "OpenAI 兼容的 content 是数组");
  assert.ok(content.some((c) => c.type === "image_url"), "用 image_url 传图");
});

test("看图失败必须返回 null 而不是抛（调用方会回落本地视觉模型）", async () => {
  const oai = new GeminiClient(cfgOai);
  const r = await withFetch({ ok: false, status: 400, json: {} }, () =>
    oai.describe([{ base64: "QUJD" }], "x")
  );
  assert.equal(await r.result, null);
});

test("模型列表:两种协议的响应字段不同", async () => {
  const native = new GeminiClient(cfgNative);
  const h1 = (
    await withFetch({ json: { models: [{ name: "models/gemini-3.5-flash-lite" }] } }, () => native.health())
  ).result;
  assert.equal(h1.ok, true);
  assert.deepEqual(h1.models, ["gemini-3.5-flash-lite"], "原生要剥掉 models/ 前缀");

  const oai = new GeminiClient(cfgOai);
  const h2 = (await withFetch({ json: { data: [{ id: "gemini-3.5-flash-lite" }] } }, () => oai.health())).result;
  assert.equal(h2.ok, true);
  assert.deepEqual(h2.models, ["gemini-3.5-flash-lite"], "OpenAI 兼容读 data[].id");
});

test("健康检查要能区分『连不上』『key 错』『地址错』", async () => {
  const oai = new GeminiClient(cfgOai);
  const h = (await withFetch({ ok: false, status: 403, json: {} }, () => oai.health())).result;
  assert.equal(h.ok, false);
  assert.match(h.version, /openai-compatible/);

  // 原来是 assert.equal(h.error, "HTTP 403")。光一个状态码解决不了问题：
  // 403/401 既可能是 key 失效，也可能是拿错了协议或地址，而 404 完全是另一回事。
  // 三者的处理办法不同（换 key / 改设置），报错必须指出来，否则用户只能反复换 key。
  assert.match(h.error, /HTTP 403/, "要带状态码");
  assert.match(h.error, /key|鉴权|认证/i, "403 要指明是鉴权（key）问题，别让用户去查网络");
  assert.match(h.error, /不是网络问题/, "要明确排除网络方向，避免误判");

  // 404 是地址/协议错，措辞必须和 key 错区分开
  const h404 = (await withFetch({ ok: false, status: 404, json: {} }, () => oai.health())).result;
  assert.equal(h404.ok, false);
  assert.match(h404.error, /HTTP 404/);
  assert.match(h404.error, /\/v1|协议/, "404 要指向地址或协议，而不是 key");

  // health 还要带上代理信息：用户排查时最需要知道的就是"到底走没走代理"。
  // 这台机器开着 Clash 而 fetch 直连，表现为 key 失效，极难自查。
  assert.ok("proxy" in h, "health 要回报代理状态");
});

test("缺 key 必须在构造期就拒绝", async () => {
  // 构造成功而请求失败的话，auto 分派会以为云端可用，
  // 然后每一块分片都失败一次 —— 一次分析拖成几百次超时
  assert.throws(() => new GeminiClient({ gemini: { apiKey: "", protocol: "openai-compatible" } }), /Key/);
});

test("protocol 拼错要退回原生而不是变成未定义行为", async () => {
  const c = new GeminiClient({ gemini: { apiKey: "K", protocol: "乱写的" } });
  assert.equal(c.protocol, "gemini-native");
});
