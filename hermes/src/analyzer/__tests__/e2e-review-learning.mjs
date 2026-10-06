/**
 * 端到端跑一次「打回 + 文字精修」，验证学习样本真的落库
 *
 * 为什么不用真实的 live#174：
 * 它的 ASR 缓存（upload/temp/..._asr.json）已经被清理任务删了 ——
 * 因为源视频也不在了，retentionDays 7 天一到就不再豁免。
 * 所以现在 review-packet 的 text 全是空串（实测 15 段长度全是 0）。
 * 这本身是个要报告的问题，但不该阻塞学习系统的验证。
 *
 * 所以这里自建一份最小的直播记录 + 逐句稿 + 粗剪工程，
 * 完整跑一遍 POST /review，然后查库确认三类样本都在。
 * 全部写进一次性数据，跑完删干净。
 *
 * 用法：node e2e-review-learning.mjs
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const base = process.env.HERMES_URL || 'http://127.0.0.1:17841';
const dbPath = join(process.cwd(), 'data', 'hermes.db');
const db = new Database(dbPath);
const tag = '__e2e_learn_probe__';

/**
 * 开工前先清掉上一轮残留的探针行。
 *
 * 为什么必须先清：`live_videos.video_path` 上有 UNIQUE 约束，
 * 而 video_path 是固定的（同一个 tmp 目录下的 probe.mp4）。
 * 上一次运行若在清理前就崩了（比如早期版本的外键顺序搞错），
 * 那一行会留在库里，于是这次 INSERT 直接 UNIQUE 冲突 ——
 * 报错指向"插入失败"，真因却是"上次没清干净"，非常难查。
 */
function purgeStaleProbe() {
  const stale = db.prepare(
    "SELECT id FROM live_videos WHERE video_path LIKE '%e2e-tmp%' OR video_name LIKE ?"
  ).all(`%${tag}%`);
  for (const r of stale) {
    const pids = db.prepare('SELECT id FROM clip_projects WHERE live_video_id = ?').all(r.id).map((x) => x.id);
    for (const pid of pids) {
      db.prepare('DELETE FROM review_edits WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM review_feedback WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM clip_projects WHERE id = ?').run(pid);
    }
    db.prepare('DELETE FROM live_segments WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM review_feedback WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM review_edits WHERE live_video_id = ?').run(r.id);
    db.prepare('DELETE FROM live_videos WHERE id = ?').run(r.id);
  }
  if (stale.length) console.log(`已清掉 ${stale.length} 条上轮残留探针行`);
}
purgeStaleProbe();

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const TMP_DIR = join(process.cwd(), 'data', 'e2e-tmp');
const ASR = join(TMP_DIR, `${tag}_asr.json`);
let liveId = null;
let projId = null;

try {
  // ── 造数据：两段 10 秒，逐句稿带时间戳 ──
  mkdirSync(TMP_DIR, { recursive: true });

  /**
   * 必须造一个真实可播的 mp4。
   * 打回链路会真的跑 ffmpeg 切片；源文件不存在时
   * clipper 直接抛"所有片段都切片失败"，于是根本走不到写学习样本那步。
   * （第一版探针就是这么"失败"的 —— 看着像学习系统坏了，其实是源文件缺失。）
   */
  const VIDEO = join(TMP_DIR, 'probe.mp4');
  if (!existsSync(VIDEO)) {
    const { execFileSync } = await import('child_process');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', VIDEO
    ], { stdio: 'ignore' });
  }
  check(existsSync(VIDEO), '探针源视频已生成（打回要真跑 ffmpeg）');

  const seg0 = ['同学们欢迎大家来到我的直播间', '今天我们来讲一下和弦的构成'];
  const seg1 = ['首先按住这个根音', '然后再弹一个四和弦出来听一下效果'];
  const sentences = [];
  // seg0: 0~20s（绝对），seg1: 20~40s
  [seg0, seg1].forEach((lines, si) => {
    const base0 = si * 20000;
    lines.forEach((t, li) => {
      sentences.push({ start_ms: base0 + li * 10000, end_ms: base0 + (li + 1) * 10000, text: t });
    });
  });
  writeFileSync(ASR, JSON.stringify({ segments: sentences }), 'utf8');

  const now = new Date().toISOString();
  const li = db.prepare(`
    INSERT INTO live_videos (video_path, video_name, duration_ms, analysis_status, asr_path, created_at, collection)
    VALUES (?, ?, ?, 'analyzed', ?, ?, ?)
  `).run(VIDEO, `${tag}.mp4`, 40000, ASR, now, 'E2E探针');
  liveId = Number(li.lastInsertRowid);

  // 两段 live_segments（粗剪用它们）
  const segIds = [];
  const mk = (role, startMs, endMs, theme) => {
    // live_segments 没有 role 列（角色存在 clip_projects.selected_segments 里）
    const r = db.prepare(`
      INSERT INTO live_segments (live_video_id, segment_index, start_ms, end_ms, duration_ms, theme_name, status, hook_quality, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'kept', 0.8, ?)
    `).run(liveId, segIds.length, startMs, endMs, endMs - startMs, theme, now);
    segIds.push(Number(r.lastInsertRowid));
  };
  mk('hook', 0, 20000, '开场欢迎');
  mk('body', 20000, 40000, '和弦讲解');

  const selected = JSON.stringify([
    { segmentId: segIds[0], startMs: 0, endMs: 20000, themeName: '开场欢迎', role: 'hook', hookQuality: 0.8 },
    { segmentId: segIds[1], startMs: 20000, endMs: 40000, themeName: '和弦讲解', role: 'body', hookQuality: 0.75 }
  ]);
  const pi = db.prepare(`
    INSERT INTO clip_projects (live_video_id, project_name, status, selected_segments, created_at, updated_at)
    VALUES (?, ?, 'reviewing', ?, ?, ?)
  `).run(liveId, `${tag}_proj`, selected, now, now);
  projId = Number(pi.lastInsertRowid);
  console.log(`探针: live#${liveId} 工程#${projId}\n`);

  const packet = await (await fetch(`${base}/projects/${projId}/review-packet`)).json();
  check(packet.segments?.length === 2, `审片包可用（${packet.segments?.length ?? 0} 段）`);
  const t0 = packet.segments?.[0]?.text;
  check(typeof t0 === 'string' && t0.includes('同学们欢迎'), `第 1 段取到原文（${String(t0).length} 字）`);

  // 框掉开头 8 个字（"同学们欢迎大家"）
  const res = await fetch(`${base}/projects/${projId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision: 'recut',
      comment: '开头别念欢迎语，直接进正题',
      segmentIds: [],
      textCuts: [{ segmentId: packet.segments[0].segmentId, ranges: [{ from: 0, to: 7 }] }]
    })
  });
  const body = await res.json();
  check(res.ok && body.ok, '打回接口成功', JSON.stringify(body).slice(0, 140));
  check(body.cuts?.applied > 0, `文字删除生效（${body.cuts?.applied ?? 0} 处 / ${((body.cuts?.removedMs ?? 0) / 1000).toFixed(2)}s）`);

  // ── 核心断言：三类样本都在 ──
  /*
   * 按 live_video_id 查，不能只按 newProjectId。
   *
   * 原因：样本里 clip_project_id 是新工程 id，而新工程刚由 clip 生成；
   * 若后续有任何一步把它标成 failed/清理，这里就查不到行了，
   * 看起来像"没记学习样本"，其实是查错了维度。
   * 按直播维度查更稳，也更符合语义（这一场直播学到了什么）。
   */
  const rows = db.prepare(
    'SELECT * FROM review_edits WHERE live_video_id = ? ORDER BY id'
  ).all(liveId);
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  console.log(`\n  样本分布: ${JSON.stringify(kinds)}（共 ${rows.length} 条）`);

  check((kinds.cut ?? 0) > 0, '有 cut：用户删掉的文字（避雷词）');
  check((kinds.keep ?? 0) > 0,
    '有 keep：用户留下的文字（正样本）',
    '★ 缺 keep 就等于只学会"别说什么"，正向逻辑是空的');
  check((kinds.segment ?? 0) > 0, '有 segment：整段保留的内容逻辑');

  const cuts = rows.filter((r) => r.kind === 'cut');
  const keeps = rows.filter((r) => r.kind === 'keep');
  console.log(`  cut: ${cuts.map((r) => JSON.stringify(String(r.text).slice(0, 12))).join(' ')}`);
  console.log(`  keep 数: ${keeps.length}`);
  check(cuts.some((r) => String(r.text).includes('同学们欢迎')), 'cut 记的正是被删的那几个字');
  check(keeps.some((r) => String(r.text).includes('和弦')), 'keep 里留着有效内容');
  check(keeps.length > cuts.length, `留存样本多于删除样本（${keeps.length} > ${cuts.length}）`);

  check(rows.every((r) => r.reason === '开头别念欢迎语，直接进正题'), '样本都带用户写的理由');
  check(rows.filter((r) => r.kind === 'segment').every((r) => r.by === 'picked'), '段落样本标记 picked');
  check(rows.filter((r) => r.kind === 'segment').every((r) => r.role), '段落样本都带 role（能学出结构）');

  // ── 归档接口：确认档案能按 IP 读出来 ──
  const archives = await (await fetch(`${base}/memory/edit-archives`)).json();
  check(archives.ok && Array.isArray(archives.archives), '归档列表接口可用');
  check(archives.archives.some((a) => a.name === 'E2E探针'), '归档列表里有这位老师',
    JSON.stringify(archives.archives.map((a) => a.name)));

  const one = await (await fetch(`${base}/memory/edit-archives?collection=${encodeURIComponent('E2E探针')}`)).json();
  check(one.ok && one.archive, '能读到该老师的完整档案');
  if (one.archive) {
    const a = one.archive;
    check(a.cutOpenings.length > 0, `档案里有避雷起手式（${JSON.stringify(a.cutOpenings.map((r) => r.opening))}）`);
    check(a.keepSamples.length > 0, `档案里有正样本（${a.keepSamples.length} 条）`);
    check(a.segments.length > 0 && a.segments[0].role, '档案里有段落结构 + role');
    check(Array.isArray(a.promptHints.avoid) && Array.isArray(a.promptHints.structure),
      '档案能直接给出注入提示词（avoid/structure）');
    check(a.summary.keeps > 0, '摘要里正样本数 > 0（正向逻辑没丢）');
  }

  void body;
} catch (err) {
  console.error('ERROR:', err.message, err.stack?.split('\n')[1] || '');
  fail++;
} finally {
  // 工程行的删除交给下面 liveId 分支统一按外键顺序做，这里不单独删。
  if (liveId) {
    /*
     * 顺序有讲究：clip_projects 引用 live_videos，外键开着时先删父行会失败
     * （第一版就是这里抛 FOREIGN KEY constraint failed，然后 video_path 的行留在库里，
     *  下次跑 UNIQUE 冲突，排查绕了一圈）。
     * 所以按 子→父 的顺序删；projectId 为空说明这次没建工程，要按 live_video_id 兜底。
     */
    const pids = db.prepare('SELECT id FROM clip_projects WHERE live_video_id = ?').all(liveId).map((r) => r.id);
    for (const pid of pids) {
      db.prepare('DELETE FROM review_edits WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM review_feedback WHERE clip_project_id = ?').run(pid);
      db.prepare('DELETE FROM clip_projects WHERE id = ?').run(pid);
    }
    db.prepare('DELETE FROM live_segments WHERE live_video_id = ?').run(liveId);
    db.prepare('DELETE FROM review_feedback WHERE live_video_id = ?').run(liveId);
    db.prepare('DELETE FROM review_edits WHERE live_video_id = ?').run(liveId);
    db.prepare('DELETE FROM live_videos WHERE id = ?').run(liveId);
  }
  // 只删这次造的转写缓存，**不能删整个目录**：
  // 上一次失败留下的 live_videos 行还在（外键失败导致 DELETE 没执行），
  // 把 video_path 指向的 mp4 一起删掉，下次跑就撞 UNIQUE(video_path)。
  // 视频留着复用即可，反正 existsSync 会跳过重新生成。
  if (existsSync(ASR)) rmSync(ASR, { force: true });
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${ASR}${suffix}`)) rmSync(`${ASR}${suffix}`, { force: true });
  }
  try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run(); } catch { /* ignore */ }
  db.close();
  console.log('\n已清理探针数据');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);