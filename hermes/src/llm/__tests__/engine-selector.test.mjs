/**
 * 内容形态判别 + 引擎分派 单元测试
 * © 2026 郭洛斌
 *
 * 这套阈值决定"要不要花云端额度",判错就是钱白花或用户干等。
 *
 * 实测校准(2026-09-30):一场 3 小时直播 = 552 段 / 38,479 字 ≈ 25,653 token,
 * 并未超出 qwen3:8b 的 40,960 窗口,但本地分析跑了 40 分钟仍未出结果(GPU 96%)。
 * 结论:真正的瓶颈是"等多久",不只是"装不装得下"。所以判别必须同时看容量与速度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContent, pickEngineFor } from '../engine-selector.js';

/* ---------- 短片段型:本地 ---------- */

test('带货短片段(几十字)走本地', () => {
	const shape = classifyContent({ durationSec: 40, segments: [{ text: '这个真的只要九块九,家人们赶紧下单' }] });
	assert.equal(shape.kind, 'short-clip');
});

test('卖课短片段(1.2k 字)走本地', () => {
	const text = '这套方法论我讲了三期,核心就一句话:先做减法再加法。'.repeat(30);
	const shape = classifyContent({ durationSec: 240, segments: [{ text }] });
	assert.equal(shape.kind, 'short-clip');
});

test('25 分钟 9k 字：窗口够大时本地跑得完，不烧额度', () => {
  // 2026-10-05：这条原本就通过，是因为当时分派器以为本地有 46k 窗口。
  // 修掉那个 bug 后门槛跟着真实窗口走，9,000 字在 8k 窗口下已贴边，
  // 所以这里显式给一份放大窗口的配置，验证「窗口够大时确实走本地」。
  const shape = classifyContent({ durationSec: 25 * 60, transcriptChars: 9000 }, { performance: { heavyCtx: 32768 } });
  assert.equal(shape.kind, 'short-clip');
});

test('窗口不够时必须走云端，绝不能静默截断', () => {
  // 2026-10-05 新增：本次修的核心不变量。
  // 原来分派器用「模型能力 40,960 tok」当门槛，而实际只请求 8,192 tok，
  // 于是 3 万字被判「本地够用」，进去只读了约 9,216 字、后面全被丢掉，且不报错。
  // 修完之后：窗口按配置算，超了必须走云端。
  const cfg = { performance: { heavyCtx: 8192 } };
  for (const chars of [38479, 60000, 90000]) {
    const shape = classifyContent({ durationSec: 3 * 3600, transcriptChars: chars }, cfg);
    assert.equal(shape.kind, 'long-form', chars + ' 字在 8k 窗口下必须判 long-form');
  }
});

/* ---------- 长直播:云端 ---------- */

test('3 小时 38k 字(实测素材)：真实窗口下就是装不下，走云端', () => {
  // 2026-10-05：原断言是 overflowRatio < 1（「装得下但太慢」），
  // 那建立在「本地有 46k 字窗口」的错误前提上。实测本地只请求 8,192 tok
  // 约合安全 9,216 字，38,479 字是它的 4 倍多 —— 不只是慢，是根本读不下。
  // 这个更正很重要：以前这类素材会走本地，然后被静默截断。
  const shape = classifyContent({ durationSec: 11220, transcriptChars: 38479 }, { performance: { heavyCtx: 8192 } });
  assert.equal(shape.kind, 'long-form');
  assert.ok(shape.overflowRatio > 1, '38,479 字远超 8k 窗口');
});

test('5 小时 6 万字:超出本地窗口,必须云端', () => {
	const shape = classifyContent({ durationSec: 18000, transcriptChars: 60000 });
	assert.equal(shape.kind, 'long-form');
	assert.ok(shape.overflowRatio > 1);
	assert.match(shape.reason, /装不下|倍/);
});

test('10 分钟但文本量爆表(高密度快语速)也走云端', () => {
	const shape = classifyContent({ durationSec: 600, transcriptChars: 90000 });
	assert.equal(shape.kind, 'long-form');
});

/* ---------- 边界 ---------- */

test('长视频但几乎无语音(纯画面)不浪费云端额度', () => {
	const shape = classifyContent({ durationSec: 45 * 60, transcriptChars: 2000 });
	assert.equal(shape.kind, 'short-clip');
	assert.match(shape.reason, /本地/);
});

test('空素材不崩', () => {
	const shape = classifyContent({ durationSec: 0, segments: [] });
	assert.equal(shape.kind, 'short-clip');
	assert.equal(shape.transcriptChars, 0);
});

/* ---------- 引擎分派 ---------- */

const shortShape = classifyContent({ durationSec: 40, transcriptChars: 200 });
const longShape = classifyContent({ durationSec: 11220, transcriptChars: 38479 });

test('auto + 短片段 -> 本地(不烧云端额度)', () => {
	assert.equal(pickEngineFor({ llm: { provider: 'auto' } }, shortShape).engine, 'ollama');
});

test('auto + 长直播 -> 长上下文引擎', () => {
	assert.equal(pickEngineFor({ llm: { provider: 'auto' } }, longShape).engine, 'gemini');
});

test('未配置 provider 时等同 auto', () => {
	assert.equal(pickEngineFor({}, shortShape).engine, 'ollama');
});

test('用户强制 ollama 时尊重设置', () => {
	const plan = pickEngineFor({ llm: { provider: 'ollama' } }, longShape);
	assert.equal(plan.engine, 'ollama');
});

test('用户强制 gemini 时尊重设置', () => {
	const plan = pickEngineFor({ llm: { provider: 'gemini' } }, shortShape);
	assert.equal(plan.engine, 'gemini');
});
