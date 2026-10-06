/**
 * 热词在 /projects/:id/review-packet 上的接缝验证
 *
 * 为什么非要往真库里塞临时数据：
 * unit test 只能证明 loadTranscript 套规则，不能证明
 * 「端点 → 按直播取归属 → 套规则 → 拼文案」这条链是对的。
 * 而这条链以前出过一个很典型的错：collection 存成字符串 "null"，
 * 各层单测全绿，端点上就是不生效。
 *
 * 真实数据里三条直播的 ASR 全丢了（源视频也不在），拿它们测只会得到空文案。
 * 所以这里造临时 live + 临时 ASR，验完按标记精确清理。
 *
 * 重点验两件事：
 *   1. 热词真的落到 review-packet 的文案里
 *   2. **归属隔离**：IP-甲 的规则不会漏到 IP-乙 / 通用稿上
 *      （这正是本次修掉的全局状态串规则的外部表现）
 *
 * @author 郭洛斌
 */
import D from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:17841';
const TMP = join(process.cwd(), 'data', 'tmp-hotword-seam');
const MARK = '热词接缝探针';
const IP_A = `${MARK}-甲`;
const IP_B = `${MARK}-乙`;
const WRONG = '陈案例老师';
const RIGHT = '陈珠老师';

mkdirSync(TMP, { recursive: true });

/** 临时 ASR：两句话，命中热词 */
const ASR_NAME = 'seam.transcript.json';
const asrPath = join(TMP, ASR_NAME);
writeFileSync(asrPath, JSON.stringify({
  segments: [
    { start_ms: 0, end_ms: 5000, text: `我是${WRONG}` },
    { start_ms: 5000, end_ms: 10000, text: `${WRONG}今天讲${WRONG}` }
  ]
}), 'utf-8');

const db = new D('data/hermes.db');
let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};
const api = (p) => fetch(BASE + p).then((r) => r.json());

/* 记住 id，清理时只删自己造的，绝不按名字模糊删 */
const made = { lives: [], projects: [], segments: [] };

try {
  console.log(`临时 ASR: ${asrPath}`);
  console.log(`原文含 "${WRONG}"，规则改成 "${RIGHT}"\n`);

  const mkLive = (name) => {
    const r = db.prepare(
      `INSERT INTO live_videos (video_path, video_name, duration_ms, file_size, analysis_status,
                                asr_path, segment_count, clip_count, created_at, analyzed_at, analysis_health, collection)
       VALUES (?, ?, ?, 0, 'completed', ?, 2, 1, datetime('now'), datetime('now'), 'ok', ?)`
    ).run(join(TMP, `${name}.mp4`), `${name}.mp4`, 10000, asrPath, name);
    const id = Number(r.lastInsertRowid);
    made.lives.push(id);
    for (let i = 0; i < 2; i++) {
      const s = db.prepare(
        `INSERT INTO live_segments (live_video_id, segment_index, start_ms, end_ms, duration_ms,
                                    theme_name, theme_confidence, matched_hit_themes, hook_quality,
                                    peak_count, transcript_summary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, '[]', 0.8, 100, ?, 'kept', datetime('now'))`
      ).run(id, i, i * 5000, (i + 1) * 5000, 5000, `${MARK}段${i}`, `原文第${i}句`);
      made.segments.push(Number(s.lastInsertRowid));
    }
    return id;
  };

  const mkProject = (liveId, label) => {
    const segs = [{ segmentId: made.segments.find((s) => true) || null, startMs: 0, endMs: 10000, themeName: `${label}段`, role: 'hook', hookQuality: 0.8 }];
    const r = db.prepare(
      `INSERT INTO clip_projects (live_video_id, project_name, status, selected_segments, total_duration_ms, output_path, created_at, updated_at)
       VALUES (?, ?, 'reviewing', ?, 10000, '', datetime('now'), datetime('now'))`
    ).run(liveId, `${MARK}-${label}`, JSON.stringify(segs));
    const id = Number(r.lastInsertRowid);
    made.projects.push(id);
    return id;
  };

  const liveA = mkLive(IP_A);
  const liveB = mkLive(IP_B);
  // 甲挂 IP，乙挂另一个 IP（通用稿的隔离由 IP-甲 的规则不外泄来体现）
  const projA = mkProject(liveA, 'A');
  const projB = mkProject(liveB, 'B');

  // 只给甲建热词
  db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(IP_A);
  db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(IP_B);
  db.prepare('INSERT INTO hotwords (collection, from_word, to_word, hits) VALUES (?, ?, ?, 0)').run(IP_A, WRONG, RIGHT);
  console.log(`liveA=${liveA} projA=${projA} | liveB=${liveB} projB=${projB}\n`);

  console.log('== 1. IP-甲 的文案应该已被纠正 ==');
  const a = await api(`/projects/${projA}/review-packet`);
  const textA = (a.segments || []).map((s) => s.text || '').join('');
  check(textA.includes(RIGHT), `文案里出现 "${RIGHT}"`, JSON.stringify(textA));
  check(!textA.includes(WRONG), `原文 "${WRONG}" 已不出现`, JSON.stringify(textA));
  check((a.segments || []).length > 0, '端点确实返回了段落', JSON.stringify((a.segments || []).length));

  console.log('\n== 2. 归属隔离：IP-乙 没有规则，必须还是原文 ==');
  const b = await api(`/projects/${projB}/review-packet`);
  const textB = (b.segments || []).map((s) => s.text || '').join('');
  check(textB.includes(WRONG), `IP-乙 的文案仍是原文 "${WRONG}"`, JSON.stringify(textB));
  check(!textB.includes(RIGHT), 'IP-乙 不该拿到 IP-甲 的规则', JSON.stringify(textB));

  console.log('\n== 3. 删掉规则后要立刻恢复原文 ==');
  db.prepare('DELETE FROM hotwords WHERE collection = ? AND from_word = ?').run(IP_A, WRONG);
  const a2 = await api(`/projects/${projA}/review-packet`);
  const textA2 = (a2.segments || []).map((s) => s.text || '').join('');
  check(textA2.includes(WRONG), '规则删掉后原文回来了', JSON.stringify(textA2));
} catch (err) {
  fail++;
  console.log('  ERROR', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
} finally {
  console.log('\n== 清理 ==');
  for (const id of made.projects) db.prepare('DELETE FROM clip_projects WHERE id = ?').run(id);
  for (const id of made.segments) db.prepare('DELETE FROM live_segments WHERE id = ?').run(id);
  for (const id of made.lives) db.prepare('DELETE FROM live_videos WHERE id = ?').run(id);
  db.prepare(`DELETE FROM hotwords WHERE collection LIKE ?`).run(`${MARK}%`);
  db.prepare(`DELETE FROM collections WHERE name LIKE ?`).run(`${MARK}%`);
  db.close();
  rmSync(TMP, { recursive: true, force: true });
  console.log(`  临时数据已删（live=${made.lives.length} project=${made.projects.length} segment=${made.segments.length}）`);
  console.log(`  临时目录还在? ${existsSync(TMP)}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);