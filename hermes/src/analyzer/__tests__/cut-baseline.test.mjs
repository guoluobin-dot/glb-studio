/**
 * cuts 的时间基准回归测试
 *
 * 为什么必须钉死：cuts 在下游（_segmentsByIndex / clipper）按**原素材绝对时间**收口，
 * 一旦某处写成相对段首，就会被算成 st=段首、en=2000，
 * 再被 `c.en - c.st >= 200` 过滤掉 —— cuts 凭空消失，
 * 而回执写着"已生效"。用户精修半天，重剪完一点变化都没有。
 *
 * @author 郭洛斌
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 复刻 orchestrator._segmentsByIndex / clipper.buildSegments 的收口逻辑 */
function applyCuts(seg, cuts) {
  const clean = (cuts || [])
    .map((c) => ({
      st: Math.max(seg.startMs, Math.round(Number(c.st ?? 0))),
      en: Math.min(seg.endMs, Math.round(Number(c.en ?? 0)))
    }))
    .filter((c) => Number.isFinite(c.st) && Number.isFinite(c.en) && c.en - c.st >= 200)
    .sort((a, b) => a.st - b.st);
  return clean.length ? clean : null;
}

// live#174 第 1 段的真实参数
const SEG = { startMs: 1750000, endMs: 1810000 };

test('cuts 必须是绝对时间：相对值会被整段丢掉', () => {
  const absolute = [{ st: 1750000, en: 1765000 }];
  const got = applyCuts(SEG, absolute);
  assert.ok(got, '绝对时间必须被保留');
  assert.equal(got.length, 1);
  assert.equal(got[0].en - got[0].st, 15000, '应剪掉 15 秒');

  // 反例：如果按相对段首存（0..15000）
  const relative = [{ st: 0, en: 15000 }];
  assert.equal(applyCuts(SEG, relative), null, '相对值会被 st 抬到段首后长度不足而丢弃');
});

test('cuts 会被夹回段边界内', () => {
  const got = applyCuts(SEG, [{ st: 1700000, en: 1900000 }]);
  assert.equal(got?.[0].st, 1750000);
  assert.equal(got?.[0].en, 1810000);
});

test('太短的碎片被丢弃，避免 ffmpeg 切黑帧', () => {
  assert.equal(applyCuts(SEG, [{ st: 1750000, en: 1750150 }]), null, '150ms 碎片应丢弃');
  assert.ok(applyCuts(SEG, [{ st: 1750000, en: 1750200 }]), '恰好 200ms 应保留');
});

test('多段 cuts 按时间排序', () => {
  const got = applyCuts(SEG, [
    { st: 1780000, en: 1785000 },
    { st: 1752000, en: 1757000 }
  ]);
  assert.equal(got?.length, 2);
  assert.ok(got[0].st < got[1].st, '必须升序');
});

test('删除整段（相对段首 0..段长）会被夹成整段，但下游会拒绝', () => {
  // 服务端在写库前就有 90% 上限的保护，这里只验证收口逻辑不会崩
  const got = applyCuts(SEG, [{ st: 1750000, en: 1810000 }]);
  assert.equal(got?.length, 1);
  assert.equal(got[0].en - got[0].st, 60000);
});