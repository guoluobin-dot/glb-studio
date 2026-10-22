import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSqlTs } from '../store.js';

/*
 * 回归：日期格式混用 = 深度补全同日每 30 秒重跑（2026-10-21 真实踩到）
 * ──────────────────────────────────────────────────────────
 * hit_videos.analyzed_at 曾写 JS 的 toISOString()（'2026-10-21T09:30:00.123Z'），
 * deep_memory.updated_at 是 SQLite datetime('now')（'2026-10-21 09:30:05'）。
 * scheduler 的补全判断 `v.analyzed_at > d.updated_at` 是字符串字典序：
 * 同一天里 'T'(0x54) 恒大于 ' '(0x20) → "刚分析完"永远比记忆新 →
 * 每 30 秒整场重跑深度分析，直到 UTC 翻天才消停。
 *
 * 修法：updateHitVideo 在入口把 analyzed_at/failed_at 统一成 SQL 口径；
 * 存量 ISO 行另行用一次性脚本修补。本测试钉住两层。
 */

test('【回归】normalizeSqlTs：ISO → SQL 口径，SQL 口径原样保留', () => {
  // JS 物件
  assert.equal(
    normalizeSqlTs(new Date(Date.UTC(2026, 9, 21, 9, 30, 0, 123))),
    '2026-10-21 09:30:00',
    'toISOString 必须被换成 SQL 格式（T→空格、去掉毫秒与 Z）'
  );
  // ISO 字符串（带 T/Z）
  assert.equal(normalizeSqlTs('2026-10-21T09:30:00.123Z'), '2026-10-21 09:30:00');
  // 无时区尾缀的 ISO 当 UTC 处理
  assert.equal(normalizeSqlTs('2026-10-21T09:30:00'), '2026-10-21 09:30:00');
  // 已是 SQL 口径的要原样返回（不能双向抖动）
  assert.equal(normalizeSqlTs('2026-10-21 09:30:00'), '2026-10-21 09:30:00');
  // 解析不动就原样吐出（别把未知格式写成 NaT）
  assert.equal(normalizeSqlTs('not-a-date'), 'not-a-date');
  assert.equal(normalizeSqlTs(''), '');
  assert.equal(normalizeSqlTs(null), null);
});

test('【回归】updateHitVideo 必须对时间列做口径收口', () => {
  const src = readFileSync(new URL('../store.js', import.meta.url), 'utf8');
  // 收口表存在且涵盖 analyzed_at / failed_at
  assert.match(src, /const TS_COLUMNS = new Set\(\[\s*'analyzed_at',\s*'failed_at'\s*\]\)/,
    '时间列清单必须包含 analyzed_at 与 failed_at');
  // updateHitVideo 的参数装载必须走 normalizeSqlTs
  assert.match(
    src,
    /TS_COLUMNS\.has\(dbKey\) && value \? normalizeSqlTs\(value\) : value/,
    'updateHitVideo 必须经 normalizeSqlTs 统一口径，防止以后又写回 ISO'
  );
  // scheduler 的比较式还在（确认修的是写入侧，不是删了比较逻辑）
  const sched = readFileSync(new URL('../../scheduler/index.js', import.meta.url), 'utf8');
  assert.match(sched, /v\.analyzed_at > d\.updated_at/, '调度器的比较逻辑必须保持原样（写入侧已统一格式）');
});
