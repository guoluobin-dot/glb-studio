/**
 * 请求取消：云端客户端必须真的认 options.signal。
 *
 * 2026-10-12 回归用例。真 bug：gemini.js / deepseek.js 只用自己的超时 controller，
 * 调用方（live-analyzer 等）传进来的 signal 被完全无视 ——
 * 用户点"取消"，云端请求断不掉，整场直播跑到自然结束还在烧 token。
 * 而本地 ollama.js 一直都实现了同一件事（:182-186），所以"分段能取消、匹配不能取消"。
 *
 * 这里钉死三件事：
 *   1) 外部 abort 之后，本地 controller 立即 abort（不能等超时）
 *   2) 已经处于 aborted 状态的 signal 传入时要**立刻**生效，不能晚一步
 *   3) detach 要能摘掉监听器，否则长跑会累积到触发 MaxListenersExceededWarning
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRequestController } from '../abort.js';

test('外部 abort 会转成请求自己的 abort', () => {
  const ext = new AbortController();
  const { controller, detach } = makeRequestController(ext.signal, 60000);
  assert.equal(controller.signal.aborted, false);
  ext.abort();
  assert.equal(controller.signal.aborted, true, '外部取消必须立刻传导到请求');
  detach();
});

test('传入一个已经 aborted 的 signal 时立即生效（不白等一个超时）', () => {
  const ext = new AbortController();
  ext.abort();
  const { controller, detach } = makeRequestController(ext.signal, 60000);
  assert.equal(controller.signal.aborted, true);
  detach();
});

test('超时仍然生效（没有外部 signal 也能兜住）', async () => {
  const { controller, detach } = makeRequestController(null, 30);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(controller.signal.aborted, true);
  detach();
});

test('detach 摘掉监听器，长跑不会累积到 MaxListeners 警告', () => {
  const ext = new AbortController();
  // Node 默认 11 个监听器就警告；不 detach 的话这里必然触发
  for (let i = 0; i < 50; i++) {
    const { detach } = makeRequestController(ext.signal, 1000);
    detach();
  }
  assert.equal(ext.signal.listenerCount?.('abort') ?? 0, 0, 'detach 后不应残留监听器');
});

test('detach 之后外部 abort 不再影响已结束的请求（避免误伤）', () => {
  const ext = new AbortController();
  const { controller, detach } = makeRequestController(ext.signal, 60000);
  detach();
  ext.abort();
  assert.equal(controller.signal.aborted, false);
});