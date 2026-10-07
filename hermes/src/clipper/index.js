/**
 * Clipper - 直播粗剪引擎
 *
 * Reads analyzed live stream segments, selects best combinations based on
 * learned hit video patterns, extracts golden 3-second hooks, and creates
 * clip projects ready for content generation.
 *
 * Workflow:
 * 1. Read live_segments for a live_video_id
 * 2. Score each segment by: theme match strength, hook quality, viral potential
 * 3. Select top segments (up to maxClipsPerLive)
 * 4. Extract hook candidates (first 3 seconds of each selected segment)
 * 5. Create clip_project with selected segments
 * 6. If uncertain, create user_queries and pause
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { FFmpegHelper } from '../analyzer/ffmpeg-helper.js';
import { ASRHelper } from '../analyzer/asr-helper.js';
import { isInteractionSentence } from '../analyzer/sentence-cutter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOK_EXTRACT_PROMPT = `You are a viral video hook expert. Given a transcript segment (first 3-5 seconds), determine if it has a strong opening hook and how to improve it.

Output strict JSON:
{
  "has_hook": true | false,
  "hook_type": "question | shock_value | story | benefit | urgency | curiosity | none",
  "hook_quality": 0.0-1.0,
  "suggested_hook_text": "improved opening line (optional)",
  "notes": "brief analysis"
}`;

const SEGMENT_SELECTION_PROMPT = `你是一位专为【声乐教学直播】剪爆款短片的资深剪辑师。下面给你一场直播的全部分段（每段含主题、摘要、钩子分、传播分），以及本主播历史爆款总结出的选段标准。请挑出最能组合成爆款短片的段。

选段硬规则（违反任何一条都算选错）：
1.【运营话术段一票否决】主要内容为 预约直播/点亮灯牌/加粉丝团/私我/扣1/刷礼物/加微信/挑战群/欢迎进直播间 的段，一律不选——这些是直播运营动作，不是观众想看的内容。
2.【教学主体优先】优先选有实操价值的段：现场示范、逐句教唱、学员纠错、技巧拆解（气息/混声/共鸣/关闭唱法/高音等）、成果对比。教学密度越高越优先。
3.【爆款开头】开头段必须有强钩子：反常识观点、成果先亮出来、学员翻车、一句话颠覆认知。
4.【完整可看】每条成片 = 强钩子开场 → 内容推进 → 自然收尾，段与段连着看不能断。
5.【宁缺毋滥】没有合格的段就少选，绝不允许拿运营段、寒暄段、水段凑数。
6.【时长】每条成片 30-90 秒。

输出严格 JSON（不要任何解释文字）：
{
  "selected_segment_ids": [1, 5, 8, 12],
  "reasoning": "简述选段策略",
  "uncertainties": [
    {
      "segment_id": 5,
      "question": "针对某段的确认问题",
      "options": ["选项A", "选项B"]
    }
  ],
  "confidence": 0.0-1.0
}`;

/**
 * 直播运营话术词表（段级过滤用）。
 * 按老板 2026-09-26 在 sentence-cutter.js 里定的口径分三档：
 *   hard  —— 导流交易型：预约下期 / 灯牌 / 粉丝团 / 刷礼物 / 私我 / 出片订单 / 挑战群 / 加微信 / 扣1
 *            命中一次就说明这段在"要东西"，直接剔除。
 *   soft  —— 需要看密度：连续要订单、催单发货这类，单独一句不算，扎堆才算。
 *   keep  —— 氛围型：点亮小红心 / 关注 / 点赞 / 评论 / 转发 / 收藏。
 *            老板明确要留——直播间人设和真实感靠它们，不能一刀切。
 */
const OP_HARD = ['预约', '灯牌', '粉丝团', '刷礼物', '刷个礼物', '礼物刷起来', '礼物走起来',
  '扣1', '扣个1', '打个1', '私我', '私信我', '加我微信', '加微信',
  '出品订单', '出片订单', '挑战群', '七天挑战', '小黄车', '下单', '发货'];
const OP_SOFT = ['导购', '优惠券', '限时', '名额有限', '今天仅此一次', '原价', '秒杀'];
/*
 * 【2026-10-05 口径变更，老板明确要求】
 *
 * 原来这里是 OP_KEEP = ['点亮小红心','点点关注','点个赞','收藏','转发','评论区']，
 * 理由是"直播间人设和真实感靠互动氛围撑着，不能一刀切"。
 * **老板现在明确要求：这些必须剪掉。**
 *
 * 所以互动引导话术从"保留"改为"剔除"。保留列表保留为空 —— 需要留的话
 * 往 data/clip-rules.json 的 keepPhrases 里加，不用改代码。
 */
const OP_KEEP = [];
// 句级额外剔除项（sentence-cutter 的历史词表里有、段级表没有的）：
// 无教学信息的寒暄与开场白。
const OP_SENTENCE_EXTRA = ['进直播间', '欢迎来到直播间', '欢迎新来的', '欢迎刚来的'];

/**
 * 剔除规则（可编辑）——读 data/clip-rules.json。
 *
 * 为什么做成文件而不是写死在代码里：
 * 每个老师的直播话术都不一样，"双击屏幕"在别的直播间叫"点一下右边的love"。
 * 写死在代码里就得改代码重新打包；而这只是一串词，放文件里最省事：
 * 用户自己改 → 下次出粗剪就生效。
 *
 * 文件缺失/写坏都必须**退回内置默认**，不能让粗剪整个挂掉 ——
 * 这条链路是出片的必经步骤。
 */
const DEFAULT_CLIP_RULES = {
  enabled: true,
  dropPhrases: [...OP_HARD, ...OP_SENTENCE_EXTRA],
  greetingPatterns: [],
  keepPhrases: OP_KEEP,
  requireNoTeachingSignalForGreeting: true,
  minKeepAfterCutMs: 8000
};

let _clipRulesCache = null;
/** @returns {typeof DEFAULT_CLIP_RULES} */
function loadClipRules() {
  if (_clipRulesCache) return _clipRulesCache;
  const r = { ...DEFAULT_CLIP_RULES };
  try {
    const p = join(__dirname, '..', '..', 'data', 'clip-rules.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const str = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : null);
      if (typeof raw.enabled === 'boolean') r.enabled = raw.enabled;
      /*
       * 剔除词 = 内置默认 + 文件里加的，**取并集而不是覆盖**。
       *
       * 原来这里是"文件里有就用文件里的"，于是用户往 dropPhrases 里加一句话词，
       * 内置的 `私我 / 预约 / 加微信 / 小黄车` 就**全丢了** —— 防护网被自己拆掉。
       * 而且这个坑很难发现：用户只是加了个词，导流话术就悄悄不剪了。
       *
       * 合并之后：内置那套始终兜底，用户只管往上加。
       * 要删某个内置词仍需改这里，但那是少数情况，且有注释标着。
       */
      r.dropPhrases = [...new Set([...r.dropPhrases, ...(str(raw.dropPhrases) || [])])];
      r.greetingPatterns = [...new Set([...(str(raw.greetingPatterns) || [])])];
      // keepPhrases 允许显式给空数组（那就是"什么都不留"），所以不合并
      if (Array.isArray(raw.keepPhrases)) r.keepPhrases = raw.keepPhrases.filter((x) => typeof x === 'string');
      if (typeof raw.requireNoTeachingSignalForGreeting === 'boolean') {
        r.requireNoTeachingSignalForGreeting = raw.requireNoTeachingSignalForGreeting;
      }
      if (Number(raw.minKeepAfterCutMs) > 0) r.minKeepAfterCutMs = Number(raw.minKeepAfterCutMs);
    }
  } catch (err) {
    console.warn(`[Clipper] clip-rules.json 读取失败，用内置默认规则：${err.message}`);
  }
  _clipRulesCache = r;
  return r;
}

/** 供测试/接口读取当前生效的规则 */
export function getClipRules() {
  return { ...loadClipRules() };
}

/** 热词式刷新：用户在界面上改了规则后调用，不必重启进程 */
export function reloadClipRules() {
  _clipRulesCache = null;
  return loadClipRules();
}

/** 反爬变体：主播常把敏感词拆开念（"私\我\开\出\品\订\单"），剥离分隔符后再匹配 */
function normalizeVariant(text) {
  return String(text || '').replace(/[\\/|·・\s]/g, '');
}

/**
 * 教学信号词（确定性识别，不靠 LLM 猜）。
 * 来自 data/clip-standard.json 的 teaching_signals——那份标准是 DeepSeek 从你的爆款里
 * 学出来的，写得很准；缺的是"代码里没用"。这里把它落成规则：
 * 命中越多 = 这段实操密度越高，越该优先选。
 */
const TEACHING_SIGNALS = [
  { name: '指令+示范', re: /(看着我|看这里|听一下|来一遍|再来一遍|往下听|跟我唱|跟着我|来试试|你听)/, w: 1 },
  { name: '纠错对比', re: /(不对|错了|你这是在|这是错的|很多人|误区|别再|而不是)/, w: 1 },
  { name: '逐字拆解', re: /(这个字|字头|字腹|字尾|前鼻音|后鼻音|开口音|闭口音|翘舌|平舌|归韵|咬字|吐字)/, w: 1.2 },
  { name: '生活类比', re: /(就像|像.{0,6}一样|打个比方|想象一下|打喷嚏|走路|穿衣服)/, w: 0.8 },
  { name: '跟练步骤', re: /(第一步|第二步|第三步|来三组|每天十组|十组到二十组|再来一次)/, w: 1 },
  { name: '歌曲示范', re: /(《[^》]{2,12}》)/, w: 0.6 },
  { name: '体感引导', re: /(手放在|放在鼻|放在你的|感受.{0,4}振动|感觉到|笑肌|抬起来|撑开)/, w: 1 },
  { name: '口诀总结', re: /(记住一句话|总结|口诀|公式|记住.{0,6}就|咬住.{0,4}拉开)/, w: 0.9 },
  { name: '声乐术语', re: /(混声|声带|关闭唱法|共鸣|气息|假声|真声|头声|咽音|横膈膜|哼鸣|鼻咽腔|位置|关闭)/, w: 1.1 },
];

/**
 * 成片时长档位（秒）。
 * 为什么要有档位：以前提示词里写死「每条 30-90 秒」，而 targetClipDurationMs 定义了从不使用，
 * 结果成片多长完全取决于模型心情。老板的爆款素材本身横跨 0.8~15 分钟四个量级，
 * 一刀切的平均数没有意义——时长必须由「这条片讲多大的选题」决定。
 * 档位值来自老板 15 条爆款实测时长的自然分布：
 *   0.8~0.9 分 / 3.7~4.4 分 / 6.3~8.8 分 / 11~15 分。
 */
const DURATION_PRESETS = {
  point:   { target: 50,  min: 30,  max: 90,   label: '单条成片' },
  compare: { target: 240, min: 180, max: 300,  label: '课程+对比' },
  song:    { target: 480, min: 360, max: 600,  label: '完整课程' },
  lesson:  { target: 780, min: 660, max: 960,  label: '长公开课' },
};

export class Clipper {
  constructor(ollama, store, config) {
    this.ollama = ollama;
    this.store = store;
    this.config = config;
    this.ffmpeg = new FFmpegHelper();
    this.maxClips = config.clipper?.maxClipsPerLive || 10;
    this.minHookQuality = config.clipper?.minHookQuality || 0.6;
    this.targetDuration = config.clipper?.targetClipDurationMs || 60000;
    this.draftDir = config.output?.draftDir || join(__dirname, '..', '..', 'output', 'draft');
    this.duration = this._resolveDurationProfile(config);
  }

  /**
   * 解析成片时长画像。优先级：显式秒数 > 档位 > 默认 point。
   * 允许 opts 覆盖（看板可按当次选题临时改，不落配置）。
   * @returns {{target:number,min:number,max:number,label:string,source:string}}
   */
  _resolveDurationProfile(config = this.config, opts = {}) {
    const c = config?.clipper || {};
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const explicit = n(opts.targetClipDurationSec ?? c.targetClipDurationSec);
    const presetKey = String(opts.durationPreset ?? c.durationPreset ?? 'point').toLowerCase();
    const preset = DURATION_PRESETS[presetKey] || DURATION_PRESETS.point;
    const target = explicit ?? preset.target;
    // 单段上下限：显式配置最优先。
    // 用档位时按 target 推导再被档位边界兜住（保证 point 档不会冒出 5 分钟的段）；
    // 显式指定秒数时围绕 target 推导（0.6~1.25 倍），此时档位边界反而会把区间撑得太宽。
    const min = n(c.clipDurationMinSec)
      ?? (explicit != null ? Math.round(target * 0.6) : Math.round(Math.min(preset.min, target * 0.6)));
    const max = n(c.clipDurationMaxSec)
      ?? (explicit != null ? Math.round(target * 1.25) : Math.round(Math.max(preset.max, target * 1.25)));
    return {
      target,
      min,
      max,
      label: preset.label,
      presetKey,
      source: explicit ? '显式秒数' : `档位 ${presetKey}`,
    };
  }

  /**
   * Create a clip project from an analyzed live video.
   * @param {number} liveVideoId
   * @param {Object} opts - { feedback: string[] (用户历史意见，必须遵守), excludeSegmentIds: number[] }
   * @returns {Promise<{projectId: number, segments: Array, pendingQueries: Array}>}
   */
  async createProject(liveVideoId, opts = {}) {
    const liveVideo = this.store.getLiveVideoById?.(liveVideoId) || this.store.getVideoById?.(liveVideoId);
    if (!liveVideo) {
      throw new Error(`Live video not found: ${liveVideoId}`);
    }

    const videoName = basename(liveVideo.video_path || '');
    console.log(`[Clipper] Creating project for live video: ${videoName}`);

    // 2026-09-30 用户已在界面上明确勾选片段时,直接用它的选段建工程。
    //
    // 为什么必须短路:下面的自动选段会做"逐句剔除运营话术",一旦判空
    // 就直接 throw。而用户的勾选恰恰说明"这几段我要",让模型再否决一次
    // 既不合理也拦死了整条流程(表现:界面选好了,出片永远失败)。
    if (Array.isArray(opts.presetSegments) && opts.presetSegments.length) {
      const videoPath = liveVideo.video_path;

      // 用户勾选路径也要支持"爆款开头前置"。
      // 不加的话,只有自动选段那条路有前置,用户手动挑反而没有 —— 行为不一致。
      const allSegs = this.store.getLiveSegmentsByVideo(liveVideoId) || [];
      const openingPlan = this._planViralOpening({
        allSegments: allSegs,
        picked: [],
        ruleText: opts.openingText || '',
        forcedSegmentId: opts.forcedOpeningSegmentId ?? null,
        enabled: opts.viralOpening !== false,
        maxSeconds: Number(opts.viralOpeningSeconds) || 15
      });

      const toRow = (s, role) => ({
        segmentId: s.id || s.segment_index,
        startMs: Number(s.startMs ?? s.start_ms ?? 0),
        endMs: Number(s.endMs ?? s.end_ms ?? 0),
        themeName: s.theme_name || s.themeName || '',
        role,
        hookQuality: Number(s.hook_quality ?? s.hookQuality ?? 0.5),
        cuts: Array.isArray(s.cuts) ? s.cuts : undefined,
        viralOpening: Boolean(s._viralOpening)
      });

      // 丢掉零长/反向段。
      //
      // 自动选段那条路在写库前已经过滤过一次，所以这里原本没事。
      // 但打回重建走的是 presetSegments，带进来的是老工程里存的历史段，
      // 其中混着零长段（endMs == startMs）—— ffmpeg 切零长会出黑帧，
      // 审片台上点开就是一段黑。实测打回后新工程里带着 8 个。
      const usable = opts.presetSegments.filter((s) => {
        const a = Number(s.startMs ?? s.start_ms ?? 0);
        const b = Number(s.endMs ?? s.end_ms ?? 0);
        if (b > a) return true;
        console.log(`[Clipper] 丢弃零长段 #${s.id ?? s.segment_index}（${a}~${b}）`);
        return false;
      });

      const selected = usable.map((s) => toRow(s, s.role || 'body'));
      if (!selected.length) {
        throw new Error('打回的段落全是零长段（起止时间相同），没有可以剪出来的内容。请重新分析这场直播再审一次。');
      }
      if (openingPlan.prepend) {
        selected.unshift(toRow(openingPlan.prepend, 'hook'));
        console.log(
          `[Clipper] 爆款开头前置：${openingPlan.reason} → Segment ${openingPlan.prepend.id ?? openingPlan.prepend.segment_index}（${openingPlan.takenSec}s）`
        );
      } else if (openingPlan.enabled) {
        console.log(`[Clipper] 爆款开头前置：未找到合适的开头（${openingPlan.reason}）`);
      }

      // 2026-09-30 按目标时长裁剪。
      //
      // 不加这一步,presetSegments 路径会完全跳过 _trimToTargetDuration,
      // 于是"50 秒档"和"8 分钟档"产出完全一样的内容 ——
      // 多版本就退化成了"同一个文件复制三份",用户挑不出任何区别。
      // 片头段永远保留(它是用户要的开头),只裁正文。
      if (opts.durationPreset || opts.targetClipDurationSec) {
        const dur = this._resolveDurationProfile(this.config, opts);
        const hookIdx = selected.findIndex((s) => s.role === 'hook');
        const hookId = hookIdx >= 0 ? selected[hookIdx].segmentId : null;
        // 补段池 = 全场里还没被选中的段。
        // 传空数组的话,"时长不足自动补足"永远不生效 ——
        // 8 分钟档却只出 4 分钟内容,用户看到的是"多版本其实没区别"。
        const chosenIds = new Set(selected.map((s) => s.segmentId));
        const pool = (allSegs || [])
          .filter((s) => !chosenIds.has(s.id ?? s.segment_index))
          .map((s) => ({ ...s, startMs: Number(s.start_ms ?? 0), endMs: Number(s.end_ms ?? 0) }));

        const before = selected.length;
        this._trimToTargetDuration(selected, dur, { forcedHookId: hookId, pool });
        // 裁完开头段被误删就补回来(它不计入时长预算)
        if (hookIdx >= 0 && !selected.some((s) => s.role === 'hook')) {
          const hook = opts.presetSegments.find((s) => openingPlan.prepend && s.id === openingPlan.prepend.id);
          if (hook) selected.unshift(toRow(openingPlan.prepend, 'hook'));
        }
        if (selected.length !== before) {
          console.log(`[Clipper] 多版本时长裁剪 ${dur.label}(${dur.target}s)：${before} 段 → ${selected.length} 段`);
        }
      }

      const draftDir = join(this.config.output?.draftDir || '', `project_pending`);
      mkdirSync(draftDir, { recursive: true });
      const projectId = this.store.createClipProject({
        liveVideoId,
        projectName: `Clip_${videoName}_${Date.now()}`,
        status: 'clipping',
        selectedSegments: selected
      });
      // 真实输出目录按 projectId 定,跟自动路径保持一致
      const dir = join(this.config.output?.draftDir || '', `project_${projectId}`);
      mkdirSync(dir, { recursive: true });
      try {
        this.store.db
          .prepare('UPDATE clip_projects SET output_path = ? WHERE id = ?')
          .run(dir, projectId);
      } catch { /* output_path 可后续补,不影响渲染 */ }
      console.log(`[Clipper] Project ${projectId} created from ${selected.length} segments (auto-select skipped, video=${videoPath})`);
      return { projectId, pendingQueries: [], usedUserSelection: true, viralOpening: openingPlan.prepend ? openingPlan.reason : null };
    }

    // 成片时长档位：opts 可临时覆盖（看板按当次选题改），不落配置文件。
    // 2026-09-28：以前提示词写死 30-90 秒且 targetClipDurationMs 从不生效，
    // 成片多长全看模型心情。现在目标时长一路贯穿到选段提示词和最终裁剪。
    const duration = this._resolveDurationProfile(this.config, opts);
    console.log(`[Clipper] 成片时长目标 ${duration.target}s（${duration.label} · ${duration.source}），单段 ${duration.min}-${duration.max}s`);

    // Read all segments for this live video
    let segments = this.store.getLiveSegmentsByVideo(liveVideoId);
    if (!segments || segments.length === 0) {
      throw new Error(`该直播还没有可用分段（转写可能为空或主题分析失败），请先点“重新分析”，成功出现分段数后再粗剪`);
    }

    // 打回意见：剔除用户明确不要的段
    const exclude = new Set([...(opts.excludeSegmentIds || []), ...this._rejectedSegmentIds(liveVideoId)]);
    if (exclude.size > 0) {
      const before = segments.length;
      segments = segments.filter(s => !exclude.has(s.id));
      console.log(`[Clipper] Excluded ${before - segments.length} user-rejected segments`);
    }
    // 运营话术段一票否决：整段以预约/灯牌/粉丝团/私我/扣1/挑战群等运营引导为主的直接剔除。
    // 2026-09-27 修：原来过滤只读 seg.summary（字段名笔误，DB 里叫 transcript_summary），
    // 等于这层保护从来没生效过；现在按时间窗把逐字稿原文切到每段上做真实判定。
    const segTexts = await this._loadSegmentFullTexts(liveVideo, segments);
    const opDropped = [];
    {
      const opBefore = segments.length;
      segments = segments.filter((s) => {
        const t = segTexts.get(s.id) || '';
        const drop = this._isOperationHeavySegment(s, t);
        if (drop) opDropped.push({ id: s.id, theme: s.theme_name || '(无主题)' });
        return !drop;
      });
      console.log(`[Clipper] 运营话术段过滤：剔除 ${opBefore - segments.length} 段` +
        (opDropped.length ? ` → ${opDropped.slice(0, 5).map((d) => `#${d.id}《${String(d.theme).slice(0, 14)}》`).join('、')}${opDropped.length > 5 ? ` 等 ${opDropped.length} 段` : ''}` : ''));
    }
    if (segments.length === 0) {
      throw new Error('所有分段都被你的历史意见排除了，换个直播或放宽要求再试');
    }

    // 教学密度：把"这段有多少实操"变成确定性的分，喂给选段模型。
    // 以前模型只能看到主题名（还常常是"待分类"）+ 摘要，等于凭感觉猜，
    // 这就是"为什么选不出有教学价值的内容"——它没有可判断的依据。
    let teachRank = [];
    {
      const scored = segments.map((s) => {
        const r = this._scoreTeachingSignals(segTexts.get(s.id) || '');
        return { id: s.id, theme: s.theme_name || '(无主题)', ...r };
      });
      teachRank = scored.sort((a, b) => b.score - a.score).slice(0, 5);
      // 得分挂回原对象，供 _llmSelectSegments 用
      const byId = new Map(scored.map((x) => [x.id, x]));
      for (const s of segments) {
        const r = byId.get(s.id);
        s._teachingScore = r ? r.score : 0;
        s._teachingHits = r ? r.hits : [];
      }
      console.log(`[Clipper] 教学密度 TOP5：${teachRank.map((t) => `#${t.id}《${String(t.theme).slice(0, 12)}》${t.score}`).join('  ')}`);
    }

    // 用户历史意见（本场 + 全局经验），LLM 选择时必须遵守
    const pastFeedback = this.store.getFeedbackByLive?.(liveVideoId, 10) || [];
    const lessons = this.store.getReviewLessons?.() || [];
    const feedbackBlock = [...pastFeedback.map(f => f.comment), ...(opts.feedback || [])]
      .filter(Boolean).slice(-8);
    console.log(`[Clipper] ${segments.length} segments available`);

    // ★ 记忆硬约束：从历史评审意见里解析"指定开头《…》"，在全场分段中定位对应时间点，
    // 强制作为成片第一段。原实现只把这类意见拼进提示词当"建议"，模型完全可以忽略，
    // 结果就是"用户明确指定了开头，成片开头仍是随机段"。
    const openingRule = this._resolveOpeningRule(liveVideoId, feedbackBlock, lessons);
    const forcedSeg = openingRule.text ? this._locateOpeningSegment(segments, openingRule.text) : null;
    const forcedSegId = forcedSeg ? (forcedSeg.id ?? forcedSeg.segment_index) : null;
    if (openingRule.text) {
      console.log(`[Clipper] 记忆指定开头《${openingRule.text}》→ ${forcedSeg ? `已定位 Segment ${forcedSegId}（${Math.round((forcedSeg.start_ms || 0) / 1000)}s）` : '本场分段未定位到，降级为提示词约束'}`);
    }

    // Score and select segments
    const scoredSegments = this._scoreSegments(segments, { forcedSegmentId: forcedSegId });
    console.log(`[Clipper] Segments scored, top score: ${scoredSegments[0]?.compositeScore?.toFixed(2) || 'N/A'}`);

    // 2026-09-26（需求③）：弃段教训参与挑选——老板在审阅台"不选"过的内容，
    // 再次出现时（按《标题》或弃段正文关键词匹配 transcript_summary）直接降权，
    // 让"一切文本逻辑结构学习爆款记忆"里的弃段偏好真正生效。
    try {
      const lessons = (this.store.getReviewLessons?.() || []).map(l => l.text || '');
      const kws = [];
      for (const t of lessons) {
        if (!t.includes('不要') && !t.includes('弃段') && !t.includes('打回')) continue;
        const body = t.match(/——\s*"(.+?)"/); if (body) kws.push(body[1].slice(0, 14));
        const title = t.match(/《(.+?)》/); if (title) kws.push(title[1].slice(0, 14));
      }
      if (kws.length) {
        let demoted = 0;
        for (const seg of scoredSegments) {
          const hay = String(seg.transcript_summary || '') + String(seg.theme_name || '');
          if (kws.some(k => k && hay.includes(k))) { seg.compositeScore = (seg.compositeScore || 0) * 0.5; demoted++; }
        }
        if (demoted) console.log(`[Clipper] 弃段教训降权 ${demoted} 段（关键词 ${kws.length} 个）`);
      }
    } catch (err) { console.warn('[Clipper] 弃段教训降权失败（不阻塞）:', err.message); }


    // Use LLM to help with selection if we have enough segments
    let selectedIds = [];
    let uncertainties = [];
    let selectionConfidence = 0.8;

    // 记忆信号判定：有主题命中、或有历史评审意见/经验、或已定位到"指定开头"时，
    // 都应让 LLM 参与选段。原实现只认 themeMatch>0 —— 于是"用户明明给了意见、
    // 但该场主题没命中爆款库"的情况下会直接跳过 LLM，用户意见被无声丢弃。
    const hasMemorySignal = scoredSegments.some(s => (s.maxThemeSim || 0) > 0.05)
      || feedbackBlock.length > 0
      || lessons.length > 0
      || forcedSegId != null;
    if (!hasMemorySignal) {
      console.log('[Clipper] No memory match signal, skipping LLM selection (heuristic only, low confidence)');
      selectedIds = this._heuristicSelect(scoredSegments);
      selectionConfidence = 0.45;
    } else if (segments.length > 3 && this.ollama) {
      try {
        const llmResult = await this._llmSelectSegments(scoredSegments, {
          feedbackBlock,
          lessons,
          forcedSegmentId: forcedSegId,
          openingText: openingRule.text || '',
          duration
        });
        selectedIds = this._mapSelectedIds(llmResult.selected_segment_ids, segments, scoredSegments);
        uncertainties = llmResult.uncertainties || [];
        selectionConfidence = llmResult.confidence || 0.8;
        console.log(`[Clipper] LLM selected ${selectedIds.length} segments, confidence: ${selectionConfidence}`);
      } catch (err) {
        console.warn(`[Clipper] LLM selection failed: ${err.message}, falling back to heuristic`);
        selectedIds = this._heuristicSelect(scoredSegments);
      }
    } else {
      selectedIds = this._heuristicSelect(scoredSegments);
    }
    // LLM 实在没选中（或返回的全是无效 id）时回退到启发式，保证永远有片可剪
    if (selectedIds.length === 0) {
      console.warn('[Clipper] LLM selection empty/invalid, falling back to heuristic');
      selectedIds = this._heuristicSelect(scoredSegments);
    }

    // ★ 记忆兜底：不管 LLM 有没有听话，记忆里指定的开头段必须入选（记忆不能被模型覆盖）
    if (forcedSegId != null && !selectedIds.includes(forcedSegId) && segments.some(s => (s.id ?? s.segment_index) === forcedSegId)) {
      console.warn(`[Clipper] LLM 未选中指定开头段 ${forcedSegId}，按记忆硬约束强制加入`);
      selectedIds = [forcedSegId, ...selectedIds.filter(id => id !== forcedSegId)].slice(0, this.maxClips);
    }

    // Get selected segment objects
    const picked = segments.filter(s => selectedIds.includes(s.id || s.segment_index));
    console.log(`[Clipper] Selected ${picked.length} segments`);

    // ★ 爆款开头前置（2026-09-30）
    //
    // 需求原话:"指定开头要能找到并前置"。现在只有 forcedHookId 一条路,
    // 而它依赖"评审意见里恰好写了这句",没写就退化成"选中的段里钩子最强的当开头" ——
    // 那不是前置,那只是排序。
    //
    // 真正要做的事:从全场(含未选中的段)里挑出最适合做爆款开头的那一段,
    // 剪到指定长度,前置到成片最前面。挑不到就用用户指定的,再挑不到就不前置。
    const openingPlan = this._planViralOpening({
      allSegments: segments,
      scored: scoredSegments,
      picked,
      ruleText: openingRule.text,
      forcedSegmentId: forcedSegId,
      enabled: opts.viralOpening !== false,
      maxSeconds: Number(opts.viralOpeningSeconds) || 15
    });
    if (openingPlan.prepend) {
      picked.unshift(openingPlan.prepend);
      console.log(
        `[Clipper] 爆款开头前置：${openingPlan.reason} → Segment ${openingPlan.prepend.id ?? openingPlan.prepend.segment_index}` +
          `（${Math.round(openingPlan.prepend.start_ms / 1000)}s 处，取 ${openingPlan.takenSec}s）`
      );
    } else if (openingPlan.enabled) {
      console.log(`[Clipper] 爆款开头前置：未找到合适的开头（${openingPlan.reason}），按原顺序出片`);
    }

    // 角色分配 + 成片排序：hook 开头（记忆指定的开头优先，其次钩子最强）→ 正文按时间 → closer 收尾
    const selectedSegments = this._assignRoles(picked, { forcedHookId: forcedSegId });
    console.log(`[Clipper] Order: ${selectedSegments.map(s => `${s.role}:${s.theme_name}`).join(' → ')}`);

    // 2026-09-27（老板指令①：逐字逐句剔除）——把每段按逐句稿拆开，运营互动句
    //（预约/灯牌/粉丝团/私我/扣1/挑战群/进直播间…）整句剔除，剩下的连续内容合并成子区间存进 seg.cuts。
    //
    // 二次修（同日）：旧实现在"剔完剩不到 40% 时整段原样保留"，等于那段运营话术
    // 原封不动进了成片——这正是"预约直播/点亮灯牌总被选上"的漏网路径。
    // 按老板口径改成：能剔多少剔多少，剔完不够最短时长就把这段判为不可用，
    // 而不是退回带脏话术的原段。宁缺毋滥。
    let rejectedBySentence = [];
    try {
      let sentences = [];
      const asrPath = liveVideo.asr_path;
      if (asrPath && existsSync(asrPath)) {
        const j = JSON.parse(readFileSync(asrPath, 'utf-8'));
        const list = Array.isArray(j) ? j : (j.segments || []);
        sentences = list.map(s => ({ st: Number(s.start_ms ?? s.start ?? 0), en: Number(s.end_ms ?? s.end ?? 0), text: String(s.text || s.word || '') }))
          .filter(x => x.en > x.st && x.text);
      }
      if (sentences.length) {
        let cutSegs = 0;
        let totalDropped = 0;
        for (const seg of selectedSegments) {
          const plan = this._planCutsWithoutOps(sentences, seg.startMs, seg.endMs);
          if (!plan) {
            rejectedBySentence.push({ id: seg.id, theme: seg.theme_name || '(无主题)', reason: '剔完运营话术后干净内容不足' });
            continue;
          }
          if (plan.droppedMs > 0) {
            seg.cuts = plan.cuts;
            cutSegs++;
            totalDropped += plan.droppedMs;
          }
        }
        for (const r of rejectedBySentence) {
          const i = selectedSegments.findIndex((s) => s.id === r.id);
          if (i >= 0) selectedSegments.splice(i, 1);
        }
        if (cutSegs) {
          console.log(`[Clipper] 逐句剔除运营话术：${cutSegs} 段切出 ${selectedSegments.reduce((a, s) => a + (s.cuts?.length || 0), 0)} 个子区间，共剔掉 ${Math.round(totalDropped / 1000)}s`);
        }
        if (rejectedBySentence.length) {
          console.log(`[Clipper] 逐句剔除后整段不可用、已移出成片：${rejectedBySentence.map((r) => `#${r.id}《${String(r.theme).slice(0, 12)}》`).join('、')}`);
        }
      }
    } catch (err) { console.warn('[Clipper] 逐句剔除失败（不阻塞）:', err.message); }

    if (!selectedSegments.length) {
      throw new Error('逐句剔除运营话术后没有可用内容了：这场直播的教学片段太少，换一场素材再剪');
    }

    // 2026-09-28：按目标成片时长收口。LLM 常常要么选太少、要么选到 6~9 分钟，
    // 以前没有任何一道关卡住总时长。这里在保留顺序的前提下增删，让成片落进目标区间。
    this._trimToTargetDuration(selectedSegments, duration, { forcedHookId: forcedSegId, pool: scoredSegments });

    // Extract hooks for each selected segment (待分类兜底段直接给中值：它的摘要是90s拼接，LLM打分纯噪音还烧10次调用)
    const hookResults = [];
    for (const seg of selectedSegments) {
      if ((seg.theme_name || '') === '待分类') {
        hookResults.push({ segmentId: seg.id || seg.segment_index, has_hook: false, hook_quality: seg.hook_quality || 0.5, notes: 'fallback segment, skipped LLM' });
        continue;
      }
      try {
        const hook = await this._extractHook(seg, liveVideo.video_path);
        hookResults.push({ segmentId: seg.id || seg.segment_index, ...hook });
      } catch (err) {
        console.warn(`[Clipper] Hook extraction failed for segment ${seg.id}: ${err.message}`);
        hookResults.push({ segmentId: seg.id || seg.segment_index, has_hook: false, hook_quality: 0.5 });
      }
    }

    // Vision 复看（文本定稿之后）：用 vision 模型看一遍每段中点画面，一次批量调用。
    // 文本决策永远保底——模型缺失/失败直接跳过；画面明显拉胯的段转成待确认，不自动丢。
    // 调度器自动粗剪默认关闭（opts.visionReview=false），避免每单都倒腾 6GB 显存；看板手动粗剪/打回重剪默认开启。
    const wantVision = opts.visionReview ?? this.config.clipper?.visionReview ?? true;
    const visualVerdicts = new Map();
    if (wantVision && selectedSegments.length > 0 && this.ffmpeg.isAvailable) {
      try {
        const verdicts = await this._visionReview(liveVideo.video_path, selectedSegments);
        for (const v of verdicts) visualVerdicts.set(v.segmentId, v);
      } catch (err) {
        console.warn(`[Clipper] Vision review skipped: ${err.message}`);
      }
    }
    const weakThreshold = this.config.clipper?.visionWeakThreshold ?? 0.35;
    for (const [segId, v] of visualVerdicts) {
      if (v.visualScore != null && v.visualScore < weakThreshold) {
        uncertainties.push({
          segment_id: segId,
          question: `画面复看偏弱（${v.visualNote || '画面平淡'}，${v.visualScore.toFixed(2)}），保留这段吗？`,
          options: ['保留', '去掉']
        });
      }
    }
    if (visualVerdicts.size > 0) {
      console.log(`[Clipper] Vision reviewed ${visualVerdicts.size} segments, ${uncertainties.length} total uncertainties`);
    }

    // Calculate total duration
    // 2026-10-05 修：这里算出来的变量叫 totalDuration，下面却传了 totalDurationMs ——
    // 而 totalDurationMs 只在 clip() 内部声明过。所以**自动选段这条路 100% 抛
    // ReferenceError**，POST /pipeline/clip 直接 500，调度器的自动粗剪静默失败
    // （只在服务器日志里留一行，界面上看不出任何异常）。
    const totalDuration = selectedSegments.reduce((sum, s) => sum + (s.duration_ms || (s.end_ms - s.start_ms)), 0);

    // Create clip project
    // 2026-09-24：建项目 / 建待确认问题 / 更新 clipCount 原来是三次独立提交，
    // 中途抛错会留下"有项目但没有 query"的孤儿项目（永远卡在 pending_review 且无人能推进）。
    // 包成一个事务：要么全成，要么什么都不写。
    let projectId = null;
    const pendingQueries = [];
    const createTx = this.store.db.transaction(() => {
    projectId = this.store.createClipProject({
      liveVideoId,
      projectName: `Clip_${videoName}_${Date.now()}`,
      status: uncertainties.length > 0 ? 'pending_review' : 'clipping',
      selectedSegments: selectedSegments.map(s => {
        const segId = s.id || s.segment_index;
        const v = visualVerdicts.get(segId);
        return {
          segmentId: segId,
          startMs: s.start_ms,
          endMs: s.end_ms,
          themeName: s.theme_name,
          role: s.role || 'body',
          hookQuality: hookResults.find(h => h.segmentId === segId)?.hook_quality || 0.5,
          visualScore: v?.visualScore ?? null,
          visualNote: v?.visualNote || null,
          /*
           * cuts 必须一起写库。
           * 上面 L543 给 seg.cuts 赋了值（逐句剔除运营话术后的子区间），
           * 但这个投影里没带上 → clip() 从库里重读项目时 seg.cuts 恒为 undefined
           * → ranges 永远走"整段"分支 → 整个逐句剔除阶段在成片上是**空转**。
           * 那些剔除（预约/加微信/刷礼物）原样留在粗剪里，而界面上完全看不出来，
           * 因为 cuts 只被拿去算时长预算了。
           */
          ...(Array.isArray(s.cuts) && s.cuts.length
            ? { cuts: s.cuts.map((c) => ({ st: Number(c.st), en: Number(c.en) })) }
            : {})
        };
      }),
      // 原来这里是裸的 totalDurationMs（未定义）→ ReferenceError，见上面 L614 的注释
      totalDurationMs: totalDuration
    });

    // Create user queries for uncertainties
    for (const u of uncertainties) {
      let seg = segments.find(s => (s.id ?? s.segment_index) === u.segment_id);
      if (!seg && Number.isFinite(Number(u.segment_id))) {
        // 兼容 LLM 返回列表序号的情况
        seg = scoredSegments[Number(u.segment_id) - 1];
      }
      // user_queries.question 是 NOT NULL，而 LLM 的 uncertainties 里可能没有 question
      // 字段（只给 segment_id + reason）。以前直接透传 undefined 会整条建工程失败：
      // NOT NULL constraint failed: user_queries.question，整场直播出不了片。
      // 这里兜一句可读文案，让"模型没写问题"退化成"这句要你确认"，而不是崩掉。
      const fallbackQuestion = seg
        ? `第 ${u.segment_id} 段《${String(seg.theme_name || '未命名').slice(0, 12)}》要保留吗？${u.reason ? `（${String(u.reason).slice(0, 40)}）` : ''}`
        : '这一段不太确定，要保留吗？';
      const question = (typeof u.question === 'string' && u.question.trim()) || fallbackQuestion;
      const queryId = this.store.addUserQuery({
        projectId,
        queryType: 'segment_confirm',
        question,
        context: { segmentId: u.segment_id, themeName: seg?.theme_name, transcriptSummary: seg?.transcript_summary },
        options: u.options || ['Yes', 'No', 'Skip'],
        status: 'pending'
      });
      pendingQueries.push({ queryId, question, options: u.options || ['Yes', 'No', 'Skip'] });
    }

    // Update live video clip count
    // path 为空时不再写：以前会 upsert 出一条 video_path='' 的幽灵直播记录
    if (liveVideo.video_path) {
      this.store.upsertLiveVideo(liveVideo.video_path, {
        clipCount: selectedSegments.length
      });
    }
    return projectId;
    });
    projectId = createTx();
    console.log(`[Clipper] Project created: id=${projectId}, ${selectedSegments.length} segments, ${uncertainties.length} uncertainties`);

    return {
      projectId,
      segments: selectedSegments,
      hookResults,
      pendingQueries,
      selectionConfidence
    };
  }

  /**
   * Perform actual video clipping using ffmpeg.
   * @param {number} projectId
   * @returns {Promise<{clipPaths: Array<string>, totalDurationMs: number}>}
   */

  async clip(projectId) {
    const project = this.store.getClipProject(projectId);
    if (!project) {
      throw new Error(`Clip project not found: ${projectId}`);
    }
    if (!project.selected_segments || project.selected_segments.length === 0) {
      throw new Error(`No segments selected for project ${projectId}`);
    }

    const liveVideo = this.store.getLiveVideoById?.(project.live_video_id) || this.store.getVideoById?.(project.live_video_id);
    if (!liveVideo) {
      throw new Error(`Source video not found for project ${projectId}`);
    }

    const videoPath = liveVideo.video_path;
    const videoName = basename(videoPath, extname(videoPath));

    console.log(`[Clipper] Starting clip for project ${projectId}: ${videoName}`);

    // Ensure draft directory exists
    const projectDir = join(this.draftDir, `project_${projectId}`);
    mkdirSync(projectDir, { recursive: true });

    const clipPaths = [];
    // 记录真正切成功的段：下面要拿它收敛 selected_segments
    const okSegments = [];
    let totalDurationMs = 0;

    if (!this.ffmpeg.isAvailable) {
      console.warn('[Clipper] ffmpeg not available, skipping actual clipping');
      // Still create placeholder records
      for (let i = 0; i < project.selected_segments.length; i++) {
        const seg = project.selected_segments[i];
        const clipPath = join(projectDir, `${videoName}_clip${i + 1}.mp4`);
        clipPaths.push(clipPath);
        totalDurationMs += (seg.endMs - seg.startMs);
      }
    } else {
      for (let i = 0; i < project.selected_segments.length; i++) {
        const seg = project.selected_segments[i];
        // 本段的子区间是否全部切成功（见下面 push 处的注释）
        let segOk = false;
        // 2026-09-27：段可带 cuts（逐句剔除运营话术后的子区间）——按子区间切多片再拼接，
        // 段中间的运营话术被真正"逐字逐句"剔除；无 cuts 的段保持原行为
        const ranges = Array.isArray(seg.cuts) && seg.cuts.length
          ? seg.cuts.map(c => ({ startSec: c.st / 1000, durationSec: (c.en - c.st) / 1000 }))
          : [{ startSec: seg.startMs / 1000, durationSec: (seg.endMs - seg.startMs) / 1000 }];
        for (let k = 0; k < ranges.length; k++) {
          const { startSec, durationSec } = ranges[k];
          const clipPath = join(projectDir, `${videoName}_clip${i + 1}${ranges.length > 1 ? `_${k + 1}` : ''}.mp4`);

          try {
            await this.ffmpeg.clipSegment(videoPath, startSec, durationSec, clipPath);
            clipPaths.push(clipPath);
            // 只有这个片段的**所有**子区间都切成功，才算这一段成功
            segOk = true;
            totalDurationMs += durationSec * 1000;
            console.log(`[Clipper] Clip ${i + 1}${ranges.length > 1 ? `.${k + 1}` : ''}: ${startSec}s - ${startSec + durationSec}s`);
          } catch (err) {
            segOk = false;
            console.error(`[Clipper] Failed to clip segment ${i + 1}.${k + 1}: ${err.message}`);
          }
        }
        /*
         * 2026-10-05 修：okSegments.push(seg) 原先写在**子区间循环体内**。
         *
         * 一段有 N 个 cuts（正常情况：删掉中间一段就得到 2 个区间）就会被 push N 次，
         * 于是 okSegments 比 selected_segments 长，接着下面那句
         * "okSegments.length !== selected_segments.length → 收敛" 反而会把
         * **重复的段写回库**。
         *
         * 后果全是静默的：generator 按数组下标累计字幕偏移，于是重复段的字幕
         * 被放到画面已经切走之后（字幕整体错位）；review-packet 把同一段吐 3 遍、
         * totalSec 虚高；resume-clip 会拿这份被污染的数组再切一遍，成片里出现重复画面。
         *
         * 判据必须是"这段的所有子区间都成功"，而不是"每成功一个子区间就记一次"。
         */
        if (segOk) okSegments.push(seg);
      }
    }

    // 2026-09-24 修：以前单段切片失败只打一行日志就继续，最后无条件把项目置成 reviewing，
    // 但 selected_segments 还是全集 —— generator 按全集累计时长算字幕偏移（_offsetMs），
    // 缺失段之后的所有字幕会整体前移，成片字幕与画面对不上，却看不出哪里错了。
    if (clipPaths.length === 0) {
      this.store.updateClipProject(projectId, { status: 'failed' });
      throw new Error('所有片段都切片失败，项目已标记为 failed（不进审阅、不生成成片）');
    }
    /*
     * 只在段数**变少**时收敛。
     *
     * 原来写的是 !== ，于是"变多"也会走进来 —— 而段数变多只可能是上游重复收集了
     * （见上面 okSegments.push 处的注释）。那时把重复段写回库，
     * 后果是字幕错位和成片重复画面，且不报任何错。
     * 变多属于代码 bug，应该在这里炸出来，而不是悄悄写坏数据。
     */
    if (okSegments.length < project.selected_segments.length) {
      console.warn(`[Clipper] ${project.selected_segments.length - okSegments.length} 段切片失败，selected_segments 收敛为 ${okSegments.length} 段（避免字幕整体偏移）`);
      this.store.updateClipProject(projectId, { selectedSegments: JSON.stringify(okSegments) });
    } else if (okSegments.length > project.selected_segments.length) {
      console.error(
        `[Clipper] okSegments(${okSegments.length}) 比 selected_segments(${project.selected_segments.length}) 还多，`
        + `这是上游重复收集段的 bug。已按原数组继续，不写坏数据。`
      );
    }

    // Update project status
    this.store.updateClipProject(projectId, {
      status: 'reviewing',
      outputPath: projectDir,
      totalDurationMs
    });

    console.log(`[Clipper] Clipping complete: ${clipPaths.length} clips, ${Math.round(totalDurationMs / 1000)}s total`);

    // 拼成一条完整粗剪：hook 开头 → 正文 → closer 收尾（selected_segments 已按角色排好序）
    let roughcutPath = null;
    if (clipPaths.length > 0 && this.ffmpeg.isAvailable) {
      try {
        roughcutPath = join(projectDir, `${videoName}_roughcut.mp4`);
        await this.ffmpeg.concatCopy(clipPaths, roughcutPath);
        console.log(`[Clipper] Roughcut joined: ${roughcutPath}`);
      } catch (err) {
        console.warn(`[Clipper] Concat failed, keep individual clips: ${err.message}`);
        roughcutPath = clipPaths.length === 1 ? clipPaths[0] : null;
      }
    }

        /*
     * 2026-10-05 修：粗剪拼不出来时必须让调用方知道。
     *
     * 原来多段拼接失败只 set 成 null 并 return，
     * 而 POST /pipeline/clip 照样回 { ok:true, clipped:true }，
     * 桌面端于是提示"粗剪还没渲染出来，先播原始素材"——
     * 看起来像正常的降级，实际是**根本没出粗剪**。
     * 等到出片那一步 generator 才抛 '找不到粗剪视频'，
     * 用户已经等完整个审片流程才知道白干了。
     *
     * 单段的例外：那种情况下唯一的切片本身就是粗剪，直接用它。
     */
    const roughcutFailed = clipPaths.length > 1 && !roughcutPath;
    if (roughcutFailed) {
      console.error(
        `[Clipper] 工程#${projectId}：${clipPaths.length} 段切片都成功了，`
        + `但拼接粗剪失败。必须重跑出片，不能当成成功。`
      );
    }
    return {
      clipPaths,
      roughcutPath,
      totalDurationMs,
      roughcutFailed,
      // 给上层一句话能直接转给用户的原因
      ...(roughcutFailed
        ? { error: `${clipPaths.length} 段已切好但拼接失败，请重跑一次出片` }
        : {})
    };
  }

  /**
   * 角色分配：一条完整粗剪 = hook 开头 + 正文延续（时间序）+ closer 收尾。
   * closer 优先选带货/软CTA气质的段（主题名含促销/CTA/收尾/关注，或 viral 高的末段），
   * 藏带货内容放中后部，结构整洁。
   */
  /**
   * 爆款开头前置：决定要不要从全场挑一段优质开头剪到成片最前。
   *
   * 为什么必须单独做：
   * 原来的实现只是"把选中的段按 hook 分排序"，开头仍然来自用户已选的那些段。
   * 但真实的爆款逻辑是——全场 200 段里可能只有第 37 段那句话最抓人，
   * 即使用户没勾它，也应该把它剪出来前置。这是"选片"之外的一层加工。
   *
   * 优先级：
   *   ① 用户/记忆指定的原文（forcedSegmentId）—— 硬约束
   *   ② 全场钩子分最高的段 —— 自动挑
   *   ③ 都没有 → 不前置（宁可不做，也不要硬塞一段平庸的开头）
   *
   * 只会裁剪不删内容：prepend 段是复制一份并用 cuts 限定长度，
   * 原段仍在正文中（除非它本来就被选中，那会由去重逻辑处理）。
   *
   * @returns {{prepend: object|null, reason: string, enabled: boolean, takenSec: number}}
   */
  _planViralOpening({
    allSegments = [],
    scored = [],
    picked = [],
    ruleText = '',
    forcedSegmentId = null,
    enabled = true,
    maxSeconds = 15
  }) {
    if (!enabled) return { prepend: null, reason: '已关闭', enabled: false, takenSec: 0 };

    const pool = (allSegments.length ? allSegments : picked).filter(Boolean);
    if (!pool.length) return { prepend: null, reason: '没有可用分段', enabled: true, takenSec: 0 };

    // 运营话术段绝不能当开头（预约/灯牌/私我…），先滤掉
    const usable = pool.filter((s) => !this._isOperationHeavySegment(s));
    if (!usable.length) return { prepend: null, reason: '全场都是运营话术', enabled: true, takenSec: 0 };

    const segId = (s) => s.id ?? s.segment_index;
    const pickedIds = new Set(picked.map(segId));
    const startMs = (s) => Number(s.start_ms ?? s.startMs ?? 0);
    const endMs = (s) => Number(s.end_ms ?? s.endMs ?? 0);
    const durMs = (s) => Math.max(0, endMs(s) - startMs(s));

    // ① 指定开头（硬约束）
    let chosen = forcedSegmentId != null ? usable.find((s) => segId(s) === forcedSegmentId) : null;
    let reason = '命中指定开头';
    if (!chosen && ruleText) {
      const hit = this._locateOpeningSegment(usable, ruleText);
      if (hit) { chosen = hit; reason = '按指定原文在全场定位'; }
    }

    // ② 全场挑钩子最强的（避开纯"待分类"兜底段，它们没有真实钩子分）
    if (!chosen) {
      const candidates = usable
        .filter((s) => s.theme_name && s.theme_name !== '待分类' && durMs(s) >= 8000)
        .filter((s) => {
          // 钩子分只有中位数的多半是兜底段，排序时也压后
          return Number(s.hook_quality || 0) >= 0.5;
        })
        .sort((a, b) => (b.hook_quality || 0) - (a.hook_quality || 0) || startMs(a) - startMs(b));
      chosen = candidates[0] || null;
      reason = chosen ? '全场钩子分最高' : '没有值得前置的段落';
    }
    if (!chosen) return { prepend: null, reason, enabled: true, takenSec: 0 };

    // ③ 裁到 maxSeconds：用 cuts 表达"只取开头这么多秒"
    const takeMs = Math.min(durMs(chosen), Math.max(3000, maxSeconds * 1000));
    if (takeMs <= 0) return { prepend: null, reason: '开头段时长异常', enabled: true, takenSec: 0 };

    const s0 = startMs(chosen);
    const prepend = {
      ...chosen,
      // 标记来源，便于出片后追溯，也避免与正文里的同一段重复计入
      _viralOpening: true,
      _openingReason: reason,
      // 已经逐句挑过的段保留原 cuts；否则用 cuts 限定只取开头
      cuts: Array.isArray(chosen.cuts) && chosen.cuts.length
        ? [{ st: chosen.cuts[0].st, en: Math.min(chosen.cuts[0].en, chosen.cuts[0].st + takeMs) }].filter((c) => c.en - c.st >= 2000)
        : [{ st: s0, en: s0 + takeMs }]
    };

    // cuts 裁完太短就放弃（宁可没有，也不要半句话当开头）
    if (!prepend.cuts.length || prepend.cuts[0].en - prepend.cuts[0].st < 3000) {
      return { prepend: null, reason: '开头可用长度不足 3 秒', enabled: true, takenSec: 0 };
    }

    // 已经在正文里的同一段：把它从正文位置移走，避免同一句话出现两遍
    if (pickedIds.has(segId(chosen))) {
      const i = picked.findIndex((s) => segId(s) === segId(chosen));
      if (i >= 0) picked.splice(i, 1);
    }

    return { prepend, reason, enabled: true, takenSec: Math.round((prepend.cuts[0].en - prepend.cuts[0].st) / 100) / 10 };
  }

  /**
   * 角色分配与成片排序。
   * hook（开头）→ body（正文，按时间）→ closer（收尾）。
   * 指定开头优先当 hook；closer 避开运营话术段。
   */
  _assignRoles(picked, extra = {}) {
    if (!picked || picked.length === 0) return [];
    if (picked.length === 1) return [{ ...picked[0], role: 'hook' }];
    const byId = new Map(picked.map(s => [s.id ?? s.segment_index, s]));

    // ★ 记忆优先：历史评审/经验里指定的开头段直接当 hook（成片首段），
    // 不再由"谁 hook_quality 分高"决定 —— 用户说过"开头要这个"，就必须是它
    const forcedHook = extra?.forcedHookId != null
      ? picked.find(s => (s.id ?? s.segment_index) === extra.forcedHookId)
      : null;
    if (forcedHook) {
      console.log(`[Clipper] 记忆指定开头生效：Segment ${extra.forcedHookId} 作为成片 hook 首段`);
    }
    const hookSrc = forcedHook || [...picked].sort((a, b) =>
      (b.hook_quality || 0) - (a.hook_quality || 0) || (a.start_ms || 0) - (b.start_ms || 0))[0];
    // 2026-09-27：收尾段不再按"促销/CTA/关注"主题加分——那正是"预约直播/点亮灯牌被选上"的祸首。
    // 收尾 = 传播分高 + 时间靠后的段；运营话术段在选段阶段已被一票否决，这里再兜一道。
    const closerSrc = [...picked].filter(s => s !== hookSrc && !this._isOperationHeavySegment(s)).sort((a, b) => {
      const score = (s) => ((s.viral_potential || 0) > 0.7 ? 1 : 0) + (s.start_ms || 0) / 3600000;
      return score(b) - score(a);
    })[0];
    const hookId = hookSrc.id ?? hookSrc.segment_index;
    const closerId = closerSrc ? (closerSrc.id ?? closerSrc.segment_index) : null;
    const body = picked
      .filter(s => (s.id ?? s.segment_index) !== hookId && (s.id ?? s.segment_index) !== closerId)
      .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
    const ordered = [{ ...hookSrc, role: 'hook' }];
    for (const s of body) ordered.push({ ...s, role: 'body' });
    if (closerSrc && closerId !== hookId) ordered.push({ ...closerSrc, role: 'closer' });
    return ordered;
  }

  /**
   * Score segments based on learned hit patterns.
   */
  _scoreSegments(segments, extra = {}) {
    return segments.map(seg => {
      // Base scores from analysis
      const themeMatch = seg.matched_hit_themes ?
        (() => { try { return JSON.parse(seg.matched_hit_themes); } catch { return []; } })() : [];
      const maxThemeSim = themeMatch.length > 0 ?
        Math.max(...themeMatch.map(t => t.similarity_score || 0)) : 0;

      const hookQuality = seg.hook_quality || 0.5;
      const themeConfidence = seg.theme_confidence || 0.5;
      const viralBonus = seg.viral_potential || 0.5;

      // Composite score: 记忆主题匹配提到 0.45（以前 0.3 时 143 段全 0 匹配就零区分度，只能靠自嗨分选）
      let compositeScore = (
        maxThemeSim * 0.45 +
        hookQuality * 0.2 +
        themeConfidence * 0.15 +
        viralBonus * 0.2
      );

      // ★ 记忆硬约束：历史评审指定为开头的段直接置顶，保证它必然进候选池顶部。
      // 即使该段主题没命中爆款库，用户明确要的开头也不能被算法挤掉。
      const forced = extra?.forcedSegmentId != null && (seg.id ?? seg.segment_index) === extra.forcedSegmentId;
      if (forced) compositeScore = Math.max(compositeScore, 0.95);

      return { ...seg, maxThemeSim, compositeScore, forcedOpening: forced };
    }).sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * 把 LLM 返回的 selected_segment_ids 映射到真实 DB id。
   * LLM 常把行首列表序号（1., 2.…）当成 id 返回，直接用会导致选中 0 段；
   * 这里先按 DB id 匹配，匹配不上再按“scoredSegments 排序后的 1-based 序号”换算。
   */
  _mapSelectedIds(rawIds, segments, scoredSegments) {
    if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
    const byDbId = new Map(segments.map(s => [(s.id ?? s.segment_index), s]));
    const direct = rawIds.filter(id => byDbId.has(id));
    if (direct.length > 0) {
      if (direct.length < rawIds.length) {
        console.warn(`[Clipper] ${rawIds.length - direct.length} 个 LLM 返回 id 无匹配已丢弃: ${rawIds.filter(id => !byDbId.has(id))}`);
      }
      return direct;
    }
    const mapped = [];
    for (const n of rawIds) {
      const seg = scoredSegments[Number(n) - 1];
      if (seg) mapped.push(seg.id ?? seg.segment_index);
    }
    if (mapped.length > 0) {
      console.warn(`[Clipper] LLM 返回的似乎是列表序号而非 DB id，已换算: ${rawIds} -> ${mapped}`);
      return mapped;
    }
    console.warn(`[Clipper] LLM 返回的 id 全部无效: ${rawIds}`);
    return [];
  }

  /**
   * Heuristic segment selection (fallback when LLM unavailable).
   */
  _heuristicSelect(scoredSegments) {
    const selected = [];
    const usedThemes = new Set();

    for (const seg of scoredSegments) {
      if (selected.length >= this.maxClips) break;
      if (seg.compositeScore < 0.4) break; // quality threshold

      const theme = seg.theme_name || 'unknown';
      // Diversify: don't pick too many from same theme
      const themeCount = selected.filter(id => {
        const s = scoredSegments.find(x => (x.id || x.segment_index) === id);
        return s && s.theme_name === theme;
      }).length;

      if (themeCount < 2) {
        selected.push(seg.id || seg.segment_index);
        usedThemes.add(theme);
      }
    }

    // If we have very few, lower threshold and try again
    if (selected.length < 3 && scoredSegments.length > selected.length) {
      for (const seg of scoredSegments) {
        if (selected.length >= 5) break;
        const id = seg.id || seg.segment_index;
        if (!selected.includes(id)) {
          selected.push(id);
        }
      }
    }

    return selected;
  }

  /**
   * LLM-assisted segment selection.
   */
  async _llmSelectSegments(scoredSegments, extra = {}) {
    const dur = extra.duration || this.duration;
    const segmentList = scoredSegments.map((s, i) => {
      const id = s.id || s.segment_index;
      const tags = [];
      if (extra.forcedSegmentId != null && id === extra.forcedSegmentId) tags.push('★指定开头/必须作为成片第1段');
      if ((s.maxThemeSim || 0) > 0.5) tags.push('强记忆命中');
      else if ((s.maxThemeSim || 0) > 0) tags.push('弱记忆命中');
      const memo = (s.matched_themes || []).slice(0, 2)
        .map(t => `《${t.theme_name}》${Number(t.similarity_score || 0).toFixed(2)}`).join('/');
      // 2026-09-27：教学密度是确定性算出来的（见 _scoreTeachingSignals），
      // 必须摆到模型眼前。"缺唱歌实操教学"的根因之一就是模型压根没有判断依据。
      const teach = (s._teachingScore || 0) >= 0.5 ? '【高教学密度】' : ((s._teachingScore || 0) > 0.15 ? '【含教学】' : '【教学稀薄/慎选】');
      const teachHits = (s._teachingHits || []).slice(0, 3).join('/');
      return `${i + 1}. Segment ${id}: theme="${s.theme_name}", duration=${Math.round((s.duration_ms || (s.end_ms - s.start_ms)) / 1000)}s, hook=${(s.hook_quality || 0).toFixed(2)}, viral=${(s.viral_potential || 0).toFixed(2)}, themeMatch=${(s.maxThemeSim || 0).toFixed(2)}, teaching=${(s._teachingScore || 0).toFixed(2)}${teach}${teachHits ? `(${teachHits})` : ''}${memo ? `, 命中记忆主题=${memo}` : ''}, summary="${(s.transcript_summary || '').substring(0, 80)}"${tags.length ? ` [${tags.join('|')}]` : ''}`;
    }).join('\n');

    // 记忆硬约束：指定开头必须在第 1 段，历史评审经验逐条列为必守规则
    const hardRules = [];
    if (extra.forcedSegmentId != null) {
      hardRules.push(`- 必须把 Segment ${extra.forcedSegmentId} 选为第 1 段作为成片开头（创作者在历史评审中明确指定${extra.openingText ? `：《${extra.openingText}》` : ''}），不得替换、不得挪到中间`);
    }
    if (extra.feedbackBlock?.length) {
      hardRules.push(...extra.feedbackBlock.slice(-5).map(f => `- 本场评审意见：${f}`));
    }
    if (extra.lessons?.length) {
      hardRules.push(...extra.lessons.slice(-8).map(l => `- 历史经验：${l.text || l}`));
    }
    const userRules = hardRules.length
      ? `\n创作者的历史评审意见与记忆约束（优先级最高，违反会被打回）：
${hardRules.join('\n')}

选段时必须体现上述记忆：优先选命中记忆主题（themeMatch>0）的段；曾被评为"钩子不够炸/节奏拖/没人看"的方向要降级或排除。
`
      : '';

    // 2026-09-27：注入爆款结构标准（DeepSeek 学记忆库爆款提炼，产物 data/clip-standard.json）
    const standardBlock = this._clipStandardBlock();

    const userPrompt = `从下面这场直播的全部分段里，挑出最能组合成爆款短片的段。

【本主播历史爆款结构标准（由记忆库爆款学习提炼，必须遵守）】
${standardBlock}

【每段 teaching 字段怎么读】0~1，由该段逐字稿里的确定性信号算出（现场示范指令、纠错对比、逐字拆解、声乐术语、跟练步骤的出现密度），不是让你猜的。
teaching≥0.5 且标【高教学密度】= 实操密度高的候选，优先选；标【教学稀薄/慎选】的段基本是闲聊或纯运营，除非钩子极强否则不要。

Available segments:
${segmentList}
${userRules}
Target: Create ${Math.min(this.maxClips, scoredSegments.length)} distinct clips, each ${dur.min}-${dur.max} seconds, covering different themes.
★ 时长硬约束：这些片段拼起来是【一条】成片，目标总时长 ${dur.target} 秒（选题档位：${dur.label}）。
所有选中片段的时长加总必须落在 ${Math.round(dur.target * 0.7)}~${Math.round(dur.target * 1.3)} 秒之间——
不够就多选，超了就砍掉最弱的；宁可少选也不要为了凑数选平庸段。

IMPORTANT: "selected_segment_ids" and "uncertainties[].segment_id" MUST be the database Segment IDs
(the number right after the word "Segment ", e.g. "Segment 42" -> 42),
NOT the list numbers (1., 2., 3., ...) at the line starts.

输出紧凑 JSON，不要任何解释文字，uncertainties 最多 3 条。`;

    const result = await this.ollama.generate(SEGMENT_SELECTION_PROMPT, userPrompt, {
      // 本机 8B 实测约 5~7 tok/s：输出上限给太大（原 2048）会撞 180s 超时被 abort，
      // 于是静默退化成启发式选段 —— 表现为"记忆形同没接上"。这里收紧输出 + 放宽超时。
      maxTokens: 900,
      timeout: 600000,
      temperature: 0.3,
      parseJson: true,
      // 与分段共用同一 num_ctx：切 tier 会改 num_ctx，导致 KV 缓存全部失效重新 prefill（实测 173ms → 38s）
      tier: 'heavy',
    });

    return {
      selected_segment_ids: result?.selected_segment_ids || [],
      uncertainties: result?.uncertainties || [],
      confidence: result?.confidence || 0.8
    };
  }

  /**
   * 成片时长收口：把已选片段增删到目标区间内（就地修改数组）。
   *
   * 为什么需要：LLM 选段根本不受总时长约束——提示词以前只说「每条 30-90 秒」，
   * 而 targetClipDurationMs 定义了从不使用，实际常产出 6~9 分钟的成片。
   * 光靠改提示词不够（模型会忘），所以这里再做一道确定性收口。
   *
   * 策略：
   *   1. 按实际时长统计（段被逐句剔除过的话，用 cuts 子区间的真实时长）
   *   2. 超上限 → 从最弱的一段开始丢，指定开头段与开场段永不丢
   *   3. 低于下限 → 从候选池按综合分补足
   *   4. 已经落在区间内 → 不动
   */
  _trimToTargetDuration(picked, dur, opts = {}) {
    const segMs = (s) => {
      if (Array.isArray(s.cuts) && s.cuts.length) {
        return s.cuts.reduce((a, c) => a + Math.max(0, (c.en ?? 0) - (c.st ?? 0)), 0);
      }
      return Math.max(0, (s.end_ms ?? s.endMs ?? 0) - (s.start_ms ?? s.startMs ?? 0));
    };
    const totalMs = () => picked.reduce((a, s) => a + segMs(s), 0);
    const loMs = dur.target * 0.7 * 1000;
    const hiMs = dur.target * 1.3 * 1000;

    let total = totalMs();
    if (total >= loMs && total <= hiMs) {
      console.log(`[Clipper] 成片 ${Math.round(total / 1000)}s，已在目标区间 ${Math.round(loMs / 1000)}~${Math.round(hiMs / 1000)}s 内`);
      return picked;
    }

    // 超上限：丢最弱段
    if (total > hiMs) {
      let guard = 0;
      while (total > hiMs && picked.length > 1 && guard++ < 50) {
        const idx = this._weakestIndex(picked, opts.forcedHookId);
        if (idx < 0) break;
        const [gone] = picked.splice(idx, 1);
        total = totalMs();
        console.log(`[Clipper] 超时长，移除最弱段 #${gone.id ?? gone.segment_index}（-${Math.round(segMs(gone) / 1000)}s → 剩 ${Math.round(total / 1000)}s）`);
      }
    }

    // 低于下限：从候选池补
    const pool = opts.pool || [];
    if (total < loMs && pool.length) {
      const have = new Set(picked.map((s) => s.id ?? s.segment_index));
      const cand = pool
        .filter((s) => !have.has(s.id ?? s.segment_index))
        // 补进来的段多半是 live_segments 原始行(start_ms / theme_name),
        // 不归一化的话 Clipper.clip 读 startMs 拿到 undefined,
        // 表现是"补段成功但那一片是空的"。
        .map((s) => ({
          ...s,
          segmentId: s.id ?? s.segment_index,
          startMs: Number(s.startMs ?? s.start_ms ?? 0),
          endMs: Number(s.endMs ?? s.end_ms ?? 0),
          themeName: s.theme_name ?? s.themeName ?? '',
          role: s.role || 'body',
          hookQuality: Number(s.hook_quality ?? s.hookQuality ?? 0.5)
        }))
        .sort((a, b) => (b.compositeScore || b.hookQuality || 0) - (a.compositeScore || a.hookQuality || 0));
      for (const c of cand) {
        if (total >= loMs) break;
        picked.push(c);
        have.add(c.id ?? c.segment_index);
        total = totalMs();
        console.log(`[Clipper] 时长不足，补入 #${c.id ?? c.segment_index}（+${Math.round(segMs(c) / 1000)}s → 剩 ${Math.round(total / 1000)}s）`);
      }
    }

    console.log(`[Clipper] 成片最终 ${Math.round(totalMs() / 1000)}s（目标 ${dur.target}s，区间 ${Math.round(loMs / 1000)}~${Math.round(hiMs / 1000)}s）`);
    return picked;
  }

  /** 找出最弱一段的下标：分数低者优先，指定开头段与开场段跳过。 */
  _weakestIndex(picked, forcedId) {
    let worst = -1;
    let worstScore = Infinity;
    for (let i = 0; i < picked.length; i++) {
      const s = picked[i];
      const id = s.id ?? s.segment_index;
      if (forcedId != null && id === forcedId) continue;      // 指定开头永不丢
      if (i === 0 && (s.role || '') === 'hook') continue;      // 开场段不丢
      const score = (s.compositeScore ?? s.hook_quality ?? 0.5) - (s._teachingScore || 0) * 0.5;
      if (score < worstScore) { worstScore = score; worst = i; }
    }
    return worst;
  }

  /**
   * 爆款结构标准（learn-hit-standard.cjs 的产物 data/clip-standard.json）：10 分钟缓存。
   * DeepSeek 学记忆库爆款提炼，选段指令自动注入 —— 爆款越多，标准会自己进化。
   */
  _clipStandardBlock() {
    try {
      const now = Date.now();
      if (!this._stdCache || now - this._stdAt > 600e3) {
        const p = join(__dirname, '..', '..', 'data', 'clip-standard.json');
        this._stdCache = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')).standard : null;
        this._stdAt = now;
      }
      const st = this._stdCache;
      if (!st) return '（暂无爆款结构标准：先跑 learn-hit-standard.cjs 学习记忆库爆款）';
      const fmt = (arr) => (Array.isArray(arr) ? arr : []).map((x, i) => `  ${i + 1}. ${x}`).join('\n');
      return `必须选的段落特征：
${fmt(st.must_include)}
绝不选的段落：
${fmt(st.must_exclude)}
好开头的标准：
${fmt(st.opening_standard)}
段落衔接手法：${st.flow_standard || ''}
卖课/运营话术边界：
${fmt(st.selling_boundary)}
实操教学段特征（优先命中）：
${fmt(st.teaching_signals)}
主题设计共性：${st.theme_design || ''}
选段心法：${st.summary || ''}`;
    } catch { return ''; }
  }

  /**
   * 逐句剔除运营话术，规划这段该保留哪些时间区间。
   *
   * 与旧实现的两点不同：
   *  ① 句子归属改成"重叠"而不是"完整包含"。ASR 句子常跨段边界，
   *     旧写法要求 st>=段首-800 且 en<=段尾+800，跨界的句子直接被排除，
   *     里面的运营话术因此躲过了剔除。
   *  ② 删掉了"剔完剩不到 40% 就整段原样保留"的妥协。剩下的不够最短时长时返回 null，
   *     由调用方把这段移出成片——不能为了凑时长把脏话术放回去。
   *
   * @returns {null|{cuts:Array<{st:number,en:number}>, keptMs:number, droppedMs:number, dropped:string[]}}
   */
  _planCutsWithoutOps(sentences, segStartMs, segEndMs) {
    const st0 = Number(segStartMs || 0);
    const en0 = Number(segEndMs || 0);
    if (!(en0 > st0)) return null;

    // 与该段有重叠的句子都算进来（跨界句按重叠部分裁进段内）
    const inSeg = [];
    for (const s of sentences) {
      const ovSt = Math.max(s.st, st0);
      const ovEn = Math.min(s.en, en0);
      if (ovEn - ovSt >= 300) inSeg.push({ ...s, st: ovSt, en: ovEn });
    }
    if (inSeg.length < 1) return null;

    const dropped = [];
    const kept = [];
    /*
     * 开场寒暄只在"这段完全没有教学内容"时才剪。
     * 所以先拿整段原文判一次有没有教学信号，再传给每句判定 ——
     * 否则每句各自判，"大家好"被当成寒暄剪掉，
     * 而后面紧跟着的真教学内容会留在一个没有头的片段里。
     */
    const segHasTeaching = this._segHasTeachingSignal(inSeg.map((x) => x.text).join(''));
    for (const x of inSeg) {
      if (this._isOpSentence(x.text, { segHasTeaching })) {
        dropped.push(String(x.text).slice(0, 40));
      } else {
        kept.push(x);
      }
    }

    // 连续保留句合并成子区间；短于 1.5 秒的碎片丢掉（拼出来会跳）
    const cuts = [];
    let cur = null;
    for (const x of kept) {
      if (!cur) { cur = { st: x.st, en: x.en }; continue; }
      if (x.st - cur.en < 400) cur.en = x.en; // 间隙 <0.4s 视为连续
      else {
        if (cur.en - cur.st >= 1500) cuts.push(cur);
        cur = { st: x.st, en: x.en };
      }
    }
    if (cur && cur.en - cur.st >= 1500) cuts.push(cur);

    const keptMs = cuts.reduce((a, c) => a + (c.en - c.st), 0);
    const droppedMs = dropped.length ? (en0 - st0) - keptMs : 0;

    // 没剔除任何东西：返回 droppedMs=0，调用方不会覆盖 seg.cuts（保持整段）
    if (!dropped.length) return { cuts: [], keptMs: en0 - st0, droppedMs: 0, dropped: [] };

    // 剔过之后必须还剩下"能看"的长度，否则这段整体作废（不是退回原段）
    const MIN_KEEP_MS = Number(this.config.clipper?.minKeepAfterCutMs ?? loadClipRules().minKeepAfterCutMs);
    if (!cuts.length || keptMs < MIN_KEEP_MS) return null;

    return {
      cuts: cuts.map((c) => ({ st: Math.round(c.st), en: Math.round(c.en) })),
      keptMs, droppedMs: Math.max(0, droppedMs), dropped,
    };
  }

  /**
   * 句级运营/寒暄判定 —— 粗剪"逐字逐句剔除"的唯一判据。
   *
   * 三级判定（2026-10-05 按老板口径重写）：
   *
   *  ① **命中剔除词**（dropPhrases）→ 整句剪掉。
   *     包括点点关注/点亮小红心/点个赞/收藏/转发/评论区这类互动引导，
   *     以及预约/私我/微信这类导流 —— 老板明确要求互动话术也剪。
   *     匹配前先剥分隔符（主播常拆开念："私\我\开\出\品"）。
   *
   *  ② **命中开场寒暄**（greetingPatterns）→ 剪掉，但**必须整段没有教学信号**。
   *     这一条是防误伤的关键："大家好，接下来我们讲一讲混声"这种句子
   *     带着寒暄也带着教学内容，直接剪会把正片剪没。
   *     所以只有当**整段所有句子里一个教学信号都没有**时，
   *     才敢把寒暄句剪掉；有教学信号就全段保留。
   *
   *  ③ 其他情况 → 保留。
   *
   * 白名单（keepPhrases）默认空。想留某些话就往 clip-rules.json 里加。
   */
  _isOpSentence(text, opts = {}) {
    const rules = loadClipRules();
    if (rules.enabled === false) return false;
    const t = String(text || '');
    if (!t) return false;
    const flat = normalizeVariant(t);

    const hits = (list) => list.some((k) => k && (t.includes(k) || flat.includes(normalizeVariant(k))));

    // ① 剔除词
    if (hits(rules.dropPhrases)) return true;

    // ② 开场寒暄：只在"这段没有任何教学内容"时才敢剪
    if (rules.greetingPatterns.length && hits(rules.greetingPatterns)) {
      if (!rules.requireNoTeachingSignalForGreeting) return true;
      // opts.段里有教学信号吗？没有才剪这段的寒暄
      const segHasTeaching = opts.segHasTeaching;
      if (segHasTeaching === false) return true;
      if (segHasTeaching === true) return false;
      // 传不进来就保守：宁可留寒暄，也别把教学内容剪掉
      return false;
    }

    return false;
  }

  /** 这段文本里有没有教学信号（有就说明这段是在讲东西，别当寒暄剪掉） */
  _segHasTeachingSignal(text) {
    const t = String(text || '');
    if (!t) return false;
    return TEACHING_SIGNALS.some((s) => s.re.test(t));
  }

  /**
   * 加载直播逐字稿原文，按时间窗切到每个分段上。
   *
   * 为什么必须读原文：段库里只存了 transcript_summary（LLM 写的摘要，且分段失败时
   * 退化成原文前 200 字截断）。运营话术藏在原话里，摘要通常把它省略了——
   * 只看摘要，等于永远找不到"大家预约一下直播"这种句子。
   *
   * @returns {Promise<Map<number, string>>} segmentId → 该段原文
   */
  async _loadSegmentFullTexts(liveVideo, segments) {
    const map = new Map();
    const asrPath = liveVideo?.asr_path;
    if (!asrPath || !existsSync(asrPath) || !Array.isArray(segments)) return map;
    try {
      const data = JSON.parse(readFileSync(asrPath, 'utf-8'));
      const helper = new ASRHelper(this.config);
      const all = helper._normalizeTranscript(data);
      if (!all.length) return map;
      for (const seg of segments) {
        const st = Number(seg.start_ms ?? 0);
        const en = Number(seg.end_ms ?? 0);
        if (!(en > st)) continue;
        const text = all
          .filter((s) => (Number(s.start ?? s.start_ms ?? 0)) < en && (Number(s.end ?? s.end_ms ?? 0)) > st)
          .map((s) => s.text || '')
          .join('');
        if (text) map.set(seg.id, text);
      }
      console.log(`[Clipper] 逐字稿已按段切片：${map.size}/${segments.length} 段拿到原文`);
    } catch (err) {
      console.warn(`[Clipper] 逐字稿切片失败（退化为只看摘要）：${err.message}`);
    }
    return map;
  }

  /**
   * 运营话术段一票否决。
   *
   * 2026-09-27 修了三个问题：
   *  ① 原来写成 seg.summary，而 DB 字段是 transcript_summary——字段名笔误导致
   *     这层保护实际只在看 theme_name（还常常是"待分类"），运营段一路选进成片；
   *  ② 原来要求命中 ≥2 个关键词才否决，只提一次"记得预约直播"的段照样入选；
   *  ③ 原来只看摘要，读不到原文里的运营话术（见 _loadSegmentFullTexts）。
   *
   * @param {object} seg      分段行（DB 原始字段）
   * @param {string} segText  该段逐字稿原文
   */
  _isOperationHeavySegment(seg, segText = '') {
    const text = `${seg.theme_name || ''} ${seg.transcript_summary || ''} ${segText || ''}`;
    const norm = normalizeVariant(text);

    // ① 强运营词：命中一次即否决。
    // 两种形态都要查：原文形态 + 剥离分隔符后的形态（主播常拆字念躲审核，
    // "私\我\开\出\品\订\单" 或 "扣 1" 这种，只看原文必然漏网）。
    for (const k of OP_HARD) {
      if (text.includes(k)) return true;
      if (norm.includes(normalizeVariant(k))) return true;
    }
    // ② 主题名本身被标成运营性质（比如 DeepSeek 直接把它命名为"关注引导"）
    if (/预约|灯牌|粉丝团|私我|加微信|挑战群|关注引导|运营引导|引流转化|导流/i.test(seg.theme_name || '')) return true;
    // ③ 软运营词扎堆（≥2 种不同说法）才算成交煽动，单句不冤枉
    if (OP_SOFT.filter((k) => text.includes(k)).length >= 2) return true;
    return false;
  }

  /**
   * 教学密度打分：把 clip-standard.json 里的教学信号落成确定性规则，不靠 LLM 猜。
   * 手势引导、纠错对比、逐字拆解、声乐术语密度越高，越像能爆的实操段。
   * 分数会写进选段提示词，让 LLM 有据可依——以前它只能看到"待分类"+摘要，等于瞎选。
   */
  _scoreTeachingSignals(text) {
    const t = String(text || '');
    if (!t) return { score: 0, hits: [], density: 0 };
    const hits = [];
    let raw = 0;
    for (const s of TEACHING_SIGNALS) {
      const n = (t.match(new RegExp(s.re.source, 'g')) || []).length;
      if (n > 0) {
        raw += Math.min(n, 3) * s.w; // 同一信号重复最多计 3 次，防止刷分
        hits.push(`${s.name}×${n}`);
      }
    }
    const per100 = t.length > 0 ? (raw / t.length) * 100 : 0;
    // 归一化到 0~1：每百字约 8 次加权信号才算满密度。
    // 分母定 8 是实测出来的：定 3 时一句"我们在讲到混声"就能拉满，
    // 短句虚高会让所有段都变成"高教学密度"，筛选就失去意义了。
    const score = Math.max(0, Math.min(1, per100 / 8));
    return { score: Math.round(score * 100) / 100, hits, density: Math.round(per100 * 100) / 100 };
  }

  /**
   * Vision 复看：给已选中的每段抓一张中点小图，一次 describe 批量打分。
   * 返回 [{segmentId, visualScore 0-1, visualNote}]；模型缺失返回 []（上游按文本决策继续）。
   */
  async _visionReview(videoPath, selectedSegments) {
    // 预检：vision 模型未配置/未下载时连帧都不抓（省 IO）
    try {
      if (typeof this.ollama?.resolveModel === 'function' && !this.ollama.resolveModel('vision')) return [];
    } catch { return []; }
    const maxFrames = Math.min(this.config.clipper?.visionMaxFrames ?? 8, selectedSegments.length);
    const targets = selectedSegments.slice(0, maxFrames);
    const tempDir = this.config.upload?.tempDir || join(__dirname, '..', '..', 'upload', 'temp');
    try { mkdirSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    const tag = Date.now();
    const shots = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i];
        const midSec = ((s.start_ms || 0) + (s.end_ms || 0)) / 2 / 1000;
        const out = join(tempDir, `vision_${tag}_${i}.jpg`);
        try {
          await this.ffmpeg.extractFrameAt(videoPath, midSec, out, 384);
          shots.push({ seg: s, file: out });
        } catch (err) {
          console.warn(`[Clipper] Frame grab failed seg ${s.id}: ${String(err.message).slice(0, 100)}`);
        }
      }
      if (!shots.length) return [];
      const { readFileSync } = await import('fs');
      const images = shots.map(x => { try { return readFileSync(x.file).toString('base64'); } catch { return null; } }).filter(Boolean);
      if (!images.length) return [];
      const list = shots.map((x, i) => `${i}号：${x.seg.role || 'body'}段《${(x.seg.theme_name || '').slice(0, 16)}》`).join('\n');
      const text = await this.ollama.describe(images,
        `你是短视频画面导演。给下面每张剧照的“视觉爆款价值”打分（人物状态/表情张力/画面信息量/封面潜力综合）。只输出JSON：{"verdicts":[{"idx":序号,"visual_score":0-1,"note":"十字内点评"}]}\n${list}`,
        { timeout: 300000, maxTokens: 1024 });
      if (!text) return [];
      const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
      const arr = (() => { try { return (JSON.parse((fence ? fence[1] : String(text).slice(String(text).indexOf('{'))).trim()).verdicts) || []; } catch { return []; } })();
      return arr.map(r => ({
        segmentId: shots[Number(r.idx)] ? (shots[Number(r.idx)].seg.id ?? shots[Number(r.idx)].seg.segment_index) : null,
        visualScore: Number(r.visual_score),
        visualNote: String(r.note || '').slice(0, 30),
      })).filter(v => v.segmentId != null && Number.isFinite(v.visualScore));
    } finally {
      const { unlinkSync } = await import('fs');
      for (const x of shots) { try { unlinkSync(x.file); } catch { /* ignore */ } }
    }
  }

  /**
   * Extract and evaluate the hook (first 3-5 seconds) of a segment.
   */
  async _extractHook(segment, videoPath) {
    // Try to get transcript for the first 5 seconds of the segment
    // For now, use the transcript_summary as proxy
    const hookText = (segment.transcript_summary || '').substring(0, 200);

    if (!this.ollama) {
      return {
        has_hook: segment.hook_quality > this.minHookQuality,
        hook_type: 'unknown',
        hook_quality: segment.hook_quality || 0.5,
        suggested_hook_text: '',
        notes: 'No LLM available for hook analysis'
      };
    }

    const userPrompt = `Evaluate this opening hook for a short viral video:

Transcript excerpt (first 3-5 seconds): "${hookText}"

Evaluate and output as specified JSON.`;

    try {
      const result = await this.ollama.generate(HOOK_EXTRACT_PROMPT, userPrompt, {
        maxTokens: 400,
        timeout: 300000,
        temperature: 0.3,
        parseJson: true,
        tier: 'heavy', // 与分段/匹配同 num_ctx，避免切换上下文触发重新 prefill
      });

      return {
        has_hook: result?.has_hook || false,
        hook_type: result?.hook_type || 'none',
        hook_quality: result?.hook_quality || 0.5,
        suggested_hook_text: result?.suggested_hook_text || '',
        notes: result?.notes || ''
      };
    } catch (err) {
      console.warn(`[Clipper] Hook LLM analysis failed: ${err.message}`);
      return {
        has_hook: segment.hook_quality > this.minHookQuality,
        hook_type: 'unknown',
        hook_quality: segment.hook_quality || 0.5,
        suggested_hook_text: '',
        notes: `Fallback: ${err.message}`
      };
    }
  }

  /**
   * 从历史评审意见 / 全局经验 / 记忆库里解析"指定开头《…》"的硬约束。
   * 支持写法：指定开头《x》 / 开头用《x》 / 必须以《x》开头 / 《x》作为开头。
   * 返回 { text, source }，text 为空表示本期无此约束。
   */
  _resolveOpeningRule(liveVideoId, feedbackBlock = [], lessons = []) {
    const patterns = [
      /(?:指定|要求|必须|请|要)?\s*开头(?:用|要|是|为|使用)?\s*[《【"“]([^》】"”]{1,40})[》】"”]/,
      /[《【"“]([^》】"”]{1,40})[》】"”]\s*(?:作为|当|做)\s*(?:开头|片头|首段|第一段)/,
    ];
    // 窗口法兜底：书名号内容前后 12 字窗口里出现"开头/开场/首段/片头"即视为指定开头。
    // 桌面端真实写法"[桌面端指定开头]…以它为开头剪出完整爆款：《我的老师是如何训练？》"
    // 严格式匹配不到；而"《直播分享故事》…指定新开头重找"这类打回意见窗口里没有"开头"，
    // 不会被误判成"以《直播分享故事》开头"。
    const openRe = /[《【"“]([^》】"”]{1,40})[》】"”]/g;
    const pickWindow = (t) => {
      openRe.lastIndex = 0;
      let m;
      while ((m = openRe.exec(t))) {
        const win = t.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
        if (/开头|开场|首段|片头/.test(win)) return m[1].trim();
      }
      return null;
    };
    const scan = (texts) => {
      for (const raw of texts) {
        const t = String(raw || '');
        for (const re of patterns) {
          const m = t.match(re);
          if (m && m[1]) return m[1].trim();
        }
        const win = pickWindow(t);
        if (win) return win;
      }
      return null;
    };
    // 越靠后的意见越新，优先级更高 → 先扫最近的
    const texts = [
      ...(feedbackBlock || []).slice().reverse(),
      ...(lessons || []).map(l => l.text || l).reverse(),
    ];
    let text = scan(texts);
    if (!text) {
      try {
        const memOpening = this.store.getOpeningPreference?.();
        if (memOpening) text = String(memOpening).trim();
      } catch { /* ignore */ }
    }
    return { text: text || '', source: text ? 'history' : 'none' };
  }

  /**
   * 在本次直播的分段里定位"指定开头"对应的 Segment（主题名/摘要文本匹配）。
   * 命中多个时取钩子分最高、时间最靠前者；定位不到返回 null（降级为提示词约束）。
   */
  _locateOpeningSegment(segments, openingText) {
    if (!openingText || !segments?.length) return null;
    const clean = (s) => String(s || '').replace(/[《》【】"“”'\s]/g, '').toLowerCase();
    const needle = clean(openingText);
    if (!needle) return null;
    const hit = (seg) => {
      const theme = clean(seg.theme_name);
      const summary = clean(seg.transcript_summary);
      if (theme && (theme.includes(needle) || needle.includes(theme))) return true;
      if (summary.length >= 4 && (summary.includes(needle) || (needle.length >= 4 && needle.includes(summary.slice(0, 8))))) return true;
      return false;
    };
    const candidates = segments.filter(hit);
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) =>
      (b.hook_quality || 0) - (a.hook_quality || 0) || (a.start_ms || 0) - (b.start_ms || 0))[0];
  }

  /**
   * 被用户打回过的分段 id（本场 feedback 里点名的），新建项目时自动排除。
   */
  _rejectedSegmentIds(liveVideoId) {
    try {
      const fb = this.store.getFeedbackByLive?.(liveVideoId, 20) || [];
      const ids = [];
      for (const f of fb) {
        try {
          const arr = JSON.parse(f.segment_ids || '[]');
          if (Array.isArray(arr)) ids.push(...arr);
        } catch { /* ignore */ }
      }
      return ids;
    } catch {
      return [];
    }
  }

  /**
   * Resume a paused project after user answers queries.
   */
  async resumeProject(projectId) {
    const pendingQueries = this.store.getPendingUserQueries(20);
    const projectQueries = pendingQueries.filter(q => q.project_id === projectId);

    if (projectQueries.length === 0) {
      // No pending queries, proceed to clipping
      console.log(`[Clipper] No pending queries for project ${projectId}, proceeding to clip`);
      return this.clip(projectId);
    }

    console.log(`[Clipper] Project ${projectId} still has ${projectQueries.length} pending queries`);
    return { projectId, status: 'pending_review', pendingQueries: projectQueries.length };
  }
}

function extname(path) {
  const lastDot = path.lastIndexOf('.');
  return lastDot >= 0 ? path.slice(lastDot) : '';
}

export default Clipper;
