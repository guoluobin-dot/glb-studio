import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orch = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

/*
 * 回归：引擎设置 mtime 字段名和方法名同人同名 = 热重载 100% 静默失效（2026-10-21 真实踩到）
 * ──────────────────────────────────────────────────────────
 * 症状：桌面端改了 key，调度器每轮 tick 本该热重载，却永远不见效；
 * /api/llm-reload 一调就 500，报错信息是 "TypeError: this._engineSettingsMtime is not a function"。
 *
 * 根因：构造器里写 `this._engineSettingsMtime = this._engineSettingsMtime()`，
 * 同名实例属性一旦赋值就永久遮蔽原型方法 —— 构造完字段是个数字，之后每次调用必抛
 * TypeError，而调用点全被空 catch 包着，于是每一轮 tick 都抛一次、吞一次，看起来毫无异常。
 *
 * 修法：存"上次见到的值"的字段改叫 _engineStamp，与方法名 _engineSettingsMtime 区分开；
 * 方法内部也不再给同名属性赋值（只缓存 _engineSettingsFile 文件路径）。
 * 这几条测试钉住「字段名 ≠ 方法名」这条硬规则，防止以后又被顺手改回去。
 */

test('【回归】实例字段 _engineStamp 与方法 _engineSettingsMtime 必须是两个名字', () => {
  // 构造器和 /api/llm-reload 里都不允许出现「字段 = 方法()」的同名连环覆盖
  assert.doesNotMatch(
    orch,
    /this\._engineSettingsMtime\s*=\s*this\._engineSettingsMtime\(\)/,
    '同名自赋值会把方法压成数字，正是当年的 bug 现场'
  );

  // 字段存值必须落在 _engineStamp 上
  assert.match(orch, /this\._engineStamp\s*=\s*this\._engineSettingsMtime\(\)/, '构造器里要用 _engineStamp 存 mtime');

  // 真赋值行（排除注释里的历史引用）：方法正文里不得再给同名属性赋值
  const realAssignments = orch
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^this\._engineSettingsMtime\s*=/.test(line));
  assert.equal(
    realAssignments.length,
    0,
    `不允许给方法名赋值，违规行: ${realAssignments.join(' | ')}`
  );

  // 方法内部不得缓存同名数字（当年 `this._engineSettingsMtime = 0` 的变体也不行）
  assert.doesNotMatch(
    orch,
    /this\._engineSettingsMtime\s*=\s*0\s*;/,
    '方法给同名属性赋 0 同样会遮蔽方法'
  );
});

test('【回归】maybeReloadLlmConfig 必须拿 _engineStamp 做比较与回写', () => {
  // 比较早先的 mtime、识别改动来源、更新戳，三处都要用同一个新字段
  assert.match(orch, /es === this\._engineStamp\)\s*return false/, '比较要用 _engineStamp');
  assert.match(orch, /es !== this\._engineStamp \? '桌面端引擎设置'/, '来源判断要用 _engineStamp');
  assert.match(orch, /this\._engineStamp = es;/, '回写要用 _engineStamp');

  // 反向：maybeReloadLlmConfig 的比较不能再拿 _engineSettingsMtime 当当前值用
  assert.doesNotMatch(
    orch,
    /es === this\._engineSettingsMtime\b/,
    '拿方法名当"当前值"比较永远是拿函数比数字，等于没比'
  );
});
