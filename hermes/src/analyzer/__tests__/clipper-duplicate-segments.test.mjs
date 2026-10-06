/**
 * clipper 的三处硬 bug 回归测试
 *
 * 这三个都是"不报错、但功能整个是坏的"，所以只能靠断言锁住：
 *
 * 1. createProject 里传了未定义的 totalDurationMs
 *    → 自动选段这条路 100% 抛 ReferenceError，调度器吞掉，界面上毫无异常。
 *       这是最严重的一条：整个自动粗剪从来没跑通过。
 * 2. okSegments.push(seg) 写在子区间循环体内
 *    → 一段有 N 个 cuts 就 push N 次，随后"段数不匹配 → 收敛"那步
 *       反过来把**重复的段写回库**，字幕错位 / 成片出现重复画面。
 * 3. createProject 的投影没带 cuts
 *    → clip() 从库里重读时 seg.cuts 恒为 undefined，逐句剔除运营话术整个空转。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/clipper/index.js'), 'utf8');

test('createProject 不能再传未定义的 totalDurationMs', () => {
  /*
   * 以前这里算 totalDuration、却传 totalDurationMs，
   * 而 totalDurationMs 只在 clip() 内部声明过。
   */
  assert.match(src, /const totalDuration = selectedSegments\.reduce/, '必须真的算出 totalDuration');
  assert.match(src, /totalDurationMs: totalDuration/, '必须把算出来的那个传下去');

  /*
   * 只在 createClipProject 的实参里查裸变量。
   * clip() 的 return { ..., totalDurationMs } 是合法的局部变量，不能一起禁掉
   * —— 上一版断言太宽，把正确的地方也判成错了。
   */
  const start = src.indexOf('this.store.createClipProject({');
  assert.ok(start > 0, '找得到 createClipProject 调用');
  const argBlock = src.slice(start, src.indexOf('});', start));
  assert.doesNotMatch(
    argBlock,
    /^\s*totalDurationMs\s*,?\s*$/m,
    'createClipProject 实参里不能再有裸的 totalDurationMs'
  );
});

test('okSegments 只能在整段成功后 push 一次', () => {
  /*
   * 关键不变量：okSegments 的长度永远不能**大于** selected_segments 的长度。
   * 大于就说明同一段被重复收进来了。
   */
  assert.match(
    src,
    /if \(segOk\) okSegments\.push\(seg\);/,
    '必须用"本段全部子区间都成功"的判据，且在循环外 push'
  );
  // push 必须在子区间 for 循环**结束之后**
  const pushIdx = src.indexOf('if (segOk) okSegments.push(seg);');
  const forIdx = src.indexOf('for (let k = 0; k < ranges.length; k++)');
  assert.ok(forIdx > 0 && pushIdx > forIdx, 'push 必须位于 ranges 循环之后');
  // 循环体内不能还有裸 push。
  // 必须先剥掉注释 —— 否则解释这次修复的那段注释里
  // 提到的 "okSegments.push(seg)" 会把断言自己判成失败。
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const between = stripComments(src.slice(forIdx, pushIdx));
  assert.doesNotMatch(
    between,
    /okSegments\.push/,
    'ranges 循环体内不得再 push 同一段'
  );
});

test('收敛逻辑不能把段数写多', () => {
  // 收敛只在"少了段"时发生；多了说明上游重复收集了，必须暴露而不是静默写库
  assert.match(
    src,
    /okSegments\.length < project\.selected_segments\.length/,
    '只应在段数变少时收敛；变多是上游 bug，不能写回库'
  );
});

test('cuts 必须随 selected_segments 一起写库', () => {
  /*
   * 不带 cuts 的话 clip() 重读项目时 ranges 永远走整段分支，
   * 逐句剔除运营话术（预约/加微信/刷礼物）在成片上完全空转，
   * 而界面上看不出来 —— 因为 cuts 只被拿去算时长预算了。
   */
  assert.match(src, /Array\.isArray\(s\.cuts\) && s\.cuts\.length/);
  assert.match(src, /cuts: s\.cuts\.map/, '投影里必须带上 cuts');
});

test('cuts 的时间单位是毫秒且必须是数字', () => {
  assert.match(src, /st: Number\(c\.st\), en: Number\(c\.en\)/);
});

test('review-packet 的粗剪时间轴必须按 cuts 累加，不能按整段', () => {
  /*
   * clip() 拼的是 cuts 的子区间，所以粗剪里的实际时长是 cuts 之和。
   * 而 review-packet 以前用 end-start 累加 cursor ——
   * 一个"中间删了 25 秒"的段在真实文件里只有 35 秒，却报成 60 秒，
   * 后面所有段的粗剪位置全偏。
   *
   * 用户可见后果：审片台把播放中的画面标成错误的段、点行 seek 到错位置、
   * 标题里的"粗剪 100.0s"其实只有 75s。generator 那边早就按 cuts 累加了，
   * 只有这里没跟上。
   */
  const orch = readFileSync(join(process.cwd(), 'src/orchestrator/index.js'), 'utf8');
  assert.match(orch, /Array\.isArray\(s\.cuts\) && s\.cuts\.length/);
  assert.match(orch, /sum > 0 \? sum : Math\.max\(0, end - start\)/, 'cuts 全废时要退回整段，不能算出 0 时长');
  assert.match(orch, /const dur = roughcutDur;/, 'cursor 必须按粗剪实际时长累加');
});
/*
 * 剩下四条：打回重剪丢删字 / 作废工程复活 / 学习样本重复写 / 1ms 切分。
 * 全在 orchestrator/index.js 里。
 */
const orch = readFileSync(join(process.cwd(), 'src/orchestrator/index.js'), 'utf8');

test('打回重剪必须把上一轮的 cuts 带入（否则用户删的内容复活）', () => {
  /*
   * 原来重建段列表时不传 cutsByIndex，于是 picked 里每段都没有 seg.cuts，
   * 下一段 `normalizeRanges([...(seg.cuts || []), ...merged])`
   * （注释写着"已有 cuts 要一起合并"）永远在合并空数组 —— 是死代码。
   *
   * 真实后果：第一轮删掉的几秒，第二轮重剪后原样复活，
   * 而新的 review-packet 也看不出任何痕迹。
   */
  assert.match(orch, /prevCutsBySegId/, '必须先把旧 cuts 收集起来');
  assert.match(
    orch,
    /_segmentsByIndex\(project\.live_video_id, keptIds, prevCutsBySegId\)/,
    '重建时必须把旧 cuts 传进去'
  );
  // index 必须用 segmentId（live_segments.id），不是 segment_index
  assert.match(orch, /index: Number\(seg0\.segmentId\)/);
});

test('作废的工程不许再被确认通过', () => {
  /*
   * 原来判据是 `!['reviewing','approved','finished'].includes(status)` 才重新出片，
   * superseded 落进 else 分支 → 用它自己那份旧 selected_segments 重新切片，
   * 并把状态改回 approved。于是两条 approved 并存，
   * 而用户刚在重剪版里批准的删字不在旧工程里 —— 等于把成果覆盖了。
   */
  assert.match(orch, /p\.status === 'superseded'/, '必须显式拒绝 superseded');
  assert.match(orch, /supersededBy/, '必须告诉界面该用哪个工程');
  assert.match(orch, /res\.status\(409\)/, '必须用 409 明确拒绝');
});

test('approve 的三处写入都要去重，不能只防 review_feedback', () => {
  /*
   * addReviewLesson 按集合限 30 条，反复 approve 会把别的老师的真实教训挤出窗口；
   * addReviewEdits 每段 2 行，重复 approve 会成倍堆积并污染 stage 门槛与画像中位数。
   */
  const dupIdx = orch.indexOf("decision = 'approve' AND comment = ?");
  assert.ok(dupIdx > 0, '必须有 review_feedback 的去重判据');
  const after = orch.slice(dupIdx, dupIdx + 1400);
  assert.match(after, /hasLesson/, 'addReviewLesson 也必须去重');
});

test('通过必须如实回传学习有没有写成', () => {
  /*
   * 整个正样本写入都在服务端的 try 里，抛错时"通过"照样成立。
   * 以前 catch 完直接 ok:true，界面显示"下次找爆点会参考这次的意见" ——
   * 失败时说的正好是反的。
   */
  assert.match(orch, /learnFailed = err\.message/);
  assert.match(orch, /learned,\s*\n\s*learnFailed/, '回执必须带上这两个字段');
});

test('重剪的切分下限与其他两条路径一致（200ms）', () => {
  // 另两条路径（_segmentsByIndex、clipper）都按 200ms 过滤，
  // 只有这里放行 1ms，然后一路走到 ffmpeg -t 0.001，产出黑帧或空文件
  assert.match(orch, /MIN_CUT_MS = 200/);
  assert.match(orch, /en - st >= MIN_CUT_MS/);
});
test('打回必须幂等：双击/重试不许造出两个新工程', () => {
  /*
   * 原来完全没有去重。双击「打回重剪」或客户端超时重试都会走完
   * addReviewFeedback / markSegmentsRejected / addReviewLesson / createProject，
   * 留下两个几乎一样的新工程、两行反馈、两条教训，
   * 而只有第二个 newProjectId 被返回 —— 界面上看着"成功了"。
   */
  const o2 = readFileSync(join(process.cwd(), 'src/orchestrator/index.js'), 'utf8');
  assert.match(o2, /alreadyRecut/, '必须有判重');
  assert.match(o2, /deduped: true/);
  assert.match(o2, /不重复建/);
  // 判重必须在写反馈之后（靠反馈表判重）、建工程之前
  const dedupAt = o2.indexOf('alreadyRecut');
  const before = o2.lastIndexOf('addReviewFeedback({', dedupAt);
  const after = o2.indexOf('createProject(project.live_video_id', dedupAt);
  assert.ok(before > 0 && before < dedupAt, '判重要靠已写入的反馈');
  assert.ok(dedupAt < after, '判重必须在建工程之前');
});

test('重建缺失粗剪时必须认多区间的切片文件', () => {
  /*
   * clipper 给"带 cuts 的段"产出 clip1_1.mp4 / clip1_2.mp4，
   * 而 generator 原来只匹配 /_clip\\d+\\.mp4$/ —— 漏掉的恰好是
   * **那些被删过字的段**，最需要保留的内容反而整段消失，且不报错。
   */
  const gen = readFileSync(join(process.cwd(), 'src/generator/index.js'), 'utf8');
  // 注意这是正则字面量：只写一个反斜杠。写成 \\d 匹配的是"字面反斜杠+d"，
  // 于是断言在正确实现上失败 —— 自己骗自己。
  assert.ok(gen.includes(String.raw`_clip\d+(?:_\d+)?\.mp4$/i`), "必须能匹配多区间的 clipN_M.mp4");
  // 排序必须按 (段号, 子区间号) 两个数字来，不能只按文件名。
  assert.doesNotMatch(gen.replace(/\/\*[\s\S]*?\*\//g, ""), /localeCompare/, "排序不能只按文件名");
  assert.match(gen, /ka\[0\] - kb\[0\] \|\| ka\[1\] - kb\[1\]/, '必须按两个数字排');
});

test('学习记录只能记真正生效的删除', () => {
  /*
   * buildLearningRecord 原来把客户端原始 textCuts 自己重算时间就算数，
   * 而服务端落库的 cuts 要过：算不出时间就丢、夹到段边界、归一化合并、
   * 删超过 90% 整段跳过、短于 200ms 忽略。
   *
   * 于是被规则拒绝的选区仍被记成 cut 样本 —— 那是"避雷词"，会注入下一次分析：
   * 用户试删一句被拦下，那句话还在片子里，系统却已当成"用户讨厌的说法"学走。
   * 反过来算不出时间的选区会让整段落进 keep，等于教系统"保留"用户想删的内容。
   */
  const rl = readFileSync(join(process.cwd(), 'src/analyzer/review-learning.js'), 'utf8');
  assert.match(rl, /charRangesToTime\(tc\.ranges \|\| \[\], ed, segStart, p\.appliedCutsBySeg\?\.get\(id\)\)/);
  assert.match(rl, /appliedCuts\.some/, '必须与实际落库的 cuts 核对');
  // 没有 appliedCuts 时不能变成"全不过滤"或"全过滤"，保持旧行为
  assert.match(rl, /Array\.isArray\(appliedCuts\) && appliedCuts\.length/);
});

test('粗剪拼接失败不能报成功', () => {
  /*
   * 原来多段拼接失败只把 roughcutPath 置 null，
   * 而端点照样回 { ok:true, clipped:true }，
   * 桌面端于是提示"粗剪还没渲染出来，先播原始素材" ——
   * 看着像正常降级，实际是根本没出粗剪。
   * 用户审完一整轮，到出片那一步才撞上"找不到粗剪视频"。
   */
  const clip = readFileSync(join(process.cwd(), 'src/clipper/index.js'), 'utf8');
  assert.match(clip, /roughcutFailed/);
  assert.match(clip, /拼接失败，请重跑一次出片/);

  const o3 = readFileSync(join(process.cwd(), 'src/orchestrator/index.js'), 'utf8');
  // 两个建工程入口都必须挡住
  const n = (o3.match(/roughcutFailed/g) ?? []).length;
  assert.ok(n >= 2, `两个 /pipeline/clip 分支都要判 roughcutFailed，实际 ${n} 处`);
  assert.match(o3, /clipped: false/);
});

test('charRangeToTime 必须拒掉 NaN 边界', () => {
  /*
   * 里面每道校验（b <= a / en > st / to <= from）对 NaN 都是 false，
   * 于是 NaN 能一路"通过"，返回一个由零长碎片拼成的聚合结果。
   * 今天无害只因为调用方还有一道 p.en <= p.st 兜着，
   * 而那不是它的本职。边界一旦来自脏数据（文本框算出的 from/to）就迟早会漏。
   */
  const et = readFileSync(join(process.cwd(), 'src/analyzer/editable-text.js'), 'utf8');
  assert.match(et, /!Number\.isFinite\(from\) \|\| !Number\.isFinite\(to\)/);
});