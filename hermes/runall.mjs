/**
 * 逐条分析剩下的 pending 爆款。
 *
 * 为什么手动而不用调度器：调度器每 30 秒扫一次，isRunning=true、
 * 没暂停、GPU 空闲，但它就是不捞这批队列（14 条转写都在，状态全是 pending）。
 * 手动打 /pipeline/analyze-hit 是同一条代码路径，只是绕开调度器的触发逻辑。
 *
 * 串行跑：本地模型一次只能吃一条，并发会互相抢显存。
 */
import D from 'better-sqlite3';

const BASE = 'http://127.0.0.1:17841';
const H = { 'content-type': 'application/json', origin: BASE, host: '127.0.0.1:17841' };
const COL = '案例老师';

const dbPath = '<GLB_ROOT>/Hermes/data/hermes.db';

function pending() {
  const db = new D(dbPath, { readonly: true });
  const rows = db
    .prepare("select id, video_path from hit_videos where collection=? and analysis_status='pending' order by id")
    .all(COL);
  db.close();
  return rows;
}

let pass = 0;
let fail = 0;
for (let i = 1; i <= 30; i++) {
  const rows = pending();
  if (rows.length === 0) {
    console.log(`\n✓ 全部完成，没有待分析的了`);
    break;
  }
  const t = rows[0];
  const t0 = Date.now();
  process.stdout.write(`[${i}] #${t.id} 分析中…`);
  try {
    const r = await fetch(`${BASE}/pipeline/analyze-hit`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ videoPath: t.video_path }),
    });
    const body = await r.json();
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.ok && body.ok) {
      const title = (body.analysis?.title || body.analysis?.opening_script || '').slice(0, 26);
      console.log(` ✓ ${secs}s  「${title}」`);
      pass++;
    } else {
      console.log(` ★ HTTP ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
      fail++;
      // 失败的那条标成 failed，否则会一直卡在队列最前面反复重试
      const d = new D(dbPath);
      d.prepare("update hit_videos set analysis_status='failed', last_error=?, failed_at=? where id=?")
        .run(`手动分析失败 HTTP ${r.status}`, new Date().toISOString(), t.id);
      d.close();
    }
  } catch (e) {
    console.log(` ★ 异常 ${e.message}`);
    fail++;
    const d = new D(dbPath);
    d.prepare("update hit_videos set analysis_status='failed', last_error=?, failed_at=? where id=?")
      .run(String(e.message).slice(0, 200), new Date().toISOString(), t.id);
    d.close();
  }
}

console.log(`\n完成 ${pass} 条，失败 ${fail} 条`);
const db = new D(dbPath, { readonly: true });
const by = db.prepare('select analysis_status, count(*) n from hit_videos where collection=? group by 1').all(COL);
console.log('最终状态:', JSON.stringify(by));
const themes = db.prepare(`select count(*) n from hit_themes h join hit_videos v
    on v.id=h.hit_video_id where v.collection=?`).get(COL).n;
console.log(`爆款主题累计 ${themes} 条`);
db.close();