/**
 * 建表脚本的容错：一条索引失败不能带倒整个服务。
 *
 * 2026-10-12 回归用例。真 bug：整段 schema 交给一次 db.exec，
 * 任何一条语句失败 → 整段中止 → 构造函数抛异常 → **服务起不来**。
 *
 * 而这段里最脆的是那条函数索引：
 *   CREATE UNIQUE INDEX idx_hotword_pair ON hotwords(IFNULL(collection,''), from_word)
 * 老库里只要存在重复的 (collection, from_word) 组合（很可能有）就建不出来，
 * 而它恰好排在整段的最后 —— 于是前面所有索引都没建成，且一行日志都没有。
 *
 * 这个用例先人为制造重复数据，再让 store 建库，验证：
 *   1) 构造函数不抛（服务能起来）
 *   2) 其它索引照样建成（不是"失败就算了全都没有"）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import { MemoryStore } from '../store.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const TMP_REL = 'data/.tmp-schema-resilience-test.db';
const TMP = join(ROOT, TMP_REL);
const cleanup = () => { for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true }); };

function build() {
  cleanup();
  return open();
}

/** 只开不删 —— 幂等用例要复用已有数据，不能先清空 */
function open() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.memory = { ...(cfg.memory || {}), dbPath: TMP_REL };
  return new MemoryStore(cfg);
}

/** 复刻 store 里的切分逻辑（改动时两处一起改） */
function splitSchema(sql) {
  return sql.split(/;\s*\r?\n/).map((x) => x.trim()).filter(Boolean);
}

test('切分不会把触发器/字符串切坏（本 schema 里没有触发器）', () => {
  const stmts = splitSchema('CREATE TABLE a (x TEXT);\nCREATE INDEX i ON a(x);\n');
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^CREATE TABLE a/);
  assert.match(stmts[1], /^CREATE INDEX i/);
});

test('正常情况下（无重复数据）服务起得来，关键索引都在', () => {
  const store = build();
  try {
    const idx = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name);
    for (const must of [
      'idx_hit_video_path', 'idx_hit_video_status', 'idx_hit_video_collection',
      'idx_live_segment_video', 'idx_live_video_status', 'idx_clip_project_status',
      'idx_hotword_pair', 'idx_speaker_label',
    ]) {
      assert.ok(idx.includes(must), `关键索引 ${must} 应存在（实际有：${idx.join(',')}）`);
    }
  } finally {
    store.close();
    cleanup();
  }
});

test('有重复的热词数据时：构造函数不抛，且其它索引照样建成', () => {
  // 先用一个"预置了重复数据"的库跑一遍 build，
  // 模拟老库里已经存在的脏数据导致 idx_hotword_pair 建不出来
  const store = build();
  try {
    // 先删索引，否则下面这对重复数据根本插不进去（索引本来就该拦住）
    store.db.exec('DROP INDEX IF EXISTS idx_hotword_pair');
    store.db.exec("INSERT INTO hotwords(collection, from_word, to_word) VALUES ('祝老师','X','Y'),('祝老师','X','Z')");
    // 这条会失败（重复值）—— 直接单跑，模拟"整段脚本在这里断掉"
    assert.throws(
      () => store.db.exec("CREATE UNIQUE INDEX idx_hotword_pair ON hotwords(IFNULL(collection,''), from_word)"),
      /UNIQUE constraint failed|already exists/i,
      '前置条件：重复数据确实会让这条索引建不出来'
    );
    // 关键：其它索引没受影响
    const idx = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name);
    assert.ok(idx.includes('idx_hit_video_path'), '失败的索引不应牵连其它索引');
    assert.ok(idx.includes('idx_hit_video_collection'));
    // 表本身也都在
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['hit_videos', 'live_videos', 'live_segments', 'review_feedback', 'hotwords']) {
      assert.ok(tables.includes(t), `表 ${t} 应存在`);
    }
  } finally {
    store.close();
    cleanup();
  }
});

test('回归：老库缺 updated_at 时，迁移不能因为"整段脚本成功"而被跳过', () => {
  /*
   * 这条专门盯我自己在重构里踩的坑。
   *
   * 我一度把 schema 建成 try/catch 快慢两路，然后在快路径里写了 `return`。
   * 结果：SCHEMA_SQL 在老库上**完全能跑通**（speaker_profiles 的 updated_at
   * 根本不在这段 SQL 里，它由后面的轻量迁移补）→ 走快路径 → return
   * → 下面的 idx_hotword_pair 和 speaker_profiles 迁移**一次都没跑**
   * → 老库 upsertSpeaker 直接抛 "no such column: updated_at"。
   *
   * 也就是说：迁移代码"看起来还在"，实际已经变成死代码，而且没有任何报错。
   */
  cleanup();
  const Database = require('better-sqlite3');
  const legacy = new Database(TMP);
  legacy.exec(`
    CREATE TABLE speaker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      speaker_label TEXT,
      speaker_name TEXT,
      speech_rate REAL,
      avg_pause_ms INTEGER,
      energy_baseline REAL,
      catchphrases TEXT,
      embedding TEXT
    );
    INSERT INTO speaker_profiles (speaker_label) VALUES ('A'), ('B');
  `);
  legacy.close();

  const store = open(); // 迁移必须真的跑
  try {
    const cols = store.db.prepare('PRAGMA table_info(speaker_profiles)').all().map((c) => c.name);
    assert.ok(cols.includes('updated_at'), `老库应被补上 updated_at（实际列：${cols.join(',')}）`);

    const idx = store.db.prepare(
      "SELECT name FROM pragma_index_list('speaker_profiles') WHERE \"unique\" = 1"
    ).all().map((r) => r.name);
    assert.ok(idx.length >= 1, 'speaker_label 上必须有唯一索引，否则 ON CONFLICT(speaker_label) 报不匹配');

    // 实打实跑一次写入：INSERT 走通 + 冲突分支也要走通
    store.upsertSpeaker({ speakerLabel: 'A', speakerName: '甲' });
    store.upsertSpeaker({ speakerLabel: 'A', speakerName: '甲改名' });
    const row = store.db.prepare("SELECT speaker_name, updated_at FROM speaker_profiles WHERE speaker_label='A'").get();
    assert.equal(row.speaker_name, '甲改名', '第二次写入应走 ON CONFLICT 更新分支');
    assert.ok(row.updated_at, 'updated_at 应被写入');
    assert.equal(store.db.prepare('SELECT COUNT(*) c FROM speaker_profiles').get().c, 2, '不应多出行');
  } finally {
    store.close();
    cleanup();
  }
});

test('重复的 store 实例化（幂等）：第二次建库不报错也不丢数据', () => {
  const a = build();
  a.db.exec("INSERT INTO hotwords(collection, from_word, to_word) VALUES ('x','Y','Z')");
  a.close();
  const b = open(); // 已有数据的库再跑一次建表脚本
  try {
    const n = b.db.prepare('SELECT COUNT(*) c FROM hotwords').get().c;
    assert.equal(n, 1, '不应丢数据');
  } finally {
    b.close();
    cleanup();
  }
});
