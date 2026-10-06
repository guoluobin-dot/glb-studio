/**
 * 验证剪辑档案的**非空**状态能正确显示
 *
 * 为什么必须单独验：之前只验过空状态（"还没有从 X 的剪辑里学到东西"）。
 * 而四个区块（避雷/正样本/标题改写/结构偏好）的渲染逻辑
 * 一次都没在真机上跑过 —— 它们的数据来自 getEditArchive，
 * 与空状态是完全不同的分支。
 *
 * 做法：造一位探针老师 + 足够样本（stage 必须到 warm/rich，
 * 否则面板自己会显示"样本还很少"，那验不到内容分支），
 * 面板验证完立刻清干净，不污染真实档案。
 *
 * 用法：node e2e-archive-panel.mjs
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const base = process.env.HERMES_URL || 'http://127.0.0.1:17841';
const db = new Database(join(process.cwd(), 'data', 'hermes.db'));
const COL = '案例老师';
const TMP = join(process.cwd(), 'data', 'e2e-panel-tmp');

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

function purge() {
  db.prepare('DELETE FROM review_edits WHERE collection = ?').run(COL);
  const stale = db.prepare("SELECT id FROM live_videos WHERE video_name LIKE '%panel_probe%'").all();
  for (const r of stale) {
    db.prepare('DELETE FROM clip_projects WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM live_segments WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM live_videos WHERE id = ?').run(r.id);
  }
  return stale.length;
}
purge();

let liveId = null;
try {
  mkdirSync(TMP, { recursive: true });
  const now = new Date().toISOString();
  const li = db.prepare(`
    INSERT INTO live_videos (video_path, video_name, duration_ms, analysis_status, created_at, collection)
    VALUES (?, ?, 0, 'analyzed', ?, ?)
  `).run(join(TMP, 'panel.mp4'), 'panel_probe.mp4', now, COL);
  liveId = Number(li.lastInsertRowid);
  console.log(`探针: live#${liveId} 归属=${COL}\n`);

  // 造够样本：避雷开头 ×15、正样本 ×15、标题改写 ×4、段落结构 ×6
  const edits = [];
  for (let i = 0; i < 15; i++) {
    edits.push({ kind: 'cut', text: '同学们欢迎大家来到直播间', startSec: 100 + i, endSec: 103 + i, by: 'picked' });
    edits.push({ kind: 'keep', text: '先按住这个根音我们慢慢来练', startSec: 200 + i, endSec: 204 + i, by: 'picked' });
  }
  for (let i = 0; i < 4; i++) {
    edits.push({ kind: 'title', text: '零基础唱歌气息练习完整版', oldTitle: '唱歌技巧入门第一课', by: 'edited' });
  }
  for (const [role, theme, score] of [
    ['hook', '直接抛出问题', 0.86],
    ['hook', '反常识对比', 0.82],
    ['body', '逐步拆解练习', 0.78],
    ['body', '现场演示纠错', 0.75],
    ['body', '常见错误清单', 0.72],
    ['cta', '引导关注下一课', 0.55]
  ]) {
    for (let i = 0; i < 3; i++) {
      edits.push({ kind: 'segment', role, themeName: theme, text: theme, score, by: 'picked' });
    }
  }

  const res = await fetch(`${base}/memory/edit-records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liveVideoId: liveId, edits })
  });
  const body = await res.json();
  check(res.ok && body.written === edits.length, `写入 ${body.written} 条样本`);

  const arc = (await (await fetch(`${base}/memory/edit-archives?collection=${encodeURIComponent(COL)}`)).json()).archive;
  check(!!arc, '能读到档案');
  check(arc.stage === 'rich' || arc.stage === 'warm', `样本量够（stage=${arc.stage}, ${arc.totalSamples} 条）`);
  check(arc.cutOpenings.length > 0, `避雷开头有数据（${JSON.stringify(arc.cutOpenings.slice(0, 2).map((c) => c.opening))}）`);
  check(arc.keepSamples.length > 0, `正样本有数据（${arc.keepSamples.length} 条）`);
  check(arc.titleEdits.length === 4, `标题改写有数据（${arc.titleEdits.length} 条）`);
  check(arc.titleEdits[0]?.oldTitle === '唱歌技巧入门第一课', '标题改写带原标题（能做对照）');
  check(arc.roleOrder.length >= 3, `结构偏好有 role 排序（${arc.roleOrder.map((r) => r.role).join(',')}）`);
  check(arc.hookThemes.length >= 1, `认可的开场主题有数据（${arc.hookThemes.length} 个）`);
  check(arc.promptHints.avoid.length > 0 && arc.promptHints.structure.length > 0, '能给出注入提示词');

  console.log(`\n探针已就位：collection=${COL}（面板验证后清理）`);
  console.log('COLLECTION_FOR_PANEL=' + COL);
} catch (err) {
  console.error('ERROR:', err.message);
  fail++;
} finally {
  db.close();
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);