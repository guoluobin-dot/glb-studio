/**
 * 用真实审片包校验前端"已删 X 秒"和服务端真值一致
 *
 * 为什么必须真数据校验：
 * 前端 estimateMs 复刻了服务端 charRangeToTime 的算法，
 * 复刻得对不对，只有真数据能暴露 ——
 * 一旦两边算出不同秒数，用户框选半天看到的数字和实际剪掉的不一样，
 * 这个功能会被当成坏的。
 *
 * 本脚本只读：不提交 review，不动工程 #116。
 *
 * @author 郭洛斌
 */
import { loadTranscript, buildEditableText, charRangeToTime } from '../editable-text.js';
import Database from 'better-sqlite3';
import { join } from 'path';

/** 与前端 TextCutter / 服务端 charRangeToTime 共用的标点集 */
const PUNCT = /[，。！？、；：,.!?;]/;

/** 前端 TextCutter.estimateMs 的逐句插值版本（相对段首，只用于比对） */
function frontendMs(sentences, text, durMs, ranges) {
  const inSeg = sentences
    .map((s) => ({ ...s, startMs: Math.max(0, s.startMs), endMs: Math.min(durMs, s.endMs) }))
    .filter((s) => s.endMs > s.startMs);
  if (!inSeg.length) return 0;
  const spans = [];
  let cursor = 0;
  for (const s of inSeg) {
    const t = String(s.text || '');
    spans.push({ from: cursor, to: cursor + t.length, text: t, startMs: s.startMs, endMs: s.endMs });
    cursor += t.length + 1;
  }
  let ms = 0;
  for (const r of ranges) {
    const from = Math.max(0, Math.min(text.length, Math.floor(r.from)));
    const to = Math.max(from, Math.min(text.length, Math.ceil(r.to)));
    if (to <= from) continue;
    for (const sp of spans) {
      const a = Math.max(from, sp.from);
      const b = Math.min(to, sp.to);
      if (b <= a) continue;
      const span = sp.endMs - sp.startMs;
      const spoken = Math.max(1, [...sp.text].filter((c) => !PUNCT.test(c)).length);
      let w = 0;
      for (let i = 0; i < a - sp.from; i++) w += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
      let w2 = 0;
      for (let i = 0; i < b - sp.from; i++) w2 += PUNCT.test(sp.text[i] ?? '') ? 0.25 : 1;
      ms += (span * (w2 - w)) / spoken;
    }
  }
  return Math.round(Math.min(ms, durMs));
}

const projectId = Number(process.argv[2] || 116);
const base = process.env.HERMES_URL || 'http://127.0.0.1:17841';

const packet = await (await fetch(`${base}/projects/${projectId}/review-packet`)).json();
if (!packet?.segments?.length) {
  console.error('FAIL 拿不到审片包');
  process.exit(1);
}

/**
 * 直接读 SQLite，不经过 orchestrator。
 *
 * 理由：orchestrator 一 import 就会起整个服务（监听端口、跑调度器），
 * 而这里只需要两行数据。测试脚本为了拿数据把整个服务拉起来不划算。
 */
const dbPath = join(process.cwd(), 'data', 'hermes.db');
const db = new Database(dbPath, { readonly: true });
const project = db.prepare('SELECT * FROM clip_projects WHERE id = ?').get(projectId);
if (!project) {
  console.error(`FAIL 工程 #${projectId} 不存在`);
  process.exit(1);
}
const live = db.prepare('SELECT * FROM live_videos WHERE id = ?').get(project.live_video_id);
/**
 * 段数据在 selected_segments（JSON）里，不是独立的表。
 * 时间用毫秒字段 startMs/endMs —— 与 orchestrator 组 textCuts 时取的是同一套字段。
 */
let segRows = project.selected_segments;
if (typeof segRows === 'string') {
  try { segRows = JSON.parse(segRows); } catch { segRows = []; }
}
if (!Array.isArray(segRows)) segRows = [];
const transcript = loadTranscript(live?.asr_path);
if (!transcript.length) {
  console.error(`FAIL 读不到逐句稿：${live?.asr_path}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label} ${extra}`); }
};

console.log(`== 工程 #${projectId}：${packet.segments.length} 段，逐句稿 ${transcript.length} 句 ==\n`);

const withText = packet.segments.filter((s) => s.text && s.text.length > 0);
check(withText.length > 0, `有文本段 ${withText.length} / ${packet.segments.length}`);

// 抽 3 段做对齐校验：开头、结尾、中间
const picks = [withText[0], withText[Math.floor(withText.length / 2)], withText[withText.length - 1]].filter(Boolean);
for (const seg of picks) {
  const durMs = Math.round((seg.roughcutEndSec - seg.roughcutStartSec) * 1000);
  // 段在原素材里的绝对起止：服务端 charRangeToTime 就是用这个做基准
  const segRow = segRows.find((s) => Number(s.segmentId) === Number(seg.segmentId)) || {};
  const absStart = Number(segRow.startMs ?? seg.sourceStartSec * 1000);
  const absEnd = Number(segRow.endMs ?? seg.sourceEndSec * 1000);

  // 服务端视角
  const ed = buildEditableText(transcript, absStart / 1000, absEnd / 1000);
  // 前端视角：直接用审片包给的 text / sentences
  const okText = ed.text === seg.text;
  check(okText, `第${seg.segmentIndex}段 文本拼接一致（${seg.text.length} 字）`, okText ? '' : `服务端 ${ed.text.length} 字`);

  // 选区：开头 8 字、中间 8 字、结尾 8 字
  const ranges = [
    { label: '开头 8 字', from: 0, to: Math.min(8, seg.text.length) },
    { label: '中间 8 字', from: Math.floor(seg.text.length / 2), to: Math.floor(seg.text.length / 2) + 8 },
    { label: '结尾 8 字', from: Math.max(0, seg.text.length - 8), to: seg.text.length }
  ].filter((r) => r.to > r.from && r.to <= seg.text.length);

  for (const r of ranges) {
    const front = frontendMs(seg.sentences || [], seg.text, durMs, [r]);
    const hit = charRangeToTime(ed.sentences, ed.text, r.from, r.to, absStart, absEnd);
    const back = hit ? hit.en - hit.st : 0;
    // 允许 15% 误差：审片包的 sentences 和服务端重算的 sentences 在边界句上可能有微差
    const diff = Math.abs(front - back);
    const ok = back === 0 ? front === 0 : diff <= Math.max(120, back * 0.15);
    check(ok, `第${seg.segmentIndex}段 ${r.label}：前端 ${(front / 1000).toFixed(2)}s / 服务端 ${(back / 1000).toFixed(2)}s`, `差 ${diff}ms`);
  }

  // 越界夹紧：删除超出段尾必须落在段内
  const hit = charRangeToTime(ed.sentences, ed.text, 0, ed.text.length + 500, absStart, absEnd);
  check(hit && hit.st >= absStart - 1 && hit.en <= absEnd + 1, `第${seg.segmentIndex}段 删超段尾被夹在段内`,
    hit ? `st=${hit.st} en=${hit.en} 段=[${absStart},${absEnd}]` : '返回 null');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);