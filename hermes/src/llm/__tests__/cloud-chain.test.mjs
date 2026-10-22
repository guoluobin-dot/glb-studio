/**
 * 云端链路：多路候选 + 故障转移 + 冷却复活。
 *
 * 2026-10-12 加。实测背景：APIMart 的 key 被拒（401 invalid API key），
 * 而"云端只有一路"意味着这一路挂掉 = 长直播全部回落本地，
 * 用户唯一的出路是手工换 key，换的过程中系统全程瘫着。
 *
 * 这里钉死三件事：
 *   1) 候选顺序：gemini（含中转）→ deepseek → 自定义 relay[]
 *   2) 故障转移：第一路不健康时自动选下一路，而不是直接回落本地
 *   3) 冷却复活：判死的路不会永久拉黑，冷却期过后重新纳入探测
 *      （key 失效常常是暂时的——余额充值、限流、临时故障）
 *
 * 不 import 真客户端：本测试用假的 client 对象验证编排逻辑，不发网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudChain, buildCloudCandidates, cloudSummary } from '../cloud-chain.js';

/** 造一个假的候选：health() 按脚本返回 */
function fakeCandidate(name, { ok, error = null, healthError = null } = {}) {
  const c = { name, kind: 'test', client: null };
  c.client = {
    model: `${name}-model`,
    baseUrl: `https://${name}.example/v1`,
    health: async () => {
      if (healthError) throw new Error(healthError);
      return { ok, error, models: ok ? ['a', 'b'] : [] };
    },
  };
  return c;
}

function chainWith(cands) {
  const ch = new CloudChain({});
  ch.candidates = cands;
  return ch;
}

test('第一路不通时自动选第二路，而不是回落', async () => {
  const ch = chainWith([fakeCandidate('bad', { ok: false, error: 'invalid API key' }), fakeCandidate('good', { ok: true })]);
  const picked = await ch.pick();
  assert.equal(picked.name, 'good');
});

test('第一路可用时就用第一路（不做无谓切换）', async () => {
  const ch = chainWith([fakeCandidate('good1', { ok: true }), fakeCandidate('good2', { ok: true })]);
  assert.equal((await ch.pick()).name, 'good1');
});

test('health() 抛异常也算不通，且被记录下来', async () => {
  const ch = chainWith([fakeCandidate('boom', { healthError: 'connect ETIMEDOUT' }), fakeCandidate('good', { ok: true })]);
  assert.equal((await ch.pick()).name, 'good');
  assert.match(ch.state.get('boom').error, /ETIMEDOUT/);
});

test('全部不通时返回 null（调用方据此回落本地）', async () => {
  const ch = chainWith([fakeCandidate('a', { ok: false, error: 'x' }), fakeCandidate('b', { ok: false, error: 'y' })]);
  assert.equal(await ch.pick(), null);
});

test('判死的路进入冷却，不会每轮都重试一次超时', async () => {
  let calls = 0;
  const bad = fakeCandidate('bad', { ok: false, error: 'invalid API key' });
  bad.client.health = async () => { calls++; return { ok: false, error: 'invalid API key', models: [] }; };
  const ch = chainWith([bad, fakeCandidate('good', { ok: true })]);
  await ch.pick();
  await ch.pick();
  await ch.pick();
  assert.equal(calls, 1, '冷却期内不应重复探测');
});

test('冷却期过后重新纳入（key 充值/恢复后能自动复活）', async () => {
  let healthy = true;
  let calls = 0;
  const ch = chainWith([fakeCandidate('flaky', { ok: true }), fakeCandidate('other', { ok: true })]);
  ch.candidates[0].client.health = async () => { calls++; return healthy ? { ok: true, models: ['a'] } : { ok: false, error: '401', models: [] }; };
  // 两路都健康时应当先用第一路
  assert.equal((await ch.pick()).name, 'flaky');
  // 第一路开始报错 → 立刻拉黑并顺延到第二路
  healthy = false;
  ch.markFailed('flaky', '401');
  assert.equal((await ch.pick()).name, 'other');
  // 服务恢复 + 探测 TTL 过期 → 重新纳入，第一路重新可用
  healthy = true;
  ch.lastProbe = 0;
  assert.equal((await ch.pick()).name, 'flaky');
  assert.ok(calls >= 2, `应重新探测过，实际 ${calls} 次`);
});

test('markFailed 只影响出错的那一路，不牵连别人', async () => {
  const ch = chainWith([fakeCandidate('a', { ok: true }), fakeCandidate('b', { ok: true })]);
  await ch.pick();
  ch.markFailed('a', 'boom');
  assert.equal(ch.state.get('a').ok, false);
  assert.equal(ch.state.get('b').ok, true, 'b 不该被牵连');
  assert.equal((await ch.pick()).name, 'b');
});

test('没有配置任何云端通道时，诊断要说清楚是"没配"而不是"不通"', () => {
  const s = cloudSummary({}, []);
  assert.equal(s.usable, 0);
  assert.match(s.verdict, /没有配置/);
});

test('多路里只要有一路通，摘要就报"可用：xxx"', () => {
  const s = cloudSummary({}, [{ name: 'deepseek', ok: true }, { name: 'gemini', ok: false }]);
  assert.equal(s.usable, 1);
  assert.match(s.verdict, /可用：deepseek/);
});

test('buildCloudCandidates：key 是 {env:占位符} 时靠环境变量取值', () => {
  process.env.__TEST_RELAY_KEY = 'sk-test-123';
  const cands = buildCloudCandidates({ llm: { relay: [{ name: 'r1', baseUrl: 'https://x/v1', apiKey: 'plain-key' }] }, gemini: {} });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].name, 'r1');
  delete process.env.__TEST_RELAY_KEY;
});

test('buildCloudCandidates：缺 baseUrl 或 key 的中转直接跳过，不进链路', () => {
  const cands = buildCloudCandidates({
    llm: { relay: [{ name: 'no-key' }, { baseUrl: 'https://y/v1' }, { name: 'ok', baseUrl: 'https://z/v1', apiKey: 'k' }] },
  });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].name, 'ok');
});