/**
 * 剪辑档案 → 分析提示词 的注入测试
 *
 * 守的是学习闭环的最后一环：
 * 用户在审片台的每一个动作（删开头、留某段、改标题）都落进了 review_edits，
 * 但只有真的进了下一次分析的 prompt，才叫"学到"。
 *
 * 这里最关键的两条，都是**不该注入时坚决不注入**：
 *   1. 样本不足（stage=thin/empty）必须**不注入**
 *      ——一两条记录推不出规律，硬塞等于让模型把噪声当规则，比不注入更糟。
 *      而这个"不注入"如果写错，表现是分析结果看着正常、实际被垃圾规则带偏，
 *      没人查得出来。
 *   2. 四块（避雷/正样本/标题/结构）缺一不可，
 *      只注入 avoid 的话模型只知道"不要什么"，不知道"要什么"。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../memory/store.js';

const dbPath = 'data/hermes-test-archive-stage.db';
const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
cfg.memory = { ...cfg.memory, dbPath };
const store = new MemoryStore(cfg);

const COL = '注入测试老师';

/** 往 review_edits 塞 n 条 cut，模拟用户反复删掉某些开头 */
function seedCuts(n, opening = 'AA寒暄两句再开始ZZ') {
  for (let i = 0; i < n; i++) {
    store.db.prepare(
      `INSERT INTO review_edits (clip_project_id, live_video_id, collection, kind, segment_id, role,
                                 theme_name, text, char_from, char_to, start_ms, end_ms, score, reason, by, created_at)
       VALUES (NULL, NULL, ?, 'cut', NULL, 'hook', ?, ?, NULL, NULL, 0, 1000, 0.5, NULL, 'edited', datetime('now'))`
    ).run(COL, `主题${i}`, opening);
  }
}

test('0 条样本 → 返回 null（而不是全 0 的空档案）', () => {
  /*
   * 这个 null 是有意的，而且很重要：
   * 返回一份全 0 的空档案会被前端渲染成"已学习 0 条"，
   * 让用户以为系统确实分析过这位老师 —— 而真相是压根没有数据。
   * null 才能让调用方区分"没数据"和"数据很少"。
   */
  assert.equal(store.getEditArchive(COL), null);
  // 空名字也必须安全返回 null，不能抛
  assert.equal(store.getEditArchive(''), null);
});

test('9 条样本仍是 thin —— 不能注入（噪声当规则比不注入更糟）', () => {
  seedCuts(9);
  const arc = store.getEditArchive(COL);
  assert.equal(arc.stage, 'thin');
  assert.equal(arc.totalSamples, 9);
  // thin 也允许算出 hints，但调用方（live-analyzer）必须不注入
  // 这里只锁住 stage 的分档，避免以后有人改阈值
  assert.ok(arc.totalSamples < 10);
});

test('达到 10 条 → stage=warm，此时才允许注入', () => {
  seedCuts(1); // 补到 10
  const arc = store.getEditArchive(COL);
  assert.equal(arc.stage, 'warm');
  assert.equal(arc.totalSamples, 10);
  // 反复被删的开头必须真的被统计出来，否则"避雷"这块是空的
  assert.ok(arc.promptHints.avoid.length > 0, '避雷开头不该为空');
  /*
   * 只比对前 6 个字：topCutOpenings 用的是 substr(text, 1, 6)，
   * 拿整句去 includes 会因为截断而失败 —— 那是实现的选择，不是 bug。
   */
  assert.ok(
    arc.promptHints.avoid.some((a) => String(a).includes('AA寒暄两')),
    `避雷里应有反复被删那句的前 6 字，实际：${JSON.stringify(arc.promptHints.avoid)}`
  );
});

test('分析代码只在 warm/rich 时注入，thin/empty 一律不注入', () => {
  // 直接读源码断言：这是唯一能锁住"没有注入"的办法，
  // 因为"没注入"在运行时是个 absence，光测输出测不出来。
  const src = readFileSync(join(process.cwd(), 'src/analyzer/live-analyzer.js'), 'utf8');
  assert.match(
    src,
    /arc\.stage === 'warm' \|\| arc\.stage === 'rich'/,
    '必须显式只在这两档注入'
  );
  assert.match(src, /样本不足/, '样本不足时要有日志，否则线上没法排查为什么没学到');
});

test('四块提示词缺一不可：只注入 avoid 等于只教模型"不要什么"', () => {
  const src = readFileSync(join(process.cwd(), 'src/analyzer/live-analyzer.js'), 'utf8');
  for (const [key, label] of [
    ['avoid', '避雷开头'],
    ['prefer', '正样本'],
    ['titles', '标题改写'],
    ['roles', '段落结构']
  ]) {
    assert.match(src, new RegExp(`mem\\?\\.edits\\?\\.${key}\\?\\.length`), `${label} 必须有注入分支`);
  }
});

test('rich 档（40 条以上）同样注入', () => {
  seedCuts(31); // 10 + 31 = 41
  const arc = store.getEditArchive(COL);
  assert.equal(arc.stage, 'rich');
  assert.ok(arc.totalSamples >= 40);
});

test('样本只算当前 IP 的，不串别的老师', () => {
  store.db.prepare(
    `INSERT INTO review_edits (clip_project_id, live_video_id, collection, kind, segment_id, role,
                               theme_name, text, char_from, char_to, start_ms, end_ms, score, reason, by, created_at)
     VALUES (NULL, NULL, '别的老师', 'cut', NULL, 'hook', 'X', '别的老师的话', NULL, NULL, 0, 1000, 0.5, NULL, 'edited', datetime('now'))`
  ).run();
  const mine = store.getEditArchive(COL);
  const other = store.getEditArchive('别的老师');
  assert.ok(mine.totalSamples >= 40);
  assert.equal(other.totalSamples, 1, '别的老师只有自己那 1 条');
  assert.ok(!mine.cutOpenings.some((c) => String(c.opening).includes('别的老师的话')),
    '我的档案里不能出现别人的样本');
});

test.after(() => {
  store.close();
  for (const s of ['', '-wal', '-shm']) {
    // dbPath 是相对路径（见顶部注释），所以按同样的相对位置删
    rmSync(join(process.cwd(), 'data', `hermes-test-archive-stage.db${s}`), { force: true });
  }
});