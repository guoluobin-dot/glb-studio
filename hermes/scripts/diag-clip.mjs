/** 诊断切片失败:直接跑 clipper,stderr 可见 */
import { readFileSync } from 'node:fs';
import { Clipper } from '../src/clipper/index.js';
import { createLlmClient } from '../src/llm/router.js';
import { MemoryStore } from '../src/memory/store.js';

const cfg = JSON.parse(readFileSync('./config/default.json', 'utf8'));
const store = new MemoryStore(cfg);
const ollama = createLlmClient(cfg);
const clipper = new Clipper(ollama, store, cfg);

const LIVE_ID = Number(process.argv[2] || 166);
const segId = Number(process.argv[3] || 4);

(async () => {
  // 取该段真实边界,别拿猜的时间
  const seg = store.getLiveSegmentsByVideo(LIVE_ID).find((s) => Number(s.segment_index) === segId);
  if (!seg) {
    console.log('找不到段', segId);
    process.exit(1);
  }
  console.log('段信息:', JSON.stringify({
    idx: seg.segment_index,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    theme: seg.theme_name,
    hook: seg.hook_quality
  }));

  const picked = [{
    id: seg.id,
    segment_index: seg.segment_index,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    theme_name: seg.theme_name,
    hook_quality: seg.hook_quality
  }];

  const built = await clipper.createProject(LIVE_ID, {
    presetSegments: picked,
    viralOpening: true,
    viralOpeningSeconds: 10
  });
  console.log('projectId =', built.projectId, '| viralOpening =', built.viralOpening);

  const r = await clipper.clip(built.projectId);
  console.log('clipPaths =', (r.clipPaths || []).map((p) => p.split(/[\\/]/).pop()));
})().catch((e) => {
  console.log('ERR:', e.message);
  process.exit(1);
});
