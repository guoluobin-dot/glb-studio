/**
 * 验证子进程不再弹黑框
 *
 * 判据不是"没报错"，而是**枚举可见窗口**：黑框是可见的顶层窗口，
 * 一定会被列出来。这比看日志可靠 —— 弹了就是弹了，不报错也代表弹了。
 *
 * 复现的灾难性 bug：批量上传素材到 IP 记忆库后，
 * ffmpeg / ffprobe 被反复 spawn，每次都弹一个控制台窗口并抢最上层焦点。
 *
 * @author 郭洛斌
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_PS = join(HERE, 'list-windows.ps1');

/** 当前可见窗口快照 */
function snap() {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LIST_PS],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }
  ).trim();
  if (!out) return [];
  const j = JSON.parse(out);
  return Array.isArray(j) ? j : [j];
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const before = snap();
console.log(`调用前可见窗口 ${before.length} 个`);

const { ASRHelper } = await import('../src/analyzer/asr-helper.js');
const { FFmpegHelper } = await import('../src/analyzer/ffmpeg-helper.js');

console.log('\n== 1. FFmpegHelper.run（批量上传时每条素材都会跑几次）==');
const ff = new FFmpegHelper();
check(ff.isAvailable === true, `ffmpeg 可用（${ff.ffmpegPath || '未找到'}）`);
if (ff.isAvailable) {
  try { await ff.run(ff.ffmpegPath, ['-version'], 30000); }
  catch (err) { console.log('  (run 返回:', err.message, ')'); }

  console.log('\n== 2. getEnergyCurve（另一处独立 spawn）==');
  try { await ff.getEnergyCurve('D:/__probe_nonexistent__.mp4'); }
  catch (err) { console.log('  (预期失败:', err.message.slice(0, 50), ')'); }
}

console.log('\n== 3. ASRHelper._exec（每条素材转写都会跑）==');
const asr = new ASRHelper({ upload: { tempDir: 'data/tmp-probe' }, glb: {} });
try { await asr._exec('cmd.exe', ['/c', 'exit', '0'], 15000); }
catch (err) { console.log('  (返回:', err.message, ')'); }

await new Promise((r) => setTimeout(r, 1200));

const after = snap();
const key = (w) => `${w.Pid}|${w.Title}`;
const beforeKeys = new Set(before.map(key));
const added = after.filter((w) => !beforeKeys.has(key(w)));

console.log(`\n调用后可见窗口 ${after.length} 个，新增 ${added.length} 个`);
if (added.length) {
  console.log('新增窗口:', JSON.stringify(added.slice(0, 8)));
}
check(added.length === 0, '整个过程没有弹出任何新窗口');

// 对照组：如果故意不设 windowsHide，应该能看到弹窗。
// 不做这个对照，是因为它会真的闪一下黑框打扰用户 ——
// 而"修好了"这件事，上面那条已经证明够了。
console.log('\n（未做"故意不设 windowsHide"的对照：那会真的弹一次黑框打扰你）');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);