/**
 * 逐句稿 + 热词 的出口测试
 *
 * 为什么要单独造一份临时 ASR 文件来测：
 * 真实数据里三条直播的 .transcript.json 都已经不在了（源视频也不在），
 * 拿真实工程测只会得到"文案是空的"，测不出热词到底生效没有。
 * 热词是纯函数逻辑，用临时文件测才是真的在测它。
 *
 * 守的是两件事：
 *   1. 错字从 loadTranscript 出口就被换掉（时间戳一个字不动）
 *   2. 规则跟着数据走，不靠全局状态 —— 否则并发/串行切换都会串规则
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTranscript, setHotwords } from '../editable-text.js';

const dir = mkdtempSync(join(tmpdir(), 'hermes-hw-'));

/** 造一份逐句稿，返回路径 */
function makeAsr(name, segments) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ segments }), 'utf-8');
  return p;
}

const ASR_A = makeAsr('a.transcript.json', [
  { start_ms: 0, end_ms: 2000, text: '我是猪老师' },
  { start_ms: 2000, end_ms: 4500, text: '猪老师今天讲猪老师' }
]);

test('热词在读稿出口就换掉了', () => {
  const t = loadTranscript(ASR_A, [{ from: '猪老师', to: '朱老师' }]);
  assert.deepEqual(t.map((s) => s.text), ['我是朱老师', '朱老师今天讲朱老师']);
});

test('换字不动时间戳（字幕对齐靠它）', () => {
  const t = loadTranscript(ASR_A, [{ from: '猪老师', to: '朱老师' }]);
  assert.deepEqual(t.map((s) => [s.startMs, s.endMs]), [[0, 2000], [2000, 4500]]);
});

test('不传规则时读原文', () => {
  setHotwords([]);
  const t = loadTranscript(ASR_A);
  assert.deepEqual(t.map((s) => s.text), ['我是猪老师', '猪老师今天讲猪老师']);
});

test('显式传的空数组要盖掉全局状态，而不是被忽略', () => {
  /*
   * 这条是本次修复的核心。
   * 之前 loadTranscript 只读模块级 activeHotwords，
   * 于是"先给甲 IP 读稿（设了甲的规则）→ 再给乙 IP 读稿"，
   * 乙会拿到甲的规则，而且不报错，只是文案悄悄是错的。
   *
   * 现在显式传 [] 就必须是原文。
   */
  setHotwords([{ from: '猪老师', to: '朱老师' }]);
  const t = loadTranscript(ASR_A, []);
  assert.deepEqual(t.map((s) => s.text), ['我是猪老师', '猪老师今天讲猪老师'], '显式空规则必须压过全局');
  setHotwords([]);
});

test('两条直播的规则互不干扰', () => {
  const ASR_B = makeAsr('b.transcript.json', [{ start_ms: 0, end_ms: 1000, text: '甲说猪老师' }]);
  const rulesA = [{ from: '猪老师', to: '朱老师' }];
  const rulesB = [{ from: '猪老师', to: '案例老师' }];

  const a = loadTranscript(ASR_B, rulesA);
  const b = loadTranscript(ASR_B, rulesB);
  assert.equal(a[0].text, '甲说朱老师');
  assert.equal(b[0].text, '甲说案例老师');
});

test('顺序颠倒也要得到同一个结果（长规则先替）', () => {
  const ASR_C = makeAsr('c.transcript.json', [{ start_ms: 0, end_ms: 1000, text: '朱老师老师' }]);
  const rules = [
    { from: '朱老师', to: '朱' },
    { from: '朱老师老师', to: '朱老师' }
  ];
  assert.equal(loadTranscript(ASR_C, rules)[0].text, loadTranscript(ASR_C, [...rules].reverse())[0].text);
});

test('文件不存在 / 路径为空 → 空数组，不抛', () => {
  assert.deepEqual(loadTranscript(null, []), []);
  assert.deepEqual(loadTranscript(join(dir, 'nope.json'), []), []);
});

test('坏 JSON → 空数组，不让整个请求挂掉', () => {
  const bad = join(dir, 'bad.transcript.json');
  writeFileSync(bad, '{ not json', 'utf-8');
  assert.deepEqual(loadTranscript(bad, []), []);
});

test('endMs <= startMs 的坏句子要被丢掉', () => {
  const p = makeAsr('d.transcript.json', [
    { start_ms: 1000, end_ms: 1000, text: '零长' },
    { start_ms: 0, end_ms: 100, text: '好的' }
  ]);
  const t = loadTranscript(p, []);
  assert.deepEqual(t.map((s) => s.text), ['好的']);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));