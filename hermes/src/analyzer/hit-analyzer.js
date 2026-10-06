/**
 * Hit Analyzer - 爆款视频结构拆解器
 *
 * Processes uploaded hit videos from upload/hits/:
 * 1. Extracts metadata via ffprobe
 * 2. Gets ASR transcript (from GLB output or external ASR)
 * 3. Extracts keyframes via ffmpeg
 * 4. Uses Ollama LLM to analyze structure, themes, hooks, and patterns
 * 5. Stores results in hit_videos, hit_structure, hit_themes tables
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { FFmpegHelper } from './ffmpeg-helper.js';
import { ASRHelper } from './asr-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are Hermes Video Analytics AI. You analyze short viral video transcripts to extract the creator's structural patterns, emotional arcs, and content themes.

Output strict JSON with this structure:
{
  "genre": "string - main content type (livestream_sales / tutorial / storytelling / review / emotional / comedy / other)",
  "total_duration_seconds": number,
  "structure": [
    {
      "segment_type": "hook_opening | tension_build | peak_moment | resolution_cta | outro",
      "start_seconds": number,
      "end_seconds": number,
      "description": "what happens in this segment",
      "key_text": "most impactful text snippet",
      "emotion_tag": "excitement | curiosity | urgency | trust | humor | surprise | empathy",
      "intensity": 0.0-1.0
    }
  ],
  "themes": [
    {
      "theme_name": "descriptive name in Chinese or English",
      "confidence": 0.0-1.0,
      "keywords": ["keyword1", "keyword2"],
      "related_segment_indices": [0, 1, 2]
    }
  ],
  "hook_patterns": [
    {
      "hook_text": "the exact hook phrase",
      "hook_type": "question | shock_value | story | benefit | urgency | curiosity",
      "effectiveness": 0.0-1.0
    }
  ],
  "video_title": "这条视频的标题：创作者自己起的（从口播/画面文字/文件名能看出来的就照抄），看不出来就按内容拟一个能发版的标题",
  "opening_script": "开头 3 秒的逐字文案原话（钩子原句，不要改写；听不出就取第一句）",
  "viral_points": [
    {
      "point": "这条为什么能爆的要点（一句话，可直接指导下次创作）",
      "evidence": "对应的口播原话或画面证据",
      "weight": 0.0-1.0
    }
  ],
  "on_screen_texts": [
    {
      "time_seconds": number,
      "text": "画面上出现的大字/花字/标题原文（逐字照抄，没有就别编）",
      "type": "title | caption | sticker | cta"
    }
  ],
  "cover_candidate": {
    "time_seconds": number,
    "reason": "为什么这一秒适合当封面",
    "suggested_text": "封面大字建议（8~14 字，要能勾人点进来）"
  },
  "emotion_curve": [
    {
      "start_seconds": number,
      "end_seconds": number,
      "emotion": "excitement | curiosity | urgency | trust | humor | surprise | empathy",
      "facial_expression": "这段里人物的表情/肢体状态（ smile/皱眉/手势/凑近镜头…）",
      "voice_tone": "语气（喊/悄悄话/快节奏/哽咽…）",
      "intensity": 0.0-1.0
    }
  ],
  "rhythm_analysis": {
    "pace": "fast | medium | slow",
    "speech_density": "high | medium | low",
    "key_moment_interval_seconds": number,
    "energy_curve": "rising | steady | wave | drop_then_rise"
  },
  "copywriting_patterns": [
    {
      "pattern_type": "hook | transition | urgency | cta | soft_cta | objection | social_proof | value_prop | trust",
      "text": "the exact phrase",
      "context": "surrounding 20 words",
      "effectiveness": 0.0-1.0
    }
  ]
}

Rules:
- Analyze based ONLY on the transcript text provided
- Be precise with timestamps - structure segments must cover the full video
- Identify at least 2-5 themes
- Extract 1-3 hook patterns
- Extract 3-10 copywriting patterns
- Extract 3-5 viral_points（这条为什么爆，要能直接指导下次创作，别写空话）
- on_screen_texts 只写画面上真实出现的大字/花字；口播里的画面没字就返回空数组，不要编造
- emotion_curve 要覆盖全片，每段给出表情和语气，用于后续选封面和学情绪节奏
- For teaching/knowledge content, label value-first follow invitations (follow for part 2, live practice invites) as soft_cta, not cta
- Rate effectiveness based on language impact and psychological triggers
- All text can be in Chinese or the language of the transcript`;

export class HitAnalyzer {
  constructor(ollama, store, config, hooks = {}) {
    this.ollama = ollama;
    this.store = store;
    this.config = config;
    this.hooks = hooks;
    this.ffmpeg = new FFmpegHelper();
    this.asr = new ASRHelper(config);
    this.hitsDir = config.upload?.hitsDir || join(__dirname, '..', '..', 'upload', 'hits');
    this.tempDir = config.upload?.tempDir || join(__dirname, '..', '..', 'upload', 'temp');
  }

  /**
   * 入口：同一条素材的去重锁。
   * 调度器扫到 + 用户手动点「重新分析」会同时跑两个分析，两个 Ollama 请求抢显存互相打断，
   * 表现为 fetch failed，整条素材白跑（转写+抽帧+视觉全废）。这里让重复调用复用同一个 Promise。
   * @param {string} videoPath - full path to the video
   * @returns {Promise<{hitVideoId: number, analysis: Object}>}
   */
  async analyze(videoPath) {
    this._inflight = this._inflight || new Map();
    const key = String(videoPath);
    if (this._inflight.has(key)) {
      console.warn(`[HitAnalyzer] ${basename(videoPath)} 已在分析中，复用同一次分析（避免并发抢显存）`);
      return this._inflight.get(key);
    }
    const task = this._analyzeOne(videoPath);
    this._inflight.set(key, task);
    try {
      return await task;
    } finally {
      this._inflight.delete(key);
    }
  }

  /**
   * Main entry: analyze a hit video file.
   * @param {string} videoPath - full path to the video
   * @returns {Promise<{hitVideoId: number, analysis: Object}>}
   */
  async _analyzeOne(videoPath) {
    const videoName = basename(videoPath);
    const videoId = this.store.upsertHitVideo(videoPath, {
      videoName,
      analysisStatus: 'analyzing'
    });
    // 幂等：重分析先清掉旧拆解，避免重复累积
    this.store.db.prepare('DELETE FROM hit_structure WHERE hit_video_id = ?').run(videoId);
    this.store.db.prepare('DELETE FROM hit_themes WHERE hit_video_id = ?').run(videoId);

    // Also register in video_records for FK compatibility (copywriting_patterns references video_records)
    const videoRecordId = this.store.upsertVideo(videoPath, {
      videoName,
      sourceType: 'hit',
      genre: null
    });
    // 幂等：能量峰(retention)也清掉。以前只清 structure/themes，每次重试都多插 8 条，
    // 线上已攒出 232 条重复（同一视频 40 条）。
    try {
      this.store.db.prepare('DELETE FROM retention_signals WHERE video_id = ?').run(videoRecordId);
    } catch { /* 旧库无表时忽略，_init 会建 */ }
    // 话术模式同理：以前只清 structure/themes/retention，copywriting_patterns 每次重分析都翻倍
    // （同一条素材点 3 次"重新分析"就是 3 倍话术样本，直接带偏相似度与学习权重）。
    try {
      this.store.db.prepare('DELETE FROM copywriting_patterns WHERE video_id = ?').run(videoRecordId);
    } catch { /* 同上 */ }

    console.log(`[HitAnalyzer] Analyzing hit video: ${videoName} (id=${videoId})`);

    let analysisResult = null;
    let asrResult = null;
    let metadata = {};

    try {
      // Step 1: ffprobe metadata
      if (this.ffmpeg.isAvailable) {
        try {
          metadata = await this.ffmpeg.getMetadata(videoPath);
          const format = metadata.format || {};
          const stream = (metadata.streams || []).find(s => s.codec_type === 'video') || {};
          this.store.updateHitVideo(videoId, {
            durationMs: Math.round((format.duration || 0) * 1000),
            fileSize: parseInt(format.size || 0),
            resolution: stream.width && stream.height ? `${stream.width}x${stream.height}` : null,
            fps: stream.r_frame_rate ? this._safeFps(stream.r_frame_rate) : null
          });
          console.log(`[HitAnalyzer] Metadata: ${format.duration}s, ${stream.width}x${stream.height}`);
        } catch (err) {
          console.warn(`[HitAnalyzer] ffprobe failed: ${err.message}`);
        }
      } else {
        console.warn('[HitAnalyzer] ffmpeg not available, skipping metadata extraction');
      }

      // Step 2: ASR transcript
      console.log(`[HitAnalyzer] Getting transcript...`);
      asrResult = await this.asr.getTranscript(videoPath);
      if (asrResult.transcript.length === 0) {
        console.warn(`[HitAnalyzer] No transcript available for ${videoName}`);
        const silent = !!asrResult.silent;
        this.store.updateHitVideo(videoId, {
          analysisStatus: silent ? 'skipped' : 'failed',
          analysisResult: JSON.stringify(silent
            ? { note: '未检测到可识别语音（纯音乐/静音），文本分析不适用；不重试，记忆不受影响' }
            : { error: 'No ASR transcript available' })
        });
        return { hitVideoId: videoId, analysis: null };
      }
      console.log(`[HitAnalyzer] Transcript source: ${asrResult.source}, ${asrResult.transcript.length} segments`);

      // Save ASR path
      this.store.updateHitVideo(videoId, {
        asrPath: asrResult.rawPath
      });

      // Step 3: Extract keyframes (persist under data/frames - part of permanent memory, NOT temp)
      let keyframesDir = null;
      let keyframeFiles = [];
      if (this.ffmpeg.isAvailable) {
        try {
          const framesBaseDir = join(__dirname, '..', '..', 'data', 'frames', `hit_${videoId}`);
          mkdirSync(join(framesBaseDir, 'frames'), { recursive: true });
          keyframesDir = await this.ffmpeg.extractKeyframes(videoPath, framesBaseDir, 0.3);
          const { readdirSync } = await import('fs');
          // 排除 vl_ 缩略图：缩略图也写在本目录，不过滤的话每次重分析都会叠一层前缀
          // （0001.png → vl_0001.png → vl_vl_0001.png …），几分钟就顶到 Windows 260 字符路径上限
          keyframeFiles = readdirSync(keyframesDir).filter(f => /\.png$/i.test(f) && !/^vl_/i.test(f)).sort()
            .map(f => join(keyframesDir, f));
          console.log(`[HitAnalyzer] Keyframes: ${keyframeFiles.length} frames`);
        } catch (err) {
          console.warn(`[HitAnalyzer] Keyframe extraction failed: ${err.message}`);
        }
      }

      // Step 3b: Audio energy curve (no model needed) - find loud/emotional peaks
      let energyPeaks = [];
      if (this.ffmpeg.isAvailable) {
        try {
          const curve = await this.ffmpeg.getEnergyCurve(videoPath);
          energyPeaks = this._topEnergyPeaks(curve, 8);
          for (const p of energyPeaks) {
            this.store.addRetentionSignal({
              videoId: videoRecordId,
              timeMs: p.t * 1000,
              signalType: 'audio_energy',
              value: p.db,
              confidence: 0.8,
              note: 'ebur128 loudness peak'
            });
          }
          console.log(`[HitAnalyzer] Energy peaks: ${energyPeaks.map(p => p.t + 's').join(', ') || 'none'}`);
        } catch (err) {
          console.warn(`[HitAnalyzer] Energy analysis failed: ${err.message}`);
        }
      }

      // Step 3c: Vision - let the VL model actually LOOK at keyframes (if downloaded)
      // 返回结构化结果：画面描述（喂给文本 LLM）+ 画面大字/花字 + 人物表情 + 封面候选秒
      let visual = { notes: '', onScreenTexts: [], expressions: [], coverSec: null, coverReason: '' };
      if (keyframeFiles.length > 0) {
        try {
          visual = await this._describeKeyframes(keyframeFiles);
          if (visual.notes) console.log(`[HitAnalyzer] Visual notes: ${String(visual.notes).slice(0, 120)}...`);
          if (visual.onScreenTexts?.length) console.log(`[HitAnalyzer] 画面标题 ${visual.onScreenTexts.length} 条`);
        } catch (err) {
          console.warn(`[HitAnalyzer] Vision describe failed: ${err.message}`);
        }
      }

      // Step 4: Ollama structure analysis
      console.log(`[HitAnalyzer] Running Ollama analysis...`);
      // Ollama 偶发 fetch failed（显存紧张/模型刚切走/服务瞬时没响应），直接判失败太亏：
      // 前期的转写+抽帧+视觉全白跑了。网络类错误最多重试 2 次，其余错误立即放弃。
      analysisResult = await this._analyzeWithRetry(asrResult.transcript, metadata, { energyPeaks, visualNotes: visual.notes });
      console.log(`[HitAnalyzer] Analysis complete: ${analysisResult.genre}, ${analysisResult.themes?.length || 0} themes`);

      // Step 4b: 记忆维度落库
      // 完整逐字稿必须存全文（LLM 那边可以抽样分析，但记忆不能只剩抽样，否则学不到完整话术）
      const fullText = ASRHelper.transcriptToText(asrResult.transcript);
      // 画面标题：LLM 给的优先，视觉模型抄到的补上去（去重）
      // 画面大字常是多行排版，模型会带 \n 回来；存成单行，看板展示和后续做同款封面都不会错位
    // 原来写成 /\\s*\\n\\s*/g：这是普通源码不是模板字符串，\\s 匹配的是字面"反斜杠+s"，
    // 等于这个 norm() 一直在空转，模型带回的多行画面大字原样入库。
    // 两步走：先处理模型把换行写成字面 "\n" 两个字符的情况，再压真正的换行符和连续空白。
    const norm = (s) => String(s || '')
      .replace(/\\n/g, '\n')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const onScreen = (Array.isArray(analysisResult.on_screen_texts) ? analysisResult.on_screen_texts : [])
      .map((x) => ({ ...x, text: norm(x?.text) })).filter((x) => x.text);
      for (const v of visual.onScreenTexts || []) {
        if (!onScreen.some((x) => x.text === v.text)) onScreen.push({ ...v, text: norm(v.text) });
      }
      // 封面：LLM/视觉给出候选秒 → 抓该秒画面存成封面文件，供看板预览和后续同款封面复用
      let coverFrame = null;
      const coverSec = Number(analysisResult.cover_candidate?.time_seconds) || visual.coverSec;
      if (Number.isFinite(coverSec) && coverSec >= 0 && this.ffmpeg.isAvailable) {
        try {
          const { mkdirSync } = await import('fs');
          const coverDir = join(__dirname, '..', '..', 'data', 'frames', `hit_${videoId}`);
          mkdirSync(coverDir, { recursive: true });
          const out = join(coverDir, 'cover.jpg');
          await this.ffmpeg.extractFrameAt(videoPath, coverSec, out, 720);
          coverFrame = out;
        } catch (err) {
          console.warn(`[HitAnalyzer] Cover frame capture failed: ${err.message}`);
        }
      }
      this.store.updateHitVideo(videoId, {
        analysisStatus: 'completed',
        analysisResult: JSON.stringify(analysisResult),
        genre: analysisResult.genre,
        analyzedAt: new Date().toISOString(),
        // 成功就把上一次的失败痕迹抹掉，否则重试成功后还挂着一条陈年报错
        lastError: null,
        failedAt: null,
        title: String(analysisResult.video_title || '').slice(0, 200) || null,
        openingScript: String(analysisResult.opening_script || '').slice(0, 500) || null,
        fullTranscript: fullText || null,
        viralPoints: JSON.stringify(Array.isArray(analysisResult.viral_points) ? analysisResult.viral_points : []),
        onScreenTexts: JSON.stringify(onScreen),
        coverFrame,
        coverText: String(analysisResult.cover_candidate?.suggested_text || '').slice(0, 60) || null,
        emotionCurve: JSON.stringify(Array.isArray(analysisResult.emotion_curve) ? analysisResult.emotion_curve : []),
      });
      console.log(`[HitAnalyzer] 记忆维度：标题=${analysisResult.video_title || '-'} · 要点${(analysisResult.viral_points || []).length}条 · 画面字${onScreen.length}条 · 情绪段${(analysisResult.emotion_curve || []).length} · 全文${fullText.length}字${coverFrame ? ' · 封面已存' : ''}`);

      // Store structure segments
      if (analysisResult.structure) {
        for (const seg of analysisResult.structure) {
          this.store.addHitStructure({
            hitVideoId: videoId,
            segmentType: seg.segment_type,
            startMs: Math.round(seg.start_seconds * 1000),
            endMs: Math.round(seg.end_seconds * 1000),
            durationMs: Math.round((seg.end_seconds - seg.start_seconds) * 1000),
            description: seg.description,
            keyText: seg.key_text,
            emotionTag: seg.emotion_tag,
            intensity: seg.intensity,
            keyframePath: keyframesDir || null // 该视频的关键帧目录（%04d.png），供后续封面/人工回顾用
          });
        }
      }

      // Store themes
      if (analysisResult.themes) {
        for (const theme of analysisResult.themes) {
          this.store.addHitTheme({
            hitVideoId: videoId,
            themeName: theme.theme_name,
            confidence: theme.confidence,
            keywords: theme.keywords,
            relatedSegments: theme.related_segment_indices
          });
        }
      }

      // Store copywriting patterns into existing copywriting_patterns table
      if (analysisResult.copywriting_patterns) {
        for (const cp of analysisResult.copywriting_patterns) {
          this.store.addCopywritingPattern({
            videoId: videoRecordId,
            patternType: cp.pattern_type,
            textContent: cp.text,
            effectiveness: cp.effectiveness,
            contextText: cp.context
          });
        }
      }

      // Update style profile with rhythm data
      if (analysisResult.rhythm_analysis) {
        const rhythm = analysisResult.rhythm_analysis;
        this.store.setStyleProfile('rhythm_' + analysisResult.genre, rhythm);
      }

      // Store hook patterns
      if (analysisResult.hook_patterns) {
        this.store.setStyleProfile('hooks_' + analysisResult.genre, analysisResult.hook_patterns);
      }

      console.log(`[HitAnalyzer] Stored: ${analysisResult.structure?.length || 0} segments, ${analysisResult.themes?.length || 0} themes, ${analysisResult.copywriting_patterns?.length || 0} patterns`);

      // 分析完成即自动预测播量（失败不影响主流程，调度器/手动可补）
      try {
        await this.hooks?.onCompleted?.(videoId);
      } catch (err) {
        console.warn(`[HitAnalyzer] Auto-predict skipped for ${videoName}:`, err.message);
      }

      return { hitVideoId: videoId, analysis: analysisResult };

    } catch (err) {
      console.error(`[HitAnalyzer] Analysis failed for ${videoName}:`, err.message);
      this.store.updateHitVideo(videoId, {
        analysisStatus: 'failed',
        analysisResult: JSON.stringify({ error: err.message, stack: err.stack }),
        // 记下原因和时间：以前只留一个 status='failed'，
        // 事后完全查不出是哪一步炸的（这次只能手动重跑才拿到报错）。
        lastError: String(err?.message || err).slice(0, 1000),
        failedAt: new Date().toISOString(),
      });
      throw err;
    }
  }

  /**
   * Safely parse a fraction string like "30000/1001" into a number.
   */
  _safeFps(fracStr) {
    const parts = fracStr.split('/');
    if (parts.length === 1) return parseFloat(parts[0]) || null;
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return (den && den > 0) ? num / den : null;
  }

  /**
   * 带重试的 LLM 分析：只对网络/服务瞬时错误重试（fetch failed / ECONN / timeout / 5xx），
   * 内容类错误（模型输出烂）不重试，交给内部的 repair pass 处理。
   *
   * 例外是「全空分析」：那是 repair pass 也救不回来的情况（模型两次都在写散文），
   * 但重摇一次通常就能拿到正常 JSON —— 它本质上是输出格式的运气问题，
   * 和"这条素材真的分析不了"不是一回事。所以单列出来一起重试。
   */
  async _analyzeWithRetry(transcript, metadata, extra = {}, maxRetry = 2) {
    let lastErr = null;
    for (let i = 0; i <= maxRetry; i++) {
      try {
        return await this._analyzeWithLLM(transcript, metadata, extra);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const isNet = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|socket hang up|503|502|500/i.test(msg);
        // 全空分析值得重试：repair 已经试过一次了，再整轮重摇成本远低于丢一条素材
        const isEmpty = msg.includes('未产出可用分析');
        if ((!isNet && !isEmpty) || i === maxRetry) break;
        console.warn(`[HitAnalyzer] LLM 调用失败（${msg}），${8}s 后重试 ${i + 1}/${maxRetry}…`);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    throw lastErr;
  }

  /**
   * Call Ollama to analyze transcript structure.
   */
  async _analyzeWithLLM(transcript, metadata, extra = {}) {
    const fullText = ASRHelper.transcriptToText(transcript);
    const duration = metadata.format?.duration || 0;

    // For long videos, chunk the transcript
    // 注意：中文无空格，按词数切永远切不动（几万字也只有几百“词”），必须同时看字符数。
    const maxInputWords = 3000;
    const maxInputChars = 12000;
    let textForAnalysis = ASRHelper.transcriptToTimestampedText(transcript);
    if (fullText.split(/\s+/).length > maxInputWords || fullText.length > maxInputChars) {
      const chunks = ASRHelper.chunkTranscript(transcript, 800);
      // Take first chunk, middle chunk, last chunk for a representative sample
      const sample = [
        chunks[0],
        chunks[Math.floor(chunks.length / 2)],
        chunks[chunks.length - 1]
      ].filter(Boolean).flat();
      textForAnalysis = ASRHelper.transcriptToTimestampedText(sample);
      console.log(`[HitAnalyzer] Transcript truncated for LLM (${fullText.length} → ${textForAnalysis.length} chars)`);
    }

    const userPrompt = `Analyze this viral video transcript and extract its structural patterns.

Video duration: ${Math.round(duration)} seconds
Transcript:
---
${textForAnalysis}
---
${extra.energyPeaks?.length ? `Audio energy peaks (loud/emotional moments, seconds): ${extra.energyPeaks.map(p => p.t).join(', ')}\nConsider these as candidate peak_moment anchors.\n---\n` : ''}${extra.visualNotes ? `What the video LOOKS like (from actual keyframes):\n${extra.visualNotes}\nUse this to ground segment descriptions in real visuals.\n---\n` : ''}
Please output the analysis as the specified JSON structure.`;

    // 超时放宽到 10 分钟：GPU 被别的任务占满时推理会慢很多，
    // 默认 120s 会在快出结果时把请求掐断（表现为 fetch failed），白白浪费前面的转写+抽帧
    const result = await this.ollama.generate(SYSTEM_PROMPT, userPrompt, {
      maxTokens: 4096,
      temperature: 0.3,
      parseJson: true,
      timeout: 600000
    });

    // 自修复：模型偶发输出散文式分析而非纯 JSON（线上 1314 连跪两次都是这种），
    // 用失败文本再问一次“整理成纯 JSON”，只多花一次调用，比整条重跑便宜得多
    if (typeof result === 'string') {
      console.warn('[HitAnalyzer] Non-JSON output, attempting one repair pass...');
      try {
        const repaired = await this.ollama.generate(
          '你是 JSON 整理器。只输出 JSON 对象，不要输出任何解释、前言或 markdown。结构：{"genre":"string","total_duration_seconds":number,"structure":[{"segment_type":"hook_opening|tension_build|peak_moment|resolution_cta|outro","start_seconds":number,"end_seconds":number,"description":"string","key_text":"string","emotion_tag":"string","intensity":number}],"themes":[{"theme_name":"string","confidence":number,"keywords":[],"related_segment_indices":[]}],"hook_patterns":[{"hook_text":"string","hook_type":"string","effectiveness":number}],"video_title":"string","opening_script":"string","viral_points":[{"point":"string","evidence":"string","weight":number}],"on_screen_texts":[{"time_seconds":number,"text":"string","type":"title|caption|sticker|cta"}],"cover_candidate":{"time_seconds":number,"reason":"string","suggested_text":"string"},"emotion_curve":[{"start_seconds":number,"end_seconds":number,"emotion":"string","facial_expression":"string","voice_tone":"string","intensity":number}],"rhythm_analysis":{"pace":"fast|medium|slow","speech_density":"high|medium|low","key_moment_interval_seconds":number,"energy_curve":"rising|steady|wave|drop_then_rise"},"copywriting_patterns":[{"pattern_type":"hook|transition|urgency|cta|soft_cta|objection|social_proof|value_prop|trust","text":"string","context":"string","effectiveness":number}]}',
          `将以下视频分析文本整理成上述 JSON 结构（按内容合理归纳，不要空数组凑数）：\n---\n${String(result).slice(0, 6000)}`,
          { maxTokens: 4096, temperature: 0.1, parseJson: true, timeout: 600000 }
        );
        if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
          console.log('[HitAnalyzer] Repair pass succeeded');
          return this._assertHasContent(this._normalizeAnalysis(repaired, duration));
        }
      } catch (err) {
        console.warn(`[HitAnalyzer] Repair pass failed: ${err.message}`);
      }
    }

    // Validate and normalize result
    const analysis = this._normalizeAnalysis(result, duration);
    return this._assertHasContent(analysis);
  }

  /**
   * 2026-10-05 加：分析结果必须真有内容，否则当作失败抛出去。
   *
   * 这条是为了堵一个"假成功"：
   * LLM 偶发不吐 JSON 而是写散文（线上连跪两次都是这种），
   * repair pass 再失败时，代码会带着**那个字符串**落到
   * `this._normalizeAnalysis(result, duration)`，
   * 而 _normalizeAnalysis 开头就是 `if (!raw || typeof raw !== 'object') return defaults`
   * —— 返回一个全空对象（video_title: ''、viral_points: []…）。
   * 上游 analyze() 拿到它是"没抛异常"，于是照常把 analysis_status 写成
   * completed、analyzedAt 写上时间戳，一条**内容全空的记录**就当成功入库了。
   *
   * 后果比失败更糟：
   *   - 界面上这条显示"已分析"，但标题空、爆点 0 个
   *   - 调度器 _noteOk() 记成功 → 不退避、不重试
   *   - 预测拿不到爆点，基准也学不到东西
   *   - 库里还没有错误字段，事后根本查不出它失败过
   * 实测 15 条素材里有 1 条是这样静默变空的（#15939）。
   *
   * 所以这里必须抛：抛出去 analyze() 的 catch 会置 failed，
   * 调度器也会 _noteFail() 计入退避，30 分钟后自动重来。
   *
   * structure 不算证据 —— _normalizeAnalysis 会拿时长硬造一段占位结构，
   * 它存在与否说明不了模型有没有干活。用模型真正需要产出的四样来判：
   * 标题 / 爆点 / 开头话术 / 钩子模式。
   */
  _assertHasContent(analysis) {
    const hasTitle = String(analysis?.video_title || '').trim().length > 0;
    const nPoints = Array.isArray(analysis?.viral_points) ? analysis.viral_points.length : 0;
    const nHooks = Array.isArray(analysis?.hook_patterns) ? analysis.hook_patterns.length : 0;
    const hasOpening = String(analysis?.opening_script || '').trim().length > 0;
    if (hasTitle || nPoints > 0 || nHooks > 0 || hasOpening) return analysis;
    throw new Error(
      'LLM 未产出可用分析（标题/爆点/开头话术/钩子模式全空）：' +
      `模型输出类型=${typeof analysis === 'string' ? 'string(散文)' : typeof analysis}`
    );
  }

  _normalizeAnalysis(raw, durationSeconds) {
    const defaults = {
      genre: 'other',
      total_duration_seconds: durationSeconds,
      structure: [],
      themes: [],
      hook_patterns: [],
      video_title: '',
      opening_script: '',
      viral_points: [],
      on_screen_texts: [],
      cover_candidate: null,
      emotion_curve: [],
      rhythm_analysis: {
        pace: 'medium',
        speech_density: 'medium',
        key_moment_interval_seconds: 15,
        energy_curve: 'steady'
      },
      copywriting_patterns: []
    };

    if (!raw || typeof raw !== 'object') {
      console.warn('[HitAnalyzer] LLM returned invalid JSON, using defaults');
      return defaults;
    }

    // Merge with defaults
    const result = { ...defaults, ...raw };

    // Ensure structure covers full video
    if (result.structure.length === 0 && durationSeconds > 0) {
      result.structure = [{
        segment_type: 'peak_moment',
        start_seconds: 0,
        end_seconds: durationSeconds,
        description: 'Full video analyzed as single segment (structure extraction failed)',
        key_text: '',
        emotion_tag: 'excitement',
        intensity: 0.5
      }];
    }

    // Validate segment times
    for (const seg of result.structure) {
      if (seg.start_seconds < 0) seg.start_seconds = 0;
      if (seg.end_seconds > durationSeconds) seg.end_seconds = durationSeconds;
      if (seg.end_seconds <= seg.start_seconds) {
        seg.end_seconds = Math.min(seg.start_seconds + 5, durationSeconds);
      }
    }

    return result;
  }

  /**
   * 取能量曲线上最高的几个局部峰值（去重：相邻 5s 内只留最高）。
   */
  _topEnergyPeaks(curve, topN = 8) {
    if (!curve || curve.length < 3) return [];
    const peaks = [];
    for (let i = 1; i < curve.length - 1; i++) {
      if (curve[i].db > curve[i - 1].db && curve[i].db >= curve[i + 1].db) {
        peaks.push(curve[i]);
      }
    }
    peaks.sort((a, b) => b.db - a.db);
    const picked = [];
    for (const p of peaks) {
      if (picked.length >= topN) break;
      if (picked.every(q => Math.abs(q.t - p.t) > 5)) picked.push(p);
    }
    return picked.sort((a, b) => a.t - b.t);
  }

  /**
   * 视觉理解：均匀挑最多 6 帧给 VL 模型看，重点干两件事——
   * ① 抄下画面上的大字/花字（画面标题，口播稿里没有，只能靠看）；
   * ② 抓人物表情/肢体状态（用于学情绪节奏、选封面帧）。
   * 8G 显存吃不下 1080p 原图的上万 visual tokens，先压到 480p 再送。
   * 模型未下载时 ollama.describe 返回 null，直接跳过。
   */
  async _describeKeyframes(files) {
    if (!files.length) return { notes: '', onScreenTexts: [], expressions: [] };
    // 均匀采样（原来只取首/中/尾 3 帧，画面标题出现位置不确定，容易漏）。
    // 上限 4 帧：试过 6 帧，8G 显存送完视觉再切文本模型容易 fetch failed，得不偿失。
    const want = Math.min(4, files.length);
    const picks = [];
    for (let i = 0; i < want; i++) picks.push(files[Math.round(i * (files.length - 1) / Math.max(1, want - 1))]);
    const { readFileSync, existsSync, mkdirSync } = await import('fs');
    const { join, dirname, basename } = await import('path');
    const images = [];
    for (const f of picks) {
      if (!f) continue;
      try {
        // 压到 480p 小图：visual tokens 少 4 倍，8G 卡才跑得动
        // 缩略图放独立 vl/ 子目录，不跟原始关键帧混在一起（混放会被下一轮当原帧再压一遍）
        const vlDir = join(dirname(f), '..', 'vl');
        mkdirSync(vlDir, { recursive: true });
        const small = join(vlDir, basename(f));
        if (!existsSync(small) && this.ffmpeg.isAvailable) {
          await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
            '-i', f, '-vf', 'scale=480:-2', '-y', small,
          ]);
        }
        images.push(readFileSync(existsSync(small) ? small : f).toString('base64'));
      } catch {
        try { images.push(readFileSync(f).toString('base64')); } catch { /* ignore */ }
      }
    }
    if (!images.length) return { notes: '', onScreenTexts: [], expressions: [] };
    // 注意：别在示例值里写中文说明（模型会照抄"一句话画面主体"当内容），说明放到最后一句
    const sys = '你是视频画面解读器。只看图，不联想。只输出 JSON：{"frames":[{"sec":数字或null,"on_screen_text":"画面大字原文，没有填空字符串","scene":"画面主体","expression":"人物表情或肢体状态","mood":"色调氛围"}],"cover_sec":数字或null,"cover_reason":"理由"}。要求：sec 填你估计的出现秒数（不确定填 null）；on_screen_text 必须是画面上真实可见的文字，没有就填空字符串；禁止输出解释、禁止把字段名当内容。';
    const txt = await this.ollama.describe(images,
      sys + '\n共 ' + images.length + ' 帧，按时间顺序。sec 填你估计的出现秒数（不知道填 null）。',
      { timeout: 300000 });
    let parsed = null;
    try {
      const jb = txt ? txt.match(/\{[\s\S]*\}/) : null;
      if (jb) parsed = JSON.parse(jb[0]);
    } catch { /* 视觉输出不规整就退回纯文本 */ }
    const frames = Array.isArray(parsed?.frames) ? parsed.frames : [];
    const onScreenTexts = frames
      .filter((f) => f && String(f.on_screen_text || '').trim())
      .map((f) => ({ time_seconds: Number(f.sec) || null, text: String(f.on_screen_text).trim(), type: 'caption' }));
    const expressions = frames
      .filter((f) => f && (String(f.expression || '').trim() || String(f.mood || '').trim()))
      .map((f) => ({ sec: Number(f.sec) || null, expression: String(f.expression || '').trim(), mood: String(f.mood || '').trim() }));
    const notes = frames.length
      ? frames.map((f, i) => `第${i + 1}帧：${f.scene || ''}${f.expression ? '（表情：' + f.expression + '）' : ''}${f.on_screen_text ? '（画面字：' + f.on_screen_text + '）' : ''}`).join('\n')
      : (txt || '');
    return {
      notes,
      onScreenTexts,
      expressions,
      coverSec: Number(parsed?.cover_sec) || null,
      coverReason: String(parsed?.cover_reason || '').slice(0, 200),
    };
  }

  /**
   * Scan upload/hits/ directory for new unanalyzed videos.
   */
  async scanAndAnalyze() {
    const { readdirSync } = await import('fs');
    if (!existsSync(this.hitsDir)) {
      mkdirSync(this.hitsDir, { recursive: true });
      return [];
    }

    const files = readdirSync(this.hitsDir)
      .filter(f => /\.(mp4|mov|mkv|webm|flv|avi)$/i.test(f))
      .map(f => join(this.hitsDir, f));

    const results = [];
    for (const videoPath of files) {
      // Check if already analyzed
      const existing = this.store.getHitVideo(videoPath);
      if (existing && existing.analysis_status === 'completed') {
        console.log(`[HitAnalyzer] Skip already analyzed: ${basename(videoPath)}`);
        continue;
      }

      try {
        const result = await this.analyze(videoPath);
        results.push(result);
      } catch (err) {
        console.error(`[HitAnalyzer] Failed to analyze ${videoPath}:`, err.message);
      }
    }

    return results;
  }
}

export default HitAnalyzer;
