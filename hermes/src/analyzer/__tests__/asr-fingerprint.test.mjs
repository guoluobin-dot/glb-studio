import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { ASRHelper } from '../asr-helper.js';

/*
 * 2026-10-21：ASR 缓存保真回归。
 *
 * 修的问题：整稿缓存键只含"目录名+文件名+路径哈希"，
 * 同名视频被换成新内容（重传/重切）时缓存永不失效 —— 分析会用旧稿。
 * 修法：新写入的缓存条目带 _fp（size 为主，mtime 只作诊断），
 * 读取时 size 不符即作废；没有 _fp 的老缓存（含 226 分钟级云端结果）一律放行。
 */

function makeHelper(tempDir) {
  const h = new ASRHelper({
    upload: { tempDir },
    analyzer: { termCorrect: true, cloudAsr: { priority: 'after-local' } },
  });
  return h;
}

test('_fingerprint / _fpStale：size 不符过期、无 _fp 不过期、文件读不到不误判', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asr-fp-'));
  const h = makeHelper(tmp);
  const video = join(tmp, 'a.mp4');
  writeFileSync(video, Buffer.alloc(1000, 7));

  const fp = h._fingerprint(video);
  assert.equal(fp.size, 1000, '指纹应记下字节大小');
  assert.ok(Number.isFinite(fp.mtimeMs), 'mtime 只做诊断，也要是数值');

  // 新式条目：size 不符 → 过期
  assert.equal(h._fpStale({ _fp: { size: 999, mtimeMs: 1 } }, video), true, 'size 不符必须判过期');
  assert.equal(h._fpStale({ _fp: { size: 1000, mtimeMs: 1 } }, video), true === false ? true : false, 'size 相同不应过期');

  // 老条目：没有 _fp → 放行（保护已花钱的存量云端缓存）
  assert.equal(h._fpStale({ segments: [] }, video), false);
  assert.equal(h._fpStale(null, video), false);

  // 当前文件读不到 → 不乱判（保持旧行为）
  const gone = join(tmp, 'gone.mp4');
  assert.equal(h._fpStale({ _fp: { size: 1 } }, gone), false);

  // 视频内容被替换成不同大小的文件 → 过期
  writeFileSync(video, Buffer.alloc(5555, 3));
  assert.equal(h._fpStale({ _fp: { size: 1000 } }, video), true, '同名重传必须能废掉旧稿');
});

test('getTranscript：新式缓存命中返回缓存；同名换内容后不再用旧稿', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asr-fp-'));
  mkdirSync(tmp, { recursive: true });
  const h = makeHelper(tmp);
  const video = join(tmp, 'demo.mp4');
  writeFileSync(video, Buffer.alloc(2048, 1));

  const paths = h._cachePaths(video);
  const segs = [
    { start: 0, end: 1000, text: '同友们大家好' },
    { start: 1000, end: 2000, text: '今天讲入库' },
  ];
  // 手工模拟"新式缓存写入"（与 _cloudAsr/sherpa/whisper 三个写点同构）
  writeFileSync(
    paths.current,
    JSON.stringify({ segments: segs, _fp: h._fingerprint(video), source: 'cloud-asr', videoPath: video }, null, 2),
    'utf-8'
  );

  const hit = await h.getTranscript(video);
  assert.equal(hit.source, 'cached', '指纹相符应命中缓存');
  assert.equal(hit.transcript.length, 2);

  // 同名文件被换成新内容 → 旧稿作废，落到 unavailable（本机 sherpa/whisper 由测试环境兜底）
  writeFileSync(video, Buffer.alloc(99997, 2)); // 覆盖为不同大小
  const again = await h.getTranscript(video);
  assert.notEqual(again.source, 'cached', '换内容后绝不能再返回旧稿');

  // 兜底路径至少给出真实原因（不是无声的空稿）
  assert.ok(again.reason, `应有可读性原因：${again.reason}`);
});

test('老缓存（无 _fp）依旧命中：升级不清库，云端 226 分钟资产不重付', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asr-fp-'));
  const h = makeHelper(tmp);
  const video = join(tmp, 'legacy.mp4');
  writeFileSync(video, Buffer.alloc(512, 5));

  const paths = h._cachePaths(video);
  const segs = [{ start: 0, end: 500, text: '老缓存的句子' }];
  writeFileSync(paths.current, JSON.stringify({ segments: segs, source: 'cloud-asr', videoPath: video }), 'utf-8');

  const hit = await h.getTranscript(video);
  assert.equal(hit.source, 'cached', '无 _fp 的老缓存应继续命中');
  assert.equal(hit.transcript[0].text, '老缓存的句子');
});
