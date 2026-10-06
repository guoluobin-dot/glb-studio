/**
 * 「假成功」的回归测试
 *
 * 2026-10-05 真实踩到：15 条某老师爆款素材分析完，有 1 条（#15939）
 * 状态是 completed，但标题为空、爆点 0 个 —— 一条内容全空的记录被当成成功入库了。
 *
 * 成因是一条完整的假成功路径：
 *
 *   1. LLM 偶发不吐 JSON 而是写散文（线上连跪两次都是这种）
 *   2. repair pass 让模型"整理成纯 JSON"，这次也失败/返回非对象
 *   3. 代码带着**那个字符串**落到 `this._normalizeAnalysis(result, duration)`
 *   4. _normalizeAnalysis 开头 `if (!raw || typeof raw !== 'object') return defaults`
 *      → 返回一个全空对象（video_title: ''、viral_points: [] …）
 *   5. analyze() 没收到异常，于是照常写 analysis_status='completed' + analyzedAt
 *
 * 为什么必须堵：假成功比失败更糟 ——
 *   - 界面显示"已分析"，用户以为学进去了
 *   - 调度器 _noteOk() 记成功 → 不退避、不重试，永远不再处理
 *   - 预测拿不到爆点，基准也学不到东西
 *   - 库里原本没有错误字段，事后根本查不出它失败过
 *
 * 所以判据是：模型真正需要产出的四样（标题/爆点/开头话术/钩子模式）至少要有一项，
 * 为空就抛出去，交给 analyze() 的 catch 置 failed、退避后自动重试。
 *
 * 注意 structure **不能**算证据：_normalizeAnalysis 会拿视频时长硬造一段占位结构，
 * 它永远非空，用它判断等于永远通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/analyzer/hit-analyzer.js'), 'utf8');

test('_normalizeAnalysis 对非对象输入不许静默返回全空默认值', () => {
  // 这一行就是假成功的源头：字符串/空值 → 直接 return defaults
  assert.match(
    src,
    /if \(!raw \|\| typeof raw !== 'object'\)[\s\S]{0,120}return defaults/,
    '源码里仍有"非对象就返回全空默认值"的分支'
  );
  // 它的存在本身可以保留（内部兜底），但出口必须补上内容校验
  assert.match(src, /_assertHasContent/, '必须存在内容校验出口');
});

test('分析结果全空时必须抛错，不能当成功', () => {
  const i = src.indexOf('_assertHasContent(analysis)');
  assert.ok(i > 0, '正常路径出口必须校验内容');
  assert.match(
    src.slice(i - 200, i + 120),
    /_assertHasContent\(/,
    '校验必须真的调到了'
  );
});

test('_assertHasContent 必须四项全空才判失败，且不看 structure', () => {
  const i = src.indexOf('_assertHasContent(analysis) {');
  assert.ok(i > 0, '找得到 _assertHasContent 定义');
  const seg = src.slice(i, i + 1600);
  // 四项证据
  assert.match(seg, /video_title/, '标题算证据');
  assert.match(seg, /viral_points/, '爆点算证据');
  assert.match(seg, /opening_script/, '开头话术算证据');
  assert.match(seg, /hook_patterns/, '钩子模式算证据');
  // structure 必须明确不算：它是拿时长硬造的占位结构，永远非空
  assert.doesNotMatch(
    seg.match(/const has\w+[\s\S]*?if \([^)]*\) return analysis;/)?.[0] || '',
    /structure/,
    'structure 不许算证据（它是占位结构，永远非空）'
  );
  assert.match(seg, /throw new Error/, '全空必须抛，不能 return');
});

test('全空分析要算可重试（模型吐散文时重摇一次通常就好了）', () => {
  const i = src.indexOf('async _analyzeWithRetry(');
  const seg = src.slice(i, i + 1400);
  // 只重试网络错误是不够的：全空是 repair 也救不回来的，重摇整轮才有机会
  assert.match(seg, /isEmpty/, '要单列"全空"这一类');
  assert.match(seg, /未产出可用分析/, '要和抛出的错误信息对得上');
  assert.match(seg, /\(!isNet && !isEmpty\)/, '重试条件必须包含 isEmpty');
});

test('失败要落 last_error / failed_at，成功要清空', () => {
  const i = src.indexOf("analysisStatus: 'failed'");
  assert.ok(i > 0, '找得到失败分支');
  const failed = src.slice(i, i + 600);
  assert.match(failed, /lastError/, '失败必须记原因');
  assert.match(failed, /failedAt/, '失败必须记时间');

  const c = src.indexOf("analysisStatus: 'completed'");
  assert.ok(c > 0, '找得到成功分支');
  const done = src.slice(c, c + 900);
  assert.match(done, /lastError:\s*null/, '成功后要清掉陈年报错');
  assert.match(done, /failedAt:\s*null/, '成功后要清掉失败时间');
});

test('hit_videos 必须有失败诊断列', () => {
  const store = readFileSync(join(process.cwd(), 'src/memory/store.js'), 'utf8');
  // 新建库
  assert.match(store, /last_error TEXT/, '建表要有 last_error');
  assert.match(store, /failed_at TEXT/, '建表要有 failed_at');
  // 老库补列（幂等迁移）
  const mig = store.match(/\['last_error', 'TEXT'\][\s\S]{0,120}?\['failed_at', 'TEXT'\]/);
  assert.ok(mig, '老库迁移要补这两列，否则升级后写入会报 no such column');
});
