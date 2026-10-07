/**
 * Content Generator - 字幕/标题/封面生成器
 *
 * For each clip project, generates:
 * 1. Subtitle (.srt) from ASR transcript aligned with clip timestamps
 * 2. Video title overlay (text at top of video, styled)
 * 3. First-frame cover image with title text burned in
 *
 * All powered by Ollama for text generation, ffmpeg for video/image processing.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { FFmpegHelper, escapeDrawtext, escapeSubtitlesPath, escapeFilterPath } from '../analyzer/ffmpeg-helper.js';
import { ASRHelper } from '../analyzer/asr-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TITLE_GENERATION_PROMPT = `You are a viral short video title writer. Create compelling, click-worthy titles for short videos.

Given a video's theme, transcript summary, and learned patterns from historical hit videos, generate titles.

Output strict JSON:
{
  "titles": [
    {
      "text": "The title text (can include emoji)",
      "style": "shocking | curiosity | benefit | urgency | story | question",
      "target_emotion": "surprise | curiosity | excitement | FOMO | empathy",
      "character_count": number
    }
  ],
  "recommendation": "which title to use and why"
}

Rules:
- Titles should be 15-30 Chinese characters or 30-60 English characters
- Use psychological hooks: numbers, questions, "you won't believe", "secret", "finally", "stop doing X", "the real reason"
- Match the emotional tone of the video content
- Can include 1-2 relevant emoji for visual impact`;

const COVER_PROMPT = `You are a thumbnail/cover designer AI. Given a video's theme and key moments, suggest how to design an eye-catching first-frame cover.

Output strict JSON:
{
  "suggested_layout": "center_text | split_screen | reaction_face | product_focus | before_after",
  "title_placement": "top | center | bottom",
  "color_scheme": {
    "background": "hex color",
    "text": "hex color",
    "accent": "hex color"
  },
  "text_elements": [
    {
      "text": "main title text",
      "position": "top_center | center | bottom_center",
      "font_size": "large | medium | small"
    }
  ],
  "visual_elements": ["arrows", "circles", "contrast", "blur_background", "bright_colors"],
  "notes": "design reasoning"
}`;

/** 声乐教学领域词表（字幕纠错用，2026-09-27）：老板给定 + 领域扩充。ASR 同音字错误（混声→混生、声带→生带）对照此表由 LLM 纠正。 */
const SINGING_TERMS = [
  '混声', '声带', '关闭唱法', '气息', '共鸣', '假声', '真声', '头声', '咽音', '开嗓', '护嗓',
  '胸腔共鸣', '鼻腔共鸣', '头腔共鸣', '口腔共鸣', '喉头', '喉位', '声带闭合', '闭合不良',
  '音准', '音域', '音色', '节拍', '节奏', '咬字', '吐字', '归韵', '字头', '字腹', '字尾',
  '前鼻音', '后鼻音', '翘舌音', '平舌音', '开口音', '闭口音',
  '高音', '低音', '中音', '强混', '弱混', '平衡混', '气声', '气泡音', '颤音', '滑音', '转音', '尾音',
  '横膈膜', '丹田', '腹式呼吸', '胸式呼吸', '偷气', '换气', '叹气',
  '哼鸣', '唇颤音', '打嘟', '麦克风', '返听', '修音', '跑调', '破音', '走音', '音阶', '调式', '五音不全',
  '洪湖水浪打浪', '月亮在天上', '五星红旗', '我和我的祖国', '搀扶',
];

/* ────────────────── ASS 字幕样式辅助 ────────────────── */

/**
 * #RRGGBB -> ASS 的 &HAABBGGRR。
 *
 * ASS 是 **BGR** 不是 RGB。直接把 #RRGGBB 塞给 PrimaryColour 会得到
 * 红蓝互换的颜色。以前字幕固定白色（#FFFFFF 两种写法一样）所以一直没暴露，
 * 一旦用户选了别的颜色就会发现"颜色不对"。
 * alpha 在 ASS 里是**反向**的：00 = 不透明，FF = 全透明。
 */
function assColorFromHex(hex) {
  const h = String(hex).replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `00${b}${g}${r}`.toUpperCase();
}

/**
 * ASS 的 force_style 用逗号分隔字段，值里带逗号/等号/花括号会把整串解析搞乱
 * （表现为字幕样式全部丢失或 ffmpeg 直接报错）。
 */
function sanitizeAssField(v) {
  return String(v ?? '').replace(/[,=}{]/g, ' ').trim();
}

export class ContentGenerator {
  constructor(ollama, store, config) {
    this.ollama = ollama;
    this.store = store;
    this.config = config;
    this.ffmpeg = new FFmpegHelper();
    this.asr = new ASRHelper(config);
    this.finishedDir = config.output?.finishedDir || join(__dirname, '..', '..', 'output', 'finished');
    this._running = new Set(); // 防并发：同一项目同时只允许一个包装任务（看板手动+调度器自动会撞车）
  }

  /**
   * Generate all content for a clip project.
   *
   * @param {number} projectId
   * @param {object} [options]
   * @param {boolean} [options.subtitles=true]  是否产出字幕
   * @param {boolean} [options.covers=true]      是否产出封面
   * @param {boolean} [options.title=true]       是否烧标题（关掉只给文案不合成）
   * @param {string}  [options.titleText]        指定标题文案（不指定则由模型生成）
   * @returns {Promise<{outputDir: string, titles: Array, subtitles: Array, covers: Array, finalVideos: Array}>}
   */
  async generateAll(projectId, options = {}) {
    if (this._running.has(projectId)) {
      throw new Error('该项目正在包装中（可能调度器也在跑），请稍候再试');
    }
    // 归一化:调用方可能传字符串("false")或干脆不传,不归一化会把关掉的开关当真值用
    const want = (v, dflt) => {
      if (v === undefined || v === null) return dflt;
      if (typeof v === 'string') return v !== 'false' && v !== '0' && v !== '';
      return Boolean(v);
    };
    this._running.add(projectId);
    try {
      // 视频信息:自动变焦要用关键帧(情绪/能量峰),没有依据就只能在整片上乱推
      let keyframes = [];
      try {
        const segs = this.store.db
          .prepare(
            `SELECT start_ms, end_ms, hook_quality, emotion FROM live_segments
              WHERE live_video_id = ? AND status = 'draft' ORDER BY segment_index`
          )
          .all(project.live_video_id) || [];
        keyframes = segs
          .map((s) => ({
            sec: (Number(s.start_ms) + Number(s.end_ms)) / 2000,
            score: (Number(s.hook_quality) || 0) * 0.6 + (Number(s.emotion) || 0) * 0.4
          }))
          .filter((k) => k.score > 0);
      } catch { /* 拿不到就不做自动变焦,不能因此让整个出片失败 */ }

      return await this._generateAllInner(projectId, {
        subtitles: want(options.subtitles, true),
        covers: want(options.covers, true),
        title: want(options.title, true),
        titleText: typeof options.titleText === 'string' ? options.titleText.trim() : '',

        // 画面处理
        vertical: want(options.vertical, true),
        captionStyle: typeof options.captionStyle === 'string' ? options.captionStyle : 'auto',
        coldOpen: want(options.coldOpen, false),
        titleCard: want(options.titleCard, false),
        autoZoom: want(options.autoZoom, false),
        keyframes,
        watermark: typeof options.watermark === 'string' ? options.watermark.trim() : '',

        // 音频
        bgmPath: typeof options.bgmPath === 'string' && options.bgmPath.trim() ? options.bgmPath.trim() : '',
        bgmVolume: Number.isFinite(Number(options.bgmVolume)) ? Math.max(0, Math.min(1, Number(options.bgmVolume))) : 0.22,
        duckBgm: want(options.duckBgm, true),
        sfx: want(options.sfx, false),
        sfxAt: Array.isArray(options.sfxAt) ? options.sfxAt.map(Number).filter(Number.isFinite) : [],

        // 字幕 / 标题样式（2026-10-02）
        // 只做浅归一化：具体样式项在 _composeFinalVideo 里逐个判，
        // 因为缺省值和画面高度有关（字号要按 1080p 基准等比缩放）。
        captionFontStyle: options.captionFontStyle && typeof options.captionFontStyle === 'object'
          ? options.captionFontStyle
          : null,
        titleFontStyle: options.titleFontStyle && typeof options.titleFontStyle === 'object'
          ? options.titleFontStyle
          : null,
        // 老字段也要进来：以前只在客户端透传，generator 这层从没读过，
        // 于是"标题卡停留 3 秒"和"冷开场 2 秒"这两个设置存了也白存。
        titleCardSeconds: Number.isFinite(Number(options.titleCardSeconds)) ? Number(options.titleCardSeconds) : undefined,
        coldOpenSeconds: Number.isFinite(Number(options.coldOpenSeconds)) ? Number(options.coldOpenSeconds) : undefined,

        // 用户上传的封面图 / 结尾藏带货视频
        // 主进程已经选好了具体那一条（assetPick），这里只管有没有效。
        coverImage: options.coverImage && typeof options.coverImage === 'object' ? options.coverImage : null,
        tailVideo: options.tailVideo && typeof options.tailVideo === 'object' ? options.tailVideo : null
      });
    } finally {
      this._running.delete(projectId);
    }
  }

  async _generateAllInner(projectId, opts = {}) {
    const project = this.store.getClipProject(projectId);
    if (!project) {
      throw new Error(`Clip project not found: ${projectId}`);
    }

    console.log(`[ContentGenerator] Generating content for project ${projectId}`);

    // 成片合成降级的原因（非空 = 只产出了粗剪副本，没有标题/字幕）。
    // 2026-09-24：以前这种情况照样写 status:'finished'，用户以为成功了。
    let degradedReason = null;

    const liveVideo = this.store.getLiveVideoById?.(project.live_video_id);
    if (!liveVideo) {
      throw new Error(`Source video not found for project ${projectId}`);
    }

    const videoPath = liveVideo.video_path;
    const videoName = basename(videoPath, extname(videoPath));
    const projectName = project.project_name || `project_${projectId}`;

    // Ensure output directory
    const outputDir = join(this.finishedDir, projectName);
    mkdirSync(outputDir, { recursive: true });

    const results = {
      subtitlePath: null,
      titleText: null,
      coverPath: null,
      finalVideoPath: null
    };

    try {
      // Step 1: Get ASR transcript for the source video
      let asrResult = await this.asr.getTranscript(videoPath);
      /*
       * 热词硬纠正（按 IP 老师归档的那份）。
       *
       * 为什么必须在这里再套一次，而不能指望 ASRHelper：
       * ASRHelper._withTermCorrection 只走 singing-terms.json 那份**全局**词表，
       * 它不认识用户在出片台里为某位老师加的热词。
       * 结果就是审片台文案是纠正过的、成片字幕却是带错字的 ——
       * 两边看起来各自正常，肉眼很难同时比对出来。
       *
       * collection 取这条素材自己的归属（跟分析时用同一份），
       * 不能读"当前选中的 IP"：素材 A 是上一位老师的，
       * 切到 B 之后再出片，不该把 B 的词套到 A 上。
       */
      try {
        const collection = liveVideo?.collection || null;
        const rules = this.store?.getHotwords?.(collection) || [];
        if (rules.length) {
          const before = asrResult?.transcript?.length ?? 0;
          const { applyHotwords } = await import('../analyzer/hotwords.js');
          const transcript = (asrResult?.transcript || []).map((s) => ({
            ...s,
            text: applyHotwords(String(s?.text || ''), rules)
          }));
          asrResult = { ...asrResult, transcript };
          console.log(
            `[ContentGenerator] 热词已套用(${collection || '通用'})：${rules.length} 条规则`
            + ` / ${before} 句`
          );
        }
      } catch (err) {
        // 套用失败不该挡住出片：字幕带错字远好过出不了片
        console.warn(`[ContentGenerator] 热词套用失败（不影响出片）: ${err.message}`);
      }
      const hasTranscript = Array.isArray(asrResult?.transcript) && asrResult.transcript.length > 0;
      // 字幕和标题文案都依赖转写。两者都关掉时,转写缺失不该阻断出片
      // (用户可能只是想导出裸粗剪),所以只在真需要时才拦。
      const needsTranscript = opts.subtitles || opts.titleText;
      if (needsTranscript && !hasTranscript) {
        throw new Error(
          asrResult?.reason ||
            '这条素材没有可用的转写文本,字幕无法生成。请先重新跑一次「找爆点」完成转写。'
        );
      }

      // Step 2: segments（已按 hook→正文→closer 排好序，缺 role 的老项目按原序当正文）
      const segments = project.selected_segments || [];
      // 补上每段的历史爆款匹配（封面“同款”用）
      try {
        const liveSegs = this.store.getLiveSegmentsByVideo?.(project.live_video_id) || [];
        const byId = new Map(liveSegs.map(s => [s.id, s]));
        for (const seg of segments) {
          const full = byId.get(seg.segmentId);
          if (full?.matched_hit_themes) seg.matchedHitThemes = full.matched_hit_themes;
        }
      } catch { /* ignore */ }
      if (!segments.length) throw new Error('项目没有选中片段，无法包装');

      // Step 2b: 找到粗剪单文件（clip 阶段已按角色拼好）；没有就现场拼
      // 兼容老项目：output_path 可能指向 finished，draft 片段在 output/draft/project_{id}
      const clipDir = project.output_path || join(this.config.output?.draftDir || '', `project_${projectId}`);
      const draftDir = join(this.config.output?.draftDir || '', `project_${projectId}`);
      const searchDirs = [clipDir, draftDir].filter((d, i, a) => d && a.indexOf(d) === i);
      let roughcutPath = null;
      let clipFiles = [];
      try {
        const { readdirSync } = await import('fs');
        for (const dir of searchDirs) {
          if (!existsSync(dir)) continue;
          const files = readdirSync(dir);
          const found = files.filter(f => /roughcut\.mp4$/i.test(f));
          if (found.length && !roughcutPath) roughcutPath = join(dir, found[0]);
          if (!clipFiles.length) {
            /*
             * 2026-10-05 修：原来的 `/_clip\d+\.mp4$/` 漏掉了多区间段。
             *
             * clipper 给"带 cuts 的段"产出的是 clip1_1.mp4 / clip1_2.mp4
             * （见 clipper 里 `${videoName}_clip${i+1}${ranges.length>1?`_${k+1}`:''}.mp4`），
             * 而这个正则只匹配 clip1.mp4。
             *
             * 于是重建缺失的粗剪时，**恰好是那些被删过字的段被整段漏掉** ——
             * 最需要保留的内容反而消失了，而且不报任何错。
             *
             * 排序也不能靠 localeCompare：clip1_10 会被排到 clip1_2 前面，
             * 于是子区间顺序错乱、拼接出音画错位的片子。这里按数字排。
             */
            const key = (name) => {
              const m = /_clip(\d+)(?:_(\d+))?\.mp4$/i.exec(name);
              return m ? [Number(m[1]), Number(m[2] ?? 1)] : [0, 0];
            };
            clipFiles = files
              .filter(f => /_clip\d+(?:_\d+)?\.mp4$/i.test(f))
              .sort((a, b) => {
                const ka = key(a), kb = key(b);
                return ka[0] - kb[0] || ka[1] - kb[1];
              })
              .map(f => join(dir, f));
            if (clipFiles.length) {
              console.log(`[ContentGenerator] 重建粗剪素材：找到 ${clipFiles.length} 个切片（含多区间的 clipN_M.mp4）`);
            }
          }
        }
      } catch { /* ignore */ }
      if (!roughcutPath && this.ffmpeg.isAvailable) {
        // 注意：draft 文件名顺序 clip1..N 即角色顺序（clip 阶段已按 hook→正文→closer 切）
        const clips = clipFiles.filter(p => existsSync(p));
        if (clips.length) {
          roughcutPath = join(clipDir, `${videoName}_roughcut.mp4`);
          await this.ffmpeg.concatCopy(clips, roughcutPath);
          console.log(`[ContentGenerator] Built missing roughcut: ${roughcutPath}`);
        }
      }
      if (!roughcutPath) throw new Error('找不到粗剪视频（draft 目录无片段），请先回到粗剪页重新剪');

      // Step 2c: 时间轴偏移（第 i 段在成片中的起始 = 前面各段时长之和）
      //
      // 2026-09-30 逐句裁剪对齐：段若带 cuts,实际进成片的是各子区间拼接,
      // 时长必须按 cuts 求和,不能用 endMs-startMs。否则字幕时间轴整体偏移,
      // 表现为"字幕跟画面对不上、越到后面差得越多"。
      const segDurationMs = (seg) => {
        if (Array.isArray(seg.cuts) && seg.cuts.length) {
          return seg.cuts.reduce((a, c) => a + Math.max(0, Number(c.en) - Number(c.st)), 0);
        }
        return Math.max(0, Number(seg.endMs) - Number(seg.startMs));
      };
      let acc = 0;
      for (const seg of segments) {
        seg._offsetMs = acc;
        acc += segDurationMs(seg);
      }

      // Step 3: 标题（整条成片一个主标题，取 hook 段驱动，closer 段的卖点做副标题参考）
      // 用户在界面里手写了标题就用手写的,不再让模型覆盖——否则用户改的字会被冲掉。
      const hookSeg = segments.find(s => s.role === 'hook') || segments[0];
      let title;
      if (opts.titleText) {
        title = { text: opts.titleText, alternatives: [], recommendation: '用户在界面指定' };
        console.log(`[ContentGenerator] 使用界面指定的标题: ${opts.titleText}`);
      } else {
        // 没有转写时模型写不出贴切的标题,退回中性文案而不是抛错卡住整条流水线
        title = hasTranscript
          ? await this._generateTitle(hookSeg, liveVideo, asrResult.transcript)
          : { text: `${hookSeg.themeName || '精彩片段'}`, alternatives: [], recommendation: '无转写,使用主题名兜底' };
      }
      const titles = [{ segmentIndex: 0, ...title }];

      // Step 4: 字幕（整条 srt，各段按偏移重排）
      let subtitles = [];
      if (opts.subtitles) {
        const srtPath = join(outputDir, `${videoName}_final.srt`);
        const subtitle = await this._generateJoinedSubtitle(segments, asrResult.transcript, srtPath);
        subtitles = [{ segmentIndex: 0, path: srtPath, ...subtitle }];
      } else {
        console.log('[ContentGenerator] 字幕已关闭,跳过 srt 生成');
      }

      // Step 5: 封面（成片第一帧 + 主标题 + 历史同款风格）
      let covers = [];
      if (opts.covers) {
        const coverPath = join(outputDir, `${videoName}_cover.jpg`);
        const cover = await this._generateCover(hookSeg, roughcutPath, coverPath, title);
        covers = [{ segmentIndex: 0, path: coverPath, ...cover }];
      } else {
        console.log('[ContentGenerator] 封面已关闭,跳过封面生成');
      }

      // Step 6: 合成最终成片（粗剪 + 画面处理 + 文字叠加 + 音频混合）
      //
      // 短路条件以前只有 title/subtitles 两个,于是"关掉字幕和标题但要竖屏/加水印/加 BGM"
      // 会直接跳过合成 —— 那些开关等于白勾。现在把所有会改变画面的开关都算进去。
      const needsCompose =
        opts.title ||
        opts.subtitles ||
        opts.vertical !== undefined ||
        opts.coldOpen ||
        opts.titleCard ||
        opts.watermark ||
        opts.autoZoom ||
        opts.bgmPath ||
        opts.sfx ||
        // 拼接类需求：用户传了封面图或藏带货就必须走合成，
        // 否则那几秒素材被静默丢掉（而且成片看起来完全正常）
        (opts.coverImage && opts.coverImage.usePath) ||
        (opts.tailVideo && opts.tailVideo.usePath);

      let finalPath = null;
      if (!needsCompose) {
        finalPath = roughcutPath;
        console.log('[ContentGenerator] 无任何画面/音频处理,直接使用粗剪作为成片');
      } else if (this.ffmpeg.isAvailable) {
        finalPath = join(outputDir, `${videoName}_final.mp4`);
        try {
          await this._composeFinalVideo(roughcutPath, title, subtitles[0] ?? null, finalPath, {
            burnTitle: opts.title,
            vertical: opts.vertical,
            captionStyle: opts.captionStyle,
            coldOpen: opts.coldOpen,
            titleCard: opts.titleCard,
            autoZoom: opts.autoZoom,
            keyframes: opts.keyframes,
            bgmPath: opts.bgmPath,
            bgmVolume: opts.bgmVolume,
            duckBgm: opts.duckBgm,
            sfx: opts.sfx,
            sfxAt: opts.sfxAt,
            watermark: opts.watermark,
            durationSec: project.total_duration_ms ? project.total_duration_ms / 1000 : undefined,
            // ↓ 下面这几个曾经漏在这里，于是"存了设置但出片没变化"
            // 字幕 / 标题样式
            captionFontStyle: opts.captionFontStyle,
            titleFontStyle: opts.titleFontStyle,
            // 时长可配（以前只有硬编码默认值）
            titleCardSeconds: opts.titleCardSeconds,
            coldOpenSeconds: opts.coldOpenSeconds,
            // 用户上传的封面图（首帧）/ 结尾藏带货
            coverImage: opts.coverImage,
            tailVideo: opts.tailVideo
          });
        } catch (err) {
          // 2026-09-24 修：以前合成失败就 copyFileSync 一个粗剪当"成片"，后面照样写 status:'finished'，
          // 老板拿到一条没有标题、没有字幕的片子却以为成功（最坑的是没有任何提示）。
          // 现在把降级事实记下来，状态标成 finished_degraded，看板/日志都能看出来。
          console.warn(`[ContentGenerator] 成片合成失败，降级为粗剪副本: ${err.message}`);
          degradedReason = `合成失败降级：${String(err.message).slice(0, 200)}`;
          try {
            const { copyFileSync } = await import('fs');
            copyFileSync(roughcutPath, finalPath);
          } catch {
            finalPath = roughcutPath;
          }
        }
      } else {
        finalPath = roughcutPath;
      }
      const finalVideos = finalPath ? [{ segmentIndex: 0, path: finalPath }] : [];

      // Store outputs
      for (const sub of subtitles) {
        if (sub.path) {
          this.store.addClipOutput({
            clipProjectId: projectId,
            outputType: 'subtitle',
            filePath: sub.path,
            metadata: { segmentIndex: sub.segmentIndex }
          });
        }
      }
      for (const cover of covers) {
        if (cover.path) {
          this.store.addClipOutput({
            clipProjectId: projectId,
            outputType: 'cover',
            filePath: cover.path,
            metadata: { segmentIndex: cover.segmentIndex, title: titles[cover.segmentIndex]?.text, retroFrom: cover.retroFrom || null }
          });
        }
      }
      for (const vid of finalVideos) {
        if (vid.path) {
          this.store.addClipOutput({
            clipProjectId: projectId,
            outputType: 'video',
            filePath: vid.path,
            metadata: { segmentIndex: vid.segmentIndex }
          });
        }
      }

      // Update project status
      this.store.updateClipProject(projectId, {
        status: degradedReason ? 'finished_degraded' : 'finished',
        outputPath: outputDir
      });

      console.log(`[ContentGenerator] Complete: ${titles.length} titles, ${subtitles.length} subtitles, ${covers.length} covers, ${finalVideos.length} final videos`);

      return {
        outputDir,
        titles,
        subtitles,
        covers,
        finalVideos
      };

    } catch (err) {
      console.error(`[ContentGenerator] Failed for project ${projectId}:`, err.message);
      this.store.updateClipProject(projectId, {
        status: 'failed'
      });
      throw err;
    }
  }

  /**
   * Generate a compelling title for a video segment.
   */
  async _generateTitle(segment, liveVideo, transcript) {
    const theme = segment.themeName || 'unknown';
    const summary = segment.transcriptSummary || '';

    // Get learned patterns for this genre
    const genre = liveVideo.genre || 'general';
    const hooks = this.store.getStyleProfile()['hooks_' + genre] || [];
    const copyPatterns = this.store.getCopywritingByType('hook', 5);
    const softCtas = this.store.getCopywritingByType('soft_cta', 3);
    // 过往爆款主题：标题要往这些验证过的主题上靠
    let hitThemeNames = [];
    try {
      hitThemeNames = (this.store.getAllHitThemes(50) || [])
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 5).map(t => t.theme_name);
    } catch { /* ignore */ }

    // Get the transcript text around this segment for context
    const segStartMs = segment.startMs || 0;
    const segEndMs = segment.endMs || segStartMs + 60000;
    const segmentText = this._extractSegmentText(transcript, segStartMs, segEndMs);

    const userPrompt = `Create viral video titles for this short video segment.

Theme: ${theme}
Content summary: ${summary}
Key transcript excerpt: ${segmentText.substring(0, 300)}

Learned hook patterns from historical hits:
${hooks.slice(0, 3).map(h => `- ${h.hook_text || h}`).join('\n')}

Popular hook patterns in database:
${copyPatterns.slice(0, 3).map(p => `- ${p.text_content || ''}`).join('\n')}

Proven hit themes from past viral videos (angle the title toward these):
${hitThemeNames.slice(0, 5).map(t => `- ${t}`).join('\n') || '- (no hit themes learned yet)'}

Soft follow-up invitations that worked before (weave the vibe into titles, not ads):
${softCtas.slice(0, 3).map(p => `- ${p.text_content || ''}`).join('\n')}

Generate 3 title options. Output as specified JSON.`;

    try {
      const result = await this.ollama.generate(TITLE_GENERATION_PROMPT, userPrompt, {
        maxTokens: 1024,
        temperature: 0.7,
        parseJson: true
      });

      const titles = result?.titles || [];
      const bestTitle = titles[0]?.text || `${theme} 精彩内容`;

      return {
        text: bestTitle,
        allOptions: titles.map(t => t.text),
        style: titles[0]?.style || 'general',
        recommendation: result?.recommendation || 'Use first title'
      };
    } catch (err) {
      console.warn(`[ContentGenerator] Title generation failed: ${err.message}`);
      return {
        text: `${theme} 精彩片段`,
        allOptions: [`${theme} 精彩片段`],
        style: 'fallback',
        recommendation: 'Fallback title used'
      };
    }
  }

  /**
   * 整条成片的字幕：各段转写按 _offsetMs 重偏置后合并成一个 srt。
   */
  async _generateJoinedSubtitle(segments, transcript, outputPath) {
    const rows = [];
    for (const seg of segments) {
      const segStartMs = seg.startMs || 0;
      const segEndMs = seg.endMs || segStartMs + 60000;
      const offset = (seg._offsetMs || 0) - segStartMs;
      // 逐句裁剪后,段被切成若干子区间,成片时间轴与原素材不再线性对应。
      // 这里把句子按"落在哪个子区间"分别映射,并在区间内重新计时,
      // 否则被剔除的句子仍会出现在字幕里(用户听到的没有、字幕却有)。
      const cuts = Array.isArray(seg.cuts) && seg.cuts.length
        ? seg.cuts
            .map((c) => ({ st: Number(c.st), en: Number(c.en) }))
            .filter((c) => Number.isFinite(c.st) && Number.isFinite(c.en) && c.en > c.st)
        : null;

      const cues = this._extractSegmentTranscript(transcript, segStartMs, segEndMs);
      if (!cuts) {
        for (const t of cues) {
          const text = t.text || t.word || '';
          if (!text.trim()) continue;
          rows.push({
            start: (t.start ?? t.start_ms ?? segStartMs) + offset,
            end: (t.end ?? t.end_ms ?? segEndMs) + offset,
            text,
          });
        }
        continue;
      }

      // 每个子区间起点在成片中的位置
      let cutAcc = seg._offsetMs || 0;
      for (const c of cuts) {
        const cutStart = Math.max(c.st, segStartMs);
        const cutEnd = Math.min(c.en, segEndMs);
        if (cutEnd <= cutStart) continue;
        for (const t of cues) {
          const ts = t.start ?? t.start_ms ?? cutStart;
          const te = t.end ?? t.end_ms ?? cutEnd;
          const text = t.text || t.word || '';
          if (!text.trim()) continue;
          // 只保留与该子区间有实际重叠的句子
          if (te <= cutStart || ts >= cutEnd) continue;
          const from = Math.max(ts, cutStart);
          const to = Math.min(te, cutEnd);
          rows.push({
            start: cutAcc + (from - cutStart),
            end: cutAcc + (to - cutStart),
            text,
          });
        }
        cutAcc += cutEnd - cutStart;
      }
    }
    rows.sort((a, b) => a.start - b.start);
    const split = this._splitLongCues(rows);
    if (!split.length) {
      // 2026-09-30 不再静默失败。
      // 以前这里只 console.warn 然后返回 path:null,端点照样回 ok:true,
      // 界面上"字幕已勾选"但目录里没有 srt,用户只能猜哪里出了问题。
      // 现在把真实原因带回去,由界面显示。
      const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
      const reason = !hasTranscript
        ? '这段素材没有可用的转写文本(ASR 未生成或路径失效),字幕无法生成。请先重新跑一次「找爆点」完成转写。'
        : `转写文本有 ${transcript.length} 句,但没有一句落在选中区间内(可能被逐句裁剪剔完了)。`;
      console.warn(`[ContentGenerator] No transcript rows for joined subtitle: ${reason}`);
      return { path: null, segmentCount: 0, totalText: '', error: reason };
    }
    const srtLines = [];
    split.forEach((r, i) => {
      srtLines.push(`${i + 1}`);
      srtLines.push(`${this._msToSRT(r.start)} --> ${this._msToSRT(r.end)}`);
      srtLines.push(r.text);
      srtLines.push('');
    });
    writeFileSync(outputPath, srtLines.join('\n'), 'utf-8');
    return {
      path: outputPath,
      segmentCount: split.length,
      totalText: split.map(r => r.text).join(' ').slice(0, 200),
    };
  }

  /**
   * 长句拆条：Sherpa 按 60s 切片转写，一条 cue 常是 200 字段落，烧出来糊成一片。
   * 按标点拆成 ≤36 字短条，时长按字数比例分，每条至少 800ms，保证单调不重叠。
   */
  _splitLongCues(rows, maxChars = 36) {
    const out = [];
    for (const r of rows) {
      const text = String(r.text || '').trim();
      if (!text) continue;
      if (text.length <= maxChars) { out.push({ ...r, text }); continue; }
      const parts = text.split(/(?<=[。！？!?；;…,.，、\s])/).map(s => s.trim()).filter(Boolean);
      // 无标点超长：硬切
      const pieces = [];
      for (const p of parts) {
        if (p.length <= maxChars) { pieces.push(p); continue; }
        for (let i = 0; i < p.length; i += maxChars) pieces.push(p.slice(i, i + maxChars));
      }
      if (pieces.length <= 1) { out.push({ ...r, text }); continue; }
      const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
      const dur = Math.max(0, (r.end ?? 0) - (r.start ?? 0));
      let cursor = r.start ?? 0;
      pieces.forEach((p, i) => {
        const last = i === pieces.length - 1;
        let d = last ? ((r.end ?? cursor) - cursor) : Math.max(800, Math.round(dur * (p.length / total)));
        d = Math.min(d, (r.end ?? cursor + d) - cursor);
        if (d < 400 && !last) d = 400;
        const end = last ? (r.end ?? cursor + d) : cursor + d;
        if (end > cursor) out.push({ start: Math.round(cursor), end: Math.round(end), text: p });
        cursor = end;
      });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /**
   * 字幕领域纠错层（2026-09-27）：对照唱歌领域词表纠正 ASR 同音字错误。
   * 一次成片一次 LLM 调用，句边界与时间戳不动；失败/关闭时原样返回不阻塞。
   */
  async _correctSubtitleText(items) {
    try {
      if (this.config.generator?.subtitleCorrect === false) return items;
      if (!Array.isArray(items) || items.length === 0) return items;
      const slice = items.slice(0, 400);
      const numbered = slice.map((t, i) => `${i + 1}. ${String(t.text || '')}`).join('\n');
      const out = await this.ollama.generate(
        '你是视频字幕校对员。输入是声乐教学视频的语音识别转写（编号句子列表），可能有同音字/错别字。\n' +
        '【领域词表】' + SINGING_TERMS.join('、') + '\n' +
        '规则：只纠正明显的同音字/错别字（对照词表与上下文），绝不改变句子意思、不增删字词、不动标点和序号。' +
        '输出严格 JSON 数组：[{"id":1,"text":"纠正后的句子"}]，id 与输入一一对应，所有句子都要输出。',
        numbered,
        { parseJson: true, maxTokens: 4096, temperature: 0.1 }
      );
      const arr = Array.isArray(out) ? out : null;
      if (!arr) return items;
      const map = new Map();
      for (const r of arr) {
        const id = Number(r?.id);
        const text = String(r?.text ?? '');
        if (Number.isFinite(id) && text) map.set(id, text);
      }
      let fixed = 0;
      const result = slice.map((t, i) => {
        const nt = map.get(i + 1);
        if (typeof nt === 'string' && nt !== t.text) fixed++;
        return { ...t, text: typeof nt === 'string' ? nt : t.text };
      });
      console.log(`[ContentGenerator] 字幕纠错：${items.length} 句里修正 ${fixed} 处`);
      return result.concat(items.slice(slice.length));
    } catch (err) {
      console.warn('[ContentGenerator] 字幕纠错失败（用原文继续）:', err.message);
      return items;
    }
  }

  /**
   * Generate .srt subtitle file for a segment.
   */
  async _generateSubtitle(segment, transcript, outputPath) {
    const segStartMs = segment.startMs || 0;
    const segEndMs = segment.endMs || segStartMs + 60000;

    // Extract transcript segments within this time range
    let segmentTranscript = this._extractSegmentTranscript(transcript, segStartMs, segEndMs);

    if (segmentTranscript.length === 0) {
      console.warn(`[ContentGenerator] No transcript found for segment ${segment.segmentId}`);
      return { path: null, segmentCount: 0, totalText: '' };
    }

    // 2026-09-27：字幕领域纠错层（老板指令③）——ASR 同音字错误（混声→混生、声带→生带）
    // 在生成 srt 前由 LLM 对照领域词表纠正一次；失败/关闭时原样返回，不阻塞出片。
    segmentTranscript = await this._correctSubtitleText(segmentTranscript);

    // Generate SRT content
    const cues = this._splitLongCues(segmentTranscript.map(t => ({
      start: t.start || t.start_ms || segStartMs,
      end: t.end || t.end_ms || segEndMs,
      text: t.text || t.word || '',
    })));
    const srtLines = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      srtLines.push(`${i + 1}`);
      srtLines.push(`${this._msToSRT(c.start)} --> ${this._msToSRT(c.end)}`);
      srtLines.push(c.text);
      srtLines.push('');
    }

    writeFileSync(outputPath, srtLines.join('\n'), 'utf-8');

    const totalText = cues.map(c => c.text).join(' ');
    return {
      path: outputPath,
      segmentCount: cues.length,
      totalText: totalText.substring(0, 200)
    };
  }

  /**
   * 封面帧挑选：在 hook 段内抽多个候选帧，交视觉模型挑最有"爆款感"的一张。
   *
   * 2026-09-27 修：以前永远用视频第 0 帧（extractFirstFrame → ffmpeg -ss 00:00:00），
   * 而第 0 帧通常是黑场/转场/主播还没进入状态——"封面总截不相关的图"的直接原因。
   * 另注意坐标陷阱：segment.startMs 属于原始直播时间轴，拿去 seek 粗剪成片会指错地方，
   * 必须用 Step 2c 预先算好的 _offsetMs（成片时间轴）。
   *
   * @returns {Promise<string|null>} 选中帧绝对路径（调用方负责最后删除）
   */
  async _pickCoverFrame(videoPath, segment, outDir, stamp) {
    const ff = this.ffmpeg;
    if (!ff?.isAvailable) return null;

    const startSec = Number(segment?._offsetMs ?? 0) / 1000;
    const rawDur = (Number(segment?.endMs ?? 0) - Number(segment?.startMs ?? 0)) / 1000;
    // 只从开场这一段里挑封面：实测 clip1 曾被当成 hook 段传进来（4740 秒），
    // 候选帧一路散布到第 79 分钟，而封面要代表钩子、必须在观众最先看到那几秒里选。
    const MAX_SPAN = Number(this.config.generator?.coverSpanSeconds ?? 30);
    const durSec = Math.max(1, Math.min(rawDur > 0 ? rawDur : 1, MAX_SPAN));
    const N = Number(this.config.generator?.coverCandidates ?? 6);
    const SHIFT = 0.4; // 跳过段首：剪辑点上经常是半个动作或还没张嘴

    let shots = [];
    try { mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
    for (let i = 0; i < N; i++) {
      const step = Math.max(0, durSec - SHIFT - 0.2) / Math.max(1, N - 1);
      const t = Math.max(0, startSec + SHIFT + step * i);
      const f = join(outDir, `${stamp}_${i}.jpg`);
      try {
        await ff.extractFrameAt(videoPath, t, f, 720);
        if (existsSync(f)) shots.push(f);
      } catch (err) {
        console.warn(`[ContentGenerator] 封面候选帧 ${i} 抽取失败：${String(err.message).slice(0, 80)}`);
      }
    }
    if (!shots.length) {
      // 一帧都抽不出来时退回老办法，至少保证封面文件存在（不阻塞出片）
      try {
        const fb = join(outDir, `${stamp}_fallback.jpg`);
        await ff.extractFirstFrame(videoPath, fb);
        return existsSync(fb) ? fb : null;
      } catch { return null; }
    }

    // 视觉不可用时的兜底："开场后不久的那一帧"通常也好过第 0 帧
    let bestIdx = Math.min(shots.length - 1, Math.max(0, Math.floor(shots.length / 3)));

    // 视觉模型打分（DeepSeek 是纯文本模型，describe 会自动回落本地 qwen2.5vl 看图）
    try {
      if (typeof this.ollama?.describe === 'function' && shots.length > 1) {
        const { readFileSync: rf } = await import('fs');
        const images = shots.map((f) => { try { return rf(f).toString('base64'); } catch { return null; } }).filter(Boolean);
        if (images.length) {
          const prompt = '你是短视频封面导演。给每张候选封面按"能不能让人想点进来"打分（人物是否在画面中/表情张力/是否正脸/画面是否清晰/有没有黑场或转场模糊）。只输出 JSON：{"scores":[{"idx":序号,"score":0-1,"note":"十字内点评"}]}。共 ' + images.length + ' 张，idx 从 0 开始。';
          const txt = await this.ollama.describe(images, prompt, { timeout: 300000, maxTokens: 1024 });
          const m = txt ? String(txt).match(/\{[\s\S]*\}/) : null;
          if (m) {
            const arr = JSON.parse(m[0])?.scores;
            if (Array.isArray(arr) && arr.length) {
              let top = null;
              for (const r of arr) {
                const i = Number(r?.idx); const s = Number(r?.score);
                if (Number.isInteger(i) && i >= 0 && i < shots.length && Number.isFinite(s) && (!top || s > top.s)) top = { i, s };
              }
              if (top) {
                bestIdx = top.i;
                console.log(`[ContentGenerator] 封面视觉挑选：第 ${bestIdx + 1}/${shots.length} 张得分最高（${top.s}）`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[ContentGenerator] 封面视觉挑选失败，回退默认帧：${String(err.message).slice(0, 80)}`);
    }

    // 落选候选帧立刻删掉，别在输出目录里堆垃圾
    const { unlinkSync } = await import('fs');
    for (let i = 0; i < shots.length; i++) {
      if (i === bestIdx) continue;
      try { unlinkSync(shots[i]); } catch { /* ignore */ }
    }
    return shots[bestIdx];
  }

  /**
   * Generate cover image for a segment.
   * retroFrom: 该段最匹配的历史爆款主题（封面即“历史同款”风格），写入输出元数据供看板展示。
   */
  async _generateCover(segment, videoPath, outputPath, titleInfo) {
    if (!this.ffmpeg.isAvailable) {
      console.warn('[ContentGenerator] ffmpeg not available, skipping cover generation');
      return { path: null, layout: 'unavailable' };
    }

    try {
      // 2026-09-27：封面帧不再固定取视频第 0 帧。
      // 旧 bug：这里算出 startSec 后从未被使用，实际走的是 extractFirstFrame（ffmpeg -ss 00:00:00），
      // 于是黑场/转场/主播还没进入状态的那帧被当成封面——"封面总截不相关的图"的直接原因。
      // 且 startMs 属于原始直播时间轴，套到粗剪成片上会 seek 到错误的秒数（这也是当年算完不敢用的原因）。
      // 正确做法是拿 Step 2c 算好的 _offsetMs（成片时间轴），在区间内抽候选帧再挑。
      const coverDir = dirname(outputPath);
      const coverStamp = `coverpick_${Date.now()}`;
      const framePath = await this._pickCoverFrame(videoPath, segment, coverDir, coverStamp);
      if (!framePath || !existsSync(framePath)) {
        console.warn('[ContentGenerator] 封面抽帧失败（ffmpeg 不可用或源视频损坏），跳过封面生成');
        return { path: null, layout: 'no_frame', retroFrom: null };
      }

      // Get cover design suggestion from LLM
      const designPrompt = `Suggest a cover design for this viral short video.

Title: ${titleInfo?.text || 'Video'}
Theme: ${segment.themeName || 'general'}

Output design JSON.`;

      let design = null;
      try {
        design = await this.ollama.generate(COVER_PROMPT, designPrompt, {
          maxTokens: 1024,
          temperature: 0.5,
          parseJson: true,
          tier: 'light', // 封面版式是小判断，走轻路由
        });
      } catch (err) {
        console.warn(`[ContentGenerator] Cover design LLM failed: ${err.message}`);
      }

      // 历史同款：找该段匹配过的爆款主题，封面设计往同款上靠
      let retroFrom = null;
      try {
        const matched = segment.matchedHitThemes || segment.matched_hit_themes;
        const arr = typeof matched === 'string' ? JSON.parse(matched) : (matched || []);
        if (arr.length) {
          arr.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0));
          retroFrom = arr[0].theme_name || null;
        }
      } catch { /* ignore */ }
      if (!retroFrom) {
        try {
          const top = (this.store.getAllHitThemes(5) || [])[0];
          retroFrom = top ? top.theme_name : null;
        } catch { /* ignore */ }
      }

      // Use ffmpeg to overlay title text on the chosen frame
      const titleText = escapeDrawtext(titleInfo?.text || 'Video');
      // 2026-09-24：固定 48 号，标题一长 text_w 就超过画面宽、x 变负被裁掉。
      // 按字数估宽，超过画宽 86% 就等比缩字号（与封面链路同一套做法）。
      const rawLen = Array.from(String(titleInfo?.text || 'Video')).reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0);
      const titleSize = Math.max(20, Math.min(48, Math.round(48 * Math.min(1, (1080 * 0.86) / Math.max(1, rawLen * 48)))));
      const fontFile = this._findFontFile();
      // fontfile 走专用转义：escapeSubtitlesPath 会把盘符的冒号转掉，字体就找不到了
      const fontParam = fontFile ? `:fontfile='${escapeFilterPath(fontFile)}'` : '';
      const drawtext = `drawtext=text='${titleText}':fontsize=${titleSize}:fontcolor=white:box=1:boxcolor=#FF6B35@0.8:x=(w-text_w)/2:y=30${fontParam}`;

      await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
        '-i', framePath,
        '-vf', drawtext,
        '-y',
        outputPath
      ]);

      // Clean up raw frame
      try {
        const { unlinkSync } = await import('fs');
        if (existsSync(framePath)) unlinkSync(framePath);
      } catch {
        // ignore cleanup errors
      }

      return {
        path: outputPath,
        layout: design?.suggested_layout || 'center_text',
        titleText: titleInfo?.text,
        retroFrom, // 历史同款主题
        colorScheme: design?.color_scheme || { background: '#000000', text: '#FFFFFF', accent: '#FF6B35' }
      };
    } catch (err) {
      console.error(`[ContentGenerator] Cover generation failed: ${err.message}`);
      return { path: null, layout: 'failed', error: err.message };
    }
  }

  /**
   * Compose final video with title overlay and subtitles.
   *
   * @param {string} clipPath
   * @param {{text?: string}|null} titleInfo
   * @param {{path?: string}|null} subtitleInfo  可为 null(字幕关闭)
   * @param {string} outputPath
   * @param {{burnTitle?: boolean}} [opts] burnTitle=false 时不烧标题,只烧字幕
   */
  /**
   * 合成最终成片：把画面处理与文字叠加一次性做完。
   *
   * 这里以前只支持"标题 + 字幕"两个叠加,界面上另外十几个开关（竖屏、
   * 冷开场、闪前、标题卡、自动变焦、BGM、音效、水印…）在后端完全没有实现,
   * 勾了不生效也不报错 —— 用户以为生效了,拿到的还是同一个片子。
   * 现在逐项落地,每项都能在成片上看出来。
   *
   * @param {object} opts
   *   burnTitle  烧标题
   *   vertical   竖屏(不竖屏时加上下黑边,而不是拉伸变形)
   *   titleCard  开头标题卡
   *   coldOpen   冷开场:前 N 秒定格首帧并叠大字
   *   flashForward 闪前:开头插一段后面出现的画面(先给结果再讲过程)
   *   autoZoom   关键帧自动推近
   *   keyframes  [{ sec, score }] 自动变焦依据(情绪/能量峰)
   *   bgmPath    背景音乐
   *   bgmVolume  BGM 音量(0~1)
   *   duckBgm    人声出现时压低 BGM
   *   sfx        爆点音效
   *   sfxAt      [sec] 音效插入点
   *   watermark  水印文字
   *   captionStyle 字幕样式: auto|none|bold|karaoke
   *   captionSize  字幕字号
   *   flashSeconds 闪前时长(秒)
   *   durationSec 粗剪时长(用于兜底计算)
   */
  async _composeFinalVideo(clipPath, titleInfo, subtitleInfo, outputPath, opts = {}) {
    if (!this.ffmpeg.isAvailable) {
      throw new Error('ffmpeg not available');
    }

    const titleText = escapeDrawtext(titleInfo?.text || '');
    const subtitlePath = subtitleInfo?.path;

    // Find a Windows font for drawtext
    const fontFile = this._findFontFile();
    // fontfile 走专用转义（escapeSubtitlesPath 是给 subtitles= 用的，两处别混）
    const fontParam = fontFile ? `:fontfile='${escapeFilterPath(fontFile)}'` : '';

    // Build filter complex: 画面处理 + 文字叠加
    //
    // 顺序有讲究：zoompan 必须排在最前。
    // 它会把每帧重采样到 s= 指定的尺寸，放后面会覆盖掉前面 crop/scale 的结果
    // （实测 404x720 却输出 1280x720）。所以它单独存，最后拼到最前面。
    const filters = [];
    const zoomFilters = [];
    const meta = await this.ffmpeg.getMetadata(clipPath).catch(() => ({}));
    // getMetadata 返回 ffprobe 的原始 JSON：{ streams: [...], format: {...} }。
    // streams 是**数组**，必须从里面挑出视频流。以前读 meta.stream.width
    // （单数）永远取不到，静默落回默认 1080x1920 —— 于是所有尺寸判断都是错的：
    // 16:9 素材被当成竖屏去裁，输出成 3414x1922 这种畸形比例。
    const vStream = (Array.isArray(meta?.streams) ? meta.streams : []).find((s) => s.codec_type === 'video');
    const w0 = Number(vStream?.width) || 1080;
    const h0 = Number(vStream?.height) || 1920;
    const dur = Number(opts.durationSec) || Number(meta?.format?.duration) || 0;

    // ── ① 竖屏 / 横屏 ────────────────────────────────────────────
    //
    // 竖屏：从宽素材裁中心而不是拉伸。拉伸会把人拉胖,这是最常见的"AI 味"来源。
    // 横屏：从竖素材加上下黑边（letterbox），同样不拉伸。
    //
    // 踩过的坑：pad 的目标尺寸不能小于输入尺寸。竖转横时如果直接
    // pad=iw:ih*9/16，而 ih*9/16 < ih，ffmpeg 报
    // "Padded dimensions cannot be smaller than input dimensions" 并整条失败。
        // 只有显式 false 才算横屏。undefined/null 都按竖屏 —— 桌面端默认出竖屏片，
    // UI 的开关永远是 true/false，不会传 null。
    const wantVertical = opts.vertical !== false;
    if (wantVertical) {
      if (w0 > h0) {
        const cropW = Math.floor((h0 * 9) / 16 / 2) * 2;
        filters.push(`crop=${cropW}:${h0}:(in_w-${cropW})/2:0`);
      } else if (w0 !== h0) {
        // 非标准比例先等比缩到能塞进 9:16，再 pad 补齐
        const targetW = Math.floor((h0 * 9) / 16 / 2) * 2;
        filters.push(`scale=${targetW}:${h0}:force_original_aspect_ratio=decrease,pad=${targetW}:${h0}:(ow-iw)/2:(oh-ih)/2:black`);
      }
    } else if (h0 > w0) {
      // 竖转横：16:9 的宽度 = 高 * 16/9。目标高必须 >= 缩放后的高。
      const targetW = Math.ceil((h0 * 16) / 9 / 2) * 2;
      const targetH = Math.ceil((targetW * 9) / 16 / 2) * 2;
      filters.push(`scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`);
    }

    // ── ② 冷开场：开头定格首帧 ──────────────────────────────────
    // 用 tpad 克隆首帧再裁,比 freeze_frame 兼容性好（老版本 ffmpeg 没有）
    const coldSec = Number(opts.coldOpenSeconds) || (opts.coldOpen ? 1.2 : 0);
    if (opts.coldOpen && coldSec > 0) {
      filters.push(`tpad=start_mode=clone:start_duration=${coldSec}`);
    }

    // ── ③ 自动变焦：按关键帧分数在能量峰处轻微推近 ────────────────
    //
    // 幅度刻意做小（1.0→1.12）。推太猛会晕，而且观众感觉得到"被 AI 处理过"。
    // 用 zoompan 的 z 表达式按时间区间控制，区间外保持 1.0（不推）。
    const kf = Array.isArray(opts.keyframes) ? opts.keyframes : [];
    if (opts.autoZoom && kf.length > 0 && dur > 0) {
      // 只取分数靠前的峰，最多 3 个；太密会变成幻灯片
      const peaks = kf
        .filter((k) => Number.isFinite(Number(k.sec)) && Number(k.sec) > 1 && Number(k.sec) < dur - 1)
        .sort((a, b) => Number(b.score) - Number(a.score))
        .slice(0, 3);
      if (peaks.length > 0) {
        // z 表达式：每个峰值区间内从 1.0 线性升到 1.12，区间外恒为 1.0
        //
        // 不用嵌套 if(gte(t,a,lt(t,b)), ...) —— 逗号会被 ffmpeg 当成滤镜分隔符，
        // 报 "No such filter: lt"。改成 multiply 累加：各区间的"推进量"相加，
        // 区间外为 0，天然等于 1.0。重叠时叠加也不会出问题。
        //
        // 另外时间变量是 in_time 不是 t（用 t 报 "Undefined constant ..."）。
        const terms = peaks.map((p) => {
          const s = Math.max(0, Number(p.sec) - 1.5);
          const e = Math.min(dur, Number(p.sec) + 1.5);
          const span = Math.max(0.5, e - s);
          return `between(in_time,${s.toFixed(2)},${e.toFixed(2)})*0.12*(in_time-${s.toFixed(2)})/${span.toFixed(2)}`;
        });
        const zoomExpr = `1+${terms.join('+')}`;
        // s= 必须是字面数字，而且要用**裁切前**的原始尺寸：
        // zoompan 会把每帧缩放到 s 指定的尺寸，所以 s 是它的输出尺寸，
        // 不是上游 crop/scale 之后的尺寸。用裁切后的值会报
        // "Error while opening encoder - maybe incorrect parameters"。
        //
        // 另外时间变量是 in_time 不是 t（用 t 报 "Undefined constant ... in 't-0.3)/1.20,1)'"）。
        //
        // 放进 zoomFilters 而不是 filters：它必须排在裁切之前，
        // 否则输出的原始尺寸会盖掉 crop 的结果（实测 404x720 变回 1280x720）。
        zoomFilters.push(
          `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w0}x${h0}:fps=25`
        );
      }
    }
    // ── ④ 标题卡 / 顶部标题：样式可配 ──────────────────────────
    //
    // 标题有两种形态，选其一（原来是这样，这里保持）：
    //   标题卡 = 只在开头 cardSec 秒出现的大字
    //   烧标题 = 全程在顶部的横幅
    // 样式（字体/字号/颜色/位置/阴影/底板）走 opts.titleFontStyle，
    // 没给就用各自的默认值 —— 默认值保持和改动前一致，别让老项目出片变形。
    const ts = opts.titleFontStyle && typeof opts.titleFontStyle === 'object' ? opts.titleFontStyle : {};
    const titleFontParam = (() => {
      const f = this._resolveFontFile(ts.font);
      return f ? `:fontfile='${escapeFilterPath(f)}'` : fontParam;
    })();
    const titleColor = /^#[0-9a-fA-F]{6}$/.test(String(ts.color || '')) ? String(ts.color) : 'white';
    const titleShadow = Number.isFinite(Number(ts.shadow)) ? Math.max(0, Number(ts.shadow)) : 0;
    // 阴影用 black@不透明度 的 box，比 drawtext 的 shadow 参数可控
    const titleShadowPart = titleShadow > 0 ? `:shadowcolor=black@${Math.min(1, titleShadow / 10).toFixed(2)}:shadowx=2:shadowy=2` : '';
    // 底板：给了颜色才加。原来是硬编码 #FF6B35@0.8，留空则完全不加。
    const titleBoxPart = (() => {
      const c = String(ts.boxColor || '#FF6B35');
      const o = Number.isFinite(Number(ts.boxOpacity)) ? Math.max(0, Math.min(1, Number(ts.boxOpacity))) : 0.8;
      return `:box=1:boxcolor=${c}@${o.toFixed(2)}:boxborderw=14`;
    })();
    /** 纵向位置：预设 + 微调。算成绝对像素，供 drawtext 的 y 用 */
    const titleY = (() => {
      const pos = String(ts.position || 'top');
      const off = Number.isFinite(Number(ts.offsetY)) ? Number(ts.offsetY) : 0;
      // 参照高度就是画面真实高度
      const hRef = h0;
      // 距离（20/40/140）要按画面高度缩放，但 hRef 本身已经是真实像素，
      // 不能再乘一遍 —— 早先写成 (hRef - 140) * scale，等于把整个画面高度
      // 又缩了一次。720x1280 的素材算出来 760，看起来在画面中间而不是底部，
      // 而界面上写着"底部"，用户根本猜不出差在哪。
      const scale = hRef / 1920 || 1;
      const offPx = Math.round(off * scale);
      if (pos === 'bottom') return Math.round(hRef - 140 * scale) + offPx;
      if (pos === 'middle') return Math.round(hRef / 2 - 40 * scale) + offPx;
      return Math.round(20 * scale) + offPx;
    })();

    const cardSec = Number(opts.titleCardSeconds) || 1.8;
    if (opts.titleCard && titleText && cardSec > 0) {
      const cardSize = Number(ts.size) > 0 ? Math.round(Number(ts.size) * (h0 / 1920 || 1)) : Math.round(64 * (h0 / 1920 || 1));
      filters.push(
        `drawtext=text='${titleText}':fontsize=${Math.max(12, cardSize)}:fontcolor=${titleColor}${titleShadowPart}:box=1:boxcolor=black@0.55:boxborderw=18:` +
        `x=(w-text_w)/2:y=(h-text_h)/2-40:enable='between(t,0,${cardSec})'${titleFontParam}`
      );
    }

    // Title overlay (top center, with colored background box)
    // 关掉标题时不能留一个空 drawtext —— 那会让 ffmpeg 找不到字体而整条失败。
    const burnTitle = opts.burnTitle !== false;
    if (burnTitle && titleText && !opts.titleCard) {
      const s36 = Number(ts.size) > 0 ? Math.round(Number(ts.size) * (h0 / 1920 || 1)) : Math.round(36 * (h0 / 1920 || 1));
      filters.push(
        `drawtext=text='${titleText}':fontsize=${Math.max(10, s36)}:fontcolor=${titleColor}${titleShadowPart}${titleBoxPart}:` +
        `x=(w-text_w)/2:y=${titleY}${titleFontParam}`
      );
    }

    // ── ⑤ 字幕：走 ASS force_style，字体/颜色/位置/描边/阴影都能配 ──
    //
    // 颜色表示法要注意：ASS 用 &HAABBGGRR（注意是 BGR 不是 RGB），
    // 直接把 "#RRGGBB" 塞进去会变成另一种颜色 —— 白(#FFFFFF) 恰好一样，
    // 所以以前只用白色时一直没暴露，换成别的颜色就会发现颜色是错的。
    const hasSubtitle = Boolean(subtitlePath && existsSync(subtitlePath));
    if (hasSubtitle) {
      const cs = opts.captionFontStyle && typeof opts.captionFontStyle === 'object' ? opts.captionFontStyle : {};
      const style = String(opts.captionStyle || 'auto');
      // 字号：旧的 captionSize 优先(向后兼容)，其次新样式里的 size
      const rawSize = Number.isFinite(Number(opts.captionSize)) && Number(opts.captionSize) > 0
        ? Number(opts.captionSize)
        : (Number(cs.size) > 0 ? Number(cs.size) : 0);
      const size = rawSize > 0 ? Math.round(rawSize * (h0 / 1920 || 1)) : 0;

      const parts = [];
      if (cs.font) parts.push(`FontName=${sanitizeAssField(cs.font)}`);
      if (size > 0) parts.push(`FontSize=${size}`);
      if (cs.bold) parts.push(`Bold=1`);
      // &HAABBGGRR
      if (/^#[0-9a-fA-F]{6}$/.test(String(cs.color || ''))) {
        parts.push(`PrimaryColour=&H${assColorFromHex(String(cs.color))}`);
        // 描边色：跟着字色走会让描边在浅色字上看不见，这里固定黑
        parts.push(`OutlineColour=&H00000000`);
      }
      // 描边：0 表示不要描边（BorderStyle=1 无边框）
      const outline = Number.isFinite(Number(cs.outline))
        ? Math.max(0, Number(cs.outline))
        : (style === 'bold' ? 3 : undefined);
      if (outline !== undefined) {
        parts.push(`BorderStyle=${outline > 0 ? 3 : 1}`);
        parts.push(`Outline=${Math.round(outline)}`);
      }
      // 阴影
      const shadow = Number.isFinite(Number(cs.shadow)) ? Math.max(0, Number(cs.shadow)) : undefined;
      if (shadow !== undefined) parts.push(`Shadow=${Math.round(shadow)}`);
      // 位置：MarginV 是距画面底部的像素，越大越靠上
      if (Number.isFinite(Number(cs.marginV)) && Number(cs.marginV) > 0) {
        parts.push(`MarginV=${Math.round(Number(cs.marginV) * (h0 / 1920 || 1))}`);
      }
      // 底部底条：BorderStyle=3 + BackColour
      if (cs.box) {
        const op = Number.isFinite(Number(cs.boxOpacity)) ? Math.max(0, Math.min(1, Number(cs.boxOpacity))) : 0.5;
        parts.push('BorderStyle=3');
        parts.push(`BackColour=&H${Math.round((1 - op) * 255).toString(16).toUpperCase().padStart(2, '0')}000000`);
      }

      if (parts.length > 0) {
        filters.push(
          `subtitles='${escapeSubtitlesPath(subtitlePath)}':force_style='${parts.join(",")}'`
        );
      } else if (style === 'bold') {
        filters.push(
          `subtitles='${escapeSubtitlesPath(subtitlePath)}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=3,Shadow=1'`
        );
      } else {
        filters.push(`subtitles='${escapeSubtitlesPath(subtitlePath)}'`);
      }
    }

    // ── ⑥ 水印 ──────────────────────────────────────────────────
    const wm = String(opts.watermark || '').trim();
    if (wm) {
      const wmText = escapeDrawtext(wm);
      filters.push(
        `drawtext=text='${wmText}':fontsize=22:fontcolor=white@0.7:box=1:boxcolor=black@0.35:` +
        `x=w-tw-24:y=h-th-24${fontParam}`
      );
    }

    const hasVideoFilter = filters.length > 0 || zoomFilters.length > 0;
    const vf = [...zoomFilters, ...filters].join(',');

    // ── 音频：BGM / 音效 ─────────────────────────────────────────
    //
    // 这两项必须走 -filter_complex 而不是 -af：BGM 要和人声混、
    // 还要在有人声时自动压低（sidechaincompress），单条 -af 表达不了。
    const bgmPath = String(opts.bgmPath || '').trim();
    const hasBgm = bgmPath && existsSync(bgmPath);
    const wantSfx = opts.sfx !== false;

    // ── 拼接素材：封面图(首帧) / 结尾藏带货 ────────────────────────
    //
    // 这两项都要走 filter_complex 才能接进正片，因为它们是**额外的输入**，
    // 而 concat 必须在滤镜图里表达（单条 -vf 只能处理一个输入）。
    //
    // 输入索引必须动态分配：0 恒是主片，BGM 可选，封面/藏带货又可选。
    // 写死索引（比如假定 BGM 一定存在）会在"没 BGM 但有封面"时
    // 静默拿错流，症状是成片开头插了一段藏带货 —— 极难看出来源。
    const coverCfg = opts.coverImage && typeof opts.coverImage === 'object' ? opts.coverImage : null;
    const coverPath = coverCfg && coverCfg.usePath ? String(coverCfg.usePath).trim() : '';
    const hasCover = Boolean(coverPath && existsSync(coverPath));
    if (coverCfg && !hasCover && coverPath) {
      console.warn(`[ContentGenerator] 封面图不存在，已忽略: ${coverPath}`);
    }

    const tailCfg = opts.tailVideo && typeof opts.tailVideo === 'object' ? opts.tailVideo : null;
    const tailPath = tailCfg && tailCfg.usePath ? String(tailCfg.usePath).trim() : '';
    const hasTail = Boolean(tailPath && existsSync(tailPath));
    if (tailCfg && !hasTail && tailPath) {
      console.warn(`[ContentGenerator] 藏带货视频不存在，已忽略: ${tailPath}`);
    }

    // 组装 ffmpeg 参数。索引在这里定下来，后面拼接链全靠它。
    const args = ['-i', clipPath];
    let inputCount = 1;
    if (hasBgm) {
      args.push('-stream_loop', '-1', '-i', bgmPath);
      inputCount++;
    }
    let idxCover = -1;
    if (hasCover) {
      // -loop 1 把静态图当视频流；-t 给时长。
      // 这两个开关必须放在 -i **之前**：放后面 ffmpeg 会当成输出时长，
      // 整条命令的行为就变了（症状是成片长度诡异）。
      const coverSec = Math.max(0.1, Math.min(10, Number(coverCfg.seconds) || 1.5));
      args.push('-loop', '1', '-t', String(coverSec), '-i', coverPath);
      idxCover = inputCount++;
    }
    let idxTail = -1;
    if (hasTail) {
      args.push('-i', tailPath);
      idxTail = inputCount++;
    }

    const chains = [];
    let audioOut = null;

    if (hasBgm) {
      const vol = Math.max(0, Math.min(1, Number(opts.bgmVolume ?? 0.22)));
      const bgmIdx = 1;
      if (opts.duckBgm !== false) {
        // 人声压低 BGM：sidechaincompress 用人声当旁路信号
        // threshold 0.03/ratio 8 是实测比较自然的档位 —— 再狠人声会显得闷
        chains.push(
          `[${bgmIdx}:a]volume=${vol},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[bgmraw]`,
          `[bgmraw][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bgmduck]`
        );
        chains.push(`[0:a][bgmduck]amix=inputs=2:duration=first:dropout_transition=0[amixout]`);
      } else {
        chains.push(`[${bgmIdx}:a]volume=${vol},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[bgmraw]`);
        chains.push(`[0:a][bgmraw]amix=inputs=2:duration=first:dropout_transition=0[amixout]`);
      }
      audioOut = '[amixout]';
    } else if (opts.bgmPath) {
      console.warn(`[ContentGenerator] BGM 文件不存在，已忽略: ${opts.bgmPath}`);
    }

    // 音效：用 ffmpeg 内建的短促提示音（不依赖外部素材文件）
    // sine 1200Hz / 0.18s，比"叮"更接近爆点提示音
    let wantSfxHere = false;
    if (wantSfx) {
      // 插入点：没给就用能量峰（挑 2 个），都不给就在 3 秒和 8 秒处
      let sfxAt = Array.isArray(opts.sfxAt) ? opts.sfxAt.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
      if (sfxAt.length === 0 && dur > 8) sfxAt = [3, 8];
      sfxAt = sfxAt.slice(0, 4);
      wantSfxHere = sfxAt.length > 0;

      if (wantSfxHere) {
        // 每个音效都要从上一步的**新标签**接着混。
        // label 必须在循环内取：放外面第二次迭代还是 amixout，
        // 而那个标签已被第一次 amix 消费（一个标签只能被引用一次），
        // ffmpeg 报 "Stream specifier 'amixout' ... matches no streams"。
        for (const at of sfxAt) {
          const ms = Math.round(at * 1000);
          const label = (audioOut || '[0:a]').replace(/^\[|\]$/g, '');
          chains.push(
            `sine=frequency=1200:duration=0.18,volume=0.35,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[sfx${ms}]`
          );
          chains.push(`[${label}][sfx${ms}]amix=inputs=2:duration=first:dropout_transition=0[amix${ms}]`);
          audioOut = `[amix${ms}]`;
        }
      }
    }

    /* ── 视频拼接：封面图(首帧) + 主片 + 藏带货(结尾) ───────────────
     *
     * 三个前提，缺一个就会出现"画面尺寸对不上/首帧一闪而过"这类怪问题：
     *  1. 所有分支必须输出**完全相同**的宽高/帧率/像素格式，
     *     concat 才肯接。封面图是任意尺寸，必须先 scale+pad 到主片规格。
     *  2. 只能取藏带货的**画面**（concat 的 a=0）。它的原声会被丢掉 ——
     *     带货片段通常配自己的音乐，混进来会和正片人声打架。
     *     音频始终是主片的，衔接才不断。
     *     副作用（有意为之）：封面帧和藏带货那几秒是**静音**的。
     *     不加 -shortest 就是为了保住这几秒 —— 加了的话音频会把视频
     *     截回主片长度，封面和藏带货被静默丢掉（而且不报错）。
     *     BGM 那边不靠 -shortest 收尾，靠 amix=duration=first 限到主片长度。
     *  3. 帧率统一成 25（和 zoompan 那边一致），否则 concat 会按第一路的
     *     帧率算时长，结尾会多出一段静止画面。
     */
    let videoOut = null;
    const FPS = 25;
    if (hasCover || hasTail) {
      // 统一到主片最终画幅。concat 要求各路宽高完全一致，
      // 所以封面图（任意尺寸）和藏带货（任意尺寸）都要先 scale+pad 到这里。
      const outW = wantVertical ? Math.floor((h0 * 9) / 16 / 2) * 2 : Math.ceil((h0 * 16) / 9 / 2) * 2;
      const outH = wantVertical ? h0 : Math.ceil((outW * 9) / 16 / 2) * 2;

      /** 归一化滤镜（不带输出标签），用于拼进某个分支 */
      const normChain = () =>
        `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,` +
        `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;

      // 主片：把原本的 -vf 链条搬进 filter_complex
      const mainChain = [...zoomFilters, ...filters];
      chains.push(`[0:v]${mainChain.length ? mainChain.join(',') + ',' : ''}${normChain()}[vmain]`);

      const parts = [];
      if (hasCover) {
        // 封面：烧标题文案在**中下位置**（用户要求）。
        // textY 是 0~1 的相对位置，0.68 ≈ 中下 —— 用相对值而不是绝对像素，
        // 这样 1080x1920 和 720x1280 的封面图位置一致。
        const textY = Math.max(0.05, Math.min(0.95, Number(coverCfg.textY ?? 0.68)));
        const size = Math.max(
          14,
          Math.round((Number(coverCfg.textSize) > 0 ? Number(coverCfg.textSize) : 46) * (outH / 1920))
        );
        const color = /^#[0-9a-fA-F]{6}$/.test(String(coverCfg.textColor || ''))
          ? String(coverCfg.textColor)
          : 'white';
        const outline = Number(coverCfg.textOutline) > 0 ? Math.round(Number(coverCfg.textOutline)) : 3;
        const scrim = Math.max(0, Math.min(0.9, Number(coverCfg.scrim ?? 0.25)));
        const coverFont = this._resolveFontFile(ts.font);
        const coverFontParam = coverFont ? `:fontfile='${escapeFilterPath(coverFont)}'` : '';
        const cvf = [normChain()];
        if (scrim > 0) {
          // 压一层暗底再写字。浅色封面上白字根本看不清，
          // 而"看不清"是出片之后才发现的那种问题。
          cvf.push(`drawbox=x=0:y=0:w=${outW}:h=${outH}:color=black@${scrim.toFixed(2)}:t=fill`);
        }
        if (titleText) {
          cvf.push(
            `drawtext=text='${escapeDrawtext(titleText)}':fontsize=${size}:fontcolor=${color}:` +
              `borderw=${outline}:bordercolor=black@0.85:` +
              `x=(w-text_w)/2:y=(h-text_h)*${textY.toFixed(3)}${coverFontParam}`
          );
        }
        chains.push(`[${idxCover}:v]${cvf.join(',')}[vcover]`);
        parts.push('[vcover]');
      }
      parts.push('[vmain]');

      if (hasTail) {
        const tvf = [normChain()];
        const label = String(tailCfg.labelText || '').trim();
        if (label) {
          const tSize = Math.max(
            12,
            Math.round((Number(tailCfg.labelSize) > 0 ? Number(tailCfg.labelSize) : 40) * (outH / 1920))
          );
          const tFont = this._resolveFontFile(ts.font);
          const tFontParam = tFont ? `:fontfile='${escapeFilterPath(tFont)}'` : '';
          tvf.push(
            `drawtext=text='${escapeDrawtext(label)}':fontsize=${tSize}:fontcolor=white:` +
              `borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=h-th-60${tFontParam}`
          );
        }
        chains.push(`[${idxTail}:v]${tvf.join(',')}[vtail]`);
        parts.push('[vtail]');
      }

      chains.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0[vcat]`);
      videoOut = '[vcat]';
    }

    const filterComplex = chains.length ? chains.join(';') : null;

    // 真的什么都不用做才复制。这里必须在算完音效之后判断 ——
    // 提前判断会把"只开音效"这种只改音频的情况误判成无需处理,
    // 结果音效被静默丢掉。
    if (!hasVideoFilter && !hasBgm && !chains.length && !hasCover && !hasTail) {
      const { copyFileSync } = await import('fs');
      copyFileSync(clipPath, outputPath);
      console.log(`[ContentGenerator] No processing requested, copied roughcut: ${outputPath}`);
      return outputPath;
    }

    // 编码器梯子：NVENC（N卡独立单元，不跟 LLM 抢 CUDA）→ QSV（核显）→ CPU x264兜底。
    // 字幕/drawtext 滤镜仍在 CPU 跑，但编码（最吃算力的部分）走硬件，1080p 能快 5~10 倍。
    const ladders = [
      ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-cq', '23'],
      ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23'],
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'],
    ];
    let lastErr = null;
    for (const enc of ladders) {
      // 没有画面滤镜时不要带 -vf，否则 ffmpeg 报 "Filtergraph ... was not defined"
      const encArgs = [...args];
      if (filterComplex) encArgs.push('-filter_complex', filterComplex);
      // 有拼接素材时画面已经在 filter_complex 里拼好了，
      // 绝不能再叠一遍 -vf（那等于对已拼好的画面又处理一次，
      // 字幕/标题会烧两次，zoompan 也会跑两遍）。
      if (hasVideoFilter && !videoOut) encArgs.push('-vf', vf);
      // 画面流：有拼接走 [vcat]，否则映射主片原始流
      encArgs.push('-map', videoOut || '0:v');
      // 关键：没有 filter_complex 时，音频必须用原始流映射（0:a:0），
      // 不能写 [0:a] —— 后者是滤镜图标签，没有滤镜图时 ffmpeg 报
      // "Output with label '0:a' does not exist in any defined filter graph"。
      encArgs.push('-map', audioOut || '0:a:0');
      encArgs.push(
        ...enc,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-y',
        outputPath
      );
      try {
        await this.ffmpeg.run(this.ffmpeg.ffmpegPath, encArgs);
        console.log(`[ContentGenerator] Composed with ${enc[1]}: ${outputPath}`);
        return outputPath;
      } catch (err) {
        lastErr = err;
        // 滤镜错误（字体打不开、drawtext/subtitles 参数写坏）换编码器也没用，
        // 以前会硬试满 3 档 × 600s 超时才回退，一次失败等于卡 30 分钟。识别出来就立刻放弃。
        const msg = String(err.message || '');
        if (/(fontfile|drawtext|subtitles|filter|Invalid data|No such filter)/i.test(msg)) {
          console.warn(`[ContentGenerator] 滤镜错误，不再试其它编码器：${msg.slice(0, 200)}`);
          throw err;
        }
        console.warn(`[ContentGenerator] Encoder ${enc[1]} failed, trying next: ${msg.slice(0, 150)}`);
      }
    }
    throw lastErr || new Error('all encoders failed');
  }

  /**
   * Find a usable TrueType font on Windows for ffmpeg drawtext.
   */
   _findFontFile() {
    // 2026-09-24：以前硬编码 C:/Windows/Fonts，系统盘不是 C、或者字体被精简掉的机器上
    // 会全部落空返回 null → drawtext 拿不到 fontfile，依赖 fontconfig（ffmpeg-static 通常没有）
    // → 成片直接失败，然后被降级成没标题没字幕的副本。改为按 SystemRoot 拼 + 多几个候选。
    return this._resolveFontFile() || null;
   }

  /**
   * 按字体名解析出一个真实的字体文件路径。
   *
   * 用户在出片选项里能挑字体,但 drawtext 只认文件路径 ——
   * 所以这里把"微软雅黑"这种显示名映射到 Fonts 目录下的实际文件。
   * 映射表覆盖常见中文字体;找不到就回退到默认候选,而不是返回 null
   * (返回 null 会让 drawtext 依赖 fontconfig,那在 ffmpeg-static 上通常没有,
   *  结果是整条成片失败)。
   *
   * @param {string} [name] 界面上的字体显示名,如 "微软雅黑"
   * @returns {string|null}
   */
  _resolveFontFile(name = '') {
    const want = String(name || '').trim();
    const root = (process.env.SystemRoot || 'C:////Windows').replace(/[\\/]+$/, '');
    // 显示名 -> 文件名。多个候选按顺序试(不同系统版本带的字体不一样)
    const FONT_MAP = {
      '微软雅黑': ['msyhbd.ttc', 'msyh.ttc'],
      '微软雅黑粗体': ['msyhbd.ttc'],
      '黑体': ['simhei.ttf'],
      '宋体': ['simsun.ttc', 'simsun.ttf'],
      '楷体': ['simkai.ttf'],
      '仿宋': ['simfang.ttf'],
      '思源黑体': ['SourceHanSansSC-Regular.otf', 'NotoSansSC-Regular.otf'],
      '苹方': ['PingFang.ttc'],
      '思源宋体': ['SourceHanSerifSC-Regular.otf', 'NotoSerifSC-Regular.otf'],
      'Arial': ['arial.ttf', 'arialbd.ttf'],
      'Times New Roman': ['times.ttf'],
      'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf'],
      'Impact': ['impact.ttf']
    };
    // 选中字体 -> 可用文件。找不到就退回通用候选(微软雅黑->黑体->Arial)
    const candidates = want
      ? [...(FONT_MAP[want] || []), ...FONT_MAP['微软雅黑'], 'arial.ttf']
      : ['msyhbd.ttc', 'msyh.ttc', 'simhei.ttf', 'simsun.ttc', 'msyh.ttf', 'arial.ttf', 'segoeui.ttf'];
    for (const n of candidates) {
      const p = `${root}/Fonts/${n}`;
      if (existsSync(p)) return p;
    }
    if (want) {
      console.warn(`[ContentGenerator] 找不到字体「${want}」，回退默认字体`);
    }
    return null;
  }

  /** 列出系统里可用的字体(界面下拉用)。读 Fonts 目录,只报认得出的 */
  listAvailableFonts() {
    const root = (process.env.SystemRoot || 'C:////Windows').replace(/[\\/]+$/, '');
    const out = [];
    try {
      for (const f of readdirSync(`${root}/Fonts`)) {
        if (/\.(ttf|ttc|otf)$/i.test(f)) out.push(f);
      }
    } catch { /* 读不到就返回空,界面下拉留空即可 */ }
    return out;
  }

  // ─── Helpers ───

  _extractSegmentText(transcript, startMs, endMs) {
    if (!Array.isArray(transcript)) return '';
    // 用“区间重叠”而非“严格包含”：跨段边界的句子以前会被两边同时丢掉，导致字幕断档。
    const text = transcript
      .filter(t => {
        const tStart = (t.start ?? t.start_ms ?? 0);
        const tEnd = (t.end ?? t.end_ms ?? tStart);
        return tStart < endMs && tEnd > startMs;
      })
      .map(t => t.text || t.word || '')
      .join(' ');
    return text;
  }

  _extractSegmentTranscript(transcript, startMs, endMs) {
    if (!Array.isArray(transcript)) return [];
    return transcript.filter(t => {
      const tStart = (t.start ?? t.start_ms ?? 0);
      const tEnd = (t.end ?? t.end_ms ?? tStart);
      return tStart < endMs && tEnd > startMs;
    });
  }

  _msToSRT(ms) {
    // SRT 要求 HH:MM:SS,mmm（毫秒 3 位）。以前按厘秒输出 2 位（如 ,12），
    // 播放器/ffmpeg 会解析错乱或丢字幕。
    ms = Math.max(0, Math.round(ms));
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const millis = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }
}

export default ContentGenerator;
