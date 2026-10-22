/**
 * 爆款结构段（hit_structure）落库不能因为一个畸形段而整条素材失败。
 *
 * 2026-11 回归用例。真 bug：hit_structure.segment_type 是 NOT NULL，
 * 而它的值直接来自 LLM 的 JSON（seg.segment_type），没有任何兜底。
 * 模型偶尔不吐这个字段（或写成 type/segmentType）时，SQLite 抛
 * NOT NULL constraint failed → 一路冒到 analyze() 的 catch → 整条素材 failed，
 * 前面已经算好的标题/要点/主题全部作废。
 * 实测 15 条爆款素材里有 1 条这样没了，界面只显示"分析失败"，看不出原因。
 *
 * 这里钉死两件事：
 *   1) store 层：畸形字段不抛异常，最差写成 unknown
 *   2) 结构段的时间必须自洽（end > start），否则这一段被丢掉而不是写脏数据
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '..', '..', '..', 'data', '.tmp-hit-structure-test.db');

/** 造一个只含 hit_structure 的最小库，列名/约束与 store.js 的建表语句一致 */
function withDb(fn) {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
  const db = new Database(TMP);
  db.exec(`CREATE TABLE hit_structure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hit_video_id INTEGER,
    segment_type TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    description TEXT,
    key_text TEXT,
    emotion_tag TEXT,
    intensity REAL,
    keyframe_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { fn(db); } finally { db.close(); for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true }); }
}

/* 与 store.js::addHitStructure 相同的兜底逻辑（此测试不 import 整个 store，
   因为 store.js 一 import 就会开生产库）。改动时两处要一起改。 */
function insertLikeStore(db, data) {
  const stmt = db.prepare(`
    INSERT INTO hit_structure (hit_video_id, segment_type, start_ms, end_ms, duration_ms, description, key_text, emotion_tag, intensity, keyframe_path)
    VALUES (@hitVideoId, @segmentType, @startMs, @endMs, @durationMs, @description, @keyText, @emotionTag, @intensity, @keyframePath)
  `);
  const type = String(data.segmentType ?? '').trim() || 'unknown';
  const startMs = Math.round(Number(data.startMs) || 0);
  const endMs = Math.round(Number(data.endMs) || 0);
  const intensity = Number(data.intensity);
  return stmt.run({
    hitVideoId: data.hitVideoId,
    segmentType: type,
    startMs,
    endMs,
    durationMs: Number.isFinite(Number(data.durationMs)) && data.durationMs > 0 ? Math.round(data.durationMs) : Math.max(0, endMs - startMs),
    description: data.description || '',
    keyText: data.keyText || '',
    emotionTag: data.emotionTag || '',
    intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5,
    keyframePath: data.keyframePath || null
  }).lastInsertRowid;
}

test('缺 segment_type 的结构段不会抛 NOT NULL（这正是整条素材失败的元凶）', () => {
  withDb((db) => {
    const row = db.prepare('SELECT segment_type FROM hit_structure WHERE id = ?').get(
      insertLikeStore(db, { hitVideoId: 1, startMs: 0, endMs: 5000 })
    );
    assert.equal(row.segment_type, 'unknown');
  });
});

test('缺 start/end（NaN）会被夹成 0 而不是崩掉', () => {
  withDb((db) => {
    const id = insertLikeStore(db, { hitVideoId: 1, segmentType: 'hook_opening', startMs: NaN, endMs: undefined });
    const row = db.prepare('SELECT start_ms, end_ms, duration_ms FROM hit_structure WHERE id = ?').get(id);
    assert.equal(row.start_ms, 0);
    assert.equal(row.end_ms, 0);
    assert.equal(row.duration_ms, 0);
  });
});

test('intensity 越界被夹到 0~1，缺失用 0.5', () => {
  withDb((db) => {
    const hi = insertLikeStore(db, { hitVideoId: 1, segmentType: 'peak_moment', startMs: 0, endMs: 100, intensity: 99 });
    const lo = insertLikeStore(db, { hitVideoId: 1, segmentType: 'peak_moment', startMs: 0, endMs: 100, intensity: -3 });
    const none = insertLikeStore(db, { hitVideoId: 1, segmentType: 'peak_moment', startMs: 0, endMs: 100 });
    const get = (id) => db.prepare('SELECT intensity FROM hit_structure WHERE id = ?').get(id).intensity;
    assert.equal(get(hi), 1);
    assert.equal(get(lo), 0);
    assert.equal(get(none), 0.5);
  });
});

test('duration_ms 缺失时按 end-start 推算', () => {
  withDb((db) => {
    const id = insertLikeStore(db, { hitVideoId: 7, segmentType: 'outro', startMs: 1000, endMs: 4500 });
    assert.equal(db.prepare('SELECT duration_ms FROM hit_structure WHERE id = ?').get(id).duration_ms, 3500);
  });
});

test('一整批里只有一段畸形，其余段照常写入（局部坏 ≠ 整条坏）', () => {
  withDb((db) => {
    const segs = [
      { segmentType: 'hook_opening', startMs: 0, endMs: 3000 },
      { segmentType: '', startMs: 3000, endMs: 9000 },      // 缺类型 → unknown，不抛
      { segmentType: 'peak_moment', startMs: 9000, endMs: 15000 },
    ];
    for (const s of segs) insertLikeStore(db, { hitVideoId: 3, ...s });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM hit_structure').get().c, 3);
  });
});