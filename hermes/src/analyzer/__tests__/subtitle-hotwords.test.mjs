/**
 * 出片字幕的热词一致性测试
 *
 * 守的是一条很容易分裂、且**两边看起来都正常**的链：
 * 用户在出片台给某位老师加了热词「猪老师→朱老师」，
 * 审片台文案是纠正过的，但成片字幕要是还带错字，
 * 用户要同时比对两个界面才能发现 —— 而他根本不会去比对。
 *
 * 根因：ASRHelper._withTermCorrection 只走 singing-terms.json 那份**全局**词表，
 * 它不认识按 IP 归档的热词。所以 generator 里必须自己再套一次。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const gen = readFileSync(join(process.cwd(), 'src/generator/index.js'), 'utf8');

test('出片时必须按这条素材自己的归属套用热词', () => {
  /*
   * collection 必须取 liveVideo.collection（素材自己的归属），
   * 不能读"当前选中的 IP"：
   * 素材 A 属于上一位老师，切到 B 之后再出片，
   * 不该把 B 的词套到 A 上。
   */
  assert.match(gen, /liveVideo\?\.collection \|\| null/);
  assert.match(gen, /getHotwords\?\.\(collection\)/);
});

test('热词要在读逐句稿之后、生成字幕之前套上', () => {
  const applyAt = gen.indexOf('applyHotwords(String(s?.text');
  const asrAt = gen.indexOf('getTranscript(videoPath)');
  const srtAt = gen.indexOf('_generateJoinedSubtitle(');
  assert.ok(asrAt >= 0, '找得到读稿点');
  assert.ok(applyAt > asrAt, '必须在读稿之后套');
  assert.ok(srtAt > applyAt, '必须在生成字幕之前套 —— 否则字幕还是带错字的');
});

test('套用失败不得挡住出片', () => {
  /*
   * 字幕带错字，远好过出不了片。
   * 而这里如果 throw，出片会整体失败，
   * 用户看到的是"生成失败"，完全猜不到跟热词有关。
   */
  assert.match(gen, /热词套用失败（不影响出片）/);
});

test('不能污染原始 transcript 对象', () => {
  /*
   * 以前那种改法是直接 s.text = ...，会改到 getTranscript 返回的那个对象 ——
   * 而它可能来自缓存文件解出来的结构，
   * 同一进程内后续再读会拿到已被改过的文本，规则叠加后不可逆。
   * 这里用 {...s, text} 造新对象，不动原数组。
   */
  assert.match(gen, /\.\.\.s,\s*\n?\s*text: applyHotwords/);
  assert.doesNotMatch(gen, /\bs\.text\s*=\s*applyHotwords/);
});

test('ASRHelper 的全局词表不认识按 IP 归档的热词（这正是要补的理由）', () => {
  const asr = readFileSync(join(process.cwd(), 'src/analyzer/asr-helper.js'), 'utf8');
  assert.match(asr, /correctTranscript/);
  // 它只走词表文件，不查 hotwords 表
  assert.doesNotMatch(asr, /getHotwords/);
});

test('时间戳一个字都不能动', () => {
  // 套用只改 text，展开运算符 {...s} 保留了 start/end
  assert.match(gen, /transcript = \(asrResult\?\.transcript \|\| \[\]\)\.map\(\(s\) => \(\{\s*\n?\s*\.\.\.s,/);
});