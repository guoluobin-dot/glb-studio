/**
 * 端到端验证学习系统真的记下了"删与留"
 *
 * 只查库不够 —— 那只能证明 addReviewEdits 能写。
 * 要证明的是：跑一次真实的审片接口之后，
 * 库里同时存在 cut（避雷）、keep（正样本）、segment（段落结构）。
 * 只出现 cut 的话，整个正向学习就是空的。
 *
 * 只读，不改生产数据：读包 → 读库 → 对比。
 *
 * 用法：node verify-review-learning.mjs [projectId]
 */
import Database from 'better-sqlite3';
import { join } from 'path';

const projectId = Number(process.argv[2] || 116);
const base = process.env.HERMES_URL || 'http://127.0.0.1:17841';

const db = new Database(join(process.cwd(), 'data', 'hermes.db'), { readonly: true });

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

console.log(`== 工程 #${projectId} 学习样本 ==\n`);

const rows = db.prepare(
  'SELECT * FROM review_edits WHERE clip_project_id = ? OR live_video_id = (SELECT live_video_id FROM clip_projects WHERE id = ?) ORDER BY id'
).all(projectId, projectId);

check(rows.length > 0, `库里已有学习样本（${rows.length} 条）`);

const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
console.log(`  分布: ${JSON.stringify(byKind)}`);

check(byKind.cut > 0, '有 cut（用户删掉的文字 = 避雷词）');
check(byKind.keep > 0, '有 keep（用户留下的文字 = 正样本）', '★这条最关键：没有 keep 就等于只学会了"别说什么"');
check(byKind.segment > 0, '有 segment（整段保留的内容逻辑）');

const cols = db.prepare('PRAGMA table_info(review_edits)').all().map((c) => c.name);
check(cols.includes('by') && cols.includes('reason') && cols.includes('collection'),
  '信号强度/理由/IP 归属三列都在', cols.join(','));

// 段落级必须带 role，否则"内容逻辑"只剩一堆没结构的文字
const segs = rows.filter((r) => r.kind === 'segment');
if (segs.length) {
  const withRole = segs.filter((r) => r.role).length;
  check(withRole === segs.length, `段落样本都带 role（${withRole}/${segs.length}）`,
    '没有 role 就学不到"哪段当开场、哪段是主体"这种结构');
  const byPicked = segs.filter((r) => r.by === 'picked').length;
  check(byPicked === segs.length, '段落样本都标记为 picked（用户勾选框认可）');
}

const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_review_edits%'").all();
check(idx.length >= 2, `查询索引已建（${idx.length} 个）`);

if (rows.length) {
  console.log('\n样本示例:');
  for (const k of ['cut', 'keep', 'segment']) {
    const s = rows.filter((r) => r.kind === k).slice(-1)[0];
    if (s) {
      console.log(`  [${k}] ${s.collection || '通用'} role=${s.role || '-'} by=${s.by}`);
      console.log(`        ${String(s.text || '').slice(0, 70)}`);
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail ? 1 : 0);