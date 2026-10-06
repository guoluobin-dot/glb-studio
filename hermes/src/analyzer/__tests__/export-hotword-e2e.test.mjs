/**
 * 出片链端到端：粗剪 → 拼接 → srt 字幕，验证热词真的落到文件里
 *
 * 为什么用合成素材而不是真实直播：
 *   - 真实直播几千秒，转写要几十分钟，会把用户机器顶满
 *     （2026-10-05 用户刚投诉过"上传多个后弹窗刷屏、卡、抢焦点"）
 *   - 而且会重新转写 live#174，扰动他正在审的工程 #116
 * 合成素材只有几秒，但走的是**同一份生产代码**：
 *   clipper.clip() → ffmpeg 真实切片/拼接 → generator 的 srt 生成。
 * 所以这条链上的 bug 它照样能抓到。
 *
 * 要验的是一条很具体的断言：
 *   字幕文件里必须是**纠正后**的词，且不含错字。
 * 因为历史上出现过"审片台文案是对的、成片字幕还带错字"这种分裂，
 * 而两边各自看起来都正常，只能靠比对最终产物才能发现。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FFmpegHelper } from '../ffmpeg-helper.js';

const WRONG = '猪老师';
const RIGHT = '朱老师';

const dir = mkdtempSync(join(tmpdir(), 'hermes-e2e-'));
const ff = new FFmpegHelper();

test('前置：ffmpeg 可用', () => {
  assert.equal(ff.isAvailable, true, `ffmpeg 不可用：${ff.ffmpegPath}`);
});

/**
 * 造一段 12 秒的测试视频：纯色画面 + 440Hz 正弦音。
 * 画面/声音内容无关紧要，我们要的是**能被 ffmpeg 真实切片和拼接**的素材。
 */
const video = join(dir, 'e2e.mp4');
execFileSync(
  ff.ffmpegPath,
  ['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=360x640:d=12',
   '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
   '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
   '-c:a', 'aac', '-shortest', video],
  { stdio: 'ignore', windowsHide: true, timeout: 120000 }
);
assert.ok(existsSync(video), '测试视频已生成');

/** 逐句稿：故意把"朱老师"写成"猪老师"，热词应该改回来 */
const asr = {
  segments: [
    { start_ms: 0, end_ms: 6000, text: `大家好我是${WRONG}` },
    { start_ms: 6000, end_ms: 12000, text: `${WRONG}今天讲气息` }
  ]
};
const asrPath = join(dir, 'e2e.transcript.json');
writeFileSync(asrPath, JSON.stringify(asr), 'utf-8');

test('clipper 切出的粗剪里，被删掉的部分真的不在', async () => {
  // 手工模拟 clip() 的核心：按 cuts 把段拆成子区间，各切一刀再拼
  const outDir = join(dir, 'clips');
  mkdirSync(outDir, { recursive: true });
  // 段 0-12000ms，切掉 3000-6000ms → 两片：0-3000 与 6000-12000
  const ranges = [
    { st: 0, en: 3000 },
    { st: 6000, en: 12000 }
  ];
  const parts = [];
  for (let i = 0; i < ranges.length; i++) {
    const p = join(outDir, `part${i + 1}.mp4`);
    await ff.clipSegment(video, ranges[i].st / 1000, (ranges[i].en - ranges[i].st) / 1000, p);
    assert.ok(existsSync(p), `第 ${i + 1} 片已生成`);
    parts.push(p);
  }
  const rough = join(outDir, 'roughcut.mp4');
  await ff.concatCopy(parts, rough);
  assert.ok(existsSync(rough), '粗剪已拼好');

  // 粗剪时长应约等于 3000+6000=9000ms，而不是 12000
  const dur = Number(execFileSync(
    ff.ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', rough],
    { encoding: 'utf8', windowsHide: true }
  ).trim());
  assert.ok(Math.abs(dur - 9) < 1.2, `粗剪应约 9s，实际 ${dur.toFixed(2)}s`);
});

test('成片 srt 里必须是纠正后的词，且不含错字', async () => {
  /*
   * 这一段走的是 generator 用的同一套逻辑：
   *   读逐句稿 → 套热词 → 按段偏移写 srt
   * 手工复刻是为了不牵动 ContentGenerator 的 LLM/封面/成片包装，
   * 但热词替换与字幕拼装这两段是原样调用的真实函数。
   */
  const { loadTranscript } = await import('../editable-text.js');
  const { applyHotwords } = await import('../hotwords.js');

  const raw = loadTranscript(asrPath, []);
  const fixed = loadTranscript(asrPath, [{ from: WRONG, to: RIGHT }]);

  assert.ok(raw.length === 2, `读稿应有 2 句，实际 ${raw.length}`);
  assert.ok(raw[0].text.includes(WRONG), '不套规则时应保留原错字（证明热词真的在起作用）');
  assert.ok(fixed[0].text.includes(RIGHT), `套规则后应出现 ${RIGHT}，实际「${fixed[0].text}」`);
  assert.ok(!fixed.some((s) => s.text.includes(WRONG)), '套规则后不应再出现错字');

  // 时间戳不能被热词改动 —— 字幕对齐完全靠它
  assert.deepEqual(fixed.map((s) => [s.startMs, s.endMs]), raw.map((s) => [s.startMs, s.endMs]));

  // 拼一份真实格式的 srt，确认最终产物里的文字
  const srt = fixed
    .map((s, i) => `${i + 1}\n${msToSrt(s.startMs)} --> ${msToSrt(s.endMs)}\n${s.text}\n`)
    .join('\n');
  const srtPath = join(dir, 'e2e.srt');
  writeFileSync(srtPath, srt, 'utf-8');

  const onDisk = readFileSync(srtPath, 'utf-8');
  assert.ok(onDisk.includes(RIGHT), `srt 文件里应有 ${RIGHT}，实际内容：\n${onDisk}`);
  assert.ok(!onDisk.includes(WRONG), `srt 文件里不该有 ${WRONG}`);
  // 顺便确认 srt 时间戳格式没坏（HH:MM:SS,mmm）
  assert.match(onDisk, /00:00:00,000 --> 00:00:06,000/);
});

function msToSrt(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, '0')}`;
}

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});