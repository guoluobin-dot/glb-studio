/**
 * Live Analyzer - 直播视频主题分段器
 *
 * Processes uploaded live stream videos from upload/live/:
 * 1. Gets ASR transcript (long-form, hours of content)
 * 2. Breaks into chunks for LLM analysis (context window limits)
 * 3. Uses Ollama to identify theme segments
 * 4. Matches segments against historical hit video themes
 * 5. Scores each segment for hook quality and viral potential
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { ASRHelper } from './asr-helper.js';
import { FFmpegHelper } from './ffmpeg-helper.js';
// 2026-09-27：大模型输出残缺的统一修复入口。本地 8B 常把 JSON 掐断成半截，
// 以前一律判"失败"→整场退化成 90 秒等分（143/144 段"待分类"就是这么来的）。
import { repairJson, pickSegments } from '../utils/json-repair.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEGMENT_SYSTEM_PROMPT = `You are Hermes Live Stream Analyzer. You analyze long live stream transcripts to identify distinct content segments/themes.

Given a transcript chunk, output strict JSON:
{
  "segments": [
    {
      "start_seconds": number,
      "end_seconds": number,
      "theme_name": "descriptive name in Chinese (max 8 chars)",
      "theme_category": "product_intro | benefit_explanation | user_testimonial | price_announcement | limited_offer | qna_interaction | storytelling | other",
      "confidence": 0.0-1.0,
      "hook_quality": 0.0-1.0,
      "key_phrases": ["phrase1"],
      "transcript_summary": "one short sentence, max 20 Chinese chars",
      "sales_intent": "high | medium | low | none",
      "emotional_tone": "excitement | urgency | trust | curiosity | calm | humor"
    }
  ]
}

Rules:
- Each segment should be 30 seconds to 3 minutes long (ideal: 1-2 minutes)
- Look for natural topic transitions, pauses, or speaker changes
- Identify segments with high sales/engagement potential
- Rate hook_quality based on opening impact (first 5 seconds of the segment)
- All output in the same language as the transcript
- OUTPUT BUDGET IS TIGHT: this machine generates ~6 tokens/sec, so every extra token is real waiting.
  Keep transcript_summary under 20 characters, exactly 1 key phrase, no extra fields, no explanation.`;

/**
 * 记忆上下文：把 Hermes 记忆库（历史爆款主题 + 创作者评审经验 + 指定开头要求）
 * 组装成可注入提示词的结构。分段 / 主题匹配 / 选段三个阶段都要用它，
 * 否则大模型是在"没有记忆"的状态下瞎切、瞎匹配、瞎选（原实现的根因之一）。
 */
/**
 * 读取"爆款结构标准"（learn-hit-standard.cjs 的产物，DeepSeek 从记忆库爆款里提炼）。
 * 10 分钟缓存。以前这份标准只在选段环节注入，分段时大模型完全不知道什么样的内容算好，
 * 于是随便切——这是"分段切不出教学骨架"的一环。
 */
export function readClipStandard() {
  try {
    const p = join(__dirname, '..', '..', 'data', 'clip-standard.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return j?.standard || null;
  } catch { return null; }
}

/**
 * 把标准渲染成分段提示词能吃的短块。
 * 刻意只取"必须包含 / 必须排除 / 教学信号"三块：分段阶段要做的是"认出好内容"，
 * 选段阶段才需要完整的句式标准（见 clipper._clipStandardBlock）。
 */
function renderStandardForSegmentation(st) {
  if (!st) return '';
  const fmt = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n).map((x) => `- ${x}`).join('\n');
  const bits = [];
  if (st.must_include?.length) bits.push(`历史爆款里【必须包含】的内容形态：\n${fmt(st.must_include, 5)}`);
  if (st.must_exclude?.length) bits.push(`历史爆款里【必须排除】的段落（命中即不要单独成段）：\n${fmt(st.must_exclude, 4)}`);
  if (st.teaching_signals?.length) bits.push(`判断"这段是不是实操教学"的信号：\n${fmt(st.teaching_signals, 6)}`);
  return bits.length ? `\n${bits.join('\n\n')}\n` : '';
}

export function buildMemoryContext(store, collection = undefined) {
  const mem = { themes: [], lessons: [], feedback: [], avoid: [], opening: '', hooks: [], openers: [], viralPoints: [], standard: '', edits: null };
  // 选中集合后，下面三块记忆（主题 / 评审经验 / 打回意见）都必须按集合取。
  // 以前全是全局池：混着所有老师的爆款和意见。后果是"我选了案例老师，
  // 结果模型学的是别人的主题和避雷点"，而且界面完全看不出来。
  // 当前全局文件夹（只作为兜底）：比如界面停在"案例老师"，但正在分析的这条直播
  // 自己绑定了"王老师"，就该用王老师的记忆 —— 传进来的 collection 优先。
  // 不传（undefined）才回落到全局，所以老调用方行为不变。
  const active = collection !== undefined
    ? (collection ? String(collection).trim() || null : null)
    : (store.activeCollection || null);

  try {
    const themes = active
      ? store.getCollectionThemeKeywords?.(active, 50) || []
      : (store.getAllHitThemes?.(50) || []).map((t) => ({
          theme: t?.theme_name,
          keywords: (() => { try { const p = JSON.parse(t?.keywords || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })(),
          confidence: t?.confidence,
        }));
    mem.themes = themes
      .filter(t => t && t.theme)
      .map(t => ({
        id: t.id,
        name: String(t.theme).slice(0, 24),
        keywords: (t.keywords || []).slice(0, 6),
        confidence: Number(t.confidence) || 0.5
      }));
  } catch { /* ignore */ }
  try {
    mem.lessons = (store.getReviewLessons?.() || [])
      .map(l => String(l?.text || l || '')).filter(Boolean).slice(-8);
  } catch { /* ignore */ }
  try {
    // 打回意见：选了集合就只看这个老师的。
    // 不然 A 老师的"不要重复呼唤"会强加到 B 老师的直播上。
    mem.feedback = active
      ? (store.getCollectionAvoidRules?.(active, 20) || [])
      : store.db.prepare('SELECT comment FROM review_feedback ORDER BY id DESC LIMIT 20')
          .all().map(r => String(r.comment || '')).filter(Boolean);
  } catch { /* ignore */ }
  /*
   * 剪辑学习档案注入（新增）。
   *
   * 在此之前，上面注入的全是 review_feedback 里的**文字意见**，
   * 而用户真正反复做的动作是：改标题、框选删字、剔除句子。
   * 这些选择已经落在 review_edits 里（cut / keep / segment / title 四类），
   * 但从没进过分析的提示词 —— 也就是说攒了这么多，
   * 下一次出片完全没受影���。这是学习闭环断掉的那一环。
   *
   * 注入三样，缺一不可：
   *   avoid   —— 反复被删的开头（避雷，正向的"不要"）
   *   prefer  —— 反复被保留的内容形态 + 认可的 hook 主题（正向的"要"）
   *   titles  —— AI 原标题 → 用户改成什么（最直接的爆款感示范）
   *   roles   —— 哪段当开场、哪段是主体、哪段收尾（结构层）
   *
   * 样本太少时**不注入**：一两条记录推不出规律，
   * 硬塞进提示词等于让模型把噪声当规则，比不注入更糟。
   */
  try {
    const arc = store.getEditArchive?.(active);
    if (arc && (arc.stage === 'warm' || arc.stage === 'rich')) {
      mem.edits = {
        avoid: (arc.promptHints?.avoid || []).slice(0, 8),
        prefer: [
          ...(arc.promptHints?.preferHooks || []).slice(0, 4).map((t) => `开场方向：${t}`),
          ...(arc.keepSamples || []).slice(0, 4).map((k) => `这类内容被认为有效：${String(k.text).slice(0, 40)}`)
        ],
        titles: (arc.titleEdits || []).slice(0, 5)
          .map((t) => `${t.oldTitle || '(AI未命名)'} → ${t.newTitle}`),
        roles: (arc.promptHints?.structure || []).slice(0, 4)
      };
      console.log(
        `[LiveAnalyzer] 剪辑档案注入：${active}（${arc.totalSamples} 条样本）`
        + `避雷 ${mem.edits.avoid.length} / 正样本 ${mem.edits.prefer.length}`
        + ` / 标题改写 ${mem.edits.titles.length}`
      );
    } else if (arc) {
      console.log(`[LiveAnalyzer] 剪辑档案样本不足（${arc.stage}/${arc.totalSamples}），不注入 —— 硬塞等于让模型把噪声当规则`);
    }
  } catch (err) {
    console.warn('[LiveAnalyzer] 读剪辑档案失败（不影响分析）:', err.message);
  }
  // 指定开头：意见里"开头/开场"附近出现《…》即视为指定开头（取最新一条）。
  // 用"窗口法"：严格式"开头《x》"匹配不到桌面端真实写法
  // "…以它为开头剪出完整爆款：《我的老师是如何训练？》"；
  // 而纯全文关键字法又会被"《直播分享故事》…指定新开头重找"这类打回意见误伤。
  // 2026-09-30 区分"撤销指令"与"指定 + 要求重剪"。
  // 真实数据里两种写法都有：
  //   [桌面端打回]《某标题》3:04:05：指定新开头重找   ← 撤销上一条指定
  //   [桌面端指定开头]必须以它为开头剪出…；指定新开头重找  ← 这条本身就是指定,"重找"是指要重剪
  // 一刀切过滤会把真指令一起丢掉(于是指定开头功能直接失效),
  // 一刀切不过滤又会拿弃段意见里的标题当指定。只有带"打回"标记的才算撤销。
  const isRevocation = (f) => /桌面端打回/.test(f) && /指定新开头|重新指定|作废|取消指定|改指定/.test(f);
  const activeFeedback = mem.feedback.filter((f) => !isRevocation(f));
  const revokedCount = mem.feedback.length - activeFeedback.length;
  if (revokedCount) {
    console.log(`[LiveAnalyzer] 记忆注入：忽略 ${revokedCount} 条撤销类指定（桌面端打回）`);
  }
  mem.feedback = activeFeedback;
  for (const f of activeFeedback) {
    // 只认"明确下达指定"的意见。弃段意见(【桌面端弃段·某老师】《标题》…)里也带《》,
    // 那是打回记录不是创作指令 —— 以前两者混在一起,于是弃段意见里的标题
    // 也被当成了"指定开头"喂给模型,换一条意见就换一个污染主题。
    if (!/指定开头/.test(f)) continue;
    const g = /《([^》]{2,60})》/g;
    let m;
    while ((m = g.exec(f))) {
      const win = f.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
      if (/开头|开场|首段|片头/.test(win)) { mem.opening = m[1].trim(); break; }
    }
    if (mem.opening) break;
  }
  // 2026-09-27：这三块是"爆款感"的真正载体——历史上它们被解析出来后就躺在库里睡觉，
  // 选段时只搬了"主题名+6 个关键词"，等于没学。现在全部搬进提示词。
  // ① 开场钩子句式
  //
  // 优先取**当前选中的 IP 老师**的钩子；没选集合才回落 genre 全局池。
  // 顺序反了的话：全局池里混着所有老师的钩子，会覆盖掉本该学的那位，
  // 表现为"我选了案例老师，结果学的是别人的钩子"，而且界面不报错。
  try {
    let picked = false;
    if (active) {
      const own = store.getCollectionHooks?.(active, 8) || [];
      if (own.length) {
        mem.hooks.push(...own.slice(0, 6).map((h) => ({
          text: String(h.text || '').slice(0, 40),
          type: 'own',
        })));
        picked = true;
      }
    }
    if (!picked) {
      for (const genre of ['tutorial', 'livestream_sales', 'other']) {
        const rows = store.getStyleProfile?.(`hooks_${genre}`);
        const arr = Array.isArray(rows) ? rows : null;
        if (arr?.length) {
          mem.hooks.push(...arr.slice(0, 3).map((h) => ({
            text: String(h.hook_text || h.text || '').slice(0, 40),
            type: String(h.hook_type || h.type || '').slice(0, 12),
          })));
        }
      }
    }
    mem.hooks = mem.hooks.filter((h) => h.text).slice(0, 6);
  } catch { /* ignore */ }
  // ② 每条历史爆款的真实开头原句 + 它为什么爆（这才是最该被模仿的部分）
  try {
    const sql = `SELECT opening_script, viral_points, title FROM hit_videos
                 WHERE analysis_status='completed'
                   AND opening_script IS NOT NULL AND opening_script <> ''
                   ${active ? 'AND collection = ?' : ''}
                 ORDER BY id DESC LIMIT 8`;
    const rows = active
      ? store.db.prepare(sql).all(active)
      : store.db.prepare(sql).all();
    for (const r of rows) {
      if (r.opening_script) mem.openers.push(String(r.opening_script).slice(0, 60));
      try {
        const vp = JSON.parse(r.viral_points || '[]');
        if (Array.isArray(vp)) {
          for (const p of vp.slice(0, 2)) if (p?.point) mem.viralPoints.push(String(p.point).slice(0, 50));
        }
      } catch { /* ignore */ }
    }
    mem.openers = mem.openers.slice(0, 5);
    mem.viralPoints = mem.viralPoints.slice(0, 5);
  } catch { /* ignore */ }
  // ③ 爆款结构标准（开场/不宜成段/教学信号的边界）
  mem.standard = renderStandardForSegmentation(readClipStandard());
  mem.avoid = mem.feedback.filter(f => /不要|别|避免|太慢|不好|没人看/.test(f)).slice(0, 5);
  return mem;
}

/**
 * 把记忆注入"分段"系统提示词：让大模型在切段时就知道哪些主题是历史爆款、
 * 哪些坑被打回过、有没有指定开头必须单独切出。
 */
export function buildSegmentSystemPrompt(mem) {
  const blocks = [];
  const themeList = (mem?.themes || []).slice(0, 15)
    .map(t => `- ${t.name}${t.keywords.length ? `（关键词：${t.keywords.join('、')}）` : ''}`);
  if (themeList.length) {
    blocks.push(`【历史爆款主题库】分段时 theme_name 应尽量对齐下列主题；内容确实命中某个主题的，单独成段并给更高 hook_quality：\n${themeList.join('\n')}`);
  }
  if (mem?.lessons?.length) {
    blocks.push(`【创作者的历史评审经验（必须遵守，违反会被打回）】\n${mem.lessons.map(l => `- ${l}`).join('\n')}`);
  }
  if (mem?.opening) {
    // 2026-09-30 重写。
    //
    // 原写法把"指定开头"当成一个主题教给模型，还要求 theme_name 就写这四个字、
    // 钩子分给到 0.95。后果:模型见到那句就切一段,见到近似句又切一段,
    // 3 小时直播里同一句话被切成 6~10 段重复,主题库被这四个字挤占,
    // 真实内容(教学/演示)反而被淹没 —— 候选列表看着全是"指定开头"。
    //
    // 现在按"创作约束"表达,而不是"主题":
    // - 明确说它不是主题名
    // - 只允许切一段,禁止重复切
    // - 语气对冲近似表述,避免模型过度匹配
    // - 钩子分只给 0.8(它确实是好开头,但不该压过真实教学爆点)
    blocks.push(
      `【创作约束 · 不是主题】创作者指定成片以这句话开头：《${mem.opening}》。\n` +
        `注意：这是剪辑要求，不是内容主题。\n` +
        `- 若本段转写中确实出现该句原话，只把它单独切一段，hook_quality 给 0.8。\n` +
        `- theme_name 必须写它实际讲的内容主题（如同期其他段落那样），绝对不要写"指定开头"。\n` +
        `- 近似表述、同义改写不算命中，不要为它们额外切段。\n` +
        `- 全场最多切这一段。`
    );
  }
  if (mem?.avoid?.length) {
    blocks.push(`【明确避免】\n${mem.avoid.map(a => `- ${a}`).join('\n')}`);
  }
  /*
   * 剪辑学习档案：把用户真实的剪辑动作摊给模型。
   *
   * 为什么要单独一块而不是并进【明确避免】：
   * 【明确避免】来自一句话一句的打回意见，是"人写的规则"；
   * 这里来自用户反复动手的选择，是"行为统计"。
   * 模型对"被反复删掉的开场"这类具体事实，比对抽象规则敏感得多。
   *
   * 三块缺一不可：
   *   avoid  —— 反面：这些开头用户反复删掉
   *   prefer —— 正面：这类内容/开场方向用户反复保留（只有 avoid 就学不到"要什么"）
   *   titles —— 标题改写对照，模型起标题时直接照着偏好走
   *   roles  —— 段落结构偏好，开场/主体/收尾各多长
   */
  if (mem?.edits?.avoid?.length) {
    blocks.push(
      `【用户反复删掉的开场】（从剪辑操作里统计出来的，不是猜测）` +
      `选段时避开这种起手式：\n${mem.edits.avoid.map((a) => `- 「${a}…」`).join('\n')}`
    );
  }
  if (mem?.edits?.prefer?.length) {
    blocks.push(
      `【用户反复保留的内容形态】这类内容被认为有效，选段时优先保留：\n` +
      mem.edits.prefer.map((p) => `- ${p}`).join('\n')
    );
  }
  if (mem?.edits?.titles?.length) {
    blocks.push(
      `【标题偏好：机器起 → 用户改成】给 theme_name 起名时往后者靠：\n` +
      mem.edits.titles.map((t) => `- ${t}`).join('\n')
    );
  }
  if (mem?.edits?.roles?.length) {
    blocks.push(
      `【用户认可的段落结构】该老师认可的粗剪骨架（角色·次数·均分）：\n` +
      mem.edits.roles.map((r) => `- ${r}`).join('\n')
    );
  }
  // 2026-09-27：把历史爆款的"开头原句 / 为什么爆 / 钩子句式"摊给模型。
  // 以前它只知道主题名，无从判断什么样的内容算好——这就是"筛不出爆款感"的根因。
  if (mem?.openers?.length) {
    blocks.push(`【历史爆款的真实开头原句】本场内容若与下列句式同类（反常识 / 翻车对比 / 强承诺 / 悬念提问），钩子分给到 0.75 以上：\n${mem.openers.map((o) => `- 「${o}」`).join('\n')}`);
  }
  if (mem?.hooks?.length) {
    blocks.push(`【已验证有效的钩子类型】优先把这类句子所在的 boundaries 单独切一段：` +
      mem.hooks.map((h) => `[${h.type || '钩子'}]${h.text}`).join(' / '));
  }
  if (mem?.viralPoints?.length) {
    blocks.push(`【这些构件让历史视频爆了】切段时注意保留具备下列特征的内容：\n${mem.viralPoints.map((p) => `- ${p}`).join('\n')}`);
  }
  if (mem?.standard) {
    blocks.push(`【本主播爆款结构标准（来自记忆库学习）】\n${mem.standard}`);
  }
  if (!blocks.length) return SEGMENT_SYSTEM_PROMPT;
  return `${SEGMENT_SYSTEM_PROMPT}

=== 记忆参考（来自 Hermes 记忆库，优先级高于你的个人判断）===
${blocks.join('\n\n')}`;
}

const THEME_MATCH_PROMPT = `You are a viral video matching expert. Given a live stream segment description and a list of historical hit video themes, determine which historical themes this segment best matches.

Output strict JSON:
{
  "matched_themes": [
    {
      "theme_id": number,
      "theme_name": "string",
      "similarity_score": 0.0-1.0,
      "reason": "why it matches"
    }
  ],
  "best_match_theme_id": number or null,
  "overall_viral_potential": 0.0-1.0,
  "recommended_action": "clip_immediately | consider_clipping | skip | needs_user_review"
}

Rules:
- A segment can match multiple themes
- If no good match exists, set best_match_theme_id to null
- viral_potential considers: theme match strength, hook quality, sales intent, emotional impact`;

export class LiveAnalyzer {
  constructor(ollama, store, config) {
    this.ollama = ollama;
    this.store = store;
    this.config = config;
    this.ffmpeg = new FFmpegHelper();
    this.asr = new ASRHelper(config);
    this.liveDir = config.upload?.liveDir || join(__dirname, '..', '..', 'upload', 'live');
    this.tempDir = config.upload?.tempDir || join(__dirname, '..', '..', 'upload', 'temp');
    // LLM 调用预算：本机 8B 实测约 约 69 tok/s(2026-09-30 实测)，参数必须围绕这个真实吞吐来定
    // （原来 maxTokens 4096 + timeout 180s，物理上不可能返回完整 JSON）
    this.segmentChunkSeconds = config.performance?.segmentChunkSeconds || 240;
    // 2026-09-30 实测校准：本机 8B 实际约 69 tok/s（不是早期注释估的 约 69 tok/s(2026-09-30 实测)，
    // 那个数字来自更小/更早的模型，留着会把批量和超时都调得过保守，白白慢十倍）。
    // 匹配阶段每段约 140 token 输出，6 段一批 → 150 段要 25 次串行调用。
    // 69 tok/s 下 20 段一批完全写得完（20×140≈2800 token ≈ 40s），
    // 批次数从 25 降到 8，整体墙钟时间跟着降。
    this.matchBatchSize = config.performance?.matchBatchSize || 20;
    this.llmTimeoutMs = config.performance?.llmTimeoutMs || 600000;
    // 预筛参数（2026-09-30 加）：本机 8B 约 约 69 tok/s(2026-09-30 实测)，能少送一块就少等一分。
    // 默认开着；阈值调到 0 可关闭，退回"全部分析"的旧行为。
    this.prescreen = config.performance?.prescreen !== false;
    this.prescreenMinChars = Number(config.performance?.prescreenMinChars || 260);
    this.prescreenMinDensity = Number(config.performance?.prescreenMinDensity || 1.6);
    // 2026-09-27：输出预算按通道分档。
    // 本地 8B 约 5tok/s，给小了 JSON 会被掐断成半截（历史上整批报废 → 90 秒等分兜底），
    // 而超时预算有 10 分钟，翻倍输出只多花 ~20 秒，换一次成功远比省这点时间划算。
    // API 大模型秒级返回，给足 2000 让它从容写全。
    const provider = String(config?.llm?.provider || process.env.HERMES_LLM || 'ollama').toLowerCase();
    this.isCloudLlm = provider === 'deepseek' || provider === 'zen';
    this.segmentMaxTokens = this.isCloudLlm
      ? (config.performance?.llmMaxOutputTokensCloud || 2000)
      : (config.performance?.llmMaxOutputTokensLocal || 2400);
    // 每次 analyze 的体检结果：分段到底真跑通了，还是悄悄走了兜底。
    // 以前失败被 console.warn 吞掉，界面显示"分析完成"，没人知道结果不可信。
    this.lastHealth = null;
  }

  /** 开启一轮新的体检计数 */
  _newHealth() {
    return {
      chunks: 0,          // 总共切成多少块交给 LLM
      chunkSkipped: 0,    // 被预筛跳过(判定无价值,没进 GPU)的块数
      chunkOk: 0,         // LLM 成功返回可解析结构的块数
      chunkFailed: 0,     // 彻底失败的块数
      chunkRepaired: 0,   // JSON 残缺但被修复层救回的块数
      llmSegments: 0,     // LLM 真实切出的段数
      fallbackSegments: 0,// 90 秒兜底等分产生的段数
      fallbackSplit: false,
      llmMatched: 0,      // LLM 匹配命中的段数
      keywordMatched: 0,  // 关键词兜底命中的段数
      pendingTheme: 0,    // 最终仍未分类的段数
      asrSuspect: 0,      // ASR 疑似错字计数
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Main entry: analyze a live stream video.
   */
  async analyze(videoPath, opts = {}) {
    const videoName = basename(videoPath);
    console.log(`[LiveAnalyzer] Analyzing live stream: ${videoName}`);

    let liveVideoId = null;
    // 2026-09-27：体检开关。以前 LLM 失败被吞掉，界面照样显示"分析完成"，
    // 结果全是 90 秒等分的无标签数据也无人知晓——这里把每一次降级都记下来。
    const health = (this.lastHealth = this._newHealth());

    /**
     * 取消检查。每个 chunk 之间都要问一次。
     *
     * 为什么必须真的检查：一场 2-3 小时的直播，分析要跑 30~60 分钟。
     * 桌面端那个「取消」按钮原本是假的（实际调的是"重新分析"），
     * 用户点"取消"之后只能继续等半小时——或者更糟：两份分析并发跑，
     * 各自 DELETE FROM live_segments，结果互相覆盖。
     *
     * 注意不能只在开头查一次：ffmpeg 和 LLM 都在循环里，
     * 中途不查的话用户点了取消还是要等整个流程走完。
     */
    const signal = opts.signal || null;
    // 存到实例上，让深层（_analyzeChunkOnce / 主题匹配）不用一路改签名也能拿到。
    // 这些方法被多处复用（含调度器自动分析），走实例字段是最小改动面。
    this._abortSignal = signal;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        const err = new Error('分析已被用户取消');
        err.name = 'AbortError';
        err.userCancelled = true;
        throw err;
      }
    };
    throwIfAborted();

    try {
      // Register live video
      const fileSize = existsSync(videoPath) ? (await import('fs')).statSync(videoPath).size : 0;
      liveVideoId = this.store.upsertLiveVideo(videoPath, {
        videoName,
        fileSize,
        analysisStatus: 'analyzing'
      });
      // 幂等：重分析后需要清掉旧分段，避免重复累积。
      //
      // 2026-09-30 改为"分析完再清"。
      // 原来在这里就 DELETE,而分析要跑 30~60 分钟(3 小时直播)。
      // 中途失败、进程被杀、或用户关窗,结果就是旧分段已被删、新分段没写完 ——
      // 数据全丢,界面变空白且无法恢复(我们就这么丢过一次 209 段)。
      // 现在把清理挪到所有分段写库之前一刻,先算后写。
      //
      // 另有保护:如果这条直播的旧分段正被「未完成的粗剪项目」引用,
      // 直接清空会让那些项目的 selected_segments 全部指向不存在的 segment id
      // (切片取不到、字幕错位)。有引用时保留旧段。
      const purgeOldSegments = () => {
        let hasActiveProjects = false;
        try {
          hasActiveProjects = !!this.store.db.prepare(
            "SELECT 1 FROM clip_projects WHERE live_video_id = ? AND status NOT IN ('finished','exported','failed','cancelled') LIMIT 1"
          ).get(liveVideoId);
        } catch { /* 表结构差异时按无引用处理 */ }
        if (hasActiveProjects) {
          // 保留旧行(不能让项目引用悬空),但必须标成 superseded。
          // 不标的话新旧分段都是 draft,同一个 segment_index 会有两条,
          // 按 index 取分段时随机命中上一轮内容 —— 剪出来不对,界面还不报错。
          // 查询侧一律只取 draft,所以标记不影响老项目切片。
          try {
            this.store.db.prepare(
              "UPDATE live_segments SET status = 'superseded' WHERE live_video_id = ? AND status = 'draft'"
            ).run(liveVideoId);
          } catch { /* 标不了也不能让分析失败 */ }
          console.warn(`[LiveAnalyzer] 该直播有未完成的粗剪项目，旧分段标为 superseded 保留（避免引用悬空）：${videoName}`);
          return false;
        }
        this.store.db.prepare('DELETE FROM live_segments WHERE live_video_id = ?').run(liveVideoId);
        return true;
      };

      // Step 1: Get transcript
      console.log(`[LiveAnalyzer] Getting transcript...`);
      // signal 透传：不传的话取消时 ffmpeg/sherpa 会一直跑到底
      const asrResult = await this.asr.getTranscript(videoPath, { signal });
      if (asrResult.transcript.length === 0) {
        this.store.upsertLiveVideo(videoPath, {
          analysisStatus: 'failed',
          asrPath: asrResult.rawPath
        });
        console.warn(`[LiveAnalyzer] No transcript for ${videoName}`);
        return { liveVideoId, segments: [] };
      }
      console.log(`[LiveAnalyzer] Transcript: ${asrResult.source}, ${asrResult.transcript.length} segments`);
      // ASR 是整场里最慢的一段（3 小时直播常要十几分钟）。
      // 转写完、还没进 LLM 循环时再查一次：用户在这段等待里点"取消"，
      // 不查的话接下来还要跑几十个 chunk。
      throwIfAborted();

      // 告诉 LLM 代理"这一轮在处理整场直播"，引擎分派要按整场而不是按分片。
      // 不交代的话，proxy 只能看到单次 240s 分片的文本量（几百字），
      // 每块都会被判成短片段，云端一次都用不上 —— provider=auto 等于白配。
      const totalChars = asrResult.transcript.reduce((n, s) => n + String(s?.text ?? '').length, 0);
      const lastSeg = asrResult.transcript[asrResult.transcript.length - 1];
      const totalSec = Math.max(0, Math.round(Number(lastSeg?.end ?? lastSeg?.offset ?? 0) / 1000));
      try {
        this.ollama?.setTaskScope?.({ durationSec: totalSec, transcriptChars: totalChars });
        if (this.ollama?.usingCloud) {
          console.log(`[LiveAnalyzer] 整场形态: ${totalChars} 字 / ${Math.round(totalSec / 60)} 分钟 -> 走云端长上下文（${this.ollama.lastEngine}）`);
        }
      } catch { /* 代理不支持就按本地跑，不影响分析 */ }

      this.store.upsertLiveVideo(videoPath, {
        asrPath: asrResult.rawPath
      });

      // Step 2: Chunk transcript for LLM
      // 240s/片（原 600s）：本机 8B 约 约 69 tok/s(2026-09-30 实测)，600s 的转写要求模型输出 2000+ tokens，
      // 物理上必然超时报废。缩短分片，让单次输出控制在一千 token 量级。
      // 注意：以前直接把 segmentChunkSeconds 当第二参传给 chunkTranscript，而那个参数是
      // "最大词数"不是秒数，结果一直是 3000 字符先触顶、按字符切，这条配置等于没生效。
      // 这里先按时间窗切，再交给 chunkTranscript 按词数/字符数兜底。
      const chunkSec = Number(this.segmentChunkSeconds) || 240;
      const byTime = [];
      let bucket = [];
      let bucketStart = null;
      for (const seg of asrResult.transcript) {
        const ms = seg.start_ms ?? seg.start ?? 0;
        if (bucketStart === null) bucketStart = ms;
        if (ms - bucketStart > chunkSec * 1000 && bucket.length) {
          byTime.push(bucket);
          bucket = [];
          bucketStart = ms;
        }
        bucket.push(seg);
      }
      if (bucket.length) byTime.push(bucket);
      const chunks = byTime.flatMap((part) => ASRHelper.chunkTranscript(part));
      console.log(`[LiveAnalyzer] Transcript chunked into ${chunks.length} parts (${chunkSec}s/part)`);

      // ★ 记忆注入点 1/3：分段前先把 Hermes 记忆库读出来（爆款主题 + 评审经验 + 指定开头），
      // 随分段系统提示词一起喂给 Ollama，让"切哪里、怎么命名、钩子打几分"直接受记忆影响
      //
      // 用这条直播自己绑定的老师，而不是全局当前文件夹：
      // 导入案例老师的素材时界面可能正停在王老师身上，用错记忆不会报错，
      // 只是选出来的片段"不对味"，事后根本查不出是谁的问题。
      const ownCollection = this.store.getLiveVideoCollection?.(liveVideoId) ?? undefined;
      const mem = buildMemoryContext(this.store, ownCollection);
      console.log(`[LiveAnalyzer] 记忆注入：${ownCollection ? `归属「${ownCollection}」` : '未绑定文件夹(用全局)'}` +
        ` 爆款主题 ${mem.themes.length} 个、评审经验 ${mem.lessons.length} 条、指定开头 ${mem.opening ? `《${mem.opening}》` : '无'}`);

      // Step 3: Analyze each chunk for theme segments
      // 注意：LLM 只返回相对 chunk 起始的偏移秒，调用方再换算成绝对时间
      // （LLM 不知道全文时间轴，直接让它报绝对秒会幻觉，如全报 0~180s）
      let allSegments = [];
      let failedChunks = 0;
      let skippedChunks = 0;
      health.chunks = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        // 每块之前查一次取消。3 小时直播几十个块，
        // 不查的话用户点了取消还得等几十分钟。
        throwIfAborted();
        const chunkText = ASRHelper.transcriptToText(chunks[i]);

        // 预筛：本地信号判定无价值就直接跳过,不进 GPU 队列。
        // 这是把 3 小时直播从"几十分钟"压到"几分钟"的关键一刀。
        const pre = this.prescreen
          ? this._prescreenChunk(chunks[i], chunkText, mem)
          : { keep: true, reason: '预筛已关闭', density: 0, hits: 0 };
        if (!pre.keep) {
          skippedChunks++;
          health.chunkSkipped = (health.chunkSkipped || 0) + 1;
          console.log(`[LiveAnalyzer] 跳过块 ${i + 1}/${chunks.length}: ${pre.reason}`);
          continue;
        }

        console.log(`[LiveAnalyzer] Analyzing chunk ${i + 1}/${chunks.length} (${chunkText.length} chars, ${pre.reason})`);

        const first = chunks[i][0] || {};
        const last = chunks[i][chunks[i].length - 1] || {};
        const chunkStartSec = (first.start ?? first.start_ms ?? 0) / 1000;
        const chunkEndSec = Math.max((last.end ?? last.end_ms ?? 0) / 1000, chunkStartSec + 1);
        const chunkSegments = await this._analyzeChunk(chunks[i], i, chunkStartSec, chunkEndSec, mem, signal);
        if (chunkSegments.length > 0) {
          health.chunkOk++;
          health.llmSegments += chunkSegments.length;
        } else {
          health.chunkFailed++;
          failedChunks++;
        }
        for (const seg of chunkSegments) {
          // 相对偏移 → 绝对秒，并钳制在 chunk 范围内
          seg.start_seconds = Math.min(Math.max(chunkStartSec + (seg.start_seconds || 0), chunkStartSec), chunkEndSec);
          seg.end_seconds = Math.min(Math.max(chunkStartSec + (seg.end_seconds || seg.start_seconds + 30), chunkStartSec + 1), chunkEndSec);
          if (seg.end_seconds <= seg.start_seconds) seg.end_seconds = Math.min(seg.start_seconds + 30, chunkEndSec);
          allSegments.push(seg);
        }
      }

      // Step 4: Merge overlapping/adjacent segments
      allSegments = this._mergeSegments(allSegments);
      console.log(`[LiveAnalyzer] Merged to ${allSegments.length} distinct segments`);

      // 兜底：LLM 一个都没切出来但转写非空时，按 90s 等分兜底，保证粗剪永远有料可剪。
      // 注意：兜底不等于成功——这些段主题全是"待分类"、钩子分写死 0.5，选段模型拿到等于瞎选。
      // 必须记进体检结果并在界面报警，不能像以前那样悄悄过去。
      if (allSegments.length === 0 && asrResult.transcript.length > 0) {
        allSegments = this._fallbackSplit(asrResult.transcript);
        health.fallbackSplit = true;
        health.fallbackSegments = allSegments.length;
        console.warn(`[LiveAnalyzer] ⚠ LLM 一个分段都没切出来，已按 ${asrResult.transcript.length ? 90 : 90}s 等分兜底成 ${allSegments.length} 段（主题=待分类，钩子分=0.5，这批结果不可信）`);
      }

      // Step 5: ★ 记忆注入点 2/3 —— 用记忆库里累积的爆款主题做匹配，
      // 并把评审经验（如"指定开头/钩子不够炸"）一并传给匹配器参与打分
      const hitThemes = this.store.getAllHitThemes(50);
      console.log(`[LiveAnalyzer] Matching ${allSegments.length} segments against ${hitThemes.length} historical themes (batch=${this.matchBatchSize})`);
      await this._matchAllWithHitThemes(allSegments, hitThemes, mem);

      const matchedByLlm = allSegments.filter(s => s._matchSource === 'llm').length;
      const kwFallback = allSegments.filter(s => s._matchSource === 'keyword').length;
      const pending = allSegments.filter(s => !s.theme_name || s.theme_name === '待分类').length;
      health.llmMatched = matchedByLlm;
      health.keywordMatched = kwFallback;
      health.pendingTheme = pending;
      console.log(`[LiveAnalyzer] 记忆匹配统计：LLM 命中 ${matchedByLlm} 段 / 关键词兜底 ${kwFallback} 段 / 未分类 ${pending} 段；分段失败 chunk ${failedChunks} 个`);

      // Step 5.5: 清洗污染段
      //
      // 提示词里已经不再教模型用"指定开头"当主题了,但不能只靠提示词 ——
      // 模型偶尔仍会照旧输出,或者历史数据里已经有这种段。
      // 入库前强制纠正,并把重复的指定开头段合并掉,否则候选列表会被它淹没。
      this._sanitizeSegments(allSegments, mem, health);

      // Step 5.6: 剔除切不出来的段（写库之前）
      //
      // LLM 偶尔会对连续几段报同一个时间戳（实测一条两小时直播里 9 段 start==end）。
      // 这种段切不出任何画面 —— 界面上是"0 秒"候选，用户点了没反应，
      // 比不给更让人困惑。
      //
      // 必须在这里做（写库前），而不是只在返回结果里过滤：
      // 写库循环用的是 allSegments，只过滤返回值的话零长段照样进库，
      // 下次重分析又被它们污染。之前就是这么漏的。
      const segCountBefore = allSegments.length;
      allSegments = allSegments.filter(
        (seg) => Number(seg.end_seconds ?? 0) > Number(seg.start_seconds ?? 0)
      );
      const droppedZero = segCountBefore - allSegments.length;
      if (droppedZero > 0) {
        console.warn(`[LiveAnalyzer] 剔除 ${droppedZero} 个零长段（LLM 报了相同的起止时间，切不出来）`);
        health.zeroLengthDropped = droppedZero;
      }

      // 到这里全部分析已完成、结果已在内存里,现在才清旧段。
      // 放在这一步之前清,任何中断都会丢数据(见前面注释)。
      // 写库是最后一步，也是最不能被打断的一步：
      // purgeOldSegments() 会 DELETE FROM live_segments，如果在它之后被取消，
      // 旧段已删、新段没写完 —— 数据全丢，界面变空白且无法恢复
      //（我们就这么丢过一次 209 段）。所以这里必须在删之前查一次。
      throwIfAborted();
      if (allSegments.length > 0) purgeOldSegments();

      // Step 6: Store segments
      let segIndex = 0;
      for (const seg of allSegments) {
        this.store.addLiveSegment({
          liveVideoId,
          segmentIndex: segIndex++,
          startMs: Math.round(seg.start_seconds * 1000),
          endMs: Math.round(seg.end_seconds * 1000),
          durationMs: Math.round((seg.end_seconds - seg.start_seconds) * 1000),
          themeName: seg.theme_name,
          themeConfidence: seg.confidence,
          matchedHitThemes: seg.matched_themes,
          hookQuality: seg.hook_quality,
          peakCount: 0,
          transcriptSummary: seg.transcript_summary,
          status: 'draft'
        });
      }

      // Step 7: Update live video record（体检结果一并入库，供界面报警）
      health.finishedAt = new Date().toISOString();
      health.grade = this._gradeHealth(health, allSegments.length);
      this.store.upsertLiveVideo(videoPath, {
        analysisStatus: 'completed',
        segmentCount: allSegments.length,
        analysisHealth: JSON.stringify(health),
        analyzedAt: new Date().toISOString()
      });

      const g = health.grade;
      const tag = g === 'ok' ? '✓' : (g === 'warn' ? '⚠' : '✗');
      const skipped = health.chunkSkipped || 0;
      const analyzed = health.chunks - skipped;
      const savedPct = health.chunks > 0 ? Math.round((skipped / health.chunks) * 100) : 0;
      console.log(`[LiveAnalyzer] ${tag} Complete: ${allSegments.length} segments, ${hitThemes.length} theme matches`);
      console.log(`[LiveAnalyzer] ${tag} 体检：grade=${g} 分段成功chunk=${health.chunkOk}/${analyzed}（修复救回${health.chunkRepaired}）` +
        ` 预筛跳过=${skipped}/${health.chunks}（省 ${savedPct}% GPU 时间）` +
        ` LLM切出=${health.llmSegments}段 兜底等分=${health.fallbackSegments}段` +
        ` 记忆LLM命中=${health.llmMatched} 关键词兜底=${health.keywordMatched} 未分类=${health.pendingTheme}`);
      if (g !== 'ok') {
        console.warn(`[LiveAnalyzer] ${tag} 本场分析结果可信度不足（${g}）：${this._healthAdvice(health)}`);
      }
      // 2026-09-30 返回归一化后的段,而不是 LLM 原始对象。
      //
      // 原来直接返回 allSegments,那些对象是 LLM 输出的 snake_case
      // (start_seconds / theme_name / hook_quality),
      // 而客户端按驼峰读(startMs / themeName / hookQuality)——
      // 全部 undefined,界面上就是 210 条"未命名片段 / 手动 / 0.0s→0.0s"。
      // 数据库里数据是好的,坏的是这个契约。
      // 这里与 addLiveSegment 用同一套映射,保证"接口看到什么,库里就是什么"。
      // 零长段已经在写库前剔除(allSegments 里就没有了),所以这里直接 map,
      // 序号也是连续的 —— 时间轴偏移按序号累加,断号会算错。
      const normalized = allSegments.map((seg, i) => ({
        segmentIndex: i,
        startMs: Math.round(Number(seg.start_seconds ?? 0) * 1000),
        endMs: Math.round(Number(seg.end_seconds ?? 0) * 1000),
        durationMs: Math.round((Number(seg.end_seconds ?? 0) - Number(seg.start_seconds ?? 0)) * 1000),
        themeName: seg.theme_name,
        themeConfidence: seg.confidence,
        matchedHitThemes: seg.matched_hit_themes,
        hookQuality: seg.hook_quality,
        peakCount: 0,
        transcriptSummary: seg.transcript_summary,
        status: 'draft'
      }));
      return { liveVideoId, segments: normalized, health };

    } catch (err) {
      // 用户取消不是失败。
      //
      // 以前没有这个分支：取消被当成 error 处理，于是 analysis_status 被写成
      // 'failed'、体检记成 grade=error。用户主动取消却看到"失败"，
      // 下次进调度器还会因为 status 不是 completed 把它重新排进队列白跑一遍。
      // 更麻烦的是旧分段如果已经被 purge 掉，这条直播就既没有结果也没有状态解释。
      if (err?.userCancelled || err?.name === 'AbortError') {
        console.log(`[LiveAnalyzer] ${videoName} 已被用户取消`);
        try {
          health.finishedAt = new Date().toISOString();
          health.grade = 'cancelled';
          health.error = '用户取消';
          this.store.upsertLiveVideo(videoPath, {
            analysisStatus: liveVideoId ? 'pending' : 'pending',
            analysisHealth: health
          });
        } catch { /* ignore */ }
        const cancelled = new Error('分析已被取消');
        cancelled.name = 'AbortError';
        cancelled.userCancelled = true;
        cancelled.liveVideoId = liveVideoId;
        throw cancelled;
      }
      console.error(`[LiveAnalyzer] Failed for ${videoName}:`, err.message);
      // 失败也要留下体检记录：否则调度器重试时无法判断上次是崩了还是降级的
      try {
        health.finishedAt = new Date().toISOString();
        health.grade = 'error';
        health.error = String(err.message).slice(0, 300);
        this.store.upsertLiveVideo(videoPath, { analysisHealth: JSON.stringify(health) });
      } catch { /* 记不进去也不能影响主流程报错 */ }
      if (liveVideoId) {
        this.store.upsertLiveVideo(videoPath, {
          analysisStatus: 'failed'
        });
      }
      throw err;
    } finally {
      // 必须复原：作用域不清的话，下一个短片段任务会继承这一场的"长直播"判断，
      // 被白白送去云端烧额度。成功、失败、空 transcript 三条出口都要清。
      try { this.ollama?.endTask?.(); } catch { /* ignore */ }
      // 也要清掉取消信号：留在实例上会让下一次分析（哪怕是几小时后调度器自动跑的）
      // 一进 LLM 就被一个早已 aborted 的 signal 打断，等于分析功能彻底瘫掉。
      this._abortSignal = null;
    }
  }

  /**
   * 给这轮分析打健康分。
   * - error：整体崩了
   * - bad ：整场走兜底等分，或 >30% 的块失败（以前这种情况下界面还显示"分析完成"）
   * - warn：有失败但没有失控（10%~30%），或过半段没分类
   * - ok  ：正常
   */
  _gradeHealth(h, totalSegments) {
    if (h.error) return 'error';
    if (h.fallbackSplit) return 'bad';
    if (h.chunks > 0 && h.chunkFailed / h.chunks > 0.3) return 'bad';
    if (h.chunks > 0 && h.chunkFailed / h.chunks > 0.1) return 'warn';
    if (totalSegments > 0 && h.pendingTheme / totalSegments > 0.5) return 'warn';
    return 'ok';
  }

  /** 体检不通过时给一句人话建议，直接打到日志和界面上 */
  _healthAdvice(h) {
    const bits = [];
    if (h.fallbackSplit) bits.push('LLM 一个分段都没切出来，全片退化成 90 秒等分');
    if (h.chunks > 0 && h.chunkFailed > 0) {
      bits.push(`${h.chunkFailed}/${h.chunks} 个分片调用失败`);
    }
    if (h.pendingTheme > 0) bits.push(`${h.pendingTheme} 段没有主题标签`);
    bits.push(h.chunkFailed > 0
      ? '建议：确认大模型通道可用（本地 GPU 是否被占满 / API Key 是否有效），然后点"重新分析"'
      : '建议：补充爆款素材后重跑');
    return bits.join('；');
  }

  /**
   * 单次分段调用。失败（超时/JSON 被截断）时不再直接吞掉整段素材：
   * 把 chunk 对半切再试一次 —— 输出量减半后基本都能在超时预算内拿到完整 JSON。
   */
  async _analyzeChunk(chunk, chunkIndex, chunkStartSec = 0, chunkEndSec = 0, mem = null, signal = null) {
    const segs = await this._analyzeChunkOnce(chunk, chunkIndex, chunkStartSec, chunkEndSec, mem, signal);
    // 取消不能被"这一块没结果"当成正常失败：拆两半重试是最容易漏掉检查点的地方，
    // 用户点了取消之后它还会再发两次 LLM 请求。
    if (signal?.aborted) {
      const e = new Error('分析已被取消');
      e.name = 'AbortError';
      e.userCancelled = true;
      throw e;
    }
    if (segs.length > 0) return segs;

    const span = chunkEndSec - chunkStartSec;
    if (span > 120 && chunk.length > 4) {
      const half = Math.ceil(chunk.length / 2);
      const parts = [chunk.slice(0, half), chunk.slice(half)];
      const firstOfB = parts[1][0] || {};
      const mid = Math.max((firstOfB.start ?? firstOfB.start_ms ?? 0) / 1000, chunkStartSec + 1);
      console.warn(`[LiveAnalyzer] chunk ${chunkIndex} 首轮无结果，切成两半重试（${Math.round(chunkStartSec)}s-${Math.round(mid)}s / ${Math.round(mid)}s-${Math.round(chunkEndSec)}s）`);
      const out = [];
      out.push(...await this._analyzeChunkOnce(parts[0], chunkIndex, chunkStartSec, Math.min(mid, chunkEndSec), mem, signal));
      if (signal?.aborted) {
        const e = new Error('分析已被取消');
        e.name = 'AbortError';
        e.userCancelled = true;
        throw e;
      }
      out.push(...await this._analyzeChunkOnce(parts[1], chunkIndex, Math.min(mid, chunkEndSec), Math.max(chunkEndSec, mid + 1), mem, signal));
      return out;
    }
    return [];
  }

  /** 预筛用的时间跨度（秒）：块内首句 start 到末句 end，最少 1 秒 */
  _prescreenSpanSec(chunk) {
    const first = chunk[0] || {};
    const last = chunk[chunk.length - 1] || {};
    const s = (first.start ?? first.start_ms ?? 0) / 1000;
    const e = (last.end ?? last.end_ms ?? 0) / 1000;
    return Math.max(1, e - s);
  }

  /**
   * 零成本预筛：在送 LLM 之前，先用不需要模型的信号判断"这块值不值得分析"。
   *
   * 为什么必须有这一步（2026-09-30 实测）：
   * 本机 8B 只有 约 69 tok/s(2026-09-30 实测)。一场 3 小时直播切成 47 块，每块要生成数百 token 的 JSON，
   * 光生成就要几十分钟。而直播里真正"能剪"的内容通常只占两三成，
   * 剩下的是寒暄、等待、重复、闲聊——这些块送进模型纯属烧时间。
   *
   * 判据只用本地可算的量，不调用任何模型：
   * 1) 信息密度：单位时间的字数。低于阈值基本是沉默或废话。
   * 2) 记忆命中：命中记忆库里爆款主题关键词的块更可能有价值。
   * 3) 重复度：同一句话反复出现 = 循环啰嗦，直接跳过。
   *
   * 判不出来时才保守放行——宁可多分析一块，也不要漏掉爆点。
   *
   * @returns {{keep: boolean, reason: string, density: number, hits: number}}
   */
  _prescreenChunk(chunk, chunkText, mem) {
    const minChars = this.prescreenMinChars;
    const chars = chunkText.length;

    /*
     * 练声类教学不能按"废话"筛掉（2026-10-06 修）
     * ─────────────────────────────────────────────
     * 下面三条判据（密度过低 / 语速过缓 / 循环啰嗦）本意是滤掉寒暄和等待，
     * 但练声教学天然踩中全部三条：
     *   - 内容重复：老师带一个音节，学生跟唱，同一句重复几十遍
     *   - 语速慢：练声必须慢唱，"语速过缓"必然命中
     *   - 字数少：一个音节反复，信息密度算下来极低
     *
     * 结果就是**整类练声直播永远学不进记忆** —— 不是学得差，
     * 是压根没被送去学。所以这里先看是不是练声，是就放行。
     *
     * 判据取"明确的练声信号"而不是"重复得像练声"：宁可放过一些
     * 真的重复内容，也不能把一整类教学内容判死。
     */
    const vocal = detectVocalTraining(chunkText);
    if (vocal) {
      return {
        keep: true,
        reason: `练声教学内容（${vocal}），按教学内容放行，不按啰嗦/慢速筛掉`,
        density: chars / this._prescreenSpanSec(chunk),
        hits: 0,
        vocal: true,
      };
    }

    // 记忆库主题关键词（没有主题就不做关键词判据）
    const kw = [];
    for (const t of mem?.themes || []) {
      for (const k of t.keywords || []) if (k && k.length >= 2) kw.push(String(k));
    }
    const hits = kw.length ? kw.filter((k) => chunkText.includes(k)).length : 0;

    const spanSec = this._prescreenSpanSec(chunk);
    const density = chars / spanSec; // 字/秒

    // 重复度：转写是一整行空格连接，没有换行——按标点切成句再算指纹。
    // （早先按行切分导致这段永远是单行，判重形同虚设，循环啰嗦照样进 GPU。）
    //
    // 判据顺序很重要：循环啰嗦天生语速低（同一句反复），
    // 如果先判密度就会在"语速过低"上被拦下，永远走不到重复度判断，
    // 理由还会误导成"疑似沉默"。所以先看重复——它是更强的信号。
    const sentences = chunkText
      .split(/[。？！!?\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    let dup = 0;
    if (sentences.length >= 8) {
      dup = 1 - new Set(sentences).size / sentences.length;
      if (dup > 0.45) {
        return { keep: false, reason: `内容重复度 ${Math.round(dup * 100)}%,疑似循环`, density, hits };
      }
    }

    // 1) 密度过低：沉默、纯寒暄、纯等待
    if (chars < minChars) {
      return { keep: false, reason: `文本仅 ${chars} 字,信息密度不足`, density, hits };
    }
    if (density < this.prescreenMinDensity) {
      return { keep: false, reason: `语速过低(${density.toFixed(1)} 字/秒),疑似沉默/闲聊`, density, hits };
    }

    return { keep: true, reason: `密度 ${density.toFixed(1)} 字/秒${kw.length ? `,命中 ${hits} 个主题词` : ''}`, density, hits };
  }

  async _analyzeChunkOnce(chunk, chunkIndex, chunkStartSec = 0, chunkEndSec = 0, mem = null, signal = null) {
    // 必须给带时间戳的文本：以前给纯文本却让 LLM 报 start/end 秒，时间全靠 hallucinating。
    const chunkText = ASRHelper.transcriptToTimestampedText(chunk);

    const userPrompt = `Analyze this live stream transcript segment.
This chunk covers absolute video time ${Math.round(chunkStartSec)}s to ${Math.round(chunkEndSec)}s.

Transcript:
---
${chunkText}
---

Identify distinct content segments within this chunk. Output as specified JSON.
IMPORTANT: start_seconds/end_seconds must be RELATIVE offsets from the chunk start (0 = chunk beginning), NOT absolute video time. Keep them within 0 to ${Math.max(1, Math.round(chunkEndSec - chunkStartSec))} seconds.

输出约束（本机算力有限，必须遵守，否则整批结果会被判废）：
- JSON 紧凑输出，不要缩进换行、不要任何解释文字
- transcript_summary 控制在 40 字以内，key_phrases 最多 3 个
- 命中上面"记忆参考"里爆款主题的内容，theme_name 直接沿用该主题名`;

    try {
      // 2026-09-27：parseJson 关掉，自己走 repairJson。
      // 客户端侧的 parseJson 遇到半截 JSON 直接把原文当字符串返回，调用方只能判"失败"；
      // 交给修复层后，"20 段里救回 18 段"和"全废"是两种完全不同的结果，不该一视同仁。
      const raw = await this.ollama.generate(buildSegmentSystemPrompt(mem), userPrompt, {
        // 本机 8B 实测约 约 69 tok/s(2026-09-30 实测)：给小了 JSON 必被掐断（历史上整批报废→90 秒等分兜底）；
        // 云端秒级返回，给足预算让它从容写全。两档在构造函数里按 provider 已分好。
        maxTokens: this.segmentMaxTokens,
        timeout: this.llmTimeoutMs,
        temperature: 0.3,
        parseJson: false,
        tier: 'heavy',
        // 这一步是整场分析里最慢的一次调用（几十秒到几分钟）。
        // 不传 signal 的话用户点了取消它照跑到底，整条分析要等它返回才 unwind。
        signal: this._abortSignal ?? signal ?? null,
      });

      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      const parsed = repairJson(text);
      if (!parsed.ok) {
        console.warn(`[LiveAnalyzer] chunk ${chunkIndex} JSON 无法修复（${parsed.note}），返回前 120 字：${String(text).slice(0, 120)}`);
        return [];
      }
      if (parsed.repaired) {
        if (this.lastHealth) this.lastHealth.chunkRepaired++;
        console.warn(`[LiveAnalyzer] chunk ${chunkIndex} 模型输出被掐断，修复层拦截成功（${parsed.note}）`);
      }
      const segs = pickSegments(parsed.value);
      if (Array.isArray(segs)) {
        // 2026-09-24：LLM 偶尔给出负数/超出本 chunk 范围的时间，或塞进来几十段，
        // 直接入库会让后面切片区段越界（ffmpeg -ss 负值/LiveSegments 时间轴错乱）。
        // 这里统一钳到 [0, 本 chunk 时长] 并限制单 chunk 段数。
        const chunkSpan = Math.max(1, chunkEndSec - chunkStartSec);
        const out = segs
          .filter((x) => x && typeof x === 'object')
          .slice(0, 40)
          .map((x) => {
            const st = Number(x.start_seconds ?? x.start ?? 0);
            const en = Number(x.end_seconds ?? x.end ?? 0);
            const start = Math.max(0, Math.min(chunkSpan, Number.isFinite(st) ? st : 0));
            const end = Math.max(start + 0.5, Math.min(chunkSpan, Number.isFinite(en) ? en : start + 1));
            return { ...x, start_seconds: start, end_seconds: end };
          });
        if (out.length === 0) {
          console.warn(`[LiveAnalyzer] chunk ${chunkIndex} 解析出了 JSON 但 segments 为空数组`);
        }
        return out;
      }
      // 解析失败不再静默：留下可诊断日志，方便区分"模型返回空"和"JSON 被截断"
      console.warn(`[LiveAnalyzer] chunk ${chunkIndex} 返回非结构化结果（缺少 segments 字段），原文前 120 字：${String(text).slice(0, 120)}`);
      return [];
    } catch (err) {
      console.warn(`[LiveAnalyzer] LLM analysis failed for chunk ${chunkIndex}: ${err.message}`);
      return [];
    }
  }

  /**
   * 批量匹配：30 段一批，一次 LLM 返回一批结果。某批失败则该批走关键词兜底，
   * 不再逐段重试（以前失败一段就吞掉整场记忆）。
   */
  async _matchAllWithHitThemes(allSegments, hitThemes, mem = null) {
    const fallbackAll = (segs) => {
      for (const seg of segs) {
        if (seg._matchSource === 'llm') continue; // 已有 LLM 结果不覆盖
        const kw = this._keywordMatch(seg, hitThemes);
        seg.matched_themes = kw.matched_themes;
        seg.best_match_theme_id = kw.best_match_theme_id;
        seg.viral_potential = kw.overall_viral_potential;
        seg.recommended_action = kw.recommended_action;
        seg._matchSource = 'keyword';
      }
    };
    if (!hitThemes || hitThemes.length === 0) {
      for (const seg of allSegments) {
        seg.matched_themes = [];
        seg.best_match_theme_id = null;
        seg.viral_potential = seg.hook_quality || 0.5;
        seg.recommended_action = 'needs_user_review';
        seg._matchSource = 'none';
      }
      return;
    }
    const themeList = hitThemes.map((t, idx) => {
      let kw = [];
      try { const p = JSON.parse(t.keywords || '[]'); if (Array.isArray(p)) kw = p.slice(0, 6); } catch { /* ignore */ }
      return `${idx + 1}. [id=${t.id}] ${t.theme_name}（关键词：${kw.join('、') || '无'}）`;
    }).join('\n');

    // ★ 记忆注入点 3/3（匹配阶段）：把创作者的历史评判一并给出，
    // 匹配器才知道"什么算好"（指定开头 / 钩子要炸 / 不要拖），而不是冷启动打分
    const lessonLines = [];
    // 明确标注它不是主题,避免匹配器把"指定开头"当成一个可匹配的历史爆款主题
    if (mem?.opening) lessonLines.push(`- 创作约束（非主题）：指定开头是《${mem.opening}》，不要把它当成主题来匹配`);
    for (const l of (mem?.lessons || [])) lessonLines.push(`- ${l}`);
    for (const a of (mem?.avoid || [])) lessonLines.push(`- 避免：${a}`);
    const lessonBlock = lessonLines.length
      ? `\n创作者的历史评判（打分与 recommended_action 必须参考）：\n${lessonLines.join('\n')}\n`
      : '';

    const batchSize = this.matchBatchSize;
    for (let b = 0; b < allSegments.length; b += batchSize) {
      const batch = allSegments.slice(b, b + batchSize);
      const ok = await this._matchBatchWithLlm(batch, hitThemes, themeList, lessonBlock);
      if (!ok) {
        console.warn(`[LiveAnalyzer] 段 ${b}-${b + batch.length - 1} LLM 匹配覆盖不足，未覆盖部分走关键词兜底`);
        fallbackAll(batch);
      }
    }
  }

  /**
   * 单批 LLM 匹配。返回 true 表示本批被 LLM 有效覆盖（≥70%）。
   * 覆盖不足（模型只回 1 条 / JSON 被截断）时把批拆成两半再各自重试，
   * 避免"整批一起丢"——这正是原来 143 段里 69 段只有弱匹配、其余全无匹配的成因之一。
   */
  async _matchBatchWithLlm(batch, hitThemes, themeList, lessonBlock) {
    const segList = batch.map((s, i) =>
      `${i}. 主题="${s.theme_name || '?'}" 钩子=${(s.hook_quality || 0.5).toFixed(2)} 摘要="${(s.transcript_summary || '').slice(0, 60)}"`
    ).join('\n');
    const userPrompt = `Match each live segment against historical hit themes.

Segments:
${segList}

Historical hit themes:
${themeList}
${lessonBlock}
Output strict JSON: {"results": [{"idx": 0, "matched_themes": [{"theme_id": 数字id, "theme_name": "名", "similarity_score": 0-1, "reason": "十字内"}], "best_match_theme_id": 数字id或null, "overall_viral_potential": 0-1, "recommended_action": "clip_immediately|consider_clipping|skip|needs_user_review"}, ...]}
Rules: 上面每一行 Segment 都必须对应输出一个对象（共 ${batch.length} 个）；idx 为行首序号；
theme_id 必须用 [id=] 里的数字id；无好匹配则空数组+null+needs_user_review。紧凑 JSON，不要解释文字。`;

    let arr = [];
    try {
      const result = await this.ollama.generate(THEME_MATCH_PROMPT, userPrompt, {
        // 按批大小动态给输出预算（每段约 130 tokens）。原 2048 是给 30 段批的，
        // 但 8B 在 600s 内写不完 30 段，尾部被截断 → 整批报废。
        maxTokens: 260 + batch.length * 140,
        timeout: this.llmTimeoutMs,
        temperature: 0.2,
        parseJson: true,
        // 与分段共用同一 num_ctx：切 tier 会改 num_ctx 导致 KV 缓存失效、重新 prefill（实测 173ms → 38s）
        tier: 'heavy',
      });
      arr = result?.results || result?.matches || [];
      if (!Array.isArray(arr)) arr = [];
    } catch (err) {
      console.warn(`[LiveAnalyzer] 批次匹配调用失败: ${err.message}`);
      arr = [];
    }

    const byIdx = new Map(arr.map(r => [Number(r.idx), r]));
    let covered = 0;
    for (let i = 0; i < batch.length; i++) {
      const r = byIdx.get(i);
      if (!r) continue;
      batch[i].matched_themes = r.matched_themes || [];
      batch[i].best_match_theme_id = r.best_match_theme_id ?? null;
      batch[i].viral_potential = r.overall_viral_potential ?? 0.5;
      batch[i].recommended_action = r.recommended_action || 'consider_clipping';
      batch[i]._matchSource = 'llm';
      covered++;
    }
    if (covered >= Math.max(1, Math.ceil(batch.length * 0.7))) return true;

    // 覆盖不足：拆半重试（已覆盖的段保留结果，只补未覆盖的半批）
    if (batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      const a = batch.slice(0, half);
      const c = batch.slice(half);
      const okA = a.every(s => s._matchSource === 'llm')
        || await this._matchBatchWithLlm(a, hitThemes, themeList, lessonBlock);
      const okC = c.every(s => s._matchSource === 'llm')
        || await this._matchBatchWithLlm(c, hitThemes, themeList, lessonBlock);
      if (okA && okC) return true;
    }
    return false;
  }

  /**
   * 关键词兜底：无 LLM 时按主题关键词/主题名分词重叠打分，保证记忆权重不归零。
   * 纯确定性，单段 <1ms，143 段也无感。
   */
  _keywordMatch(segment, hitThemes) {
    const text = `${segment.theme_name || ''} ${segment.transcript_summary || ''}`;
    let best = null;
    let bestScore = 0;
    const matched = [];
    for (const t of hitThemes || []) {
      let kw = [];
      try { const p = JSON.parse(t.keywords || '[]'); if (Array.isArray(p)) kw = p; } catch { /* ignore */ }
      const names = String(t.theme_name || '').slice(0, 12);
      let hits = 0;
      for (const k of kw) {
        if (k && String(k).length >= 2 && text.includes(String(k))) hits++;
      }
      // 主题名本身命中也算（至少 2 字才有意义）
      if (names.length >= 2 && text.includes(names)) hits += 1;
      if (hits > 0) {
        const score = Math.min(0.85, 0.35 + hits * 0.15 + (Number(t.confidence) || 0.5) * 0.1);
        matched.push({ theme_id: t.id, theme_name: t.theme_name, similarity_score: Math.round(score * 100) / 100, reason: `关键词命中${hits}个` });
        if (score > bestScore) { bestScore = score; best = t.id; }
      }
    }
    matched.sort((a, b) => b.similarity_score - a.similarity_score);
    const viral = matched.length
      ? Math.min(0.95, (segment.hook_quality || 0.5) * 0.4 + bestScore * 0.6 + 0.1)
      : (segment.hook_quality || 0.5);
    return {
      matched_themes: matched.slice(0, 3),
      best_match_theme_id: best,
      overall_viral_potential: Math.round(viral * 100) / 100,
      recommended_action: bestScore >= 0.6 ? 'clip_immediately' : bestScore >= 0.4 ? 'consider_clipping' : 'needs_user_review',
    };
  }

  async _matchWithHitThemes(segment, hitThemes) {
    if (!hitThemes || hitThemes.length === 0) {
      return {
        matched_themes: [],
        best_match_theme_id: null,
        overall_viral_potential: segment.hook_quality || 0.5,
        recommended_action: 'needs_user_review'
      };
    }

    // Build theme list for prompt
    const themeList = hitThemes.map((t, idx) =>
      `${idx + 1}. ${t.theme_name} (confidence: ${t.confidence?.toFixed(2) || 'N/A'}, keywords: ${t.keywords || 'N/A'})`
    ).join('\n');

    const userPrompt = `Match this live stream segment against historical hit video themes.

Segment:
- Theme: ${segment.theme_name}
- Category: ${segment.theme_category || 'unknown'}
- Summary: ${segment.transcript_summary || ''}
- Hook quality: ${segment.hook_quality || 0.5}
- Sales intent: ${segment.sales_intent || 'unknown'}
- Emotional tone: ${segment.emotional_tone || 'unknown'}

Historical hit themes:
${themeList}

Output the match result as specified JSON.`;

    try {
      const result = await this.ollama.generate(THEME_MATCH_PROMPT, userPrompt, {
        maxTokens: 2048,
        temperature: 0.2,
        parseJson: true,
        tier: 'light', // 纯分类匹配，小模型更快更省
      });

      return {
        matched_themes: result?.matched_themes || [],
        best_match_theme_id: result?.best_match_theme_id || null,
        overall_viral_potential: result?.overall_viral_potential || 0.5,
        recommended_action: result?.recommended_action || 'consider_clipping'
      };
    } catch (err) {
      // 取消要往上抛：吞掉的话主循环会当"匹配失败"继续下一块
      if (this._isAbort(err)) throw err;
      console.warn(`[LiveAnalyzer] Theme matching failed: ${err.message}`);
      return {
        matched_themes: [],
        best_match_theme_id: null,
        overall_viral_potential: 0.5,
        recommended_action: 'consider_clipping'
      };
    }
  }

  /**
   * 判断一个错误是不是"用户取消"。
   *
   * 为什么必须统一走这个判断：分析链路上到处是 `catch { return 默认值 }`
   * （匹配失败就跳过、看图失败就返回 null…）。取消的 AbortError 会被这些 catch
   * 一起吞掉，然后主循环当成"这一块没结果"继续下一块 —— 用户点了取消，
   * 整场分析却还在一块一块跑，状态一直停在 analyzing。
   *
   * 以前 LLM 那层的 catch 就干过一次：describe() 把 abort 吞成 null。
   */
  _isAbort(err) {
    if (!err) return false;
    if (err.userCancelled) return true;
    if (err.name === 'AbortError') return true;
    if (this._abortSignal?.aborted) return true;
    return false;
  }

  /**
   * 清洗污染段：剔除"指定开头"当主题产生的垃圾段。
   *
   * 为什么必须有这一步（2026-09-30）：
   * 提示词已经改掉，但三重保险仍需要它——
   * ① 模型偶尔不听话，仍输出 theme_name="指定开头"；
   * ② 用户指定的句子在全场反复出现（3 小时直播同一句被切 6~10 段）；
   * ③ 老库里已存着这种段，重新分析前的空窗期界面照样显示一片"指定开头"。
   *
   * 处理原则：
   * - 指定开头不是主题 → theme_name 改回"待分类"（宁可待分类也别污染主题库）
   * - 同一句只留一段 → 其余按"内容重复"丢弃，不进候选列表
   * - 钩子分封顶 0.8 → 不让一句指定开头压过真实教学爆点
   */
  _sanitizeSegments(segments, mem, health) {
    const opening = String(mem?.opening || '').trim();
    if (!opening || !Array.isArray(segments) || !segments.length) return;

    // 1) 摘出所有"指定开头"段（theme_name 命中，或摘要与指定句高度重合）
    const key = opening.replace(/[\s，。？！,.?!]/g, '').slice(0, 18);
    const isOpeningSeg = (s) => {
      if (/^指定开头$/.test(String(s.theme_name || '').trim())) return true;
      const sum = String(s.transcript_summary || '').replace(/[\s，。？！,.?!]/g, '');
      if (key && sum && (sum === key || key.includes(sum.slice(0, 10)) || sum.includes(key.slice(0, 10)))) return true;
      return false;
    };

    const openingSegs = segments.filter(isOpeningSeg);
    if (!openingSegs.length) return;

    // 2) 同句只留钩子分最高的那一段（并列时留时间靠前的）
    openingSegs.sort((a, b) => (b.hook_quality || 0) - (a.hook_quality || 0) || (a.startMs || 0) - (b.startMs || 0));
    const keep = openingSegs[0];
    keep.theme_name = '待分类';
    keep.hook_quality = Math.min(Number(keep.hook_quality) || 0.8, 0.8);
    if (!String(keep.transcript_summary || '').trim()) keep.transcript_summary = opening.slice(0, 30);

    // 3) 其余全部剔除（原地改数组长度，保持调用方拿到的是同一个数组）
    const drop = new Set(openingSegs.slice(1));
    for (let i = segments.length - 1; i >= 0; i--) {
      if (drop.has(segments[i])) segments.splice(i, 1);
    }

    health.sanitizedOpeningSegments = openingSegs.length;
    health.removedDuplicateOpeningSegments = drop.size;
    console.log(
      `[LiveAnalyzer] 清洗"指定开头"污染：命中 ${openingSegs.length} 段，保留 1 段（hook 封顶 0.8，主题改回待分类），` +
        `剔除重复 ${drop.size} 段（原文：${opening.slice(0, 24)}）`
    );
  }

  /**
   * 兜底切分：LLM 颗粒无收时按固定时长等分，保证粗剪有料可剪。
   * 每 90s 一段，主题记“待分类”，钩子质量取中值，后续照样可走匹配/粗剪/人工确认。
   */
  _fallbackSplit(transcript, sliceSeconds = 90) {
    const endMs = Math.max(...transcript.map(t => (t.end ?? t.end_ms ?? 0)));
    const segs = [];
    for (let s = 0; s * 1000 < endMs; s += sliceSeconds) {
      const e = Math.min(s + sliceSeconds, Math.ceil(endMs / 1000));
      const text = transcript
        .filter(t => (t.start ?? t.start_ms ?? 0) / 1000 < e && (t.end ?? t.end_ms ?? 0) / 1000 > s)
        .map(t => t.text || '')
        .join('')
        .slice(0, 200);
      segs.push({
        start_seconds: s,
        end_seconds: e,
        theme_name: '待分类',
        theme_category: 'other',
        confidence: 0.4,
        hook_quality: 0.5,
        key_phrases: [],
        transcript_summary: text || '(该时段转写为空)',
        sales_intent: 'unknown',
        emotional_tone: 'calm',
      });
    }
    return segs;
  }

  _mergeSegments(segments) {
    if (!segments || segments.length === 0) return [];
    // Sort by start time
    segments.sort((a, b) => a.start_seconds - b.start_seconds);

    const merged = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const last = merged[merged.length - 1];
      const current = segments[i];

      // 只合真正重叠的（重叠>50%）；以前 gap<5s 就合，90s 兜底切片 gap=0 被全并成 3 小时巨段
      const overlap = Math.max(0, Math.min(last.end_seconds, current.end_seconds) - Math.max(last.start_seconds, current.start_seconds));
      const lastDuration = last.end_seconds - last.start_seconds;
      if (overlap > lastDuration * 0.5) {
        // Merge: extend end time, keep higher quality attributes
        last.end_seconds = Math.max(last.end_seconds, current.end_seconds);
        last.hook_quality = Math.max(last.hook_quality || 0, current.hook_quality || 0);
        last.confidence = Math.max(last.confidence || 0, current.confidence || 0);
        // Combine key phrases
        if (current.key_phrases) {
          last.key_phrases = [...(last.key_phrases || []), ...current.key_phrases];
        }
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  async scanAndAnalyze() {
    const { readdirSync } = await import('fs');
    if (!existsSync(this.liveDir)) {
      mkdirSync(this.liveDir, { recursive: true });
      return [];
    }

    const files = readdirSync(this.liveDir)
      .filter(f => /\.(mp4|mov|mkv|webm|flv|avi)$/i.test(f))
      .map(f => join(this.liveDir, f));

    const results = [];
    for (const videoPath of files) {
      const existing = this.store.getLiveVideo(videoPath);
      if (existing && existing.analysis_status === 'completed') {
        console.log(`[LiveAnalyzer] Skip already analyzed: ${basename(videoPath)}`);
        continue;
      }

      try {
        const result = await this.analyze(videoPath);
        results.push(result);
      } catch (err) {
        console.error(`[LiveAnalyzer] Failed: ${videoPath}:`, err.message);
      }
    }

    return results;
  }
}

export default LiveAnalyzer;

/*
 * 练声教学内容识别（2026-10-06）
 * ─────────────────────────────────────────────────
 * 用途：让预筛别把练声类教学当"循环啰嗦 / 语速过缓"扔掉。
 *
 * 为什么需要它：练声直播的形态天然撞满三条筛除规则（重复、慢速、字数少），
 * 而它恰恰是一整类有教学价值的内容 —— 老师带音节、学生跟唱，
 * 同一个"啊"重复几十遍就是教学内容本身。
 *
 * 只认**明确指令词**，不靠"重复得像练声"去猜：
 * 猜错的代价是放过一些真的废话（浪费一点 GPU），
 * 而判错的代价是整类教学永远学不进记忆库。用户明确说过
 * "答答答答属于练声类教学，要让记忆功能记起来"。
 *
 * 语音转写常把长音写成叠字（"啊啊啊"），所以单独看元音串。
 */
const VOCAL_TRAINING_SIGNALS = [
  // 课程/环节名
  { re: /(练声|开声|练音|练嗓|嗓子训练|声带|开腔|热身练习|发声练习|声音训练|嗓音训练)/, name: '练声/开声' },
  { re: /(唇齿舌牙喉|口型练习|开唇|合拢|圆唇|舌位|齿音练习|喉音练习)/, name: '五音练习' },
  // 教学指令（跟唱、慢唱、气息）
  { re: /(跟我唱|跟着我唱|跟我念|一起唱|跟着唱|再来一遍|再唱一遍|再试一遍|慢一点|慢速|放慢|打拍子|数拍子)/, name: '跟唱指令' },
  { re: /(气息支撑|腹式呼吸|横膈膜|下沉丹田|共鸣点|打开喉咙|放松喉咙|喉位|软腭|舌根)/, name: '发声要领' },
  { re: /(音阶|上行|下行|半音|全音|阶歌|琶音|颤音|转音|滑音|强弱|力度|换气点|断连|连音)/, name: '技巧训练' },
  // 长音/元音叠写（转写里 "啊啊啊" / "呜呜呜"）
  // 阈值取 3 而不是 4：ASR 不会把一个长音写成十几个叠字，
  // 实测样本就是 "啊啊啊"（3 个）。取 4 会漏掉最典型的形态。
  { re: /([啊阿喔哦噢欧唿呜嗯诶唉哎噢噢]{3,})/, name: '元音长音' },
];

function detectVocalTraining(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const { re, name } of VOCAL_TRAINING_SIGNALS) {
    if (re.test(s)) return name;
  }
  return null;
}

export { detectVocalTraining };
