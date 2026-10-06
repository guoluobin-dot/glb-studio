/**
 * 剪辑决策学习：样本抽取的回归测试
 *
 * 这里守的是整个学习系统最容易做错、且错了完全静默的一件事：
 * **只学删除、不学保留。**
 *
 * 删除是显式动作，保留是默认动作。如果只把删掉的写进库，
 * 系统学到的只有"别说什么"，而"该说什么"—— 也就是爆款的正向逻辑 ——
 * 一条样本都没有。下次找爆点会得出反向结论：
 * 凡是用户删过的类型都别要，包括用户其实很喜欢的那些。
 *
 * @author 郭洛斌
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { splitByCuts, keptSegments, buildLearningRecord } from '../review-learning.js';

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

const PUNCT = /[，。！？、；：,.!?;]/;

/** 与 charRangeToTime 同算法（review-learning.mapRange 的行为） */
function mapRange(sentences, r, segStart) {
  const spans = [];
  let cursor = 0;
  for (const s of sentences) {
    const t = String(s.text || '');
    spans.push({ from: cursor, to: cursor + t.length, text: t, startMs: s.startMs, endMs: s.endMs });
    cursor += t.length + 1;
  }
  const text = sentences.map((s) => s.text).join(' ');
  const from = Math.max(0, Math.min(text.length, Math.floor(r.from ?? 0)));
  const to = Math.max(from, Math.min(text.length, Math.ceil(r.to ?? 0)));
  if (to <= from) return null;
  let st = Infinity;
  let en = -Infinity;
  for (const sp of spans) {
    const a = Math.max(from, sp.from);
    const b = Math.min(to, sp.to);
    if (b <= a) continue;
    const span = Math.max(0, sp.endMs - sp.startMs);
    if (!(span > 0)) continue;
    const spoken = Math.max(1, [...sp.text].filter((c) => !PUNCT.test(c)).length);
    let w = 0;
    for (let i = 0; i < a - sp.from; i++) w += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
    let w2 = 0;
    for (let i = 0; i < b - sp.from; i++) w2 += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
    st = Math.min(st, segStart + sp.startMs + span * (w / spoken));
    en = Math.max(en, segStart + sp.startMs + span * (w2 / spoken));
  }
  if (!Number.isFinite(st) || en <= st) return null;
  return { st: Math.round(st), en: Math.round(en) };
}

const SENTENCES = [
  { startMs: 0, endMs: 10000, text: '同学们欢迎大家来到我的直播间' },
  { startMs: 10000, endMs: 20000, text: '今天我们来讲和弦的构成' },
  { startMs: 20000, endMs: 30000, text: '首先按住这个根音' }
];
const TEXT = SENTENCES.map((s) => s.text).join(' ');

describe('学习样本 · 删与留都要记', () => {
  it('删第一句的话术，第二三句必须作为 keep 留下来', () => {
    const cuts = [mapRange(SENTENCES, { from: 0, to: SENTENCES[0].text.length }, 0)];
    const r = splitByCuts(SENTENCES, TEXT, cuts, 0);
    expect(r.cuts.length).toBe(1);
    expect(r.cuts[0].text).toContain('同学们欢迎');
    // 这是最关键的一条断言：留存的比删掉的多得多
    expect(r.keeps.length).toBeGreaterThan(0);
    expect(r.keeps.map((k) => k.text).join('')).toContain('和弦的构成');
  });

  it('不删任何东西时，全部都是 keep（保留是默认动作，必须显式记）', () => {
    const r = splitByCuts(SENTENCES, TEXT, [], 0);
    expect(r.cuts.length).toBe(0);
    expect(r.keeps.length).toBe(3);
  });

  it('删整句时该句不产生 keep（否则会把删掉的内容当成正样本）', () => {
    const all = SENTENCES.map((s) => s.text).join(' ').length;
    const r = splitByCuts(SENTENCES, TEXT, [mapRange(SENTENCES, { from: 0, to: all }, 0)], 0);
    expect(r.keeps.length).toBe(0);
    expect(r.cuts.length).toBe(3);
  });

  it('句内局部删除：切出来的 keep 拼回原文（不丢字、不重字）', () => {
    const s0 = SENTENCES[0].text;
    // 删"欢迎大家"四个字
    const r = splitByCts(s0);
    function splitByCts(t) {
      const cuts = [mapRange(SENTENCES, { from: 3, to: 7 }, 0)];
      return splitByCuts(SENTENCES, TEXT, cuts, 0);
    }
    const cutTxt = r.cuts.map((c) => c.text).join('');
    const keepTxt = r.keeps.map((k) => k.text).join('');
    expect(cutTxt.length + keepTxt.length).toBe(TEXT.replace(/ /g, '').length);
    expect(keepTxt).toContain('同学们');
  });

  it('cut 带字符位置，能反查回原文（学习样本要能溯源）', () => {
    const r = splitByCuts(SENTENCES, TEXT, [mapRange(SENTENCES, { from: 0, to: 3 }, 0)], 0);
    const c = r.cuts[0];
    expect(c.fromChar).toBe(0);
    expect(c.toChar).toBe(3);
    expect(TEXT.slice(c.fromChar, c.toChar)).toBe(c.text);
  });

  it('空句子列表不崩（实操段没有文本）', () => {
    const r = splitByCts();
    function splitByCts() { return splitByCuts([], '', [], 0); }
    expect(r.cuts.length).toBe(0);
    expect(r.keeps.length).toBe(0);
  });
});

describe('学习样本 · 整段保留的内容逻辑', () => {
  const picked = [
    { id: 1, role: 'hook', themeName: '欢迎语', hookQuality: 0.9, startMs: 0, endMs: 15000 },
    { id: 2, role: 'body', themeName: '和弦讲解', hookQuality: 0.7, startMs: 15000, endMs: 60000 },
    { id: 3, role: 'cta', themeName: '关注引导', hookQuality: 0.5, startMs: 60000, endMs: 70000 }
  ];

  it('勾选的段全部记下来，带上角色（结构层信号）', () => {
    const kept = keptSegments(picked, []);
    expect(kept.length).toBe(3);
    expect(kept.map((k) => k.role)).toEqual(['hook', 'body', 'cta']);
    expect(kept[0].by).toBe('picked');
  });

  it('被点名打回的段不算"用户认可"（不能当正样本学）', () => {
    const kept = keptSegments(picked, [1]);
    expect(kept.length).toBe(2);
    expect(kept.find((k) => k.segmentId === 1)).toBeUndefined();
  });

  it('只靠一个字段就能区分主动认可和默认保留', () => {
    // by 必须有：用户没点勾选框的段只能算"没反对"，
    // 当成"用户认为这段好"是过度解读，会把噪声学进去。
    const kept = keptSegments(picked, []);
    for (const k of kept) expect(k.by).toBe('picked');
  });
});

describe('学习样本 · buildLearningRecord 汇总', () => {
  it('同时产出 cut / keep / segment 三类', () => {
    const editableBySeg = new Map([[1, { text: TEXT, sentences: SENTENCES }]]);
    const rec = buildLearningRecord({
      picked: [{ id: 1, role: 'hook', themeName: '开场', hookQuality: 0.8, startMs: 0, endMs: 30000 }],
      rejectedIds: [],
      textCuts: [{ segmentId: 1, ranges: [{ from: 0, to: 3 }] }],
      editableBySeg,
      segStartById: new Map([[1, 0]]),
      liveVideoId: 1,
      comment: '开场别念欢迎语'
    });
    expect(rec.cuts.length).toBe(1);
    expect(rec.keeps.length).toBeGreaterThan(0);
    expect(rec.keptSegments.length).toBe(1);
  });

  it('被点名打回的段，其文字取舍不算认可（不记 keep）', () => {
    const editableBySeg = new Map([[1, { text: TEXT, sentences: SENTENCES }]]);
    const rec = buildLearningRecord({
      picked: [{ id: 1, role: 'body', themeName: 'x', hookQuality: 0.5, startMs: 0, endMs: 30000 }],
      rejectedIds: [1],
      textCuts: [{ segmentId: 1, ranges: [{ from: 0, to: 3 }] }],
      editableBySeg,
      segStartById: new Map([[1, 0]]),
      liveVideoId: 1,
      comment: ''
    });
    // 整段被否决 → 没有 keptSegments，文字样本也不该记成正样本
    expect(rec.keptSegments.length).toBe(0);
    expect(rec.keeps.length).toBe(0);
  });
});

describe('记忆库 · review_edits 落库与读取', () => {
  const dbPath = 'data/hermes-test-edits.db';
  let store;

  before(async () => {
    // \u5bfc\u51fa\u540d\u662f MemoryStore
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
      { clipProjectId: null, liveVideoId: 1, collection: '某老师', kind: 'cut', text: '同学们欢迎大家', by: 'edited' },
      { clipProjectId: null, liveVideoId: 1, collection: '某老师', kind: 'keep', text: '今天讲和弦的构成', by: 'edited' },
      { clipProjectId: null, liveVideoId: 1, collection: '某老师', kind: 'segment', role: 'hook', themeName: '开场', text: '正文…', by: 'picked' }
    ]);
    expect(n).toBe(3);
    expect(store.getReviewEditsByKind('keep', '某老师').length).toBe(1);
    expect(store.getReviewEditsByKind('segment', '某老师').length).toBe(1);
  });

  it('按 IP 老师隔离，且通用样本（collection=NULL）对所有人可见', () => {
    store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: null, kind: 'cut', text: '欢迎新宝宝' }]);
    // 某老师应能读到自己的 + 通用的
    const zhu = store.getReviewEditsByKind('cut', '某老师');
    expect(zhu.length).toBe(2);
    // 别的老师只读到通用那条
    store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: '李老师', kind: 'cut', text: '李老师的避雷' }]);
    expect(store.getReviewEditsByKind('cut', '李老师').length).toBe(2);
    // 李老师不该看到某老师的
    expect(store.getReviewEditsByKind('cut', '李老师').some((r) => r.text === '同学们欢迎大家')).toBe(false);
  });

  it('摘要同时统计删和留（这是"有没有学到正向逻辑"的唯一判据）', () => {
    const sum = store.getEditStyleSummary('某老师');
    expect(sum.cuts).toBeGreaterThan(0);
    expect(sum.keeps).toBeGreaterThan(0);
    expect(sum.segments).toBeGreaterThan(0);
  });

  it('统计最常被删的开头（避雷词要能聚类出模式）', () => {
    for (let i = 0; i < 3; i++) {
      store.addReviewEdits([{ clipProjectId: null, liveVideoId: 1, collection: '某老师', kind: 'cut', text: '同学们欢迎大家来' }]);
    }
const top = store.topCutOpenings('某老师', 5);
    expect(top.length).toBeGreaterThan(0);
    // 开头 6 字，是用户最常删的"起手式"的共同前缀
    expect(top[0].opening).toBe('同学们欢迎大');
    expect(top[0].n).toBeGreaterThanOrEqual(3);
  });

  it('空行不入库（text 和 themeName 都空的没有学习价值）', () => {
    const before = store.getReviewEdits('某老师', 999).length;
    store.addReviewEdits([{ kind: 'cut', text: '', themeName: '' }, { kind: 'cut' }]);
    expect(store.getReviewEdits('某老师', 999).length).toBe(before);
  });
});

describe('IP 老师归档 · 每个老师的档案独立', () => {
  let store;

  before(async () => {
    // \u5bfc\u51fa\u540d\u662f MemoryStore
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
      seed('某老师', 'cut', '同学们欢迎大家');
      seed('某老师', 'keep', '今天我们讲和弦的构成方法');
seed('某老师', 'segment', '开场：直接抛出问题', 'hook', '直接抛出问题');
      seed('李老师', 'cut', '家人们双击666');
      seed('李老师', 'keep', '这首歌我教你唱');
      seed('李老师', 'segment', '开场：先讲背景故事', 'hook', '先讲背景故事');
    }
    const zhu = store.getEditArchive('某老师');
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
    const a = store.getEditArchive('某老师');
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
    expect(list.some((r) => r.name === '某老师')).toBe(true);
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
      VALUES ('D:/x/a.mp4', 'a.mp4', 'analyzed', ?, '某老师')
    `).run(now);
    store.activeCollection = '李老师';
    const got = store._ownerOfLive(Number(store.db.prepare('SELECT id FROM live_videos WHERE video_path=?').get('D:/x/a.mp4').id));
    // 关键：不能记成李老师 —— 那是"审片那天用户正好选中的"，
    // 和这条直播属于谁没关系。错记会持续产出错误的避雷规则。
    expect(got).toBe('某老师');
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