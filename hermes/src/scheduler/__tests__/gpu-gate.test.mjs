import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gpu = readFileSync(new URL('../gpu.js', import.meta.url), 'utf8');
const sched = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

/*
 * 回归：模型常驻显存 = 自动队列永久停摆（2026-10-06 真实踩到）
 * ──────────────────────────────────────────────────────────
 * 症状：手动跑完一批分析之后，自动队列再也不动了。
 * 用户看到的是"上传了素材但什么都不学进去"，而且没有任何报错。
 *
 * 根因：ollamaBusy 的判据是 /api/ps 非空，也就是"权重还留在显存里"。
 * Ollama 跑完不会卸载权重，会常驻几十分钟。于是 scheduler 里
 *   if (gpu.mode === 'busy' || gpu.ollamaBusy) return
 * 从那之后每一轮都命中，整轮让路 —— 分析队列永远捞不到东西。
 *
 * 这两条测试钉住"常驻 ≠ 正在推理"这个区分，防止以后又被改回去。
 */

test('【回归】ollamaBusy 必须区分「模型常驻」和「正在推理」', () => {
  // getGpuState 里要同时产出两个标记
  assert.match(gpu, /ollamaBusy/, '必须报告是否正在推理');
  assert.match(gpu, /ollamaLoaded/, '必须单独报告模型是否常驻显存');

  // 判定式：模型加载着 + GPU 利用率够高 = 才算正在推理
  assert.match(
    gpu,
    /ollamaBusy\s*=\s*smi\s*\?\s*smi\.util\s*>=\s*idleBelow\s*:\s*true/,
    'ollamaBusy 必须结合 GPU 利用率判断，不能只看 /api/ps 非空'
  );

  // 不能再直接用 models.length > 0 当 busy 的返回值
  assert.doesNotMatch(
    gpu,
    /return Array\.isArray\(j\?\.models\)\s*&&\s*j\.models\.length\s*>\s*0/,
    '不能把「模型加载着」直接当「正在推理」返回'
  );
});

test('【回归】模型常驻显存时不能让整轮让路，只能降并发', () => {
  // 让路的条件只能是"真在推理"或"用户把显卡占满"
  assert.match(
    sched,
    /if \(gpu\.mode === 'busy' \|\| gpu\.ollamaBusy\)/,
    '让路条件应该只含 mode=busy 和 ollamaBusy（真在推理）'
  );
  assert.doesNotMatch(
    sched,
    /if \([^)]*gpu\.ollamaLoaded[^)]*\)[\s\S]{0,80}return;/,
    'ollamaLoaded 单独出现时不能直接 return —— 那就是原来的 bug'
  );

  // 常驻时降并发到 1，并且必须真的用 effLimit 而不是 limit
  assert.match(sched, /gpu\.ollamaLoaded\s*&&\s*!gpu\.ollamaBusy/, '常驻未推理时要识别出来');
  assert.match(sched, /effLimit\s*=\s*1/, '常驻未推理时并发降到 1');
  assert.match(
    sched,
    /this\.runningTasks\.size\s*>=\s*effLimit/,
    '并发判断必须用 effLimit，否则降档白降'
  );
  assert.match(sched, /this\._effLimit\s*=\s*effLimit/, '_effLimit 必须赋 effLimit');
});

test('【回归】三个节流时间戳必须在构造函数里初始化', () => {
  // 缺一个就会被 undefined 反复触发判断，每轮都打日志刷屏
  for (const f of ['_busyLogged', '_loadedLogged', '_limitLogged']) {
    assert.match(sched, new RegExp(`this\\.${f}\\s*=\\s*0`), `${f} 必须初始化为 0`);
  }
});