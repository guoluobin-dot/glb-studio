/**
 * DeepAnalyzer —— 爆款视频深度理解（记忆链条 P1）。
 *
 * 在 HitAnalyzer（主题/钩子/结构/预估）之上再深一层，产出可直接指导剪辑的记忆：
 *   1. clean_transcript：去口误 / 重复 / 语气词 / 冗余后的干净逐句稿（时间戳原样保留）
 *   2. structure：完整结构（开场钩子/铺垫/高潮/收尾/CTA，起止 ms + 小结）
 *   3. keep_list：必要保留内容（起止 + 理由）
 *   4. drop_list：可去除内容（起止 + 理由：重复/口误/跑题/拖沓）
 *   5. cut_points：建议剪辑点（at_ms，in/out/jump + 说明）
 *
 * 输入逐句稿来源：hit_videos.asr_path 的缓存 JSON（不重新转写）；
 * 缓存缺失才走 ASRHelper.getTranscript。无稿则记 status='empty' 终态，不重试。
 * 长稿分块（clean 按 40 句/块，structure 超 12000 字分两半合并），时间戳均为绝对 ms。
 */
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { ASRHelper } from './asr-helper.js';

const CLEAN_CHUNK_SEGS = 40;
const STRUCT_MAX_CHARS = 12000;

const CLEAN_SYSTEM = `你是逐句稿清洗器。只输出 JSON，不要任何解释、前言、markdown。
规则：
- 轻微修正 ASR 错别字（人名/术语按上下文修正），不要改写原意；
- 每句判定 keep(true/false)：语气词堆砌、无信息口头禅、重复啰嗦、说错自我纠正、完全跑题，判 false；
- 情感饱满、讲解清晰、有教学或信息价值的句子必须 keep(true)——哪怕语气强烈、带感叹，也绝不是语气词；
- 教学内容（讲解/示范/纠正/方法步骤）是核心价值，一律 keep(true)；
- 重复话去除：意思重复的教学点（表述不同但讲的是同一件事）只保留讲得最清楚、情绪最饱满的一句，其余 keep(false)、reason 用 repeat；
- reason 只能是 keep/filler/repeat/mistake/offtopic/draggy 其中之一；
- 时间戳照抄，不要改。
输出结构：{"segments":[{"i":句号(从0编号，与输入一致),"text":"清洗后文本","keep":true,"reason":"keep"}]}`;

const STRUCT_SYSTEM = `你是短视频结构拆解器。只输出 JSON，不要任何解释、前言、markdown。
要求：
- structure：完整覆盖全片的结构段，type 只能是 hook_opening/build_up/peak_moment/payoff/cta/outro，
  每段 title（一句话）+ summary（两三句）+ 起止毫秒；
- keep_list：必须保留的高价值内容（金句/干货演示/高潮），起止毫秒 + reason；
- drop_list：建议剪掉的内容（重复/跑题/拖沓），起止毫秒 + reason；
- cut_points：建议剪辑点，at_ms + kind(in 入点/out 出点/jump 跳切)+ note；
- 所有时间都是毫秒整数，不要超出片长。
输出结构：{"structure":[{"type":"hook_opening","title":"...","summary":"...","start_ms":0,"end_ms":0}],"keep_list":[{"start_ms":0,"end_ms":0,"reason":"..."}],"drop_list":[{"start_ms":0,"end_ms":0,"reason":"..."}],"cut_points":[{"at_ms":0,"kind":"in","note":"..."}]}`;

export class DeepAnalyzer {
  constructor(ollama, store, config) {
    this.ollama = ollama;
    this.store = store;
    this.config = config;
    this.asr = new ASRHelper(config);
    this._ensureTable();
  }

  /** 深解表：构造时幂等建表（IF NOT EXISTS），不碰 store.js。 */
  _ensureTable() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS deep_memory (
        hit_video_id INTEGER PRIMARY KEY,
        status TEXT DEFAULT 'completed',
        note TEXT DEFAULT '',
        clean_transcript TEXT,
        structure TEXT,
        keep_list TEXT,
        drop_list TEXT,
        cut_points TEXT,
        duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deep_video ON deep_memory(hit_video_id);
    `);
  }

  /** upsert 深解记录。 */
  _save(videoId, data) {
    this.store.db.prepare(`
      INSERT INTO deep_memory (hit_video_id, status, note, clean_transcript, structure, keep_list, drop_list, cut_points, duration_ms, updated_at)
      VALUES (@hitVideoId, @status, @note, @cleanTranscript, @structure, @keepList, @dropList, @cutPoints, @durationMs, datetime('now'))
      ON CONFLICT(hit_video_id) DO UPDATE SET
        status = @status, note = @note, clean_transcript = @cleanTranscript,
        structure = @structure, keep_list = @keepList, drop_list = @dropList,
        cut_points = @cutPoints, duration_ms = @durationMs, updated_at = datetime('now')
    `).run({
      hitVideoId: videoId,
      status: data.status || 'completed',
      note: data.note || '',
      cleanTranscript: data.cleanTranscript ? JSON.stringify(data.cleanTranscript) : null,
      structure: data.structure ? JSON.stringify(data.structure) : null,
      keepList: data.keepList ? JSON.stringify(data.keepList) : null,
      dropList: data.dropList ? JSON.stringify(data.dropList) : null,
      cutPoints: data.cutPoints ? JSON.stringify(data.cutPoints) : null,
      durationMs: data.durationMs || 0,
    });
  }

  async analyze(videoPath) {
    const row = this.store.getHitVideo(videoPath);
    if (!row) throw new Error('no hit_video row for ' + videoPath);
    const videoId = row.id;
    const videoName = row.video_name || basename(videoPath);
    console.log(`[DeepAnalyzer] Deep pass: ${videoName} (id=${videoId})`);

    const fileGone = !existsSync(videoPath);
    const segs = fileGone ? [] : await this._loadSegments(row, videoPath);
    const durationMs = row.duration_ms || (segs.length ? Math.round(segs[segs.length - 1].end) : 0);
    if (!segs.length) {
      this._save(videoId, {
        status: 'empty', note: fileGone ? '源文件已不在投喂目录（可能被删除），跳过深解；重新投喂后自动补' : '无可用逐句稿（静音/转写缺失），跳过深解',
        durationMs,
      });
      console.log(`[DeepAnalyzer] No transcript, marked empty: ${videoName}`);
      return { hitVideoId: videoId, empty: true };
    }

    const cleaned = await this._cleanTranscript(segs);
    const kept = cleaned.filter((s) => s.keep);
    const struct = await this._structureVideo(kept.length ? kept : cleaned, durationMs);
    this._save(videoId, {
      status: 'completed', note: '',
      cleanTranscript: kept, structure: struct.structure,
      keepList: struct.keep_list, dropList: struct.drop_list,
      cutPoints: struct.cut_points, durationMs,
    });
    console.log(`[DeepAnalyzer] Done: kept ${kept.length}/${cleaned.length} segs, ` +
      `${struct.structure.length} structure, ${struct.cut_points.length} cuts`);
    return {
      hitVideoId: videoId, kept: kept.length,
      dropped: cleaned.length - kept.length, cuts: struct.cut_points.length,
    };
  }

  /** 读缓存逐句稿并统一成 [{start,end(ms),text}]；缓存缺失走 ASR 链。 */
  async _loadSegments(row, videoPath) {
    const durationMs = row.duration_ms || 0;
    const norm = (list) => (Array.isArray(list) ? list : [])
      .map((s) => {
        let start = null;
        let end = null;
        if (Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms)) {
          start = s.start_ms;
          end = s.end_ms;
        } else if (s._sec || (Number.isFinite(s.start) && Number.isFinite(s.end))) {
          // 秒→毫秒；但有些缓存把毫秒直接塞在 start/end 里，用片长反推
          const maybeSec = s._sec || (durationMs > 0 && s.end * 1000 <= durationMs * 1.2);
          if (maybeSec) {
            start = s.start * 1000;
            end = s.end * 1000;
          } else {
            start = s.start;
            end = s.end;
          }
        }
        const text = String(s.text || s.word || '').trim();
        if (start == null || end == null || !text) return null;
        return { start: Math.round(start), end: Math.round(end), text };
      })
      .filter(Boolean);
    if (row.asr_path && existsSync(row.asr_path)) {
      try {
        const cached = JSON.parse(readFileSync(row.asr_path, 'utf-8'));
        const list = norm(cached.segments || cached);
        if (list.length) {
          console.log(`[DeepAnalyzer] Loaded ${list.length} segs from ASR cache`);
          return list;
        }
      } catch (err) {
        console.warn(`[DeepAnalyzer] Bad ASR cache, fallback to ASR chain: ${err.message}`);
      }
    }
    const r = await this.asr.getTranscript(videoPath);
    return norm(r.transcript || []);
  }

  /** 逐块清洗：修正错别字 + 标 keep/drop。opts.dedupRepeat=false 时关闭语义去重（重复句也保留）。 */
  async _cleanTranscript(segs, opts = {}) {
    const out = [];
    for (let b = 0; b * CLEAN_CHUNK_SEGS < segs.length; b++) {
      const chunk = segs.slice(b * CLEAN_CHUNK_SEGS, (b + 1) * CLEAN_CHUNK_SEGS);
      const numbered = chunk.map((s, k) => {
        const i = b * CLEAN_CHUNK_SEGS + k;
        return { i, line: `[${(s.start / 1000).toFixed(1)}s] ${s.text}` };
      });
      const sys = opts.dedupRepeat === false
        ? CLEAN_SYSTEM + '\n注意：本次不要做重复话去除——即使多句意思重复，也全部 keep(true) 原样保留。'
        : CLEAN_SYSTEM;
      const user = `清洗以下逐句稿（共${chunk.length}句，编号${numbered[0].i}起）：\n` +
        numbered.map((x) => `${x.i}: ${x.line}`).join('\n');
      const res = await this._jsonCall(sys, user, { maxTokens: 4096, temperature: 0.2 });
      const byId = new Map(chunk.map((s, k) => [b * CLEAN_CHUNK_SEGS + k, s]));
      const seen = new Set();
      for (const r of res.segments || []) {
        const orig = byId.get(r.i);
        if (!orig || seen.has(r.i)) continue;
        seen.add(r.i);
        out.push({
          start: orig.start, end: orig.end,
          text: typeof r.text === 'string' && r.text.trim() ? r.text.trim() : orig.text,
          keep: r.keep !== false, reason: r.reason || 'keep',
        });
      }
      // 模型漏句则原样保留（宁可多留，不丢内容）
      for (const [i, s] of byId) {
        if (!seen.has(i)) out.push({ start: s.start, end: s.end, text: s.text, keep: true, reason: 'keep' });
      }
      console.log(`[DeepAnalyzer] Cleaned chunk ${b + 1}: keep ${out.filter((s) => s.keep).length}/${out.length} so far`);
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /** 结构拆解：超长分两半合并（时间戳绝对值，可直接拼接）。 */
  async _structureVideo(kept, durationMs) {
    const textOf = (list) => list.map((s) => `[${(s.start / 1000).toFixed(1)}s] ${s.text}`).join('\n');
    const full = textOf(kept);
    const parts = full.length > STRUCT_MAX_CHARS
      ? [kept.slice(0, Math.ceil(kept.length / 2)), kept.slice(Math.floor(kept.length / 2))]
      : [kept];
    const merged = { structure: [], keep_list: [], drop_list: [], cut_points: [] };
    for (let p = 0; p < parts.length; p++) {
      const head = parts.length > 1 ? `（第${p + 1}/${parts.length}部分，片长${Math.round(durationMs / 1000)}秒，只拆解本部分）\n` : '';
      const user = `${head}拆解以下逐句稿：\n${textOf(parts[p])}`;
      const res = await this._jsonCall(STRUCT_SYSTEM, user, { maxTokens: 6144, temperature: 0.2 });
      for (const k of ['structure', 'keep_list', 'drop_list', 'cut_points']) {
        if (Array.isArray(res[k])) merged[k].push(...res[k]);
      }
    }
    // 归一化：时间钳到片长，cut 按时间排序
    const clamp = (v) => Math.max(0, Math.min(durationMs || v, Math.round(Number(v) || 0)));
    for (const s of merged.structure) {
      s.start_ms = clamp(s.start_ms ?? s.startMs ?? 0);
      s.end_ms = clamp(s.end_ms ?? s.endMs ?? s.start_ms);
      if (s.end_ms <= s.start_ms) s.end_ms = Math.min(s.start_ms + 5000, durationMs || s.start_ms + 5000);
    }
    for (const L of [merged.keep_list, merged.drop_list]) {
      for (const r of L) {
        r.start_ms = clamp(r.start_ms ?? 0);
        r.end_ms = clamp(r.end_ms ?? r.start_ms);
        if (r.end_ms <= r.start_ms) r.end_ms = r.start_ms + 1000;
      }
    }
    for (const c of merged.cut_points) {
      c.at_ms = clamp(c.at_ms ?? 0);
      if (!['in', 'out', 'jump'].includes(c.kind)) c.kind = 'jump';
    }
    merged.cut_points.sort((a, b) => a.at_ms - b.at_ms);
    return merged;
  }

  /** JSON 调用 + 一次散文修复（照抄 HitAnalyzer 的便宜修复）。 */
  async _jsonCall(system, user, opts) {
    const result = await this.ollama.generate(system, user, { ...opts, parseJson: true });
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    console.warn('[DeepAnalyzer] Non-JSON output, one repair pass...');
    const repaired = await this.ollama.generate(
      '你是 JSON 整理器。只输出 JSON 对象，不要解释、前言、markdown。',
      `整理成 JSON：\n---\n${String(result).slice(0, 6000)}`,
      { maxTokens: 4096, temperature: 0.1, parseJson: true }
    );
    if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) return repaired;
    throw new Error('LLM 未返回可用 JSON');
  }
}

export default DeepAnalyzer;
