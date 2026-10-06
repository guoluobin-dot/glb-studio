import { readFileSync } from 'node:fs';
import { MemoryStore } from '../src/memory/store.js';
const cfg = JSON.parse(readFileSync('./config/default.json','utf8'));
const store = new MemoryStore(cfg);
const vids = store.db.prepare('SELECT id, video_path, segment_count, analysis_status FROM live_videos ORDER BY id DESC LIMIT 3').all();
for (const v of vids) console.log('live_video', JSON.stringify(v));
const target = vids[0];
if (target) {
  const segs = store.db.prepare('SELECT * FROM live_segments WHERE live_video_id = ? ORDER BY segment_index LIMIT 3').all(target.id);
  console.log('\n=== 前 3 段原始行 ===');
  for (const s of segs) console.log(JSON.stringify(s));
}
