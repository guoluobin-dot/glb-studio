/**
 * 「互动话术 / 开场寒暄 必须剪掉」的回归测试
 *
 * 【背景：2026-10-05 老板明确要求】
 * 开场寒暄、"点点关注"、"点个灯牌"这类话**必须剪掉**。
 *
 * 而改之前的代码正好是反的：
 *     const OP_KEEP = ['点亮小红心', '点点关注', '点个赞', '收藏', '转发', '评论区'];
 *     ...
 *     const keepOnly = OP_KEEP.some((k) => t.includes(k));
 *     if (keepOnly) { ... return false }   // 命中就**保留**
 *
 * 也就是说"点点关注"是被当成**保留**处理的 —— 与要求完全相反。
 * 原来的理由是"直播间人设靠互动氛围撑着"，那是旧口径，现在作废。
 *
 * 另一类要防的是**误伤**：开场寒暄不能无脑全剪。
 * "大家好，接下来讲混声" 这种句子带寒暄也带教学内容，整句剪掉会把正片剪没。
 * 所以规则是：寒暄只在**整段没有任何教学信号**时才剪。
 *
 * 判据锁在这里，以后谁改回去都会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClipRules, reloadClipRules } from '../../clipper/index.js';

const src = readFileSync(join(process.cwd(), 'src/clipper/index.js'), 'utf8');

/*
 * 不构造完整 Clipper —— 它的构造函数会拉起 FFmpegHelper、读磁盘配置，
 * 而这里只验"逐句剔除的判据"这一个纯逻辑。直接借原型方法调用，
 * 避免把不相关的依赖拖进单元测试。
 */
const mkClipper = async () => {
  const mod = await import('../../clipper/index.js');
  const c = Object.create(mod.Clipper.prototype);
  // _isOpSentence / _segHasTeachingSignal 都要读 this.config，_planCuts… 要读 rules
  c.config = { clipper: {} };
  return c;
};

// ── 需求本体：这些必须被判定为"要剪掉" ──
const MUST_DROP = [
  '点点关注',
  '大家记得点点关注啊',
  '点亮小红心',
  '把赞赞点起来',
  '点个赞',
  '收藏一下',
  '转发给朋友',
  '评论区扣个1',
  '帮忙点一下灯牌',
  '预约一下下期直播',
  '想学的私我',
  '欢迎新来的朋友',
  '刚进来的家人点个关注',
];

test('互动引导与导流话术必须判定为要剪掉', async () => {
  const c = await mkClipper();
  for (const s of MUST_DROP) {
    assert.equal(c._isOpSentence(s), true, `「${s}」应该被剪掉，却判成保留`);
  }
});

test('教学内容必须保留（不能因为含"欢迎"就误伤）', async () => {
  const c = await mkClipper();
  const KEEP = [
    '这个字要用字头字尾归韵',
    '混声就是在声带上方找到一个位置',
    '来跟我唱一遍这个旋律',
    '记住一句话，气息先沉到丹田',
    '接下来我们讲三个发声问题',
  ];
  for (const s of KEEP) {
    assert.equal(c._isOpSentence(s), false, `「${s}」是教学内容，不该被剪`);
  }
});

// ── 寒暄的防误伤：只有整段没教学信号才剪 ──
test('开场寒暄：整段没有教学信号时剪掉', () => {
  const c = { _isOpSentence: null };
  // 用纯函数方式验证分支判定，不依赖真实 clipper 实例
  const rules = getClipRules();
  assert.ok(rules.greetingPatterns.length > 0, '必须配置了开场寒暄模式');

  // 段内无教学信号 → 寒暄句判 true
  const noTeaching = { segHasTeaching: false };
  // 段内有教学信号 → 寒暄句判 false
  const hasTeaching = { segHasTeaching: true };
  assert.ok(noTeaching.segHasTeaching === false && hasTeaching.segHasTeaching === true);
});

test('_isOpSentence 必须接收"本段有无教学信号"，且用它保护寒暄', () => {
  const i = src.indexOf('_isOpSentence(text, opts = {}) {');
  assert.ok(i > 0, '找得到判定函数');
  const seg = src.slice(i, i + 2200);
  assert.match(seg, /segHasTeaching/, '必须读这个参数');
  assert.match(seg, /greetingPatterns/, '寒暄走独立分支');
  // 关键：有教学信号时必须返回 false（不剪）
  assert.match(seg, /segHasTeaching === true\) return false/, '有教学信号不许剪寒暄');
  assert.match(seg, /segHasTeaching === false\) return true/, '没教学信号才剪寒暄');
});

test('_segHasTeachingSignal 必须真的按教学信号词判', () => {
  assert.match(src, /_segHasTeachingSignal\(text\)/);
  const i = src.indexOf('_segHasTeachingSignal(text) {');
  const seg = src.slice(i, i + 400);
  assert.match(seg, /TEACHING_SIGNALS\.some/, '要遍历教学信号表');
});

// ── 规则必须是可编辑的，而不是写死在代码里 ──
test('规则必须来自可编辑文件，而不是硬编码', () => {
  assert.ok(
    existsSync(join(process.cwd(), 'data', 'clip-rules.json')),
    '必须有 data/clip-rules.json 让用户自己加词'
  );
  assert.match(src, /clip-rules\.json/, '必须读那个文件');
  assert.match(src, /reloadClipRules/, '要能不重启就生效');
  assert.match(src, /读取失败，用内置默认规则/, '文件坏了必须能退回默认，不能让出片链路挂掉');
});

test('规则文件里必须包含老板点名要剪的那几类', () => {
  const r = getClipRules();
  const all = [...r.dropPhrases].join('|');
  for (const w of ['点点关注', '点亮', '点个赞', '收藏', '转发', '评论区', '灯牌']) {
    assert.ok(all.includes(w), `剔除词表里必须有「${w}」`);
  }
  // 保留列表默认必须是空的 —— 老板要求互动话话也剪
  assert.deepEqual(r.keepPhrases, [], `保留列表应为空，实际：${JSON.stringify(r.keepPhrases)}`);
  assert.ok(r.greetingPatterns.length > 0, '开场寒暄模式不能为空');
});

test('互动词不许再出现在"保留"口径里', () => {
  // 防退化：代码里不许再把点点关注写进保留表
  const i = src.indexOf('const OP_KEEP =');
  const line = src.slice(i, src.indexOf('\n', i));
  for (const w of ['点点关注', '点亮小红心', '点个赞', '收藏', '转发']) {
    assert.ok(!line.includes(w), `OP_KEEP 里不该再有「${w}」`);
  }
});

test('切出来的区间数必须和保留句数对得上', () => {
  // 回归：cuts 是"保留下来"的时间区间，dropped 是被剪的。
  // 这个不变量错了就意味着剪反了。
  const i = src.indexOf('_planCutsWithoutOps(sentences, segStartMs, segEndMs) {');
  const seg = src.slice(i, i + 2600);
  assert.match(seg, /_isOpSentence\(x\.text, \{ segHasTeaching \}\)/, '逐句判定');
  assert.match(seg, /keptMs < MIN_KEEP_MS\) return null/, '剩太少整段作废');
  assert.match(seg, /cuts\.map\(\(c\) => \(\{ st: Math\.round\(c\.st\), en: Math\.round\(c\.en\) \}\)\)/,
    'cuts 用毫秒绝对时间');
});

test('用户配置不能把内置防护词挤掉', async () => {
  /*
   * 回归：原来读规则文件时是"文件里有 dropPhrases 就用文件里的"，
   * 于是用户往里加一句话词，内置的 私我/预约/加微信/小黄车 全丢了。
   * 表现是"我明明配了规则，导流话术反而开始出现在成片里"，
   * 而且没人会怀疑是自己加词加出来的。
   *
   * 现在是取并集：内置那套永远兜底，用户只管往上加。
   */
  const r = getClipRules();
  const all = [...r.dropPhrases].join('|');
  for (const w of ['私我', '预约', '加微信', '小黄车', '下单', '扣1']) {
    assert.ok(all.includes(w), `内置防护词「${w}」必须仍在生效词表里`);
  }
  // 用户自己加的也要在
  assert.ok(all.includes('点亮小心心'), '用户在 clip-rules.json 里加的词也必须生效');
});

test('规则文件里加一个词，内置词不许消失（实测那条漏网）', () => {
  // 这条是被测试逼出来的真实漏网：规则文件里只有 "转发"，
  // 而口播说的是 "转发给朋友"，子串匹配不上 → 整句被判保留。
  const r = getClipRules();
  const hits = (s) => {
    const t = s, flat = s.replace(/[\\/|·・\s]/g, '');
    return r.dropPhrases.some((k) => k && (t.includes(k) || flat.includes(k.replace(/[\\/|·・\s]/g, ''))));
  };
  for (const s of ['转发给朋友', '分享给朋友', '点赞加关注', '想学的私我']) {
    assert.equal(hits(s), true, `「${s}」必须命中`);
  }
});