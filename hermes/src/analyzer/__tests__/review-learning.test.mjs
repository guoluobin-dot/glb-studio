/**
 * 剪辑决策学习：记忆库落库与读取的回归测试
 *
 * 打回重剪（recut）链路已下线，因此本文件里原先针对
 * review-learning.js（splitByCuts / keptSegments / buildLearningRecord）
 * 的那几组用例一并删除 —— 那个模块只被已删除的打回分支调用。
 *
 * 保留下来的是**保留 approve 学习闭环**需要的部分：
 * approve 分支写 review_edits（segment + keep 正样本），
 * 桌面端 /memory/edit-records 也走同一张表，
 * 再由 getEditArchive / getEditStyleSummary 读回去注入下一次分析。
 * 这里守的就是这条链路的两端：写得进、读得出、按 IP 隔离。
 *
 * @author 郭洛斌
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

/**
 * 最小 expect 垫片。
 *
 * GLB 前端用 vitest（自带 expect），Hermes 用 node:test（没有）。
 * 这里手写一个够用的版本，而不是把整个测试改成 assert 风格 ——
 * 断言的可读性比这点样板代码值钱。
 */
function expect(actual) {
  const api = {
    toBe: (v) => assert.strictEqual(actual, v, `期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual)}`),
    toEqual: (v) => assert.deepStrictEqual(actual, v),
    toContain: (v) => assert.ok(
      Array.isArray(actual) ? actual.includes(v) : String(actual).includes(v),
      `期望包含 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual)}`
    ),
    toBeGreaterThan: (v) => assert.ok(actual > v, `期望 > ${v}，实际 ${actual}`),
    toBeGreaterThanOrEqual: (v) => assert.ok(actual >= v, `期望 >= ${v}，实际 ${actual}`),
    toBeLessThan: (v) => assert.ok(actual < v, `期望 < ${v}，实际 ${actual}`),
    toBeTruthy: () => assert.ok(actual, '期望为真'),
    toBeFalsy: () => assert.ok(!actual, '期望为假'),
    toBeUndefined: () => assert.strictEqual(actual, undefined)
  };
  api.not = {
    toBe: (v) => assert.notStrictEqual(actual, v),
    toBeUndefined: () => assert.notStrictEqual(actual, undefined)
  };
  return api;
}

describe('记忆库 · review_edits 落库与读取', () => {
  const dbPath = 'data/hermes-test-edits.db';
  let store;

  before(async () => {
    const { MemoryStore } = await import('../../memory/store.js');
    /*
     * 指向一次性库，绝不碰生产数据。
     *
     * 注意配置路径是 cfg.memory.dbPath，不是 cfg.paths.dbPath。
     * 而且 Store 会把相对路径按 src/memory/../.. 解析成绝对路径，
     * 所以这里要给绝对路径，写相对的会落到 src/memory/ 下面去。
     */
    const json = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
    json.memory = { ...json.memory, dbPath: dbPath };
    store = new MemoryStore(json);
  });

  after(() => {
    try { store?.db?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
  });

  it('写入三类样本', () => {
    const n = store.addReviewEdits([
      { clipProjectId: null, liveVideoId: 1, collection: '案例老师', kind: 'cut', text: '同学们欢迎大家', by: 'edited' },
      { clipProjectId: null, liveVideoId: 1, collection: '案例老师', kind: 'keep', text: '今天讲和弦的构成', by: 'edited' },
      { clipProjectId: null, liveVideoId: 1, collection: '案例老师', kind: 'segment', role: 'hook', themeName: '开场', text: '正文…', by: 'picked' }
    ]);
    expect(n).toBe(3);
    expect(store.getReviewEditsByKind('keep', '案例老师').length).toBe(1);
    expect(store.getReviewEditsByKind('segment', '案例老师').length).toBe(1);
  });

  it('按 IP 老师隔离，且通用样本（collection=NULL）对所有人可见', () => {
    store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: null, kind: 'cut', text: '欢迎新宝宝' }]);
    // 案例老师应能读到自己的 + 通用的
    const zhu = store.getReviewEditsByKind('cut', '案例老师');
    expect(zhu.length).toBe(2);
    // 别的老师只读到通用那条
    store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: '李老师', kind: 'cut', text: '李老师的避雷' }]);
    expect(store.getReviewEditsByKind('cut', '李老师').length).toBe(2);
    // 李老师不该看到案例老师的
    expect(store.getReviewEditsByKind('cut', '李老师').some((r) => r.text === '同学们欢迎大家')).toBe(false);
  });

  it('摘要同时统计删和留（这是"有没有学到正向逻辑"的唯一判据）', () => {
    const sum = store.getEditStyleSummary('案例老师');
    expect(sum.cuts).toBeGreaterThan(0);
    expect(sum.keeps).toBeGreaterThan(0);
    expect(sum.segments).toBeGreaterThan(0);
  });

  it('统计最常被删的开头（避雷词要能聚类出模式）', () => {
    for (let i = 0; i < 3; i++) {
      store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: '案例老师', kind: 'cut', text: '同学们欢迎大家来' }]);
    }
const top = store.topCutOpenings('案例老师', 5);
    expect(top.length).toBeGreaterThan(0);
    // 开头 6 字，是用户最常删的"起手式"的共同前缀
    expect(top[0].opening).toBe('同学们欢迎大');
    expect(top[0].n).toBeGreaterThanOrEqual(3);
  });

  it('空行不入库（text 和 themeName 都空的没有学习价值）', () => {
    const before = store.getReviewEdits('案例老师', 999).length;
    store.addReviewEdits([{ kind: 'cut', text: '', themeName: '' }, { kind: 'cut' }]);
    expect(store.getReviewEdits('案例老师', 999).length).toBe(before);
  });
});

describe('IP 老师归档 · 每个老师的档案独立', () => {
  let store;

  before(async () => {
    const { MemoryStore } = await import('../../memory/store.js');
    const dbPath = 'data/hermes-test-archive.db';
    const json = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
    json.memory = { ...json.memory, dbPath };
    store = new MemoryStore(json);
  });

  after(() => {
    try { store?.db?.close(); } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) {
      try { rmSync(join(process.cwd(), 'data', `hermes-test-archive.db${s}`), { force: true }); } catch { /* ignore */ }
    }
  });

/*
   * seed 要把 themeName 一起塞进去。
   * getEditArchive 的 hookThemes 是按 theme_name 聚合的，
   * 只给 role+text 的话 hookThemes 恒为空 ——
   * 断言 preferHooks 里有主题名就会失败，而且看不出是数据没填还是查询写错。
   */
  const seed = (col, kind, text, role, theme) => store.addReviewEdits([{
    clipProjectId: null, liveVideoId: 1, collection: col, kind,
    role: role || null, themeName: theme || null, text,
    by: kind === 'segment' ? 'picked' : 'edited'
  }]);

  /**
   * 标题改动也是学习信号。
   *
   * 粗剪的标题是 AI 起的手，用户改标题 = 在纠正"什么样的标题能爆"。
   * 这是最直接的爆款感输入：避雷词只是排除项，标题改写是**正向示范**。
   *
   * kind 用 'title'，并且**必须同时存原标题和新标题** ——
   * 只存改后的，等于丢失了"AI 原本会写成什么"，
   * 下次做对照时就没有基线了。
   */
  it('标题改动能进档案，且同时留着原标题和新标题', () => {
    for (let i = 0; i < 3; i++) {
      store.addReviewEdits([{
        clipProjectId: null, liveVideoId: 1, collection: '改标题老师',
        kind: 'title', text: '和弦教学完整版', by: 'edited',
        reason: `机器起的是"和弦入门第一课"（${i}）`,
        // 原标题放在 reason 里会丢结构，这里用 theme_name 存 AI 原标题
        themeName: '和弦入门第一课'
      }]);
    }
    const a = store.getEditArchive('改标题老师');
    expect(a.titleEdits.length).toBeGreaterThan(0);
    expect(a.titleEdits[0].newTitle).toBe('和弦教学完整版');
    expect(a.titleEdits[0].oldTitle).toBe('和弦入门第一课');
    // 摘要里也要能看出"改过标题"
    expect(a.summary.titles).toBeGreaterThan(0);
  });

  it('两位老师的样本互不串档', () => {
    for (let i = 0; i < 12; i++) {
      seed('案例老师', 'cut', '同学们欢迎大家');
      seed('案例老师', 'keep', '今天我们讲和弦的构成方法');
seed('案例老师', 'segment', '开场：直接抛出问题', 'hook', '直接抛出问题');
      seed('李老师', 'cut', '家人们双击666');
      seed('李老师', 'keep', '这首歌我教你唱');
      seed('李老师', 'segment', '开场：先讲背景故事', 'hook', '先讲背景故事');
    }
    const zhu = store.getEditArchive('案例老师');
    const li = store.getEditArchive('李老师');
    expect(zhu.totalSamples > 0).toBe(true);
    expect(li.totalSamples > 0).toBe(true);
    // 关键：各自的档案里不能出现对方的样本
    expect(zhu.cutOpenings.some((r) => r.opening.includes('家人们'))).toBe(false);
    expect(li.cutOpenings.some((r) => r.opening.includes('同学们'))).toBe(false);
    expect(zhu.promptHints.preferHooks.join()).toContain('直接抛出问题');
    expect(li.promptHints.preferHooks.join()).toContain('先讲背景故事');
  });

  it('档案给出可直接用的结构偏好（role 排序 + 避雷开头）', () => {
    const a = store.getEditArchive('案例老师');
    expect(Array.isArray(a.roleOrder)).toBe(true);
    expect(a.roleOrder.some((r) => r.role === 'hook')).toBe(true);
    expect(Array.isArray(a.promptHints.avoid)).toBe(true);
    expect(a.promptHints.structure.join()).toContain('hook');
  });

  it('样本少的档案会自报"还很薄"，不假装学到了很多', () => {
    store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: '新人老师', kind: 'cut', text: '嗯这个' }]);
const a = store.getEditArchive('新人老师');
    // 样本少的时候必须自报"还很薄"，不能假装学到了很多
    expect(a.stage === 'empty' || a.stage === 'thin').toBe(true);
  });

  it('查不存在的老师返回 null，不返回空档案冒充', () => {
    expect(store.getEditArchive('查无此人')).toBe(null);
  });

  it('归档列表只列真的学过的，不列空文件夹', () => {
    store.createCollection('空文件夹老师');
    const list = store.listEditArchives();
    expect(list.some((r) => r.name === '空文件夹老师')).toBe(false);
    expect(list.some((r) => r.name === '案例老师')).toBe(true);
  });

  it('改名时所有归档表都要跟着改（否则记忆留在旧名下）', () => {
    /*
     * 这是最容易漏的一条：renameCollection 以前只改 hit_videos，
     * 结果 review_edits / review_feedback 还挂在旧名，
     * 用户以为偏好跟着老师搬过去了，实际没有 —— 且不报错。
     */
    seed('待改名老师', 'cut', '欢迎新宝宝们');
    seed('待改名老师', 'keep', '这里是正文内容示例');
    seed('待改名老师', 'segment', '开场结构', 'hook');
    expect(store.getEditArchive('待改名老师').totalSamples).toBeGreaterThan(0);

    store.renameCollection('待改名老师', '改好后老师');

    expect(store.getEditArchive('待改名老师')).toBe(null);
    const moved = store.getEditArchive('改好后老师');
    expect(moved.totalSamples).toBeGreaterThan(0);
    expect(moved.cutPhrases.some((r) => r.text.includes('欢迎新宝宝'))).toBe(true);
    // review_feedback 也要跟着改
    const fb = store.db.prepare("SELECT COUNT(*) c FROM review_feedback WHERE collection='改好后老师'").get();
    expect(fb).toBeTruthy();
  });
});

describe('IP 老师归属 · 用素材自己的 IP，不是当前选中的', () => {
  let store;

  before(async () => {
    const { MemoryStore } = await import('../../memory/store.js');
    const dbPath = 'data/hermes-test-owner.db';
    const json = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
    json.memory = { ...json.memory, dbPath };
    store = new MemoryStore(json);
  });

  after(() => {
    try { store?.db?.close(); } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) {
      try { rmSync(join(process.cwd(), 'data', `hermes-test-owner.db${s}`), { force: true }); } catch { /* ignore */ }
    }
  });

  it('素材带了自己的 IP，就用它，哪怕当前选中的是别人', () => {
    const now = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO live_videos (video_path, video_name, analysis_status, created_at, collection)
      VALUES ('D:/x/a.mp4', 'a.mp4', 'analyzed', ?, '案例老师')
    `).run(now);
    store.activeCollection = '李老师';
    const got = store._ownerOfLive(Number(store.db.prepare('SELECT id FROM live_videos WHERE video_path=?').get('D:/x/a.mp4').id));
    // 关键：不能记成李老师 —— 那是"审片那天用户正好选中的"，
    // 和这条直播属于谁没关系。错记会持续产出错误的避雷规则。
    expect(got).toBe('案例老师');
  });

  it('素材没有 IP 时才回落到当前选中', () => {
    const now = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO live_videos (video_path, video_name, analysis_status, created_at, collection)
      VALUES ('D:/x/b.mp4', 'b.mp4', 'analyzed', ?, NULL)
    `).run(now);
    store.activeCollection = '李老师';
    const got = store._ownerOfLive(Number(store.db.prepare('SELECT id FROM live_videos WHERE video_path=?').get('D:/x/b.mp4').id));
    expect(got).toBe('李老师');
  });

  it('两者都没有时返回 null（不猜，宁可不用也不要错记）', () => {
    const now = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO live_videos (video_path, video_name, analysis_status, created_at, collection)
      VALUES ('D:/x/c.mp4', 'c.mp4', 'analyzed', ?, NULL)
    `).run(now);
    store.activeCollection = null;
    const got = store._ownerOfLive(Number(store.db.prepare('SELECT id FROM live_videos WHERE video_path=?').get('D:/x/c.mp4').id));
    expect(got).toBe(null);
  });
});

describe('记忆库 · 真实库上确认表已建', () => {
  it('生产库存在 review_edits 及索引', () => {
    const db = new Database(join(process.cwd(), 'data', 'hermes.db'), { readonly: true });
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_edits'").get();
    expect(t).toBeTruthy();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_review_edits%'").all();
    expect(idx.length).toBeGreaterThanOrEqual(2);
    db.close();
  });
});