import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 云端模型名兜底：配置里的模型服务商没有时，不能整轮分析全废。
 *
 * 背景（2026-10-12）：配置写的是 gemini-3.5-flash-lite，APIMart 那边并没有这个 id。
 * 而一场长直播会连着打几十次请求，每次都 404 —— 等于整轮分析白跑，
 * 用户看到的却只是一句"模型不存在"，不知道该改成什么。
 *
 * 这里钉死三件事：
 *   1) 只在"列表里确实没有配置的名字"时才替换，绝不静默改成别的模型
 *   2) 同族前缀优先（gemini-* 不会被换成 gpt-*），再按 flash/pro 特征挑
 *   3) 列表拉不到时保持原样，不猜
 *
 * 不 import gemini.js：本测试只验挑选逻辑，不发网络请求。
 */

/** 与 GeminiClient._resolveModelFallback 同源的挑选规则（改动时两处一起改） */
function resolveModelFallback(configured, models) {
  if (!models.length) return null;
  if (models.includes(configured)) return configured;
  const base = String(configured).split('-')[0].toLowerCase();
  const family = models.filter((m) => m.toLowerCase().startsWith(base));
  const pool = family.length ? family : models;
  const prefer = pool.find((m) => /flash/i.test(m)) || pool[0];
  return prefer || null;
}

test('列表里没有配置的名字时，优先挑同族 + flash', () => {
  const models = ['gpt-5', 'claude-sonnet-4.5', 'gemini-2.0-flash', 'gemini-2.5-pro'];
  assert.equal(resolveModelFallback('gemini-3.5-flash-lite', models), 'gemini-2.0-flash');
});

test('绝不会被换成别家模型（同族优先）', () => {
  const models = ['gpt-5', 'claude-sonnet-4.5', 'gemini-2.0-pro'];
  assert.equal(resolveModelFallback('gemini-9-ultra', models), 'gemini-2.0-pro');
});

test('同族一个都没有时，退回整表第一个（总比 404 好）', () => {
  assert.equal(resolveModelFallback('qwen-max', ['gpt-5', 'claude-sonnet-4.5']), 'gpt-5');
});

test('配置的名字就在列表里 → 原样返回，绝不换', () => {
  const models = ['gemini-2.0-flash', 'gemini-3.5-flash-lite'];
  assert.equal(resolveModelFallback('gemini-3.5-flash-lite', models), 'gemini-3.5-flash-lite');
});

test('列表拉不到（空）时保持 null，不瞎猜', () => {
  assert.equal(resolveModelFallback('gemini-3.5-flash-lite', []), null);
});