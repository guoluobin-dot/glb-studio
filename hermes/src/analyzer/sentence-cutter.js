/**
 * SentenceCutter —— 逐句成片：把直播/长视频里"值得留的教学句"一句句挑出来，
 * 按原顺序拼接成一条完整的视频（不是整段爆点切片）。
 *
 * 流程：
 *   1. 取逐句稿（hit_videos / live_videos 的转写缓存优先，没有才走 ASR）
 *   2. 复用 DeepAnalyzer 的逐句清洗（去口误/重复/语气词/跑题，保留清晰、情感饱满的讲解句）
 *   3. 把连续的 keep 句合并成段（句间间隙 ≤1.2s 视为连续），太碎的段丢弃
 *   4. ffmpeg 单命令 filter_complex trim+concat，拼成一条 mp4（重编码，句级切点才准）
 *
 * 结果记录在 sentence_cuts 表，供看板"逐句成片"区块展示/预览/下载。
 * 同一视频重复触发：若清洗结果已缓存（sentence_cuts.segments）直接重拼，不重跑 LLM。
 */
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { ASRHelper } from './asr-helper.js';
import { FFmpegHelper } from './ffmpeg-helper.js';
import { DeepAnalyzer } from './deep-analyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_FILTER_SEGS = 120; // filter_complex 段数上限，超过会命令过长

// 直播互动话术：求关注/灯牌/预约/礼物/弹幕引导——开启清理时整句剪掉，不进粗剪
// 2026-09-26 扩充（老板截图：扣1/点亮小红心/打Call/七天挑战群/私我出片订单/关注好我这个账号等漏网）
// 直播互动话术规则（2026-09-26 二次调整，老板定规则）：
//   【保留不剪】氛围型互动——点亮小红心 / 关注 / 点赞 / 评论 / 转发 / 收藏（直播间人设与真实感）
//   【整句剪掉】导流交易型——刷礼物 / 灯牌 / 粉丝团 / 预约直播下期 / 私我 / 出品订单 / 挑战群 / 加微信 / 扣1数字引导
// 反爬变体：剥离 \ / | · 空格 后再匹配（"私\\我\\开\\出\\品\\订\\单\\"→"私我开出品订单"）
const INTERACT = ['灯牌', '灯牌点亮', '粉丝团', '进粉丝团', '加粉丝团', '预约', '预约下期', '预约明天', '预约今晚', '预约直播',
	'小礼物', '刷礼物', '刷个礼物', '礼物刷起来', '礼物走起来',
	'扣1', '扣个1', '打个1',
	'私我', '私信我', '加我微信', '出品订单', '出片订单', '预订搭',
	'挑战群', '七天挑战',
	'进直播间', '欢迎来到直播间', '欢迎新来的', '欢迎刚来的'];
// 反爬变体归一化：剥离 \ / | · 空格 等分隔符（"私\\我\\开\\出\\品\\订\\单\\"→"私我开出品订单"）
function normalizeVariant(text) {
	return String(text || '').replace(/[\\/|·・\s]/g, '');
}
const INTERACT_NORM = INTERACT.map(normalizeVariant).filter(Boolean);
function isInteractionSentence(text) {
	const t = String(text || '');
	const low = t.toLowerCase(); // 英文部分忽略大小写（打Call/打call）
	if (INTERACT.some((k) => low.includes(k.toLowerCase()))) return true;
	const n = normalizeVariant(t).toLowerCase();
	if (n === low) return false;
	return INTERACT_NORM.some((k) => n.includes(k.toLowerCase()));
}
function filterInteractionSegs(segs) {
  return (segs || []).filter((s) => !isInteractionSentence(s.text));
}

export class SentenceCutter {
  constructor(ollama, store, config) {
    this.store = store;
    this.config = config;
    this.asr = new ASRHelper(config);
    this.ffmpeg = new FFmpegHelper();
    // 清洗逻辑直接复用 DeepAnalyzer（同一套 keep/drop 判定，记忆一致）
    this.deep = new DeepAnalyzer(ollama, store, config);
    const outDir = config.output?.sentenceDir || join(__dirname, '..', '..', '..', 'output', 'sentence');
    this.outDir = outDir;
    this._ensureTable();
  }

  _ensureTable() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS sentence_cuts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_path TEXT,
        video_name TEXT,
        output_path TEXT,
        segments TEXT,
        kept_secs INTEGER,
        total_secs INTEGER,
        status TEXT DEFAULT 'done',
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sentence_video ON sentence_cuts(video_path);
    `);
  }

  list() {
    // 成功的（带文件预览）+ 最近失败的（让用户看到失败原因，而不是默默无响应）
    const done = this.store.db.prepare(
      "SELECT * FROM sentence_cuts WHERE status='done' ORDER BY created_at DESC, id DESC LIMIT 30"
    ).all().map((r) => ({ ...r, segments: r.segments ? JSON.parse(r.segments) : [], exists: existsSync(r.output_path || '') }));
    const failed = this.store.db.prepare(
      "SELECT id, video_path, video_name, output_path, status, note, created_at FROM sentence_cuts WHERE status='failed' ORDER BY id DESC LIMIT 3"
    ).all();
    return [...done, ...failed];
  }

  /** 视频时长（ms），用于判断逐句稿时间戳到底是秒还是毫秒（ASR 链统一返回毫秒，缓存可能是秒）。 */
  async _videoDurationMs(videoPath) {
    try {
      const meta = await this.ffmpeg.getMetadata(videoPath);
      const d = Number(meta?.format?.duration || 0);
      return Math.round(d * 1000);
    } catch { return 0; }
  }

  /** 逐句稿：优先 hit_videos / live_videos 的转写缓存，缺失走 ASR 链。时间戳单位自动识别（秒/毫秒都吃）。 */
  async _loadSegments(videoPath) {
    const durationMs = await this._videoDurationMs(videoPath);
    const norm = (list) => (Array.isArray(list) ? list : [])
      .map((s) => {
        let start = null, end = null;
        if (Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms)) { start = s.start_ms; end = s.end_ms; }
        else if (Number.isFinite(s.start) && Number.isFinite(s.end)) {
          // 只有 start/end：用片长判断是秒还是毫秒——ASRHelper 输出就是毫秒，别再 ×1000（曾经把时间轴放大 1000 倍，面板显示"精选 810 分钟"）。
          // durationMs 拿不到时不再静默按毫秒处理（以前会让时间轴缩 1000 倍且无声）
          if (!(durationMs > 0) && !norm._warned) { norm._warned = true; console.warn('[SentenceCutter] 拿不到片长，逐句稿按毫秒解析；若时间轴异常请先重新转写'); }
          const maybeSec = durationMs > 0 && s.end * 1000 <= durationMs * 1.2;
          start = maybeSec ? s.start * 1000 : s.start;
          end = maybeSec ? s.end * 1000 : s.end;
        }
        const text = String(s.text || s.word || '').trim();
        if (start == null || end == null || !text || end <= start) return null;
        return { start: Math.round(start), end: Math.round(end), text };
      }).filter(Boolean);
    for (const q of [
      this.store.db.prepare('SELECT asr_path FROM hit_videos WHERE video_path = ?').get(videoPath),
      this.store.db.prepare('SELECT asr_path FROM live_videos WHERE video_path = ?').get(videoPath),
    ]) {
      if (q?.asr_path && existsSync(q.asr_path)) {
        try {
          const { readFileSync } = await import('fs');
          const cached = JSON.parse(readFileSync(q.asr_path, 'utf-8'));
          const list = norm(cached.segments || cached);
          if (list.length) return list;
        } catch { /* 缓存坏了走 ASR */ }
      }
    }
    const r = await this.asr.getTranscript(videoPath);
    return norm(r.transcript || []);
  }

  /** 清洗：优先复用同视频上次的清洗结果（sentence_clean_cache），没有才跑 LLM。
   *  注意：缓存必须存"逐句 keep/drop 结果"，不能复用成片时间线（以前复用 sentence_cuts.segments 没有 keep 字段 → 第二次跑同视频直接报"清洗后没有可保留的句子"。 */

  async _cleanCached(videoPath, segs, opts = {}) {
    const dedupRepeat = opts.dedupRepeat !== false;
    // key 里加内容指纹：同路径重新转写后句数可能一样，但时间戳全变了，
    // 只按句数做 key 会直接复用失效的旧清洗结果（时间戳对不上画面，且毫无提示）。
    const fp = segs.length ? `${segs[0].start}-${segs[segs.length - 1].end}-${String(segs[0].text || '').length}` : '0';
    const vkey = 'path:' + videoPath + ':' + segs.length + ':' + fp;
    try {
      const row = this.store.db.prepare('SELECT segments FROM sentence_clean_cache WHERE video_key = ?').get(vkey);
      if (row) {
        try {
          const cached = JSON.parse(row.segments);
          if (Array.isArray(cached) && cached.length) {
            console.log(`[SentenceCutter] 复用上次清洗结果 ${cached.length} 句（不重跑 LLM）`);
            return cached;
          }
        } catch { /* 缓存坏就重跑 */ }
      }
    } catch { /* 表还没建就直接用 LLM */ }
    const cleaned = await this.deep._cleanTranscript(segs, { dedupRepeat });
    try {
      this.store.db.prepare(
        `INSERT INTO sentence_clean_cache (video_key, segments) VALUES (?,?)
         ON CONFLICT(video_key) DO UPDATE SET segments = excluded.segments, updated_at = datetime('now')`
      ).run(vkey, JSON.stringify(cleaned));
    } catch { /* 写缓存失败不影响成片 */ }
    return cleaned;
  }

  /** keep 句 → 拼接时间线：连续 keep 合并，碎段丢弃；targetSec>0 时累计到上限为止；
   *  keepExtra 开启时 3~45s 的空隙（唱歌/间奏/连麦安静段）保留为 ♪ 段拼进成片 */
  _buildTimeline(kept, targetSec = 0, keepExtra = true, droppedRanges = []) {
    const GAP = 2500, MIN_SEG = 1500, PAD = 60; // 句间 2.5s 内算连续（整句整句地过）；段最短 1.5s；碎段贴相邻，不产生一堆断句
    const segs = [];
    for (const s of kept) {
      const last = segs[segs.length - 1];
      if (last && s.start - last.end <= GAP) {
        last.end = Math.max(last.end, s.end); // 连续：延长当前段
      } else {
        segs.push({ start: s.start, end: s.end });
      }
    }
    const out = [];
    let acc = 0;
    for (const seg of segs) {
      if (seg.end - seg.start < MIN_SEG) {
        // 太碎：贴到前一段（间隙小）否则丢弃
        const prev = out[out.length - 1];
        if (prev && seg.start - prev.end <= 5000) prev.end = seg.end; // 碎段贴相邻（5s 内），孤立碎段丢弃
        continue;
      }
      // 连麦/音乐保留：前一段到本段之间 3~45s 的空隙（唱歌/间奏/安静）保留为 ♪ 段
      // （与被剪句子时间段重叠的空隙不保留——那是重复话去除剪掉的内容，不能又拼回来）
      if (keepExtra) {
        const prev = out[out.length - 1];
        const gapStartSec = prev ? prev.end / 1000 : 0;
        const gapEndSec = seg.start / 1000;
        const overlaps = droppedRanges.some((dr) => gapStartSec < dr[1] / 1000 && gapEndSec > dr[0] / 1000);
        const gapSec = prev ? (gapEndSec - gapStartSec) : 0;
        if (prev && gapSec >= 3 && gapSec <= 45 && !overlaps) {
          out.push({ start: prev.end, end: seg.start - PAD, gap: true });
          acc += gapSec * 1000;
        }
      }
      const piece = { start: Math.max(0, seg.start - PAD), end: seg.end + PAD };
      // 时长上限：按时间顺序拼，够长就停（保留开头，符合"一条完整内容"的叙事顺序）
      if (targetSec > 0) {
        const remain = targetSec * 1000 - acc;
        if (remain <= 0) break;
        if (piece.end - piece.start > remain) piece.end = piece.start + remain;
      }
      acc += piece.end - piece.start;
      out.push(piece);
    }
    return out;
  }

  /**
   * 主流程：逐句成片。
   * 返回 {outputPath, keptSecs, totalSecs, segCount, keptCount, droppedCount}
   */
  async cut(rawVideoPath, opts = {}) {
    // 路径规范化：外面传进来的可能是 D:////xxx 这种被转义搞乱的写法——不 normalize 会存成脏数据，
    // 后面按路径查素材记录查不到（重复跑 ASR）。
    const videoPath = normalize(String(rawVideoPath || ''));
    const name = videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    if (!existsSync(videoPath)) throw new Error('源文件不存在：' + videoPath);
    if (!this.ffmpeg.isAvailable) throw new Error('ffmpeg 不可用');

    console.log(`[SentenceCutter] 逐句成片开始: ${name}`);
    const segs = await this._loadSegments(videoPath);
    if (!segs.length) throw new Error('没有可用逐句稿（先转写，或检查视频是否有语音）');
    console.log(`[SentenceCutter] 逐句稿 ${segs.length} 句`);

    const cleaned = await this._cleanCached(videoPath, segs, { dedupRepeat: opts.dedupRepeat !== false });
    // 直播互动清理：开启时把求关注/灯牌/预约这类话术整句剪掉（默认开启）
    // 防误杀：长教学句即使含"点亮/关注"这类词也不算互动
    const TEACHY = (t) => String(t).length >= 15 && ['怎么', '如何', '方法', '练', '教学', '示范', '注意', '重点', '发音', '气息', '共鸣', '音准', '节奏', '技巧'].some((k) => String(t).includes(k));
    // 2026-09-26 加（老板截图第 9 段漏网）：互动浓度判定——互动词出现 ≥2 次的句子
    // 是纯互动长句（"点个赞，让我再此点一次灯牌，点灯牌，点个灯牌，灯牌"）,
    // 即使含教学词也不豁免，强制剪掉。单次命中的长教学句仍走 TEACHY 豁免不误伤。
    const interactCount = (t) => INTERACT.reduce((n, k) => n + (String(t).split(k).length - 1), 0);
    const preFilter = opts.interactionClean === false ? cleaned
      : cleaned.filter((s) => {
          if (!isInteractionSentence(s.text)) return true;      // 非互动保留
          if (interactCount(s.text) >= 2) return false;          // 高浓度互动强制剪
          return TEACHY(s.text);                                  // 单次命中：教学句豁免，否则剪
        });
    const kept = preFilter.filter((s) => s.keep);
    const droppedRanges = preFilter.filter((s) => !s.keep).map((s) => [s.start, s.end]);
    if (!kept.length) throw new Error('清洗后没有可保留的句子');
    console.log(`[SentenceCutter] 清洗：保留 ${kept.length}/${cleaned.length} 句`);

    // 粒度检查：整段塞成一句（平均句长超 20s）切不出细句，提示先转写
    const avgSec = segs.reduce((a, s) => a + (s.end - s.start), 0) / segs.length / 1000;
    // 2026-09-24：sherpa 按 60s 分块，≤120s 的素材往往只出 1~2 个 segment，
    // 逐句成片会退化成"原片重编码"（concat=n=1），而以前只在 note 里留一句警告，界面上完全看不出。
    const degenerate = segs.length <= 2 || kept.length <= 1;
    const granWarn = degenerate
      ? `逐句稿只有 ${segs.length} 句（平均 ${Math.round(avgSec)} 秒）——本条成片等于原片重编码，没有起到逐句剪辑作用；建议换更长素材，或先用 GLB 重新转写`
      : (avgSec > 20 ? '逐句稿粒度太粗（平均每句 ' + Math.round(avgSec) + ' 秒），建议先用 GLB 重新转写再切，效果更好' : '');
    if (degenerate) console.warn(`[SentenceCutter] ⚠ 逐句稿粒度过粗（${segs.length} 句），成片≈原片：${name}`);

    const timeline = this._buildTimeline(kept, Number(opts.targetSec) || 0, opts.keepExtra !== false, droppedRanges);
    if (!timeline.length) throw new Error('没有合成出可用片段');
    // 段数超限：保留时长最长的 N 段并按时间排回——不要直接报错中断（长直播会白跑一遍清洗）
    let cutTimeline = timeline;
    if (cutTimeline.length > MAX_FILTER_SEGS) {
      cutTimeline = [...cutTimeline].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, MAX_FILTER_SEGS).sort((a, b) => a.start - b.start);
      console.log(`[SentenceCutter] 片段数 ${timeline.length} 超过上限 ${MAX_FILTER_SEGS}，保留时长最长的 ${MAX_FILTER_SEGS} 段继续成片`);
    }
    const keptSecs = Math.round(cutTimeline.reduce((a, s) => a + (s.end - s.start), 0) / 1000);
    console.log(`[SentenceCutter] 时间线：${cutTimeline.length} 段，共 ${keptSecs} 秒`);

    // 输出：output/sentence/<名>_逐句成片.mp4（同名校旧文件加时间戳）
    mkdirSync(this.outDir, { recursive: true });
    let out = join(this.outDir, `${name}_逐句成片.mp4`);
    if (existsSync(out)) out = join(this.outDir, `${name}_逐句成片_${Date.now()}.mp4`);

    await this._render(videoPath, cutTimeline, out);

    const totalSecs = await this._probeDuration(out);
    this.store.db.prepare(
      "INSERT INTO sentence_cuts (video_path, video_name, output_path, segments, kept_secs, total_secs, status, note) VALUES (?,?,?,?,?,?,'done',?)"
    ).run(videoPath, name, out, JSON.stringify(cutTimeline), keptSecs, totalSecs, granWarn);
    console.log(`[SentenceCutter] 完成：${out}（${keptSecs}s，来自 ${cutTimeline.length} 段）`);
    return { outputPath: out, keptSecs, totalSecs, segCount: cutTimeline.length, keptCount: kept.length, droppedCount: cleaned.length - kept.length, warning: granWarn, degenerate };
  }

  /** 单命令 filter_complex trim+concat：一次解码，句级切点准确。 */
  async _render(videoPath, timeline, out) {
    const vParts = [], aParts = [], concatLabels = [];
    timeline.forEach((s, i) => {
      const a = i * 1000;
      vParts.push(`[0:v]trim=start=${(s.start / 1000).toFixed(3)}:end=${(s.end / 1000).toFixed(3)},setpts=PTS-STARTPTS[v${a}]`);
      aParts.push(`[0:a]atrim=start=${(s.start / 1000).toFixed(3)}:end=${(s.end / 1000).toFixed(3)},asetpts=PTS-STARTPTS[a${a}]`);
      concatLabels.push(`[v${a}][a${a}]`);
    });
    const filter = `${vParts.join(';')};${aParts.join(';')};${concatLabels.join('')}concat=n=${timeline.length}:v=1:a=1[vout][aout]`;
    const args = ['-y', '-i', videoPath, '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
    console.log(`[SentenceCutter] ffmpeg 拼接 ${timeline.length} 段（重编码，句级切点）…`);
    await this.ffmpeg.run(this.ffmpeg.ffmpegPath, args, 3600000); // 长视频拼接给足 1 小时
  }

  async _probeDuration(file) {
    try {
      const out = await this.ffmpeg.run(this.ffmpeg.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60000);
      return Math.round(parseFloat(String(out).trim()) || 0);
    } catch { return 0; }
  }
}

export { filterInteractionSegs, isInteractionSentence };
export default SentenceCutter;
