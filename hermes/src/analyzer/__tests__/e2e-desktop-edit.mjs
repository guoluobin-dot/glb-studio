/**
 * 端到端验证桌面端那条链路：改标题 + 剔句子 → 同步到该 IP 老师的档案
 *
 * 走的是真实端点 POST /memory/edit-records，
 * 而不是直接调 store —— 因为归属判定（记到谁名下）
 * 和清洗规则都活在这个端点里，绕过它就测不到真正会出错的地方。
 *
 * 只读+临时写入，跑完清理。
 *
 * 用法：node e2e-desktop-edit.mjs
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

const base = process.env.HERMES_URL || 'http://127.0.0.1:17841';
const dbPath = join(process.cwd(), 'data', 'hermes.db');
const db = new Database(dbPath);
const TMP = join(process.cwd(), 'data', 'e2e-desk-tmp');
const tag = '__e2e_desk_probe__';
const COL = '桌面端探针老师';

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

function purge() {
  const stale = db.prepare(
    "SELECT id FROM live_videos WHERE video_path LIKE '%e2e-desk-tmp%' OR video_name LIKE ?"
  ).all(`%${tag}%`);
  for (const r of stale) {
    const pids = db.prepare('SELECT id FROM clip_projects WHERE live_video_id = ?').all(r.id).map((x) => x.id);
    for (const pid of pids) {
      db.prepare('DELETE FROM review_edits WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM review_feedback WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM clip_projects WHERE id = ?').run(pid);
    }
    db.prepare('DELETE FROM review_edits WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM live_segments WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM live_videos WHERE id = ?').run(r.id);
  }
  db.prepare('DELETE FROM review_edits WHERE collection = ?').run(COL);
  return stale.length;
}
const purged = purge();
if (purged) console.log(`清掉 ${purged} 条残留\n`);

let liveId = null;
try {
  mkdirSync(TMP, { recursive: true });
  const ASR = join(TMP, `${tag}_asr.json`);
  const sentences = [
    { start_ms: 0, end_ms: 10000, text: '和弦入门第一课今天我们来讲一下' },
    { start_ms: 10000, end_ms: 20000, text: '首先按住这个根音' },
    { start_ms: 20000, end_ms: 30000, text: '家人们双击666点个关注' }
  ];
  writeFileSync(ASR, JSON.stringify({ segments: sentences }), 'utf8');

  const now = new Date().toISOString();
  const li = db.prepare(`
    INSERT INTO live_videos (video_path, video_name, duration_ms, analysis_status, asr_path, created_at, collection)
    VALUES (?, ?, ?, 'analyzed', ?, ?, ?)
  `).run(join(TMP, 'desk.mp4'), `${tag}.mp4`, 30000, ASR, now, COL);
  liveId = Number(li.lastInsertRowid);
  console.log(`探针: live#${liveId} 归属=${COL}\n`);

  // 桌面端在审阅台做的三件事：改标题、剔掉寒暄句、留下干货句
  const edits = [
    { kind: 'title', text: '和弦教学完整版', oldTitle: '和弦入门第一课', by: 'edited' },
    { kind: 'cut', text: '家人们双击666点个关注', startSec: 20, endSec: 30, by: 'picked', reason: '开场寒暄' },
    { kind: 'keep', text: '首先按住这个根音', startSec: 10, endSec: 20, by: 'picked' }
  ];

  const res = await fetch(`${base}/memory/edit-records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liveVideoId: liveId, reason: '开场寒暄', edits })
  });
  const body = await res.json();
  check(res.ok && body.ok, '端点返回成功', JSON.stringify(body).slice(0, 140));
  check(body.collection === COL, `归档到素材自己的 IP（${body.collection}）`,
    '★ 不该是当前选中的 IP');
  check(body.written === 3, `写入 3 条（${body.written}）`);

  // 库里的实际内容
  const rows = db.prepare('SELECT * FROM review_edits WHERE collection = ? ORDER BY id').all(COL);
  check(rows.length === 3, `库里 3 条（${rows.length}）`);
  const kinds = rows.map((r) => r.kind).sort();
  check(kinds.join(',') === 'cut,keep,title', `三类信号都在（${kinds.join(',')}）`);

  const t = rows.find((r) => r.kind === 'title');
  check(t?.text === '和弦教学完整版', '标题：新标题存进 text');
  check(t?.theme_name === '和弦入门第一课', '标题：AI 原标题存进 theme_name（要做对照）');

  // 归档接口
  const arc = await (await fetch(`${base}/memory/edit-archives?collection=${encodeURIComponent(COL)}`)).json();
  check(arc.ok && arc.archive, '能读到该老师的档案');
  const a = arc.archive;
  check(a.titleEdits.length === 1 && a.titleEdits[0].newTitle === '和弦教学完整版',
    '档案里有标题改写记录');
  check(a.titleEdits[0].oldTitle === '和弦入门第一课', '档案里同时留着原标题');
  check(a.summary.titles === 1, `摘要统计到改过 1 次标题（${a.summary.titles}）`);
  check(a.summary.cuts === 1 && a.summary.keeps === 1, '摘要同时统计删和留');
  check(a.promptHints.avoid.length > 0, `避雷开头已提取（${JSON.stringify(a.promptHints.avoid)}）`);

  // 列表
  const list = await (await fetch(`${base}/memory/edit-archives`)).json();
  check(list.archives.some((x) => x.name === COL), '归档列表里有这位老师');

  // 改名要全搬
  const newCol = `${COL}改名后`;
  db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(newCol);
  // 通过 store 的 rename 才算真（接口层不暴露 rename，这里直接验库的效果等价性）
  const { MemoryStore } = await import('../../memory/store.js');
  const s = new MemoryStore(JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8')));
  s.renameCollection(COL, newCol);
  check(
    db.prepare('SELECT COUNT(*) c FROM review_edits WHERE collection = ?').get(newCol).c === 3,
    '改名后 3 条样本全部跟过去了'
  );
  s.db.close();
  // 还原名字，避免污染后面的手工验证
  const s2 = new MemoryStore(JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8')));
  s2.renameCollection(newCol, COL);
  s2.db.close();
} catch (err) {
  console.error('ERROR:', err.message, err.stack?.split('\n')[1] || '');
  fail++;
} finally {
  purge();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run(); } catch { /* ignore */ }
  db.close();
  console.log('\n已清理探针数据');
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);