import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithDiagnostics } from '../proxy.js';
import { makeRequestController } from '../abort.js';
import { GeminiClient } from '../gemini.js';
import { AutoClient } from '../router.js';

/*
 * 回归：用户取消被翻译成"超时"→ 白烧两轮退避重试 → 云端链路被拉黑 10 分钟（2026-10-21）
 * ──────────────────────────────────────────────────────────
 * 根因链：proxy.js 把 AbortError 一律 new Error("连接 xxx 超时") —— name 变成 'Error'，
 * gemini.js 的 `err.name === 'AbortError' || err?.userCancelled` 取消分支永远进不去；
 * 文案里的"超时"正好命中 _isRetryable，于是取消被当成故障退避重试；
 * 重试到头 router.markFailed('gemini','超时') 一路上报故障，云端被拉黑十分钟。
 *
 * 修法：makeRequestController 在 controller 上记 _abortedBy（user/timeout），
 * fetchWithDiagnostics 按原因分流：用户取消 → name='AbortError' + userCancelled=true；
 * 真超时 → name='TimeoutError'。这套测试把三段语义都钉死。
 */

// 一个"接受连接但永远不回话"的本地服务：让请求真的挂在网络上，超时/取消都走真路
let server = null;
let baseUrl = '';
before(() => {
  server = http.createServer(() => { /* 故意不响应 */ });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/chat`;
      resolve();
    });
  });
});
after(() => new Promise((resolve) => server.close(resolve)));

test('【回归】外部 signal 取消 → 必须保留 AbortError 身份 + userCancelled，不许报"超时"', async () => {
  const ext = new AbortController();
  const { controller, detach } = makeRequestController(ext.signal, 60000);
  const p = fetchWithDiagnostics(baseUrl, { signal: controller.signal }, 30000);
  ext.abort(); // 模拟用户点"取消"
  const err = await p.then(() => null, (e) => e);
  detach();
  assert.ok(err, '必须 reject 才有取消可言');
  assert.equal(err.name, 'AbortError', `取消的错误必须叫 AbortError（实际: ${err.name}）`);
  assert.equal(err.userCancelled, true, '必须带 userCancelled 标记，gemini 的取消分支靠它认人');
  assert.doesNotMatch(err.message, /超时/, '用户取消的文案不许再含"超时"');
  assert.match(err.message, /已取消/);
});

test('【回归】合并 controller 自己的计时器到点 → 必须是 TimeoutError，不许冒充取消', async () => {
  const { controller, detach } = makeRequestController(null, 60);
  const err = await fetchWithDiagnostics(baseUrl, { signal: controller.signal }, 30000)
    .then(() => null, (e) => e);
  detach();
  assert.ok(err, '超时必须 reject');
  assert.equal(err.name, 'TimeoutError', `超时的错误必须叫 TimeoutError（实际: ${err.name}）`);
  assert.equal(err.userCancelled, undefined, '超时不是用户取消，不能带 userCancelled');
  assert.match(err.message, /超时/);
});

test('【回归】_isRetryable：取消不许重试，超时允许重试', () => {
  const g = Object.create(GeminiClient.prototype);
  assert.equal(g._isRetryable('已取消：请求被调用方终止（api.example.com）。这是正常停止，不是故障。'), false, '取消不是故障');
  assert.equal(g._isRetryable('连接 chat.example.com 超时（600s）。'), true, '超时按故障退避重试');
});

function makeAuto() {
  const config = {
    llm: { provider: 'gemini' },
    gemini: { apiKey: 'test-key', model: 'gemini-test' },
    ollama: { baseUrl: 'http://127.0.0.1:9', chatModel: 'offline-m', embeddingModel: '' },
  };
  const auto = new AutoClient(config);
  auto.local = {
    // 正常回落路径应使用的哨兵：取消路径一旦走到这里，断言立刻能分辨
    generate: async () => 'LOCAL-SENTINEL',
  };
  return auto;
}

test('【回归】router._call：取消必须原样上抛，不许 markFailed / 换路 / 回落本地', async () => {
  const auto = makeAuto();
  let markFailedCalls = 0;
  auto._chain = { markFailed: () => { markFailedCalls++; } };
  auto._cloud = { generate: async () => {
    const e = new Error('已取消：请求被调用方终止（api.example.com）。这是正常停止，不是故障。');
    e.name = 'AbortError';
    e.userCancelled = true;
    throw e;
  } };
  await assert.rejects(
    auto._call('generate', ['sys', 'usr']),
    (e) => e.userCancelled === true,
    '取消错误必须原样抛给调用方'
  );
  assert.equal(markFailedCalls, 0, '取消不能拉黑通道');
});

test('【回归】云端真故障才拉黑（取消路径不触发），判死带时间戳供冷却复位', async () => {
  const auto = makeAuto();
  auto._chain = {
    markFailed: () => {},
    list: () => [],
    pick: async () => null, // 备路也全坏
  };
  auto._cloud = { generate: async () => { throw new Error('HTTP 500 服务异常'); } };
  const out = await auto._call('generate', ['sys', 'usr']); // 应回落本地哨兵
  assert.equal(out, 'LOCAL-SENTINEL', '真故障应回落本地');
  assert.equal(auto._cloudUsable, false, '故障后云端应判死');
  assert.ok(auto._cloudFailAt > 0, '判死必须带时间戳（冷却靠它复位）');
  // 注：粘滞 _cloudUsable 只在 provider=auto 时闸引擎选择；显式 gemini 不受它限。
  // 「冷却到期重新放行」的语义单由 auto 场景钉住（下一个用例）。
});

test('【回归】provider=auto 时判死冷却到期也会重新放行（长素材场景）', async () => {
  const config = {
    llm: { provider: 'auto' },
    gemini: { apiKey: 'test-key', model: 'gemini-test' },
    ollama: { baseUrl: 'http://127.0.0.1:9', chatModel: 'offline-m', embeddingModel: '' },
  };
  const auto = new AutoClient(config);
  auto.setTaskScope({ durationSec: 11220, transcriptChars: 38479 }); // 3 小时长直播 → auto 会选云端
  auto._cloudUsable = false;          // 模拟此前判死
  auto._cloudFailAt = Date.now() - (11 * 60 * 1000); // 冷却早已过
  const plan = auto._plan();
  assert.equal(auto._cloudUsable, undefined, '冷却到期必须复位 _cloudUsable');
  assert.equal(plan.engine, 'gemini', '冷却到期后长素材应重新考虑云端');
});
