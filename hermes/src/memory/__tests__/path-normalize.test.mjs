import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 素材路径归一化：写进去的和查出来的必须是同一个键。
 *
 * 2026-10-12 回归用例。真实 bug：全文件散着 7 处 `replace(/\\/g,'/')`，
 * 而且**注释声称已修、实际没修** —— 至少三处注释写着
 * "调度器扫到 D:////x 时 ON CONFLICT(video_path) 匹配不上，同一条素材会插出两条记录"，
 * 可代码只换了分隔符：`D:////x` 和 `D:/x` 归一后仍是两个字符串，
 * UNIQUE(video_path) 拦不住，双跑锁失效。
 *
 * 而且读侧口径又不一样：getHitVideo 归一，getVideo/getLiveVideo 压根不归一。
 * 同一个文件里三种写法，一个素材因此能变成两行。
 *
 * 不 import store.js：本测试只验纯函数，避免顺带打开生产库。
 */

/** 与 store.js::normalizeVideoPath 同源（改动时两处一起改） */
function normalizeVideoPath(p) {
  let s = String(p ?? '');
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 3) s = s.replace(/\/+$/, '');
  return s;
}

test('连续斜杠折叠成单个 —— 这正是注释声称已修、实际没修的那个', () => {
  assert.equal(normalizeVideoPath('D:////x/a.mp4'), 'D:/x/a.mp4');
  assert.equal(normalizeVideoPath('E:\\\\直播\\\\a.mp4'), 'E:/直播/a.mp4');
  assert.equal(normalizeVideoPath('E:\\\\直播\\\\\\\\b.mp4'), 'E:/直播/b.mp4');
});

test('反斜杠与正斜杠归一到同一个键（不会插出两条记录）', () => {
  assert.equal(normalizeVideoPath('E:\\直播\\a.mp4'), normalizeVideoPath('E:/直播/a.mp4'));
});

test('去掉尾部斜杠（path-lookup.test.mjs 里有真实用例：E:/直播/a.mp4/）', () => {
  assert.equal(normalizeVideoPath('E:/直播/a.mp4/'), 'E:/直播/a.mp4');
  assert.equal(normalizeVideoPath('E:\\直播\\a.mp4\\'), 'E:/直播/a.mp4');
});

test('盘符根目录的斜杠要保住', () => {
  assert.equal(normalizeVideoPath('E:/'), 'E:/');
  assert.equal(normalizeVideoPath('C:\\'), 'C:/');
});

test('空值安全（不该抛异常）', () => {
  assert.equal(normalizeVideoPath(null), '');
  assert.equal(normalizeVideoPath(undefined), '');
  assert.equal(normalizeVideoPath(''), '');
});

test('内部路径分隔不受影响（不会把 a//b 里的语义弄丢）', () => {
  assert.equal(normalizeVideoPath('/home/user/video.mp4'), '/home/user/video.mp4');
  assert.equal(normalizeVideoPath('\\\\server\\share\\v.mp4'), '/server/share/v.mp4');
});

test('幂等：归一一次和归一两次结果相同（否则读写循环会一直改值）', () => {
  for (const p of ['D:////x/a.mp4', 'E:\\直播\\a.mp4\\', '/home/u/v.mp4', 'E:/']) {
    const once = normalizeVideoPath(p);
    assert.equal(normalizeVideoPath(once), once, `对 ${p} 不幂等`);
  }
});