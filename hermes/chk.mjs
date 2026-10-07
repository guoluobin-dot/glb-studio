import D from 'better-sqlite3';
const db = new D('<GLB_ROOT>/Hermes/data/hermes.db', { readonly: true });
const COL = '案例老师';

console.log('=== hit_videos 分析状态 ===');
const rows = db.prepare(`select id, analysis_status, coalesce(last_error,'') err,
    length(coalesce(title,'')) tl from hit_videos where collection=? order by id`).all(COL);
const by = {};
for (const r of rows) by[r.analysis_status] = (by[r.analysis_status] || 0) + 1;
console.log('  汇总:', JSON.stringify(by));
for (const r of rows.filter((x) => x.analysis_status !== 'completed')) {
  console.log(`  #${r.id} ${r.analysis_status}  ${r.err ? '原因: ' + r.err.slice(0, 70) : '(无错误信息)'}`);
}

console.log('\n=== 主题样本量（分析完会涨）===');
const t = db.prepare(`select h.theme_name, count(*) n from hit_themes h
  join hit_videos v on v.id=h.hit_video_id where v.collection=?
  group by h.theme_name order by n desc limit 6`).all(COL);
for (const r of t) console.log(`  ${String(r.n).padStart(2)}  「${r.theme_name}」`);
const tot = db.prepare(`select count(*) n from hit_themes h join hit_videos v on v.id=h.hit_video_id where v.collection=?`).get(COL).n;
console.log(`  主题总数 ${tot}`);
const ge10 = db.prepare(`select count(*) n from (select h.theme_name, count(*) c from hit_themes h
  join hit_videos v on v.id=h.hit_video_id where v.collection=?
  group by h.theme_name having c>=10)`).get(COL).n;
console.log(`  样本≥10（可注入分析）的主题数: ${ge10}`);
db.close();
