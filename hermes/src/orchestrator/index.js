/**
 * GLB Orchestrator
 * The bridge between Hermes and GLB.
 *
 * Receives GLB webhook events, orchestrates the pipeline:
 * 1. GLB transcribes video -> Hermes learns from transcript
 * 2. GLB detects highlights -> Hermes adjusts thresholds + injects memory
 * 3. GLB exports clips -> Hermes generates & embeds copywriting
 *
 * Also watches GLB's output directory for new files.
 */

import express from 'express';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, basename, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { MemoryStore } from '../memory/store.js';
import { createLlmClient } from '../llm/router.js';
import { HitAnalyzer } from '../analyzer/hit-analyzer.js';
import { SentenceCutter } from '../analyzer/sentence-cutter.js';
import { DeepAnalyzer } from '../analyzer/deep-analyzer.js';
import { LiveAnalyzer } from '../analyzer/live-analyzer.js';
import { loadTranscript, buildEditableText, describeTextless, charRangeToTime, normalizeRanges } from '../analyzer/editable-text.js';
import { buildLearningRecord } from '../analyzer/review-learning.js';
import { Clipper } from '../clipper/index.js';
import { ContentGenerator } from '../generator/index.js';
import { UserQuery } from '../query/index.js';
import { IdleScheduler } from '../scheduler/index.js';
import { getGpuState } from '../scheduler/gpu.js';
import { killAllFfmpeg } from '../analyzer/ffmpeg-helper.js';
import { GlbBridge } from '../bridge/glb-memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, '..', '..', 'config', 'default.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

const WEAK_SECRETS = new Set(['', 'hermes-local-secret', 'changeme', '123456', 'password']);
const WINDOWS_RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

// 强密钥：默认弱口令不再直接使用，首次启动生成并落盘到 data/.hermes-secret（不进 git、不写日志）。
function resolveWebhookSecret(config) {
  const fromCfg = String(config?.glb?.webhookSecret || '');
  if (fromCfg && !WEAK_SECRETS.has(fromCfg)) return fromCfg;
  try {
    const secretFile = join(__dirname, '..', '..', 'data', '.hermes-secret');
    if (existsSync(secretFile)) {
      const saved = String(readFileSync(secretFile, 'utf-8')).trim();
      if (saved.length >= 32) return saved;
    }
    let fresh = '';
    try {
      fresh = randomBytes(32).toString('hex');
    } catch {
      fresh = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 64);
      while (fresh.length < 64) fresh += Math.random().toString(16).slice(2);
      fresh = fresh.slice(0, 64);
    }
    try {
      mkdirSync(dirname(secretFile), { recursive: true });
      writeFileSync(secretFile, fresh + '\n', { encoding: 'utf-8', mode: 0o600 });
    } catch { /* ignore */ }
    return fresh;
  } catch {
    // 2026-09-24：以前静默回落到全网已知的 'hermes-local-secret'，等于没鉴权还没人知道。
    // 现在至少把这事吼出来（服务仍能起，不至于因为一个密钥把整套系统拦死）。
    if (!fromCfg) console.warn('[Security] 警告：未能生成或读取 .hermes-secret，已回落到默认弱口令！请检查 data 目录写权限。');
    return fromCfg || 'hermes-local-secret';
  }
}

function isLocalOrigin(origin) {
  // 2026-09-24 安全修：origin === 'null' 不能当成本机来源放行。
  // 沙箱 iframe（<iframe sandbox srcdoc="...">）发出的请求 Origin 就是字符串 "null"，
  // 于是任意网页都能对 127.0.0.1:17841 发写请求（删素材 / 跑清理 / 改配置）——CSRF 直通。
  // 真正无 Origin 的情况（Electron 主进程用 Node fetch、curl）走下面这行，不受影响。
  if (!origin) return true; // 无 Origin：Electron 主进程 / curl（浏览器请求一定带 Origin）
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:' || u.protocol === 'app:') return true;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || isLoopbackIp(host);
  } catch {
    return false;
  }
}

function isLoopbackIp(host) {
  if (!host) return false;
  if (host === '127.0.0.1' || host === '::1') return true;
  // 127.0.0.0/8 全段 + ::ffff:127.x 映射（窄名单 fail-closed，只扩回环段）
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(host)) return true;
  return false;
}

function isLoopbackRemote(remote) {
  const r = String(remote || '');
  if (!r) return true;
  const h = r.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  return isLoopbackIp(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// 挪盘自愈：配置里写死的 D:/GLB… 在换盘/改名后不存在时，自动回退到全家桶相对路径
function resolveBundlePaths(config) {
  try {
    const bundleRoot = join(__dirname, '..', '..', '..');
    const fallback = {
      outputWatchDir: join(bundleRoot, 'output'),
      transcriptDir: join(bundleRoot, 'output', 'transcripts'),
      highlightDir: join(bundleRoot, 'output', 'highlights'),
      clipDir: join(bundleRoot, 'output', 'clips'),
      exePath: join(bundleRoot, 'GLB', 'GLB.exe'),
      hitsDir: join(bundleRoot, 'Hermes', 'upload', 'hits'),
      liveDir: join(bundleRoot, 'Hermes', 'upload', 'live'),
      tempDir: join(bundleRoot, 'Hermes', 'upload', 'temp'),
      finishedDir: join(bundleRoot, 'output', 'finished'),
      draftDir: join(bundleRoot, 'output', 'draft'),
    };
    const fix = (p, fb) => (!p || !existsSync(p)) && existsSync(fb) ? fb : p;
    if (config?.glb) {
      config.glb.outputWatchDir = fix(config.glb.outputWatchDir, fallback.outputWatchDir);
      config.glb.transcriptDir = fix(config.glb.transcriptDir, fallback.transcriptDir);
      config.glb.highlightDir = fix(config.glb.highlightDir, fallback.highlightDir);
      config.glb.clipDir = fix(config.glb.clipDir, fallback.clipDir);
      config.glb.exePath = fix(config.glb.exePath, fallback.exePath);
    }
    if (config?.upload) {
      config.upload.hitsDir = fix(config.upload.hitsDir, fallback.hitsDir);
      config.upload.liveDir = fix(config.upload.liveDir, fallback.liveDir);
      config.upload.tempDir = fix(config.upload.tempDir, fallback.tempDir);
    }
    if (config?.output) {
      config.output.finishedDir = fix(config.output.finishedDir, fallback.finishedDir);
      config.output.draftDir = fix(config.output.draftDir, fallback.draftDir);
    }
  } catch { /* ignore */ }
  return config;
}

/**
 * 按档取段 v2：三档是【每一条】成片的时长，且时长随主题内容自然变化。
 * 先按“主题连续”聚类（标题/钩子共享关键词 + 时间相邻），再按档位取段：
 * - 短档：切合的单条直接过
 * - 中/长档：同一主题簇的自然跨度即时长（不足往两边补到 min，有 Hermes 分段时贴分段边；
 *   超 max 取价值锚点居中的 target 窗）；每条时长由内容决定，不再清一色
 * - 撞过打回的不做锚点；已占区间不再重叠出段；最多 10 条
 */
/**
 * 记忆挑句（句级爆款挑选）：
   * 输入桌面端传来的逐句稿 + 记忆语料，输出"按记忆学会的爆款知识挑出的教学句，
   * 一句句拼成档位时长的一条完整成片"的时间线（pieces 多段拼接）。
   *
   * 两级质量：
   *   - 规则清洗（秒回）：去相邻重复、丢无实义短句，记忆关键词打分
   *   - LLM 深度清洗（后台跑，写缓存）：下次点「按记忆里找爆点」自动用上
   */
/** 规则起名兜底：LLM 起名超时/失败时给切片一个像样的标题（不依赖 GPU）。
 *  取第一句带钩子的短句（问句 / 怎么 / 为什么 / 记住 / 注意…），截到 12 字并去掉尾部残留虚词。 */
function ruleBasedClipTitle(text) {
  const t = String(text || '').replace(/\s+/g, '').trim();
  if (!t) return '';
  const sents = t.split(/[。！？!?；;]/).filter(Boolean);
  const pick = sents.find((s) => /[?？]/.test(s) || /怎么|如何|为什么|记住|注意|其实|原来|对了|错了|干货|方法|技巧|重点/.test(s)) || sents[0] || t;
  return pick.slice(0, 12).replace(/[，,、和与及就还也吧啊哦嗯的了]$/, '');
}

function filterInteractionSegs(segs) {
  // 直播互动话术：求关注/灯牌/预约/礼物/弹幕引导——整句剪掉，不进粗剪
  const INTERACT = ['灯牌', '点亮', '预约', '粉丝团', '关注主播', '点个关注', '点关注', '加关注', '关注一下', '关注一波', '扣个', '公屏', '小心心', '小礼物', '刷礼物', '礼物刷起来', '点点关注', '进直播间', '欢迎来到直播间', '欢迎新来的', '评论区扣', '打在公屏', '点赞关注'];
  return segs.filter((s) => {
    const t = String(s.text || '');
    return !INTERACT.some((k) => t.includes(k));
  });
}

function memorySentenceSegments(videoName, rawSegs, mode, themeKws, hooks, opts = {}) {
  const interactionClean = opts.interactionClean !== false;
  // 连麦/音乐保留：false 时把"纯闲聊/无教学价值"的句子也剔掉（连麦对话、场外闲聊）
  const keepExtra = opts.keepExtra !== false;
  // 重复话去除：false 时只做整句复述的严格去重，语义级重复全部保留
  const dedupRepeat = opts.dedupRepeat !== false;
  const kwHit = (text) => {
    let score = 0, hits = [];
    for (const { kw, w, theme } of themeKws || []) {
      if (text.includes(kw)) { score += w * 2; hits.push(theme); }
    }
    return { score, hits: [...new Set(hits)] };
  };
  const TEACH = ['怎么', '如何', '方法', '练', '教学', '示范', '注意', '重点', '其实', '正确', '错误', '技巧', '要点', '步骤', '原因', '区别', '讲解', '干货', '发音', '气息', '共鸣', '音准', '节奏'];
  const EMOTE = ['真的', '特别', '一定', '千万', '必须', '绝对', '最重要', '错了', '对了', '！', '!'];
  // 句首连接词：这种句子离了前文就没头（"然后…"单独出现就是半截话）
  const CONNECTOR = ['然后', '但是', '所以', '而且', '因为', '接着', '另外', '就是说', '接下来', '那么'];
  const hookSim = (text) => (hooks || []).some((h) => text.includes(String(h.text_content || '').slice(0, 6)) && String(h.text_content || '').length >= 4);
  const lcs = (a, b) => {
    if (!a || !b) return 0;
    let best = 0; const dp = new Array(b.length + 1).fill(0);
    for (let i = 0; i < a.length; i++) { let prev = 0;
      for (let j = 0; j < b.length; j++) { const t = dp[j + 1]; dp[j + 1] = a[i] === b[j] ? prev + 1 : 0; if (dp[j + 1] > best) best = dp[j + 1]; prev = t; } }
    return best;
  };
  // 直播互动清理：开启时整句剪掉（用户要求：直播间、灯牌点亮、预约直播等不进粗剪）
  const INTERACT = ['灯牌', '点亮', '预约', '粉丝团', '关注主播', '点个关注', '点关注', '加关注', '关注一下', '关注一波', '扣个', '公屏', '小心心', '小礼物', '刷礼物', '礼物刷起来', '点点关注', '进直播间', '欢迎来到直播间', '欢迎新来的', '评论区扣', '打在公屏', '点赞关注'];
  // 防误杀：长教学句即使含"点亮/关注"这类词也不算互动（例：共鸣位置要点亮起来）
  const TEACHY = (t) => t.length >= 15 && TEACH.some((k) => t.includes(k));
  const isInteract = (t) => interactionClean && INTERACT.some((k) => t.includes(k)) && !TEACHY(t);
  // 跨场去重：同一教学点全场只进一次成片（不只看相邻句——1 小时后重讲也算重复）
  // 重复话去除：同一教学点（表述可以不同）只保留讲得最清楚/情绪最饱满的一段，其余剪辑时跳过
  //   - 严格级（恒开）：整句复述（连续 12 字相同）直接丢
  //   - 语义级（「重复话去除」开关，默认开）：去掉称呼/连接词/标点后高度重合（≥60%）也算重复，
  //     且新句更有情绪/分数更高时，用新句替换旧句（保留讲得更好的那段）
  const normForDup = (t) => String(t)
    .replace(/^(同学们?|就比如说|比如说|比如|就是说|那么|然后|但是|而且|因为|接着|另外|好)/, '')
    .replace(/[，。！？!?,.\s\d]/g, '');
  const seen = [];
  const scored = [];
  const dropped = []; // 被剪掉的句子时间段（互动/水句/重复）——音乐空隙保留时必须排除，否则剪掉的内容又拼回来
  let interact = 0, dup = 0;
  const emoScore = (t, sc) => (String(t).match(/[！!真的特别最]/g) || []).length + (sc >= 6 ? 1 : 0);
  for (const s of rawSegs) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    if (isInteract(text)) { interact++; dropped.push([s.start, s.end]); continue; }
    const teach = TEACH.filter((k) => text.includes(k)).length;
    const emote = EMOTE.filter((k) => text.includes(k)).length;
    const mem = kwHit(text);
    const isHook = hookSim(text) ? 2 : 0;
    const lenOk = text.length >= 6;
    let score = 1 + teach * 2 + (emote ? 1 : 0) + Math.round(mem.score) + isHook + (text.length >= 8 && text.length <= 80 ? 1 : 0);
    if (!lenOk && !teach && !mem.score && !isHook) { dropped.push([s.start, s.end]); continue; }
    // 去重判定（对池子里每条已保留句）
    const nt = normForDup(text);
    let dupIdx = -1;
    for (let k = 0; k < seen.length; k++) {
      const se = seen[k];
      const c = lcs(nt, se.nt);
      let hit = dedupRepeat
        ? (c >= 4 && c >= Math.min(nt.length, se.nt.length) * 0.6)
        : (lcs(text, se.raw) >= 12 && lcs(text, se.raw) >= Math.min(text.length, se.raw.length) * 0.6);
      // 核心教学词保护：两句高度重合，但差异部分正好是核心教学词（高音 vs 低音、鼻腔 vs 头腔）
      // → 这是两个不同的教学点，绝不能当重复去掉
      if (hit && dedupRepeat) {
        const CORE = ['高音', '低音', '中音', '真声', '假声', '混声', '鼻腔', '头腔', '胸腔', '口腔', '咽音', '换气', '咬字', '吐字', '气息', '共鸣', '音准', '节奏'];
        // 找出 nt 有而 se.nt 没有的核心词（或反之）
        const onlyA = CORE.filter((w) => nt.includes(w) && !se.nt.includes(w));
        const onlyB = CORE.filter((w) => se.nt.includes(w) && !nt.includes(w));
        if (onlyA.length || onlyB.length) hit = false;
      }
      if (hit) { dupIdx = se.idx; break; }
    }
    if (dupIdx >= 0) {
      dup++; dropped.push([s.start, s.end]);
      // 保留情绪效果好的一段：新句更有情绪/分数明显更高时，替换旧句（时间位置换成新句）
      const oldSeg = scored[dupIdx];
      if (emoScore(text, score) > emoScore(oldSeg.text, oldSeg.score) || score > oldSeg.score + 2) {
        scored[dupIdx] = { ...s, text, score, hits: mem.hits, connector: CONNECTOR.some((k) => text.startsWith(k)) };
      }
      continue;
    }
    scored.push({ ...s, text, score, hits: mem.hits, connector: CONNECTOR.some((k) => text.startsWith(k)) });
    seen.push({ nt, raw: text, idx: scored.length - 1 });
    if (seen.length > 120) seen.shift();
  }
  scored.interactCount = interact;
  scored.dupCount = dup;
  scored.droppedRanges = dropped;
  scored.dedupRepeat = dedupRepeat;
  return scored;
}

/** 把打分句打包成档位时长的拼接成片：整句整句过（碎句并入相邻）、条目有头有尾；
 *  keepExtra 开启时长间隙（唱歌/间奏/连麦安静段）也拼进成片，不跳过 */
/**
 * 把打分句打包成档位时长的拼接成片：**连续内容块优先**（观感：不要几十段碎句来回跳）
 *   1. 相邻句（间隙 ≤5s，或连接词开头）先合并成"块"——块 = 一段完整的讲解
 *   2. 按"价值密度 × 有效时长"给块排序，挑够档位时长为止（块数上限，避免段数爆炸）
 *   3. 选中的块按时间排序拼起来；块之间的空隙在 keepExtra 开启时保留（唱歌/间奏/连麦安静）
 *   4. 被剪掉的句子（互动/重复/水句）所在区间不会以"音乐空隙"名义拼回来
 */
/**
 * 把打分句打包成档位时长的拼接成片：**种子扩展**（观感：成片时间紧凑，不全片撒点）
 *   1. 相邻句（间隙 ≤5s，或连接词开头）先合并成"块"——块 = 一段完整的讲解
 *   2. 取记忆权重最高的块做种子，向时间两侧扩展相邻块，凑够档位时长
 *      → 每条成片在时间轴上是紧凑的一段（不是 71 个碎片散布 3 小时）
 *   3. 块之间的间隙在 keepExtra 开启时保留为 ♪（唱歌/间奏/连麦安静段原声）
 *   4. 被剪掉的句子（互动/重复/水句）所在区间不会以"音乐空隙"名义拼回来
 */
/**
 * 单位护栏：整条链路的 scored 用毫秒，输出用秒。
 *
 * 真实 bug：某次调用把毫秒直接当秒传进来，3 小时的视频产出 2330000 秒的候选，
 * 界面显示 "2330000.0s"。根因是没有人在入口处确认单位，
 * 于是错误一路传到最底下才暴露成"界面上的时间不对"。
 * 这里只做一次判断，并且把"发现单位不对"写进返回值，让调用方能记进体检。
 */
function normalizeToMs(list, hint) {
  const arr = (list || []).filter((s) => s && (Number.isFinite(s.start) || Number.isFinite(s.startMs)));
  if (!arr.length) return { list: arr, fixed: false, maxRaw: 0 };
  const maxRaw = Math.max(...arr.map((s) => Number(s.start ?? s.startMs ?? 0)));
  // 一场直播再长也就 12 小时 = 43,200,000ms；当成秒的话这个值就是 4320 万秒 = 500 天。
  // 阈值取 100,000 秒（27.7 小时）足够宽松，不会误伤真实素材。
  const SECONDS_UPPER_BOUND = 100_000;
  const fixed = maxRaw > SECONDS_UPPER_BOUND;
  if (!fixed) return { list: arr, fixed, maxRaw };
  // 看起来是毫秒被当成了秒 —— 往下游传秒。真正的错值会在这里被纠正。
  return {
    list: arr.map((s) => ({
      ...s,
      start: Number(s.start ?? s.startMs ?? 0) / 1000,
      end: Number(s.end ?? s.endMs ?? 0) / 1000
    })),
    fixed,
    maxRaw,
    unitNote: `${hint || 'sentences'} 的时间戳量级像毫秒（最大 ${maxRaw}），已按秒处理`
  };
}

function packSentencePieces(scored, mode, opts = {}) {
  const keepExtra = opts.keepExtra !== false;
  const dropped = opts.droppedRanges || []; // 被剪掉句子的时间段（毫秒）
  const maxBlocks = Math.max(1, Number(opts.maxBlocks) || 12); // 单条成片最多几段
  const overlapsDropped = (gs, ge) => dropped.some((dr) => gs < dr[1] / 1000 && ge > dr[0] / 1000);
  const ordered = [...(scored || [])].sort((a, b) => a.start - b.start);
  if (!ordered.length) return [];

  // 1) 合并成块
  const BLOCK_GAP = 5000;
  const blocks = [];
  let cur = null;
  for (const s of ordered) {
    if (!cur) { cur = { start: s.start, end: s.end, score: s.score, n: 1, first: s.text, texts: [s.text] }; continue; }
    const gap = s.start - cur.end;
    if (gap <= BLOCK_GAP || s.connector) {
      cur.end = s.end; cur.score += s.score; cur.n++; cur.texts.push(s.text);
    } else {
      blocks.push(cur);
      cur = { start: s.start, end: s.end, score: s.score, n: 1, first: s.text, texts: [s.text] };
    }
  }
  if (cur) blocks.push(cur);

  const target = mode ? Math.min(mode.max, Math.round((mode.min + mode.max) / 2)) : 120;
  const maxPer = mode ? mode.max : 240;
  const minPer = mode ? Math.max(8, mode.min) : 20;

  // 2) 种子扩展组条：每轮取权重最高的未用块，向时间两侧收相邻块凑档位
  const cands = blocks.map((b) => {
    const dur = Math.max(0.5, (b.end - b.start) / 1000);
    return { ...b, dur, weight: (b.score / b.n) * Math.min(dur, 30) };
  }).sort((a, b) => a.start - b.start);
  const used = new Array(cands.length).fill(false);
  const groups = [];
  let guard = 0;
  while (guard++ < 500) {
    let seed = -1, seedW = -1;
    for (let i = 0; i < cands.length; i++) {
      if (!used[i] && cands[i].weight > seedW) { seedW = cands[i].weight; seed = i; }
    }
    if (seed < 0) break;
    const win = [seed];
    let acc = cands[seed].dur;
    used[seed] = true;
    let lo = seed - 1, hi = seed + 1;
    while (acc < target) {
      const canLo = lo >= 0 && !used[lo] && acc + cands[lo].dur <= maxPer;
      const canHi = hi < cands.length && !used[hi] && acc + cands[hi].dur <= maxPer;
      if (canLo) { win.unshift(lo); acc += cands[lo].dur; used[lo] = true; lo--; }
      else if (canHi) { win.push(hi); acc += cands[hi].dur; used[hi] = true; hi++; }
      else break;
    }
    used[seed] = true;
    // 组装 pieces：块按时间排序，块间空隙按 keepExtra 保留（排除被剪区间）
    win.sort((a, b) => a - b);
    const pieces = [];
    win.forEach((bi, k) => {
      const b = cands[bi];
      if (k > 0) {
        const prev = cands[win[k - 1]];
        const gs = +(prev.end / 1000).toFixed(2);
        const ge = +(b.start / 1000).toFixed(2);
        const gapSec = ge - gs;
        if (keepExtra && gapSec >= 3 && gapSec <= 45 && !overlapsDropped(gs, ge)) {
          pieces.push({ startSec: gs, endSec: ge, text: "♪" });
        }
      }
      pieces.push({ startSec: +(b.start / 1000).toFixed(2), endSec: +(b.end / 1000).toFixed(2), text: b.texts.join(' ').slice(0, 120) });
    });
    groups.push({ pieces, acc });
  }

  // 3) 长条切分：连续内容超过档位上限的按 maxPer 切成多条（一条成片不该 99 分钟）
  const finalGroups = [];
  for (const x of groups) {
    if (x.acc <= maxPer) { finalGroups.push(x); continue; }
    let sub = { pieces: [], acc: 0 };
    // 块内每块的原文在 byStart 里，拆片时按片段自己的时间取值。
    // 没有它就只能复制整块第一句 —— 那正是"8 条候选一模一样"的来源。
    const textsByStart = new Map(x.pieces.map((p) => [p.startSec, p.text]));
    // 片段按时间排序，拆片时靠指针推进，避免每片都从头扫一遍
    const srcSorted = x.pieces
      .map((p, i) => ({ ...p, i }))
      .sort((a, b) => a.startSec - b.startSec);
    let si = 0;
    for (const p of x.pieces) {
      const dur = p.endSec - p.startSec;
      if (dur > maxPer) {
        // 超长连续块：按时间硬切成多条（直播"每几秒一句"会把整场连成巨块）
        //
        // 关键：每一片必须带**自己那段时间的原文**，不能沿用整块的第一句。
        // 原来所有切片共用 p.text，于是 8 条候选标题一模一样 ——
        // 用户看到"筛出来全是同一条"，而真相是：根本没分开，是同一段被复制了 8 次。
        // 而且第一条的原文还被塞给后面所有片，等于在说谎。
        let cursor = p.startSec;
        while (cursor < p.endSec - 8) {
          const segEnd = Math.min(cursor + maxPer, p.endSec);
          if (sub.acc >= 8) { finalGroups.push(sub); sub = { pieces: [], acc: 0 }; }
          // 取这段里最贴近开头的原文，而不是整块的第一句。
          // 找不到（说明 srcSorted 没覆盖到这里）才退回 p.text，并且要标明不可信。
          let pieceText = '';
          while (si < srcSorted.length && srcSorted[si].endSec <= cursor) si++;
          const first = srcSorted[si];
          if (first && first.startSec <= cursor + 1) pieceText = String(first.text || '');
          const exact = textsByStart.get(+cursor.toFixed(2));
          sub.pieces.push({
            startSec: +cursor.toFixed(2),
            endSec: +segEnd.toFixed(2),
            text: (exact || pieceText || p.text).slice(0, 120),
            // 标出这段文本是不是"这片自己的"。前端据此提示用户标题可能不准。
            textExact: Boolean(exact || pieceText)
          });
          sub.acc += segEnd - cursor;
          cursor = segEnd;
        }
        continue;
      }
      if (sub.acc + dur > maxPer && sub.acc >= 8) { finalGroups.push(sub); sub = { pieces: [], acc: 0 }; }
      sub.pieces.push(p); sub.acc += dur;
    }
    if (sub.acc >= 8) finalGroups.push(sub);
  }

  // 4) 转 modeSegments（太短的条丢弃）
  let n = 0;
  const out = finalGroups.filter((x) => x.acc >= 8).map((x) => {
    n++;
    const firstPiece = (x.pieces.find((p) => p.text !== "♪") || {}).text || "";
    return {
      id: 'mem-' + n,
      startSec: x.pieces[0].startSec,
      endSec: x.pieces[x.pieces.length - 1].endSec,
      pieces: x.pieces,
      text: x.pieces.filter((p) => p.text !== "♪").map((p) => p.text).join(' ').slice(0, 200),
      title: (firstPiece || ('记忆精选 ' + n)).slice(0, 24),
      hook: firstPiece.slice(0, 40),
      score: Math.min(99, 60 + Math.round((x.acc / Math.max(1, x.pieces.length)) * 2)),
      reason: '记忆挑句：' + x.pieces.length + ' 段拼成（紧凑时间线）',
      // 有片的原文不是它自己的 —— 多半是整场被连成一个巨块后硬切出来的。
      // 界面要据此提示"标题不准"，否则用户会以为系统只找到了一条爆点。
      textApproximate: x.pieces.some((p) => p.textExact === false),
    };
  });

  // 标题去重：标题相同就说明这些条其实来自同一段内容，
  // 直接标出来好过让用户面对一屏一模一样的卡片自己去猜。
  const byTitle = new Map();
  for (const m of out) {
    const key = String(m.title || '').trim();
    if (!key) continue;
    byTitle.set(key, (byTitle.get(key) || 0) + 1);
  }
  for (const m of out) {
    const key = String(m.title || '').trim();
    const dup = key && byTitle.get(key) > 1;
    if (dup) {
      m.titleDup = byTitle.get(key);
      m.reason += `（有 ${byTitle.get(key)} 条标题相同，多半来自同一段连续内容）`;
    }
  }
  return out;
}

function composeModeSegments(candidates, reranked, mode, segByTime) {
  const byIdx = new Map((reranked || []).map((r) => [r.idx, r]));
  const rows = (candidates || [])
    .map((c, idx) => {
      const r = byIdx.get(idx) || {};
      const s = Number(c.startSec) || 0;
      const e = Number(c.endSec) || 0;
      return { c, idx, s, e, dur: e - s, score: r.newScore ?? (Number(c.score) || 0), reasons: r.reasons || [] };
    })
    .filter((x) => x.dur > 0 && !(x.reasons.join('').includes('撞了打回')))
    .sort((a, b) => a.s - b.s);
  if (!rows.length) return [];
  // 新 id：所有候选（含被排除的打回条）最大值+1 往后排，避免和桌面端现有候选撞车
  let nextId = 1;
  for (const c of candidates || []) {
    if (Number.isFinite(Number(c.id))) nextId = Math.max(nextId, Number(c.id) + 1);
  }
  // 视频总长（用于钳制）：Hermes 分段最大值，否则候选最大值
  let videoEnd = 0;
  if (segByTime?.length) for (const g of segByTime) videoEnd = Math.max(videoEnd, (g.end_ms || 0) / 1000);
  if (!videoEnd) for (const x of rows) videoEnd = Math.max(videoEnd, x.e);
  // 主题连续：相邻候选标题/钩子的最长公共子串≥3字即同主题（2字滑窗全是“声乐/乐技”这种碎片，不准）
  const cleanText = (x) => `${x.c.title || ''} ${x.c.hook || ''}`.replace(/[^\u4e00-\u9fa50-9a-zA-Z]/g, '');
  const texts = rows.map(cleanText);
  const lcsLabel = (a, b, minLen = 3) => {
    const ta = texts[a];
    const tb = texts[b];
    if (!ta || !tb) return '';
    const dp = new Array(tb.length + 1).fill(0);
    let best = '';
    for (let i = 0; i < ta.length; i++) {
      let prev = 0;
      for (let j = 0; j < tb.length; j++) {
        const tmp = dp[j + 1];
        dp[j + 1] = ta[i] === tb[j] ? prev + 1 : 0;
        if (dp[j + 1] > best.length) best = ta.slice(i - dp[j + 1] + 1, i + 1);
        prev = tmp;
      }
    }
    return best.length >= minLen ? best.slice(0, 10) : '';
  };
  // 按时间聚类：间隔≤45s直接同簇；间隔≤240s 且共享主题子串才同簇
  const clusters = []; // [{members:[rowIdx], label}]
  let cur = { members: [0], label: '' };
  for (let i = 1; i < rows.length; i++) {
    const prev = cur.members[cur.members.length - 1];
    const gap = rows[i].s - rows[prev].e;
    const shared = gap <= 240 ? lcsLabel(prev, i) : '';
    if (gap >= 0 && (gap <= 45 || (gap <= 240 && shared))) {
      cur.members.push(i);
      if (shared && !cur.label) cur.label = shared;
    } else {
      clusters.push(cur);
      cur = { members: [i], label: '' };
    }
  }
  clusters.push(cur);
  const target = mode.min < 60 ? 0 : Math.min(mode.max, Math.round(mode.min + (mode.max - mode.min) * 0.3));
  // Hermes 分段边：起止落在分段内时扩到分段边（整主题收进来）
  const snapEdges = (s, e) => {
    if (!segByTime?.length) return [s, e];
    for (const g of segByTime) {
      const gs = (g.start_ms || 0) / 1000;
      const ge = (g.end_ms || 0) / 1000;
      if (gs >= s && gs < e) s = Math.min(s, gs);
      if (ge > s && ge <= e + 30) e = Math.max(e, ge);
    }
    return [s, e];
  };
  const out = [];
  const taken = [];
  const overlapsTaken = (s, e) => taken.some((t) => Math.max(0, Math.min(e, t[1]) - Math.max(s, t[0])) / Math.max(1, e - s) > 0.5);
  const emit = (s, e, anchor, topic) => {
    s = Math.round(s);
    e = Math.round(e);
    if (e - s < 1 || overlapsTaken(s, e)) return;
    taken.push([s, e]);
    const dur = e - s;
    const mm = Math.floor(dur / 60);
    const ss = dur % 60;
    out.push({
      id: nextId++,
      title: anchor.c.title || `记忆精选${out.length + 1}`,
      hook: anchor.c.hook || '',
      score: Math.min(100, Math.round(anchor.score + 5)),
      startSec: s,
      endSec: e,
      text: anchor.c.title || '',
      reason: `记忆按${mode.label}取段：${topic}约${mm > 0 ? `${mm}分` : ''}${ss}秒`,
      recommended: true,
      gateNotes: [`记忆按${mode.label}取段（${topic}约${mm > 0 ? `${mm}分` : ''}${ss}秒）`],
      memberIds: [anchor.c.id],
    });
  };
  for (const cl of clusters) {
    if (out.length >= 10) break;
    const members = cl.members.map((i) => rows[i]);
    const anchor = [...members].sort((a, b) => b.score - a.score)[0];
    const topic = cl.label || String(anchor.c.title || '精选').slice(0, 10);
    if (mode.min < 60) {
      // 短档：簇内切合的单条各出一条
      for (const x of members) {
        if (x.dur >= mode.min && x.dur <= mode.max) emit(x.s, x.e, x, `《${String(x.c.title || '').slice(0, 10)}》`);
      }
      continue;
    }
    let s = members[0].s;
    let e = members[members.length - 1].e;
    if (e - s < mode.min) {
      // 主题不够长：往两边补到 min（贴分段边），再不够就丢
      const need = mode.min - (e - s);
      s = Math.max(0, s - Math.ceil(need / 2));
      e = s + (e - s) + need;
      if (videoEnd && e > videoEnd) {
        e = videoEnd;
        s = Math.max(0, e - mode.min);
      }
      [s, e] = snapEdges(s, e);
      if (e - s > mode.max * 1.15) {
        const c = (s + e) / 2;
        s = Math.max(0, c - target / 2);
        e = s + target;
      }
      if (e - s < mode.min * 0.8) continue;
    } else if (e - s > mode.max) {
      // 主题太长：价值锚点居中取 target 窗
      const center = (anchor.s + anchor.e) / 2;
      s = Math.max(0, center - target / 2);
      e = s + target;
      if (videoEnd && e > videoEnd) {
        e = videoEnd;
        s = Math.max(0, e - target);
      }
      if (e - s < mode.min * 0.8) continue;
    } else {
      [s, e] = snapEdges(s, e);
      if (e - s > mode.max * 1.15 || e - s < mode.min * 0.8) continue;
    }
    emit(s, e, anchor, `《${topic}》`);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export class Orchestrator {
  constructor(config = null) {
    this.config = resolveBundlePaths(config || loadConfig());
    this.ollama = createLlmClient(this.config); // 名字保持 ollama：全链路透传，provider 由 config.llm.provider 决定
    // 2026-09-27：让看板能看见「AI 大脑」是谁——接入了什么一目了然，不再藏在配置文件里
    this.llmProvider = String(this.config?.llm?.provider || "ollama").toLowerCase();
    this.llmModel = this.ollama.model || "";
    // auto 模式下 provider 只是"策略"，不等于实际在用云端。
    // 原来直接写 provider !== "ollama"，配置成 auto 就报"云端在线"，
    // 而实际每个任务都在本地跑 —— 看板说的和做的不一致。
    this.llmCloud = typeof this.ollama?.usingCloud === "boolean" ? this.ollama.usingCloud : this.llmProvider !== "ollama";
    this.store = new MemoryStore(this.config);
    // 评审经验按文件夹（IP/老师）隔离：把当前活跃文件夹同步给记忆层，启动那一刻就生效，
    // 不用等第一次切文件夹。同步失败退回"不隔离"，不影响服务起来。
    try { this.store.setActiveCollection(this.getActiveCollection()); } catch { /* ignore */ }

    // New pipeline modules
    // 分析完成即自动预测播量（hooks.onCompleted），存量缺预测的由调度器每轮补一个
    this.hitAnalyzer = new HitAnalyzer(this.ollama, this.store, this.config, {
      onCompleted: (hitId) => this.predictHitVideo(hitId).catch((err) =>
        console.warn(`[Orchestrator] Auto-predict failed for hit ${hitId}:`, err.message)),
    });
    this.deepAnalyzer = new DeepAnalyzer(this.ollama, this.store, this.config);
    this.sentenceCutter = new SentenceCutter(this.ollama, this.store, this.config);
    this.liveAnalyzer = new LiveAnalyzer(this.ollama, this.store, this.config);
    this.clipper = new Clipper(this.ollama, this.store, this.config);
    this.contentGenerator = new ContentGenerator(this.ollama, this.store, this.config);
    this.userQuery = new UserQuery(this.store, this.config, {
      // 超时自动答题后，如果该项目已经没有待答问题，就推进它继续粗剪。
      // 与人工答题接口（/queries/:id/answer）保持同样的收尾逻辑。
      onQueryResolved: (q) => {
        try {
          if (q?.project_id && this.userQuery.getPendingForProject(q.project_id).length === 0) {
            this.clipper.resumeProject(q.project_id).catch((err) =>
              console.error(`[Orchestrator] 超时后推进项目 ${q.project_id} 失败:`, err.message));
          }
        } catch (err) { console.error('[Orchestrator] 超时推进检查失败:', err.message); }
      },
    });
    this.scheduler = new IdleScheduler(this, this.config);
    // 记忆桥：Hermes 记忆 ⇄ GLB 桌面端/CLI（每小时自动双向同步一次）
    this.glbBridge = new GlbBridge(this.store, this.config);

    this.app = express();
    // 内嵌 JSON 全局上限 15mb（长直播逐句稿几 MB～十几 MB 也收得下）；
    // 超大的请走 transcriptPath 文件路径（_loadJson），不要内嵌全文。
    this.app.use(express.json({ limit: '15mb' }));
    // 安全：本机服务，只允许同源/本地 Origin，拒绝任意互联网页面 drive-by 调用。
    // Electron file:// / app://（Origin null/file:）和 curl（无 Origin）放行；外网 Origin 必须预检且不反射 *。
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (!origin || isLocalOrigin(origin)) {
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* file: app:");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename,Authorization,x-hermes-secret');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      // 非本地 Origin 的写操作直接挡掉（即使带 secret 也不给跨站写，避免 secret 泄漏后被利用）
      if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !isLocalOrigin(origin)) {
        return res.status(403).json({ error: 'forbidden origin' });
      }
      next();
    });
    // 弱口令自愈：配置仍是出厂弱口令时生成强密钥落盘，内存中替换，避免全网同密钥
    this.webhookSecret = resolveWebhookSecret(this.config);
    if (WEAK_SECRETS.has(String(this.config?.glb?.webhookSecret || ''))) {
      console.warn('[Security] 默认 webhookSecret 已替换为 data/.hermes-secret 中的强随机密钥。请在 GLB 设置页同步更新 Webhook 密钥。');
    }
    // 写操作鉴权：同源看板/无 Origin 本机调用放行（防 CSRF 靠上面的 Origin 墙）；
    // 跨站或非回环必须带正确 x-hermes-secret / Authorization: Bearer。
    this.requireWriteAuth = (req, res, next) => {
      try {
        const secret = req.headers['x-hermes-secret'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (secret && secret === this.webhookSecret) return next();
        const origin = req.headers.origin;
        const originOk = !origin || isLocalOrigin(origin);
        if (originOk && isLoopbackRemote(req.socket?.remoteAddress)) return next();
        return res.status(401).json({ error: 'unauthorized (need x-hermes-secret)' });
      } catch {
        return res.status(401).json({ error: 'unauthorized' });
      }
    };
    this.server = null;


    // 记忆挑句的深度清洗缓存（key=视频名+句数，value=LLM 清洗后的逐句 keep/drop）
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS sentence_clean_cache (
      video_key TEXT PRIMARY KEY,
      segments TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    // 记忆挑句的结果留痕：每次「按记忆里找爆点」挑了哪些句子，看板可直接核对挑句口味
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS memory_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_name TEXT,
      duration_mode TEXT,
      seg_count INTEGER,
      sentence_count INTEGER,
      items TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    // 启动自愈：把上次进程留下的 analyzing 归位。
    //
    // 真实问题：进程被 kill、崩溃、或用户直接关窗时，分析正停在
    // analysis_status='analyzing'。而 /pipeline/live-result 看到 analyzing
    // 就回 running:true —— 于是界面永远转圈，用户既看不到结果也看不到失败原因，
    // 而且这个状态会一直挂着（调度器也可能反复重排它）。
    //
    // 判据：有活跃分段 + 体检 finishedAt 存在 -> completed（分析其实跑完了，
    // 只是最后一步没写到）；否则 -> pending（可重新分析）。
    try {
      const stuck = this.store.db
        .prepare("SELECT id, video_name, analysis_health FROM live_videos WHERE analysis_status = 'analyzing'")
        .all();
      for (const r of stuck) {
        const segs = this.store.db
          .prepare("SELECT COUNT(*) c FROM live_segments WHERE live_video_id = ? AND status = 'draft'")
          .get(r.id)?.c ?? 0;
        let finished = false;
        try { finished = Boolean(JSON.parse(r.analysis_health || '{}').finishedAt); } catch { /* 坏 JSON 当没跑完 */ }
        const to = segs > 0 && finished ? 'completed' : 'pending';
        this.store.db
          .prepare("UPDATE live_videos SET analysis_status = ? WHERE id = ?")
          .run(to, r.id);
        console.log(`[Recovery] #${r.id} 上次进程退出时停在 analyzing：${segs} 段活跃、finishedAt=${finished ? '有' : '无'} -> ${to}（${r.video_name}）`);
      }
    } catch (e) {
      console.warn('[Recovery] 归位 analyzing 失败:', e.message);
    }

    this._setupRoutes();
  }

  /**
   * 按 segment_index 取段,并把 startMs/endMs 归一 + 带上 cuts。
   *
   * 单独抽出来是因为 /pipeline/clip 与 /pipeline/set-selection 都要用同一套
   * 归一化规则:前者是"用户已勾选时跳过自动选段",后者是"渲染前改写选段"。
   * 两边规则若不一致,就会出现"界面选了 A、成片出了 B"。
   */
  /**
   * 这条直播素材的审阅意见该记到哪个 IP 老师名下。
   *
   * 优先级：素材自己的 collection > 当前选中的集合 > null。
   *
   * 为什么以素材自己的为准：分析时是"针对某位老师"做的，
   * 这条直播从头到尾就属于那位老师。审片发生在几天之后，
   * 那时用户早就切到别的 IP 了 —— 用 activeCollection 就会把
   * "某老师"的口播删减记到"李老师"名下。
   * 而且这种错记不报错，还会持续产出错误的避雷规则，污染越积越多。
   *
   * 查不到就返回 null（不猜）。宁可让这条意见暂时用不上，
   * 也不要错记到别人名下。
   */
  _collectionOfLiveVideo(liveVideoId) {
    return this.store._ownerOfLive(liveVideoId);
  }

  _segmentsByIndex(liveVideoId, segmentIds, cutsByIndex) {
    const all = this.store.getLiveSegmentsByVideo(Number(liveVideoId)) || [];
    // id 和 segment_index 都建表，两者都能查到。
    //
    // 原因：审片/桌面端传上来的是 segmentId（live_segments.id，全局自增，如 2396），
    // 而 segment_index 是每场直播从 0 重新计数的序号（0..248），两者永远不相等。
    // 只按 segment_index 查会把所有段静默丢掉（实测 249/249 全丢），
    // 表现为"逐句剔除后没有可用内容"，把排查方向误导到素材内容上。
    const byId = new Map();
    const byIndex = new Map();
    for (const s of all) {
      if (s.id !== undefined && s.id !== null) byId.set(Number(s.id), s);
      if (s.segment_index !== undefined && s.segment_index !== null) byIndex.set(Number(s.segment_index), s);
    }
    // 同 _resolveVariantSegments：工程里记的段可能已被后续重分析标成 superseded，
    // 但源视频与起止时间没变，按 id 回捞一次，只补 draft 里没有的。
    const known = new Set(byId.keys());
    const wanted = (segmentIds || []).map(Number).filter((n) => Number.isFinite(n));
    const absent = wanted.filter((n) => !known.has(n));
    if (absent.length) {
      for (const s of (this.store.getLiveSegmentsByIds?.(absent) || [])) {
        if (s && s.id !== undefined && s.id !== null) byId.set(Number(s.id), s);
      }
    }
    const cutsMap = new Map();
    for (const item of (cutsByIndex || [])) {
      if (item && item.index !== undefined && Array.isArray(item.cuts)) {
        cutsMap.set(Number(item.index), item.cuts);
      }
    }
    const out = [];
    for (const idx of segmentIds) {
      const key = Number(idx);
      const s = byId.get(key) || byIndex.get(key);
      if (!s) continue;
      const seg = { ...s, startMs: Number(s.start_ms ?? 0), endMs: Number(s.end_ms ?? 0) };
      const cuts = cutsMap.get(Number(s.segment_index)) || cutsMap.get(key);
      if (Array.isArray(cuts) && cuts.length) {
        // 夹紧到段边界并丢弃过短碎片,否则 ffmpeg 会切出黑帧
        const clean = cuts
          .map((c) => ({
            st: Math.max(seg.startMs, Math.round(Number(c.st ?? 0))),
            en: Math.min(seg.endMs, Math.round(Number(c.en ?? 0)))
          }))
          .filter((c) => Number.isFinite(c.st) && Number.isFinite(c.en) && c.en - c.st >= 200)
          .sort((a, b) => a.st - b.st);
        if (clean.length) seg.cuts = clean;
      }
      out.push(seg);
    }
    return out;
  }

  _setupRoutes() {
    // Health check（公开，负载均衡/自启探测用，不含敏感字段）
    this.app.get('/health', (req, res) => {
      res.json({ ok: true, service: 'hermes', uptime: process.uptime() });
    });
    // 敏感读接口同样鉴权：同源看板/ Electron / curl（回环+本地 Origin）免 Key 照常用，
    // 外网 Origin 无 Key 直接 401，防止 host 被改成 0.0.0.0 或 LAN 穿透时裸奔。
    this.requireReadAuth = (req, res, next) => {
      try {
        const secret = req.headers['x-hermes-secret'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (secret && secret === this.webhookSecret) return next();
        const origin = req.headers.origin;
        if (origin && !isLocalOrigin(origin)) return res.status(401).json({ error: 'unauthorized (need x-hermes-secret)' });
        if (isLoopbackRemote(req.socket?.remoteAddress)) return next();
        return res.status(401).json({ error: 'unauthorized (need x-hermes-secret)' });
      } catch {
        return res.status(401).json({ error: 'unauthorized' });
      }
    };

    // Memory stats
    this.app.get('/stats', this.requireReadAuth, (req, res) => {
      res.json(this.store.getExtendedStats());
    });

    // Style profile
    this.app.get('/style', this.requireReadAuth, (req, res) => {
      res.json(this.store.getStyleProfile());
    });

    // ─── Auto-pipeline API endpoints ───

    // Analyze a hit video (manual trigger)
    this.app.post('/pipeline/analyze-hit', this.requireWriteAuth, async (req, res) => {
      let { videoPath } = req.body;
      if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
      // 2026-09-25 修：分隔符归一化（/ 与 \ 是两个不同的键，会造成双记录、双跑锁失效）
      videoPath = String(videoPath).replace(/\\/g, '/');
      // 2026-09-24 安全加固：以前这里只判非空，等于允许把 D 盘任意文件交给 ffmpeg/ASR 解码，
      // 配合 /hits/delete 的 deleteFiles 甚至能物理删掉任意文件。现在只放行工作目录与库里登记过的素材。
      if (!this.isAllowedMediaPath(videoPath)) {
        return res.status(403).json({ error: 'videoPath 不在允许的工作目录内（需要时在 config.security.extraAllowedDirs 里加）' });
      }
      // 并发保险：同一条素材被重复触发（手动点 + 调度器扫到）会同时跑两个分析，
      // 两个 Ollama 请求抢显存互相打断，表现为 fetch failed、整条素材白跑。这里直接挡掉第二个。
      this._busyHits = this._busyHits || new Set();
      const key = String(videoPath);
      const sKey = `hit:${key}`;
      // 检查必须两头都看：只看 _busyHits 的话，调度器正在分析这条时用户点"重新分析"
      // 不会被拦，两个 analyze 同时起 → 抢 8G 显存（这正是本段注释想防的场景）。
      if (this._busyHits.has(key) || this.scheduler?.runningTasks?.has(sKey)) {
        return res.status(409).json({ ok: false, busy: true, error: '这条正在分析中，别重复触发（等它跑完会自动刷新）' });
      }
      this._busyHits.add(key);
      this.scheduler?.prioritize(videoPath);
      // 手动任务也登记进调度器的 runningTasks，下个 tick 就不会对同一条再起一个 analyze。
      // 走到这里说明调度器原本没在跑它，所以 finally 里删掉的是我们自己刚登记的标记。
      this.scheduler?.runningTasks?.add(sKey);
      try {
        const result = await this.hitAnalyzer.analyze(videoPath);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        this._busyHits.delete(key);
        this.scheduler?.runningTasks?.delete(sKey);
      }
    });

    // Deep-memory: single-video deep pass (manual trigger) + backfill progress
    this.app.post('/pipeline/deep-backfill', this.requireWriteAuth, async (req, res) => {
      const { videoPath } = req.body || {};
      if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
      // 2026-09-24 安全加固：以前这里只判非空，等于允许把 D 盘任意文件交给 ffmpeg/ASR 解码，
      // 配合 /hits/delete 的 deleteFiles 甚至能物理删掉任意文件。现在只放行工作目录与库里登记过的素材。
      if (!this.isAllowedMediaPath(videoPath)) {
        return res.status(403).json({ error: 'videoPath 不在允许的工作目录内（需要时在 config.security.extraAllowedDirs 里加）' });
      }
      /*
       * 2026-10-05 加并发锁。
       *
       * 这个端点原本**没有任何保护**：没有 _busy* 集合、没有 scheduler.runningTasks 登记、
       * 没有优先队列。每调一次就直接打一发本地视觉模型（qwen2.5vl）。
       * 连点 8 次就是 8 个模型同时加载 —— 这正是"机器卡死"的另一个来源。
       *
       * 对照 /pipeline/analyze-hit 与 /pipeline/analyze-live：它们都登记了锁，
       * 所以那条路早就不会被重复触发，只有这里漏了。
       *
       * 同时登记进 scheduler.runningTasks，让 LLM 显存闸门能看见它 ——
       * 否则它跑起来的时候，调度器以为显卡是空的，照样再起别的 LLM 任务。
       */
      this._busyDeep = this._busyDeep || new Set();
      const norm = String(videoPath).replace(/\\/g, '/');
      if (this._busyDeep.has(norm)) {
        return res.status(409).json({ ok: false, busy: true, error: '这条正在深解中，别重复触发' });
      }
      this._busyDeep.add(norm);
      const deepKey = `deep:${norm}`;
      this.scheduler?.runningTasks?.add(deepKey);
      try {
        const result = await this.deepAnalyzer.analyze(videoPath);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        // 必须放锁，否则这条素材再也深解不了
        this._busyDeep.delete(norm);
        this.scheduler?.runningTasks?.delete(deepKey);
      }
    });
    this.app.get('/api/deep-status', this.requireReadAuth, (req, res) => {
      try {
        const total = this.store.db.prepare(
          "SELECT COUNT(*) AS c FROM hit_videos WHERE analysis_status = 'completed'"
        ).get().c;
        const done = this.store.db.prepare('SELECT COUNT(*) AS c FROM deep_memory').get().c;
        res.json({ ok: true, total, done, pending: Math.max(0, total - done) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Analyze a live video (manual trigger)
    this.app.post('/pipeline/analyze-live', this.requireWriteAuth, async (req, res) => {
      let { videoPath } = req.body;
      // 这条直播归哪位老师（2026-10-02）。给了就在分析前绑到素材自己身上，
      // 分析过程按它取爆款记忆/避雷词，不再受"界面当前选中谁"影响。
      const collection = typeof req.body?.collection === 'string' ? req.body.collection.trim() : '';
      if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
      // 2026-09-25 修：分隔符归一化（/ 与 \ 是两个不同的键，会造成双记录、双跑锁失效）
      videoPath = String(videoPath).replace(/\\/g, '/');
      // 2026-09-24 安全加固：以前这里只判非空，等于允许把 D 盘任意文件交给 ffmpeg/ASR 解码，
      // 配合 /hits/delete 的 deleteFiles 甚至能物理删掉任意文件。现在只放行工作目录与库里登记过的素材。
      if (!this.isAllowedMediaPath(videoPath)) {
        return res.status(403).json({ error: 'videoPath 不在允许的工作目录内（需要时在 config.security.extraAllowedDirs 里加）' });
      }
      // 以前这个入口连 _busyHits 都没有：连点两下就是两个 liveAnalyzer.analyze 并发，
      // 每个开头都 DELETE FROM live_segments，后完成的会把先完成的分段整表清空并重建，
      // 已粗剪依赖的分段直接错位。这里补上和 analyze-hit 一样的锁。
      this._busyLives = this._busyLives || new Set();
      const key = String(videoPath);
      const sKey = `live:${key}`;
      // 同 analyze-hit：调度器正在跑这条时也要挡掉，否则两个 analyze 并发各自 DELETE live_segments
      if (this._busyLives.has(key) || this.scheduler?.runningTasks?.has(sKey)) {
        return res.status(409).json({ ok: false, busy: true, error: '这条正在分析中，别重复触发（等它跑完会自动刷新）' });
      }
      this._busyLives.add(key);
      this.scheduler?.prioritize(videoPath);
      this.scheduler?.runningTasks?.add(sKey);
      // 挂上 AbortController，「取消」才能真的断开，而不是等它跑完 40 分钟。
      this._liveAbort = this._liveAbort || new Map();
      const ctl = new AbortController();
      this._liveAbort.set(key, ctl);
      try {
        // 先绑定再分析：analyze() 内部会读 live_video 的 collection 取记忆，
        // 顺序反了就只能用全局兜底，等于没绑。
        if (collection) {
          const vid = this.store.getLiveVideoIdByPath?.(videoPath);
          if (vid) {
            const bind = this.store.bindLiveVideoCollection(vid, collection);
            console.log(`[analyze-live] 绑定归属: ${videoPath} -> ${bind.ok ? collection : '失败 ' + bind.error}`);
          }
        }
        const result = await this.liveAnalyzer.analyze(videoPath, { signal: ctl.signal });
        // 竞态兜底：abort 可能在 analyze() 刚返回、还没进 catch 时发生。
        // 这时 analyze() 走的是正常出口（没有抛错），取消分支不会执行，
        // 而 analysis_status 还停在 'analyzing' —— 界面于是永远转圈。
        //
        // 判据：客户端确实点了取消，且我们还没写过 completed。
        if (ctl.signal.aborted) {
          console.log('[analyze-live] 取消发生在正常返回之后，按取消归位');
          this.store.upsertLiveVideo(videoPath, { analysisStatus: 'pending' });
          this._busyLives.delete(key);
          this.scheduler?.runningTasks?.delete(sKey);
          if (this._liveAbort) this._liveAbort.delete(key);
          return res.json({ ok: false, cancelled: true, liveVideoId: result.liveVideoId ?? null });
        }
        res.json({ ok: true, collection, ...result });
      } catch (err) {
        // 取消返回 200 + cancelled，让客户端把它当"用户主动终止"而不是失败弹窗。
        // 报 500 的话界面会显示"分析失败"，而用户只是点了取消。
        if (err?.userCancelled || err?.name === 'AbortError') {
          return res.json({ ok: false, cancelled: true, liveVideoId: err.liveVideoId ?? null });
        }
        res.status(500).json({ error: err.message });
      } finally {
        this._busyLives.delete(key);
        this.scheduler?.runningTasks?.delete(sKey);
        if (this._liveAbort) this._liveAbort.delete(key);
      }
    });

    /**
     * 取消一条正在跑的分析。
     *
     * 为什么必须有：桌面端那个「取消」按钮原本调的是 runDetect() ——
     * 也就是"重新开始一次分析"。文案和行为正好相反，而服务端此时
     * 还在对同一个 videoPath 跑 analyze()，于是要么撞 409「正在分析中」，
     * 要么两份分析并发跑、各自 DELETE FROM live_segments，结果互相覆盖。
     *
     * 这里用 AbortController 真的把请求断开，同时清掉 busy 标记，
     * 让用户可以立刻重新发起。
     */
    this.app.post('/pipeline/analyze-cancel', this.requireWriteAuth, async (req, res) => {
      const videoPath = String(req.body?.videoPath || '').replace(/\\/g, '/');
      if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
      const key = String(videoPath);
      const ctl = this._liveAbort?.get(key);
      let aborted = false;
      if (ctl && !ctl.signal.aborted) {
        try { ctl.abort(new Error('用户取消')); aborted = true; } catch { /* ignore */ }
      }
      // 立刻杀掉在跑的 ffmpeg/ffprobe/whisper，不能只让 JS 抛错。
      // 否则界面上已经显示"已取消"，实际 CPU 还在满载、sherpa 还占着显存，
      // 用户马上重跑就会被上一次拖住 —— 实测第二次请求直接 HeadersTimeout。
      let killed = 0;
      try {
        const { killAllFfmpeg } = await import('../analyzer/ffmpeg-helper.js');
        killed += killAllFfmpeg();
      } catch { /* ignore */ }
      try {
        const { ASRHelper } = await import('../analyzer/asr-helper.js');
        killed += ASRHelper.killAll();
      } catch { /* ignore */ }
      // 无论有没有 controller 都要清标记：否则用户取消后立刻重试会撞 409，
      // 而实际上上一次已经不会再写库了。
      this._busyLives?.delete(key);
      this.scheduler?.runningTasks?.delete(`live:${key}`);
      // 状态也一起归位。
      //
      // 以前只清 busy 标记，于是有一种情况永远卡住：
      // 上一次 analyze-live 因为进程被杀/崩溃而停在 analyzing，
      // 它对应的 finally 根本没机会跑，状态就一直悬着。
      // 这时用户点「取消」，服务端找不到进行中的请求（aborted=false），
      // 于是什么都不做 —— analyzing 永远留着，界面一直转圈。
      //
      // 实测就卡在这里：取消 27ms 返回，但 analyzing 6 秒后还在。
      if (!aborted) {
        try {
          const vid = this.store.getLiveVideoIdByPath?.(videoPath);
          if (vid) {
            // 归位成 pending 而不是 completed：分段可能只写了一部分，
            // 让用户自己决定要不要重跑，比我们替他判断"这次跑完了"安全。
            this.store.db
              .prepare("UPDATE live_videos SET analysis_status = 'pending' WHERE id = ? AND analysis_status = 'analyzing'")
              .run(vid);
            console.log(`[analyze-cancel] ${videoPath} 无进行中的请求，把悬空的 analyzing 归位为 pending`);
          }
        } catch (e) {
          console.warn('[analyze-cancel] 归位失败:', e.message);
        }
      }
      console.log(`[analyze-cancel] ${videoPath} ${aborted ? '已中断' : '（无进行中的请求，仅清标记）'}`);
      return res.json({ ok: true, aborted, killed });
    });

    /**
     * 按路径回读这条直播的分析结果。
     *
     * 为什么必须有这个:两三个小时的直播,完整分析(ASR + LLM 分段)本地要跑
     * 30~60 分钟,而客户端的 HTTP 超时是有限的。之前超时一到就直接抛
     * "Hermes 调用超时",可这时候分析其实已经跑完、结果就在库里 ——
     * 用户白等一场,还被告知失败(我们就这么让用户白跑了 14 分钟)。
     *
     * 超时后回读这个端点就能把已完成的结果取回来。
     * 如果还在 analyzing,返回 running:true,让界面说"还在跑"而不是"失败"。
     */
    this.app.get('/pipeline/live-result', this.requireReadAuth, (req, res) => {
      try {
        const raw = String(req.query?.videoPath || '').trim();
        if (!raw) return res.status(400).json({ error: 'videoPath required' });
        const videoPath = raw.replace(/\\/g, '/');
        const vid = this.store.getLiveVideoIdByPath?.(videoPath);
        if (!vid) return res.status(404).json({ error: '这条直播还没登记' });
        const row = this.store.db
          .prepare('SELECT * FROM live_videos WHERE id = ?')
          .get(vid);
        const status = String(row?.analysis_status || 'pending');
        // 只有 draft 是活跃批次；superseded 是上一轮的分段，不能当结果返回。
        //
        // 但不能"非 completed 就一律丢弃"：分析被用户取消、或进程上次异常退出
        // 被启动自愈归位成 pending 之后，库里的分段其实完好（实测 207 段），
        // 而这里返回空数组 -> 界面显示 0 段，用户以为素材白分析了。
        // 状态只说明"这一轮跑到哪了"，不代表已有数据不能用。
        const segments = this.store.getLiveSegmentsByVideo?.(vid) || [];
        // 还没跑过任何分析的（连分段都没有）才算真的没有结果
        const hasResult = segments.length > 0;
        let health = null;
        try { health = row?.analysis_health ? JSON.parse(row.analysis_health) : null; } catch { /* ignore */ }

        // 注意：这里**不要**附带逐句原文。
        // 这个端点返回的是整场直播的全部分段（3 小时直播能到 200+ 段），
        // 每段再拼上完整文本会让响应体膨胀到几 MB ——
        // 而它的调用方（超时回读）只需要段数和时间轴。
        // 逐句原文只在 review-packet 里给，那是"精修单条粗剪"才需要的量级。
        res.json({
          ok: true,
          liveVideoId: vid,
          status,
          // 还在跑就别谎称"进行中"：如果已经有一批可用分段，要让界面知道有货，
          // 否则用户会一直转圈等一个其实早就出结果的分析
          running: (status === 'analyzing' || status === 'pending') && !hasResult,
          segmentCount: segments.length,
          segments: segments.map((s) => ({
            segmentIndex: s.segment_index,
            startMs: s.start_ms,
            endMs: s.end_ms,
            durationMs: s.duration_ms,
            themeName: s.theme_name,
            themeConfidence: s.theme_confidence,
            matchedHitThemes: s.matched_hit_themes,
            hookQuality: s.hook_quality,
            transcriptSummary: s.transcript_summary
          })),
          health
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Mark a video as priority (user opened it in dashboard -> transcribe/analyze it first)
    this.app.post('/pipeline/prioritize', this.requireWriteAuth, (req, res) => {
      const { videoPath } = req.body || {};
      if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
      this.scheduler?.prioritize(videoPath);
      res.json({ ok: true, prioritized: videoPath });
    });

    // Create clip project from analyzed live video
    this.app.post('/pipeline/clip', this.requireWriteAuth, async (req, res) => {
      const { liveVideoId, segmentIds, cutsByIndex } = req.body;
      if (!liveVideoId) return res.status(400).json({ error: 'liveVideoId required' });
      try {
        // 2026-09-30 用户已明确勾选时,不要走自动选段。
        //
        // 为什么:createProject 的自动路径会做"逐句剔除运营话术",一旦判空
        // 就直接抛错。于是即便用户在界面上已经挑好片段,整条流程也会在
        // 第一步就挂掉,set-selection 根本没机会执行。
        // 用户挑的片段应当优先于模型的自动判断。
        if (Array.isArray(segmentIds) && segmentIds.length > 0) {
          const picked = this._segmentsByIndex(liveVideoId, segmentIds, cutsByIndex);
          if (picked.length === 0) {
            return res.status(400).json({ error: '勾选的分段 id 一个都没匹配上' });
          }
          // presetSegments 让 createProject 跳过自动选段与话术剔除。
          // 爆款开头前置的开关/指定原文/长度一并透传,否则用户勾选这条路上没有前置。
          const built = await this.clipper.createProject(liveVideoId, {
            presetSegments: picked,
            viralOpening: req.body.viralOpening !== false,
            viralOpeningSeconds: req.body.viralOpeningSeconds,
            openingText: req.body.openingText,
            forcedOpeningSegmentId: req.body.openingSegmentId
          });
          const clipResult = await this.clipper.clip(built.projectId);
          /*
           * 粗剪拼不出来时不能报 clipped:true。
           * 桌面端看到 true 就认为粗剪已就绪，用户审完一整轮，
           * 到出片那一步才撞上 generator 的"找不到粗剪视频"。
           */
          if (clipResult?.roughcutFailed) {
            return res.status(500).json({
              ok: false,
              projectId: built.projectId,
              clipped: false,
              error: clipResult.error || '切片已生成但拼接粗剪失败，请重跑一次出片',
              ...clipResult
            });
          }
          return res.json({
            ok: true,
            projectId: built.projectId,
            clipped: true,
            usedUserSelection: true,
            viralOpening: built.viralOpening ?? null,
            ...clipResult
          });
        }

        const result = await this.clipper.createProject(liveVideoId);

        // If no pending queries, auto-clip
        if (result.pendingQueries.length === 0) {
    const clipResult = await this.clipper.clip(result.projectId);
    // 同上：拼接失败不能回 ok:true（见上面 /pipeline/clip 的注释）
    if (clipResult?.roughcutFailed) {
      return res.status(500).json({
        ok: false,
        projectId: result.projectId,
        clipped: false,
        error: clipResult.error || '切片已生成但拼接粗剪失败，请重跑一次出片',
        ...clipResult
      });
    }
    res.json({ ok: true, projectId: result.projectId, clipped: true, ...clipResult });
        } else {
          res.json({ ok: true, projectId: result.projectId, clipped: false, pendingQueries: result.pendingQueries });
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });


    /**
     * 写入用户在界面上勾选的分段。
     * 2026-09-30 新增：GLB Studio 的出片是"用户勾哪几条就出哪几条"，
     * 而 /pipeline/clip 只认 liveVideoId 并会走 Clipper 自己的选段逻辑，
     * 直接对接会把用户的勾选覆盖掉。这里补一个显式写 selected_segments 的入口。
     */
    /**
     * 多版本粗剪：一次产出多条不同长度/不同开头的成片，供用户挑。
     * 2026-09-30 新增。以前一次只能出一版，要试另一种长度就得改配置重跑。
     */
    this.app.post('/pipeline/clip-variants', this.requireWriteAuth, async (req, res) => {
      const { liveVideoId, segmentIds, cutsByIndex, variants, openingText, viralOpening } = req.body;
      if (!liveVideoId) return res.status(400).json({ error: 'liveVideoId required' });
      try {
        const result = await this.clipper.clipVariants(liveVideoId, {
          segmentIds,
          cutsByIndex,
          variants,
          openingText,
          // 前置开关以前被丢掉了,界面上关掉也没用 ——
          // 界面只是提示"已关闭",实际每一版都还是被前置了钩子。
          ...(viralOpening !== undefined ? { viralOpening: viralOpening !== false } : {})
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/pipeline/set-selection', this.requireWriteAuth, async (req, res) => {
      const { projectId, segmentIds } = req.body;
      if (!projectId || !Array.isArray(segmentIds)) {
        return res.status(400).json({ error: 'projectId and segmentIds[] required' });
      }
      try {
        const project = this.store.getClipProject(Number(projectId));
        if (!project) return res.status(404).json({ error: `Clip project ${projectId} not found` });

        // 归一化(startMs/endMs + cuts)统一走 _segmentsByIndex,
        // 与 /pipeline/clip 的预选路径共用同一套规则。
        // 两边各写一份时已经出过 bug:界面勾了区间,成片按整段出。
        const normalized = this._segmentsByIndex(project.live_video_id, segmentIds, req.body.cutsByIndex);
        if (normalized.length === 0) return res.status(400).json({ error: '勾选的分段 id 一个都没匹配上' });

        let appliedCuts = 0;
        for (const seg of normalized) {
          if (Array.isArray(seg.cuts) && seg.cuts.length) {
            appliedCuts += seg.cuts.length;
          }
        }
        if (appliedCuts) {
          console.log(`[Orchestrator] set-selection applied ${appliedCuts} sentence-level cuts across ${normalized.length} segments`);
        }

        if (typeof this.store.updateClipProjectSelection === 'function') {
          this.store.updateClipProjectSelection(Number(projectId), normalized);
        } else {
          // store 未提供更新方法时直接落库，避免"接口在但没实现"
          this.store.db
            .prepare('UPDATE clip_projects SET selected_segments = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(normalized), new Date().toISOString(), Number(projectId));
        }
        res.json({ ok: true, applied: normalized.length, requested: segmentIds.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * 对已有工程按当前 selected_segments 继续出片。
     * /pipeline/clip 一次性做完"建工程 + 选段 + 出片"，界面改过勾选后需要单独触发渲染。
     */
    this.app.post('/pipeline/resume-clip', this.requireWriteAuth, async (req, res) => {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });
      try {
        const result = await this.clipper.clip(Number(projectId));
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * 审片包：把"粗剪 + 段映射 + 历史意见"一次给全。
     *
     * 为什么单独开一个端点，而不是让桌面端自己去拼：
     *  - 粗剪文件路径以前只混在 clip() 的返回里，桌面端默认看不到它
     *    （包装选项一开就被 deliver 覆盖），于是"审片"根本无从下手；
     *  - 粗剪时间轴从 0 开始，段落信息却来自原素材，两套坐标必须由服务端
     *    换算好。桌面端自己算要复刻一遍拼接顺序的逻辑，早晚会和这里不一致；
     *  - 审片历史也只有服务端有。
     */
    this.app.get('/projects/:id/review-packet', this.requireReadAuth, (req, res) => {
      try {
        const id = parseInt(req.params.id);
        const project = this.store.getClipProject(id);
        if (!project) return res.status(404).json({ error: '项目不存在' });

        // 段映射：selected_segments 已按角色排好序，粗剪就是这个顺序拼起来的，
        // 所以按顺序累加时长就是每段在粗剪里的位置。
        //
        // 注意 getClipProject() 已经把 selected_segments JSON.parse 成数组了，
        // 这里再 parse 一次会抛错、被 catch 吞掉，结果所有工程都返回 0 段 ——
        // 而且不报错，只表现为"这个工程没有段落"。
        let segs = project.selected_segments;
        if (typeof segs === 'string') {
          try { segs = JSON.parse(segs); } catch { segs = []; }
        }
        if (!Array.isArray(segs)) segs = [];

        // selected_segments 里只有 segmentId，没有段序号。
        // 而界面要显示"第 N 段"、打回也要能指名道姓 —— 这里按 id 反查真实的 segment_index。
        // （之前直接拿 segmentId 当序号用，界面上会显示成"第 1115 段"。）
        const indexById = new Map();
        try {
          for (const row of (this.store.getLiveSegmentsByVideo(project.live_video_id) || [])) {
            if (row && row.id !== undefined && row.id !== null) indexById.set(Number(row.id), row.segment_index);
          }
        } catch { /* 反查失败就退回按顺序编号 */ }

        const map = [];
        let cursor = 0;
        // 逐句原文：审片台要"像编辑文本框一样框选几个字删掉"，
        // 而 selected_segments 里只有主题名和时间轴 —— 没有文本就没有东西可选。
        // 一次只取这条粗剪涉及的句子，不是整场，所以响应体可控。
        const liveRow = this.store.db
          .prepare('SELECT asr_path FROM live_videos WHERE id = ?')
          .get(project.live_video_id);
        /*
         * 热词在读逐句稿之前先套上。
         *
         * 这一句是整个热词功能的**全部实现**：只要 loadTranscript 出口是对的，
         * 审片台文案、打回重剪、分析提示词、成片字幕就都是对的。
         * 之前我把热词做成"给 UI 一个列表自己替换"，
         * 结果已存的项目要等重新分析才生效 —— 而用户要的是"改完立即生效"。
         */
        // 规则跟着这条直播走，不依赖全局状态（原来这里还重复调了一次）
        const transcript = loadTranscript(
          liveRow?.asr_path,
          this.store.getHotwords(this._collectionOfLiveVideo(project.live_video_id))
        );

        for (const s of segs) {
          const start = Number(s.startMs ?? 0) / 1000;
          const end = Number(s.endMs ?? 0) / 1000;
          /*
           * 粗剪里的实际时长 = cuts 剩下的子区间之和，不是整段时长。
           *
           * 2026-10-05 修：以前直接用 end-start 累加 cursor，
           * 而 clip() 拼接的只是 cuts 的子区间（clipper 里就是按 seg.cuts 切的）。
           * 于是一个"删了中间 25 秒"的段，在真实文件里只有 35 秒，
           * 但这里报成 60 秒 —— 后面所有段的粗剪位置都偏了。
           *
           * 后果全是用户可见的：审片台会把播放中的画面标成错误的段、
           * 点某一行会 seek 到错的位置、标题里的"粗剪 100.0s"其实只有 75s。
           * generator 那边早就按 cuts 累加过（见 generator/index.js 的 segDurationMs），
           * 只有这里没跟上。
           */
          const roughcutDur = (() => {
            if (Array.isArray(s.cuts) && s.cuts.length) {
              const sum = s.cuts.reduce(
                (a, c) => a + Math.max(0, (Number(c.en) - Number(c.st)) / 1000),
                0
              );
              // cuts 全废（越界/为零）时退回整段，避免算出 0 时长把后面全挤在一起
              return sum > 0 ? sum : Math.max(0, end - start);
            }
            return Math.max(0, end - start);
          })();
          const dur = roughcutDur;
          const editable = buildEditableText(transcript, start, end);
          const tl = describeTextless(editable.sentences, dur);
          map.push({
            // selected_segments 里存的是 segmentId（live_segments.id），没有 segment_index。
            // 写 segmentIndex 会全部变成 0，界面上每段都显示成"第 0 段"，
            // 点名打回也会指向错的段 —— 所以这里用 segmentId 作主键。
            segmentId: s.segmentId ?? null,
            segmentIndex: s.segmentId != null && indexById.has(Number(s.segmentId))
              ? Number(indexById.get(Number(s.segmentId)))
              : map.length + 1,
            themeName: String(s.themeName || ''),
            role: s.role || '',
            hookQuality: s.hookQuality ?? null,
            score: s.hookQuality != null ? Math.round(Number(s.hookQuality) * 100) : null,
            roughcutStartSec: Number(cursor.toFixed(3)),
            roughcutEndSec: Number((cursor + dur).toFixed(3)),
            sourceStartSec: start,
            sourceEndSec: end,
            // 可编辑原文（按句切开，句间用空格连接）
            text: editable.text,
            sentences: editable.sentences,
            // 实操教学段：几乎没有文字。这类段界面要显示成时间区间块而不是文本框 ——
            // 给它一个空文本框，用户只会以为功能坏了，而它恰恰通常是要保留的核心内容。
            textless: tl.textless,
            textlessHint: tl.hint,
            // 已经剪掉的区间（来自上一次打回），界面上要显示成删除线
            cuts: Array.isArray(s.cuts) ? s.cuts : []
          });
          cursor += dur;
        }

        // 粗剪路径：优先用工程目录里现成的，兼容只有 output_path 的老数据
        let roughcutPath = '';
        try {
          const dir = this.clipper?.draftDir ? join(this.clipper.draftDir, `project_${id}`) : '';
          if (dir && existsSync(dir)) {
            const hit = readdirSync(dir).find((f) => /roughcut\.mp4$/i.test(f));
            if (hit) roughcutPath = join(dir, hit);
          }
        } catch { /* 拿不到就让前端回退到原始素材播放 */ }

        let feedback = [];
        try { feedback = this.store.getFeedbackByProject(id) || []; } catch { /* ignore */ }

        res.json({
          ok: true,
          projectId: id,
          status: project.status,
          liveVideoId: project.live_video_id,
          roughcutPath,
          segments: map,
          totalSec: Number(cursor.toFixed(3)),
          feedback: feedback.map((f) => ({
            id: f.id,
            decision: f.decision,
            comment: f.comment,
            segmentIds: f.segment_ids,
            createdAt: f.created_at,
            collection: f.collection
          }))
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /*
     * 热词硬纠正（按 IP 老师归档）
     *
     * 读/增/删三个口都在这里。改完立刻生效，不需要重跑分析 ——
     * 因为应用点在 loadTranscript 出口，而那是所有文本的唯一来源。
     *
     * 字幕为什么也会跟着变：成片字幕由逐句稿生成，
     * 而字幕是在**出片那一刻**渲染的。
     * 所以已经出的片子不会自动变（文件已经写好了），
     * 但下一条片子、以及重新出片都会用纠正后的文本。
     * 这点必须如实告诉用户，不能说"改完全都立刻生效"。
     */
    this.app.get('/memory/hotwords', this.requireReadAuth, (req, res) => {
      try {
        // ?collection= 省略 = 通用 + 当前 IP；传空串 = 纯通用。
        // 同样要挡 "null" 字符串（见 POST 处的注释）。
        const collection = req.query.collection === undefined
          ? undefined
          : (req.query.collection === null || String(req.query.collection).trim() === ''
              ? null
              : String(req.query.collection).trim());
        res.json({ ok: true, hotwords: this.store.getHotwords(collection) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/memory/hotwords', this.requireWriteAuth, (req, res) => {
      try {
        const b = req.body || {};
        /*
         * collection 省略 = 记到"通用"（对所有 IP 生效），与 review_edits 同一约定。
         *
         * 坑：写成 String(b.collection).trim() || null 会把**JS 的 null**
         * 变成字符串 "null" 存进库（因为 String(null) === 'null'，trim 后非空）。
         * 之后查询条件 collection = NULL 永远匹配不上字符串 'null'，
         * 表现是"刚加的规则读不回来、也不生效" —— 加进去看着成功了，
         * 实际上是一条谁都看不见的孤儿数据。
         *
         * 所以必须先判 null/undefined，再谈转字符串。
         */
        const collection = b.collection === undefined || b.collection === null
          ? null
          : (String(b.collection).trim() || null);
const r = this.store.addHotword(collection, b.from, b.to);
        if (!r.ok) return res.status(400).json({ error: r.error });
        /*
         * "立刻生效"不靠任何全局状态：
         * 每个读稿处都会用自己那条直播的 collection 现取规则，
         * 所以这里只要把规则写进库，下次读稿自然就是新的。
         *
         * （以前这里调 setHotwords 去更模块级状态，看着像"立刻生效"，
         *   实际上没人读那个状态 —— 属于会误导后来人的假保证。）
         */
        res.json({ ok: true, id: r.id, updated: r.updated });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

this.app.delete('/memory/hotwords/:id', this.requireWriteAuth, (req, res) => {
      try {
        const id = Number(req.params.id);
        const ok = this.store.deleteHotword(id);
        // 同上：不再更新全局状态，读稿处按自己的 collection 现取规则
        res.json({ ok });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /*
     * 某位 IP 老师的剪辑档案（归档的读取口）。
     *
     * 为什么单独一个接口而不是塞进 review-packet：
     * 审片包是"这一条粗剪的数据"，每开一次都要；
     * 档案是"这位老师的历史积累"，整个会话读一次就够。
     * 混在一起会让每次开审片台都拖着几十万字的偏好记录。
     */
    this.app.get('/memory/edit-archives', this.requireReadAuth, (req, res) => {
      try {
        const name = String(req.query.collection || '').trim();
        if (!name) {
          return res.json({ ok: true, archives: this.store.listEditArchives() });
        }
        const archive = this.store.getEditArchive(name);
        // 没有档案是**正常状态**（这位老师还没被审过片），返回 200 + null。
        // 以前这里回 404，界面就把它当"读失败"报红：
        // "Error invoking remote method ... 404: 没有「未分类」的剪辑档案"
        // 用户看到的是"出错了"，而真相只是这位老师还没有剪辑样本。
        // 空状态和错误状态必须区分 —— 前者是正常流程，后者才需要人管。
        res.json({ ok: true, archive: archive ?? null });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /*
     * 桌面端记剪辑学习样本。
     *
     * 为什么需要单独一个端点，而不是让桌面端走 /projects/:id/review：
     * 桌面端的审阅台是**逐个候选**改的（改标题、调起止、剔句子），
     * 一次审阅会产生好几条独立的编辑信号，而且没有"打回重剪"这个整体动作。
     * 硬塞进 review 会被迫伪造 segmentIds/textCuts，还容易把"改了标题"
     * 这种编辑混进"否决了这条粗剪"的语义里 —— 后者会污染黑名单。
     *
     * body：
     *   liveVideoId / videoPath  定位这场直播（决定归档到哪位老师）
     *   edits[]                  每条编辑
     *     kind: 'cut' | 'keep' | 'title'
     *     text / themeName / oldTitle / startSec / endSec / role
     *   collection               可选，显式指定 IP；不给就按直播自身归属
     */
    this.app.post('/memory/edit-records', this.requireWriteAuth, (req, res) => {
      try {
        const b = req.body || {};
        const liveVideoId = Number(b.liveVideoId) || null;
        // 没给 liveVideoId 就按 videoPath 反查 —— 桌面端手上通常只有路径
        let lv = liveVideoId;
        if (!lv && b.videoPath) {
          // 必须用归一化查找：桌面端给的是 E:\直播\a.mp4，
          // 库里是 E:/直播/a.mp4，精确匹配查不到 → 归属退化成"通用" → 串档。
          lv = this.store._findLiveByPath(b.videoPath)?.id || null;
          if (!lv) console.warn(`[EditRecords] 按路径找不到直播，样本会记成通用：${b.videoPath}`);
        }
        /*
         * 归档到谁：显式指定 > 直播自身归属 > 当前选中。
         * 优先级不能反 —— 桌面端传什么就存什么的话，
         * 传错一个名字就把这位老师的样本全写进别人档案里了。
         */
        const col = (b.collection ? String(b.collection).trim() : null)
          || (lv ? this.store._ownerOfLive(lv) : null)
          || null;

        const rows = [];
        for (const e of (Array.isArray(b.edits) ? b.edits : [])) {
          if (!e || !e.kind) continue;
          const text = String(e.text ?? '').trim();
          const oldTitle = String(e.oldTitle ?? '').trim();
          // cut/keep 要有正文；title 要有"改成什么"
          if (!text) continue;
          if (e.kind === 'title' && !oldTitle) continue;
          rows.push({
            clipProjectId: null,
            liveVideoId: lv,
            collection: col,
            kind: e.kind,
            segmentId: Number(e.segmentId) || null,
            role: e.role ? String(e.role) : null,
            // 标题类：theme_name 存 AI 原标题，text 存用户改后的
            themeName: e.kind === 'title' ? oldTitle : (e.themeName ? String(e.themeName) : null),
            text,
            charFrom: Number.isFinite(Number(e.charFrom)) ? Number(e.charFrom) : null,
            charTo: Number.isFinite(Number(e.charTo)) ? Number(e.charTo) : null,
            startMs: Number.isFinite(Number(e.startSec)) ? Math.round(Number(e.startSec) * 1000) : null,
            endMs: Number.isFinite(Number(e.endSec)) ? Math.round(Number(e.endSec) * 1000) : null,
            score: Number.isFinite(Number(e.score)) ? Number(e.score) : null,
            reason: String(e.reason ?? b.reason ?? '').trim() || null,
            by: e.by === 'picked' ? 'picked' : 'edited'
          });
        }
        if (!rows.length) return res.json({ ok: true, written: 0, collection: col, note: '没有可入库的编辑' });
        const n = this.store.addReviewEdits(rows);
        console.log(`[EditRecords] 桌面端 +${n} 条（${col || '通用'}）`);
        res.json({ ok: true, written: n, collection: col });
      } catch (err) {
        console.error('[EditRecords] 失败:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // Generate content for a clip project
    this.app.post('/pipeline/generate', this.requireWriteAuth, async (req, res) => {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });
      try {
        // 透传全部出片选项。
        //
        // 以前只透传 subtitles/covers/title/titleText 四个,界面上另外十几个开关
        // (竖屏、冷开场、闪前、标题卡、自动变焦、BGM、音效、水印、字幕样式)
        // 在后端完全收不到 —— 勾了不生效也不报错。现在原样转发,
        // 具体实现由 ContentGenerator.generateAll 负责(那里有逐项开关的兜底与降级)。
        const b = req.body || {};
        const result = await this.contentGenerator.generateAll(Number(projectId), {
          subtitles: b.subtitles,
          covers: b.covers,
          title: b.title,
          titleText: b.titleText,

          // 画面
          vertical: b.vertical,
          captionStyle: b.captionStyle,
          captionSize: b.captionSize,
          coldOpen: b.coldOpen,
          titleCard: b.titleCard,
          autoZoom: b.autoZoom,
          watermark: b.watermark,

          // 音频
          bgmPath: b.bgmPath,
          bgmVolume: b.bgmVolume,
          duckBgm: b.duckBgm,
          sfx: b.sfx,
          sfxAt: b.sfxAt,

          // 字幕 / 标题样式（字体、颜色、字号、位置、描边、阴影、底板）
          captionFontStyle: b.captionFontStyle,
          titleFontStyle: b.titleFontStyle,
          // 这两个以前只在 RenderOptions 里,没进这条链路 ——
          // 于是"标题卡停 3 秒""冷开场 2 秒"两个设置存了也白存
          titleCardSeconds: b.titleCardSeconds,
          coldOpenSeconds: b.coldOpenSeconds,

          // 用户上传的封面图（当成片第一帧）/ 结尾藏带货视频
          coverImage: b.coverImage,
          tailVideo: b.tailVideo
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Full pipeline status
    this.app.get('/pipeline/status', this.requireReadAuth, (req, res) => {
      try {
        const stats = this.store.getExtendedStats();
        const schedulerStatus = this.scheduler.getStatus();
        res.json({
          ok: true,
          stats,
          scheduler: schedulerStatus,
          ollamaReady: this.ollamaReady
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── User Query endpoints ───

    // List pending queries
    this.app.get('/queries', this.requireReadAuth, (req, res) => {
      try {
        const queries = this.userQuery.getPending();
        res.json({ ok: true, queries });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get specific query
    this.app.get('/queries/:id', this.requireReadAuth, (req, res) => {
      try {
        const q = this.userQuery.get(parseInt(req.params.id));
        if (!q) return res.status(404).json({ error: 'Query not found' });
        res.json({ ok: true, query: q });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Answer a query
    this.app.post('/queries/:id/answer', this.requireWriteAuth, (req, res) => {
      const { answer } = req.body;
      if (!answer) return res.status(400).json({ error: 'answer required' });
      try {
        this.userQuery.answer(parseInt(req.params.id), answer);
        // Check if project can now proceed
        const q = this.userQuery.get(parseInt(req.params.id));
        if (q && q.project_id) {
          const pending = this.userQuery.getPendingForProject(q.project_id);
          if (pending.length === 0) {
            // Auto-resume the project
            this.clipper.resumeProject(q.project_id).catch(err =>
              console.error(`[Orchestrator] Auto-resume failed for project ${q.project_id}:`, err.message)
            );
          }
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Dashboard HTML page
    this.app.get('/dashboard', (req, res) => {
      let html = this._getDashboardHtml();
      if (req.query.embed === '1') { html = html.replace('</head>', '<style>header button.btn{display:none!important}.tabs button[data-t]:not([data-t="hits"]){display:none!important}#page-live,#page-outputs,#page-projects,#page-queries{display:none!important}</style></head>'); }
      // 嵌在 GLB 里时别让 iframe 吃缓存，改完看板必须立刻生效
      res.set('Cache-Control', 'no-cache');
      res.send(html);
    });
    this.app.get('/', (req, res) => res.redirect('/dashboard'));

    // 旧片段边播边下修复：把项目输出目录里的 mp4 全部 faststart 化（无损秒级），解决浏览器点播转圈/闪退
    this.app.post('/projects/:id/faststart', this.requireWriteAuth, async (req, res) => {
      try {
        const project = this.store.getClipProject(parseInt(req.params.id));
        if (!project?.output_path || !existsSync(project.output_path)) {
          return res.status(404).json({ error: '项目输出目录不存在' });
        }
        const ff = await this._getFF();
        const files = readdirSync(project.output_path).filter(f => /\.mp4$/i.test(f));
        let fixed = 0;
        const errors = {};
        for (const f of files) {
          const p = join(project.output_path, f);
          const tmp = p + '.faststart.mp4';
          const bak = p + '.bak';
          try {
            await ff.run(ff.ffmpegPath, ['-i', p, '-c', 'copy', '-movflags', '+faststart', '-y', tmp]);
            // Windows 下直接覆盖改名会失败，用 bak 中转；源文件被浏览器占用时改名同样失败则跳过
            const { renameSync, unlinkSync, existsSync } = await import('fs');
            if (existsSync(bak)) unlinkSync(bak);
            renameSync(p, bak);
            renameSync(tmp, p);
            unlinkSync(bak);
            fixed++;
          } catch (err) {
            errors[f] = String(err.message).slice(0, 200);
            console.warn(`[Faststart] ${f} failed (可能正被预览占用，关掉播放器重试): ${err.message}`);
            try { (await import('fs')).unlinkSync(tmp); } catch { /* ignore */ }
            try {
              const { renameSync, existsSync } = await import('fs');
              if (existsSync(bak)) renameSync(bak, p); // 还原
            } catch { /* ignore */ }
          }
        }
        res.json({ ok: true, fixed, total: files.length, errors });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 桌面端爆点候选打回：意见进评审表+经验，并灌给桌面端检测用 ───
    // GLB 主界面候选列表每行的“打回重找”调这里：comment 会出现在
    // review-memory.json 否决样例的 hook 里，下次“AI找爆点/按记忆重找”即生效
    this.app.post('/highlight/reject', this.requireWriteAuth, async (req, res) => {
      try {
        const { videoName, title, startSec, endSec, comment, opening } = req.body || {};
        if (!comment) return res.status(400).json({ error: '请写一句意见再打回' });
        const fmt = (s) => {
          s = Math.max(0, Math.round(Number(s) || 0));
          const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        };
        const range = (startSec != null && endSec != null) ? `${fmt(startSec)}→${fmt(endSec)}` : '';
        const name = String(title || '未命名片段').slice(0, 60);
        const from = String(videoName || '本期直播').slice(0, 60);
        const opinion = String(comment).slice(0, 200);
        this.store.addReviewFeedback({
          clipProjectId: null, liveVideoId: null,
          decision: 'recut', segmentIds: null,
          comment: `[桌面端打回·${from}]《${name}》${range}：${opinion}`,
          // 显式带上当前选中的 IP 老师。
          // 以前不传时 store 会回落 activeCollection,而桌面端当时还没这个联动,
          // 于是历史意见全落在 collection=NULL,后续按集合取"避免规则"时一条都读不到 ——
          // 用户明明说过"钩子不够炸",分析时却完全不生效。
          collection: this.store.activeCollection || null,
        });
        this.store.addReviewLesson(`桌面端打回《${name}》${range ? `（${range}）` : ''}：${opinion}，同类重找时避开`);
        // 指定了新开头：再记一条采用样例，桥接到桌面端后检测会去全场找这句话并以它开头剪
        if (opening) {
          this.store.addReviewFeedback({
            clipProjectId: null, liveVideoId: null,
            decision: 'approve', segmentIds: null,
            comment: `[桌面端指定开头]必须在全场逐句稿中找到这句话并以它为开头剪出完整爆款：《${String(opening).slice(0, 60)}》；${opinion}`,
            collection: this.store.activeCollection || null,
          });
        }
        // 立刻灌给 GLB 桌面端（不同步等待，不挡响应）
        this.glbBridge?.sync({ pull: false }).catch(() => {});
        this._briefCache = null;
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 桌面端审阅台"弃段"：用户在「审阅切点」里点某段的「不选」────────────────
    // 一次点击就是一条最干净的偏好信号：这段别要。落成评审表 + 评审经验，
    // 经验会被下次自动粗剪读取（scheduler 的 getReviewLessons），做到越用越像本人。
    // 归属：当前活跃文件夹 = 这个 IP/老师，comment 里带上名字便于看板筛选。
    // 注意：不写死段号，只记时间范围 + 文案，源视频重新转写后依然对得上。
    this.app.post('/highlight/drop-piece', this.requireWriteAuth, async (req, res) => {
      try {
        const { clipTitle, videoName, startSec, endSec, text } = req.body || {};
        // 2026-09-25 加：以前空 body 也照单全收，落一条《未命名切片》+全空字段的记录
        // 进 review_feedback，污染学习样本（实测：空 POST 会写库并返回 200）。
        const hasTextIn = typeof text === 'string' && text.trim();
        const hasRangeIn = Number.isFinite(Number(startSec)) && Number.isFinite(Number(endSec));
        if (!hasTextIn && !hasRangeIn) {
          return res.status(400).json({ error: '缺少 text 或 startSec/endSec（至少给一样）' });
        }
        const fmt = (s) => {
          s = Math.max(0, Math.round(Number(s) || 0));
          const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        };
        const hasRange = startSec != null && endSec != null;
        const range = hasRange ? `${fmt(startSec)}→${fmt(endSec)}` : '';
        const name = String(clipTitle || '未命名切片').slice(0, 60);
        const from = String(videoName || '').split(/[\\/]/).pop().slice(0, 60);
        const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const collection = this.getActiveCollection();
        this.store.addReviewFeedback({
          clipProjectId: null, liveVideoId: null,
          decision: 'reject', segmentIds: null,
          comment: `[桌面端弃段${collection ? '·' + collection : ''}]《${name}》${range}：这段不要了${body ? `——"${body}"` : ''}`,
        });
        this.store.addReviewLesson(
          `桌面端弃段《${name}》${range ? `（${range}）` : ''}${body ? `「${body}」` : ''}：这类段落没有价值，下次拼片时不要再选进来`
        );
        this.glbBridge?.sync({ pull: false }).catch(() => {});
        this._briefCache = null;
        res.json({ ok: true, collection });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 封面挑选（2026-09-27 老板指令④）：候选帧交本地 qwen2.5vl 看，挑最相关的一张 ───
    // GLB 出片后处理把候选帧（base64）POST 过来；以前封面只按音频峰值+画面统计指标排序，
    // 全程没"看"画面，总截到不相关的图。模型缺失/失败时返回 best=0，GLB 用原选点降级。
    this.app.post('/vision-pick-cover', this.requireWriteAuth, async (req, res) => {
      try {
        const frames = Array.isArray((req.body || {}).frames) ? req.body.frames.filter((f) => typeof f === 'string' && f) : [];
        if (frames.length < 2) return res.json({ ok: true, best: 0, reason: '候选不足' });
        const desc = await this.ollama.describe(
          frames,
          '这是从一条声乐教学短视频里截出的候选封面帧（按时间顺序编号，从 0 开始）。挑出最适合当抖音封面的一张：老师在讲课或示范、画面清晰有表现力、信息量足；跳过纯字幕帧、转场、空镜、观众镜头。只输出严格 JSON：{"best": 编号, "reason": "一句话理由"}',
          { timeout: 90000 }
        );
        const m = String(desc || '').match(/"best"\s*:\s*(\d+)/);
        const best = m ? Math.min(frames.length - 1, Math.max(0, parseInt(m[1], 10))) : 0;
        res.json({ ok: true, best, raw: String(desc || '').slice(0, 200) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 记忆简报：给桌面端检测提示词用的多爆款参考（长短分档，自动接入）───
    // GLB 主进程每次 AI 找爆点都会顺手拉一份拼进 system prompt，
    // 无需手选参考视频；长短形态各取所需，避雷自动带上。
    // ─── 文件夹（一个 IP/老师一个文件夹；选哪个文件夹 = 用哪套爆款记忆）───
    // ─── 记忆快照：现在真正会用哪套爆款记忆 ───
    //
    // 为什么需要这个端点：active-collection 设对了,不等于分析时真的换了记忆。
    // 中间隔着 store.activeCollection -> live-analyzer 的注入逻辑,任何一环没接上
    // 都会"界面显示已切换,实际还在用旧的"。而 Hermes 的 stdout 不落盘,
    // 没法靠翻日志验证 —— 这个端点把实际会注入的内容直接摊出来。
    this.app.get('/api/memory-snapshot', this.requireReadAuth, (req, res) => {
      try {
        const active = this.store.activeCollection || null;
        const snap = {
          ok: true,
          activeCollection: active,
          // 有集合 -> 记忆来自该集合;没集合 -> 主题/钩子为空(不回落到全局池)
          source: active ? 'collection' : 'none',
          hits: this.store.getCollectionHits?.(active, 60) || [],
          hooks: this.store.getCollectionHooks?.(active, 12) || [],
          themes: this.store.getCollectionThemeKeywords?.(active, 40) || [],
          avoid: this.store.getCollectionAvoidRules?.(active, 20) || [],
        };
        res.json({
          ...snap,
          counts: {
            hits: snap.hits.length,
            hooks: snap.hooks.length,
            themes: snap.themes.length,
            avoid: snap.avoid.length,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // AI 大脑状态（2026-09-27）：看板「AI 大脑」状态条的数据源
    this.app.get('/api/llm-status', this.requireReadAuth, (req, res) => {
      try {
        const names = { ollama: "Ollama 本地", deepseek: "DeepSeek API", zen: "Zen 云端" };
        res.json({
          ok: true,
          provider: this.llmProvider || "ollama",
          providerName: names[this.llmProvider] || this.llmProvider,
          model: this.llmModel || "",
          cloud: !!this.llmCloud,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    this.app.get('/api/collections', this.requireReadAuth, (req, res) => {
      try {
        /*
         * 只返回爆款库里的文件夹。
         *
         * 曾试过把"有剪辑档案但没导入爆款"的老师也并进来，但没用：
         * 爆款库的 IP 列表存在桌面端本地（%APPDATA%/glb 的 index.json），
         * 不走这里。而且把 entryCount=0 的条目混进 IP 选择器，
         * 会让"这位老师一条爆款都没有"看起来像数据出错。
         * 所以没并 —— 想看剪辑档案，先在爆款库里建这位老师。
         */
        res.json({ ok: true, active: this.getActiveCollection(), ...this.store.listCollections() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 新建文件夹：落库，空文件夹也会一直显示在列表里
    this.app.post('/api/collections', this.requireWriteAuth, (req, res) => {
      try {
        const r = this.store.createCollection((req.body || {}).name);
        if (!r.ok) return res.status(400).json(r);
        this._briefCache = null;
        res.json(r);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 2026-09-24 补：以前只有 POST 没有 GET，调用方没法"先读当前值再改"。
    // 实测踩过坑：读不到当前值 → 盲写把「某老师」清成了空，记忆隔离被静默关掉。
    this.app.get('/api/active-collection', this.requireReadAuth, (req, res) => {
      try {
        const name = this._activeCollection || '';
        res.json({ ok: true, name });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 设定"当前用哪个文件夹的记忆剪片"：桌面端 AI 找爆点拉 /memory-brief 时会默认用它，
    // 不用改桌面端——在看板上选一次文件夹，之后剪片就按这个 IP/老师的爆款逻辑走。
    this.app.post('/api/active-collection', this.requireWriteAuth, (req, res) => {
      try {
        const name = String((req.body || {}).name || '').trim().slice(0, 40);
        this.setActiveCollection(name);
        this._briefCache = null;
        res.json({ ok: true, active: name || null });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
/*
     * 把一批本地视频排进爆款分析队列（桌面端「继续上传爆款素材」用）。
     *
     * 【为什么必须有这个端点】
     * 调度器只扫 config.upload.hitsDir 这一个目录，用户从 E:\直播\ 之类的
     * 任意位置选的视频，它根本看不到；唯一能分析任意路径的是
     * POST /pipeline/analyze-hit，但那是**同步**的 —— 一条素材 ASR+LLM
     * 可能十几分钟，桌面端的 IPC 会先超时，用户看到的是"失败"，
     * 而 Hermes 那边其实还在跑。
     *
     * 所以这里只做"登记 + 排队"然后立刻返回：
     *   1. upsert 出 analysis_status='pending' 的 hit_videos 行
     *   2. 立刻写好 collection —— 这样即使分析失败，这条素材也仍然归属
     *      这位老师，不会变成无主的孤儿数据
     *   3. 交给调度器后台慢慢跑（需配合 scheduler 里新增的 DB 取队列）
     *
     * 传的是路径不是字节：不复制 GB 级文件，就地分析。
     */
    this.app.post('/hits/enqueue', this.requireWriteAuth, (req, res) => {
      try {
        const body = req.body || {};
        const paths = Array.isArray(body.paths) ? body.paths : [];
        // 同 POST /memory/hotwords：必须先判 null，否则 String(null) 存成字符串 'null'
        const collection = body.collection === undefined || body.collection === null
          ? null
          : (String(body.collection).trim() || null);
        if (!paths.length) return res.status(400).json({ error: 'paths 不能为空' });
        if (collection) this.store.createCollection(collection);

        const accepted = [];
        const rejected = [];
        for (const raw of paths) {
          // 分隔符归一化：D:\x 与 D:/x 是两个不同的键，会插出两条重复记录
          const p = String(raw || '').replace(/\\/g, '/').trim();
          const name = p.split('/').pop() || p;
          if (!p) { rejected.push({ path: raw, reason: '空路径' }); continue; }
          if (!this.isAllowedMediaPath(p)) {
            rejected.push({ path: p, reason: '不在允许的工作目录内（config.security.extraAllowedDirs）' });
            continue;
          }
          try {
            /*
             * upsertHitVideo 返回的是**裸 id**（store.js 里 `return row?.id`），
             * 不是整行对象。以前这里当对象用：
             *   setHitCollection([undefined])  → 匹配不到任何 id，静默不生效
             * 结果是接口回 ok、界面显示"已排队 N 条"，
             * 而素材其实谁也不属于、也没人分析 —— 两头都看不出问题。
             */
            const id = this.store.upsertHitVideo(p, { videoName: name, analysisStatus: 'pending' });
            if (!Number.isInteger(id)) {
              rejected.push({ path: p, reason: '写入素材记录失败' });
              continue;
            }
            // 归属先落库：分析失败也要留在这位老师名下，不 becoming 无主孤儿
            if (collection) this.store.setHitCollection([id], collection);
            // 已经分析完的重复排队没有意义，如实告诉调用方
            const cur = this.store.getHitVideo(p);
            if (cur?.analysis_status === 'completed') {
              rejected.push({ path: p, reason: '已经分析过了' });
              continue;
            }
            this.scheduler?.prioritize(p);
            accepted.push({ id, videoPath: p, videoName: name });
          } catch (err) {
            rejected.push({ path: p, reason: err.message });
          }
        }
        this._briefCache = null;
        res.json({
          ok: accepted.length > 0,
          collection,
          accepted,
          rejected,
          // 说清楚"已经排队"而不是"已完成"，免得界面显示成"已学会"
          queued: accepted.length,
          message: accepted.length
            ? `已排队 ${accepted.length} 条，Hermes 会在空闲时逐条分析（GPU 忙时会排在后面）。分析完成后在爆款库里点「从历史爆款库同步」即可入库并重算画像。`
            : '没有可排队的素材',
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 归类：把选中的素材放进某个文件夹（名字不存在就是新建文件夹），name 为空 = 移出文件夹
    this.app.post('/hits/collection', this.requireWriteAuth, (req, res) => {
      try {
        const { ids, id, name, byCollection, paths } = req.body || {};
        // byCollection：把整个旧文件夹改名（文件夹记录和里面素材一起改），用于文件夹重命名
        // paths：刚上传完、只知道文件路径时也能归类（上传后自动进当前文件夹）
        if (!ids && id == null && !paths && byCollection) {
          const r = this.store.renameCollection(byCollection, name);
          if (!r.ok) return res.status(400).json(r);
          this._briefCache = null;
          return res.json({ ok: true, updated: r.updated, name: r.name });
        }
        let list = ids || (id != null ? [id] : []);
        if (!list.length && Array.isArray(paths) && paths.length) {
          const ph = paths.map(() => '?').join(',');
          list = this.store.db.prepare(`SELECT id FROM hit_videos WHERE video_path IN (${ph})`)
            .all(...paths.map(String)).map((r) => r.id);
        }
        const n = this.store.setHitCollection(list, name);
        this._briefCache = null;
        // 2026-09-27：把"这次改动可撤销"告诉界面，否则老板看不见能回退这一步
        const undo = this.store.peekCollectionUndo?.() || null;
        res.json({
          ok: true, updated: n, name: String(name || '').trim() || null,
          undoable: !!undo && n > 0, undoCount: undo?.count || 0,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 2026-09-27：撤销上一次归类。批量归入点错文件夹时的一键回退（此前完全没有）。
    this.app.post('/hits/undo-collection', this.requireWriteAuth, (req, res) => {
      try {
        const r = this.store.undoLastCollection?.() || { restored: 0, to: null };
        this._briefCache = null;
        res.json({ ok: r.restored > 0, ...r });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 清除素材（批量）：ids 数组，deleteFiles=true 才连源视频一起删
    this.app.post('/hits/delete', this.requireWriteAuth, async (req, res) => {
      try {
        const { ids, deleteFiles } = req.body || {};
        const list = (Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
        if (!list.length) return res.status(400).json({ error: '请先勾选要清除的素材' });
        const r = this.store.deleteHits(list, !!deleteFiles);
        this._briefCache = null; // 记忆变了，简报缓存失效
        this.glbBridge?.sync({ pull: false }).catch(() => {});
        res.json({ ok: true, ...r });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 清空整个文件夹（里面的素材全清掉；文件夹名随之消失，跟删文件夹一样）
    this.app.post('/hits/delete-collection', this.requireWriteAuth, async (req, res) => {
      try {
        const name = String((req.body || {}).name || '').trim();
        if (!name) return res.status(400).json({ error: '先选中一个文件夹' });
        const ids = this.store.db.prepare('SELECT id FROM hit_videos WHERE collection = ?').all(name).map((r) => r.id);
        let r = { deleted: 0, files: 0 };
        if (ids.length) {
          r = this.store.deleteHits(ids, !!(req.body || {}).deleteFiles);
          this.glbBridge?.sync({ pull: false }).catch(() => {});
        }
        // 素材清完后，文件夹记录本身也删掉（跟删文件夹一个意思）
        this.store.deleteCollectionRecord(name);
        this._briefCache = null;
        res.json({ ok: true, ...r, name });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 解散文件夹（2026-09-27 老板指令五）：素材全部移出回未分类、删文件夹记录，但绝不删素材和记忆。
    // 与 /hits/delete-collection（连记忆一起清）互补：只想去掉文件夹、舍不得素材时用这个。
    this.app.post('/hits/dissolve-collection', this.requireWriteAuth, (req, res) => {
      try {
        const name = String((req.body || {}).name || '').trim();
        if (!name) return res.status(400).json({ error: '先选中一个文件夹' });
        const ids = this.store.db.prepare('SELECT id FROM hit_videos WHERE collection = ?').all(name).map((r) => r.id);
        let moved = 0;
        if (ids.length) moved = this.store.setHitCollection(ids, null);
        this.store.deleteCollectionRecord(name);
        this._briefCache = null;
        res.json({ ok: true, moved, name });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 逐句成片：把直播/长视频里值得留的教学句一句句挑出来，拼成一条完整视频 ───
    // 异步执行（长视频清洗+拼接要几十分钟），前端轮询 /api/sentence-cuts 看进度
    this.app.post('/pipeline/sentence-cut', this.requireWriteAuth, async (req, res) => {
      try {
        const videoPath = String((req.body || {}).videoPath || '');
        if (!videoPath) return res.status(400).json({ error: 'videoPath required' });
        if (!this.isAllowedMediaPath(videoPath)) return res.status(403).json({ error: 'videoPath 不在允许的工作目录内' });
        if (!existsSync(videoPath)) return res.status(404).json({ error: '源文件不存在' });
        this._sentenceBusy = this._sentenceBusy || new Set();
        if (this._sentenceBusy.has(videoPath)) return res.status(409).json({ ok: true, busy: true, error: '这条已经在逐句成片中了' });
        const targetSec = Math.max(0, Math.round(Number((req.body || {}).targetMinutes) || 0)) * 60;
        const keepExtra = (req.body || {}).keepExtra !== undefined ? !!(req.body || {}).keepExtra : this.getKeepExtra();
        // 幂等：10 分钟内同素材、同目标时长已成功产出过 → 直接复用结果，不再重切（连点两次会出两个几乎一样的成片）
        this._sentenceRecent = this._sentenceRecent || new Map();
        const recent = this._sentenceRecent.get(videoPath);
        if (recent && recent.targetSec === targetSec && Date.now() - recent.at < 600e3 && existsSync(recent.outputPath)) {
          return res.json({ ok: true, reused: true, name: videoPath.split(/[\\/]/).pop(), outputPath: recent.outputPath });
        }
        this._sentenceBusy.add(videoPath);
        res.json({ ok: true, started: true, name: videoPath.split(/[\\\\/]/).pop() });
        // 后台跑，不占响应
        this.sentenceCutter.cut(videoPath, { targetSec, keepExtra })
          .then((r) => {
            console.log(`[SentenceCutter] done: ${r.outputPath} (${r.keptSecs}s / ${r.segCount} 段)`);
				this._sentenceRecent.set(videoPath, { outputPath: r.outputPath, targetSec, at: Date.now() });
            this.glbBridge?.sync({ pull: false }).catch(() => {});
          })
          .catch((err) => {
            console.error('[SentenceCutter] failed:', err.message);
            try {
              this.store.db.prepare("INSERT INTO sentence_cuts (video_path, video_name, output_path, status, note) VALUES (?,?,NULL,'failed',?)")
                .run(videoPath, videoPath.split(/[\\\\/]/).pop(), String(err.message).slice(0, 300));
            } catch { /* ignore */ }
          })
          .finally(() => this._sentenceBusy.delete(videoPath));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    this.app.get('/api/sentence-cuts', this.requireReadAuth, (req, res) => {
      try {
        res.json({ ok: true, cuts: this.sentenceCutter.list() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 最近记忆挑句记录（核对 AI 挑了哪些句子）
    this.app.get('/api/memory-picks', this.requireReadAuth, (req, res) => {
      try {
        const rows = this.store.db.prepare(
          'SELECT * FROM memory_picks ORDER BY id DESC LIMIT 5'
        ).all().map((r) => ({ ...r, items: r.items ? JSON.parse(r.items) : [] }));
        res.json({ ok: true, picks: rows });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 连麦/音乐保留开关（全局：记忆挑句与逐句成片都跟随它）
    this.app.get('/api/keep-extra', this.requireReadAuth, (req, res) => {
      res.json({ ok: true, keepExtra: this.getKeepExtra() });
    });
    this.app.post('/api/keep-extra', this.requireWriteAuth, (req, res) => {
      const v = this.setKeepExtra((req.body || {}).keepExtra);
      res.json({ ok: true, keepExtra: v });
    });
    // 自主清理：清掉"文件已不在磁盘"的空壳记录（看板点一次，调度器每天也会自动清一次）
    this.app.post('/pipeline/purge-orphans', this.requireWriteAuth, async (req, res) => {
      try {
        const before = this.store.findOrphanHits().length;
        const r = this.store.purgeOrphanHits();
        this._briefCache = null;
        res.json({ ok: true, found: before, deleted: r.deleted });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/memory-brief', this.requireReadAuth, (req, res) => {
      try {
        // 桌面端每次 AI 找爆点都拉一份：SQL+JSON.parse 全套约几十ms，缓存 60s（打回后最多延迟60s生效）
        // collection：只看某个文件夹（IP/老师）的爆款记忆；
        // 没传就用看板上选的"当前文件夹"（桌面端 AI 找爆点不用改代码就能跟着切）
        const collection = String(req.query.collection || '').trim() || this.getActiveCollection();
        const cacheKey = collection || '__all__';
        const now = Date.now();
        if (this._briefCache && this._briefKey === cacheKey && now - this._briefAt < 60000) return res.json(this._briefCache);
        const themes = (this.store.getAllHitThemes?.(200) || []).filter((t) => t.theme_name);
        const byHit = new Map();
        for (const t of themes) {
          if (!byHit.has(t.hit_video_id)) byHit.set(t.hit_video_id, []);
          byHit.get(t.hit_video_id).push(t);
        }
        const buckets = { short: [], medium: [], long: [] };
        try {
          const sql = collection
            ? "SELECT id, duration_ms FROM hit_videos WHERE analysis_status = 'completed' AND duration_ms > 0 AND collection = ?"
            : "SELECT id, duration_ms FROM hit_videos WHERE analysis_status = 'completed' AND duration_ms > 0";
          const vids = collection
            ? this.store.db.prepare(sql).all(collection)
            : this.store.db.prepare(sql).all();
          for (const v of vids) {
            const s = v.duration_ms / 1000;
            const b = s <= 60 ? 'short' : s <= 180 ? 'medium' : 'long';
            buckets[b].push({ id: v.id, dur: Math.round(s), themes: (byHit.get(v.id) || []).slice(0, 3).map((t) => {
              let kw = [];
              try {
                const p = JSON.parse(t.keywords || '[]');
                if (Array.isArray(p)) kw = p.slice(0, 5);
              } catch { /* ignore */ }
              return { name: String(t.theme_name).slice(0, 24), keywords: kw };
            }) });
          }
        } catch { /* ignore */ }
        const med = (arr) => {
          if (!arr.length) return 0;
          const a = [...arr].sort((x, y) => x - y);
          return a[Math.floor(a.length / 2)];
        };
        const brief = {};
        for (const k of ['short', 'medium', 'long']) {
          const list = buckets[k].filter((v) => v.themes.length > 0).slice(0, 4);
          brief[k] = {
            count: buckets[k].length,
            medianDur: med(buckets[k].map((v) => v.dur)),
            ideas: list.flatMap((v) => v.themes).slice(0, 4),
          };
        }
        let hooks = [];
        try {
          hooks = this.store.db.prepare(
            "SELECT text_content FROM copywriting_patterns WHERE pattern_type IN ('hook','soft_cta') ORDER BY effectiveness DESC LIMIT 5"
          ).all().map((r) => String(r.text_content).slice(0, 30));
        } catch { /* ignore */ }
        let avoid = [];
        try {
          // 去重：同一句打回意见重复提交会挤占 5 个避雷名额（同名打回 3 次 = 只剩 2 条其他经验）
          const seenAvoid = new Set();
          avoid = this.store.db.prepare(
            "SELECT comment FROM review_feedback WHERE decision = 'recut'" +
            (collection ? " AND (collection IS NULL OR collection = ?)" : "") +
            " ORDER BY id DESC LIMIT 30"
          ).all(...(collection ? [collection] : [])).map((r) => String(r.comment || '').slice(0, 60))
            .filter((c) => {
              const k = c.replace(/\d{1,2}:\d{2}:\d{2}/g, '').replace(/\s+/g, '').slice(0, 24);
              if (!k || seenAvoid.has(k)) return false;
              seenAvoid.add(k);
              return true;
            })
            .slice(0, 5);
        } catch { /* ignore */ }
        const out = { ok: true, ...brief, hooks, avoid, collection: collection || null, totalHits: buckets.short.length + buckets.medium.length + buckets.long.length };
        this._briefCache = out;
        this._briefKey = cacheKey;
        this._briefAt = Date.now();
        res.json(out);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 开头深挖：记忆加权 + LLM 精选本场最吸引人的开场白（结果按字稿指纹缓存）───
    // 打回弹窗“挑个好开头”调这里：先 deterministic 记忆打分取前60，再让大模型挑出
    // 真正吸引人的并给一句话理由；纯 heurstic 列表只做首屏预选。
    this.app.post('/openings/mine', this.requireWriteAuth, async (req, res) => {
      try {
        const { videoName, segments, exclude, count } = req.body || {};
        const segs = (Array.isArray(segments) ? segments : [])
          .map((s) => ({ id: s.id, startSec: Number(s.startSec) || 0, text: String(s.text || '').trim() }))
          .filter((s) => s.text.length >= 6 && s.text.length <= 40);
        if (!segs.length) return res.status(400).json({ error: '字稿为空' });
        const ex = (exclude || []).filter((x) => x && x.length >= 6);
        const notUsed = (t) => !ex.some((x) => x.includes(t) || t.includes(x));
        const key = `${videoName || 'live'}|${segs.length}|${segs.reduce((n, s) => n + s.text.length, 0)}`;
        const want = Math.min(24, Math.max(6, Number(count) || 24));
        try {
          const hit = this.store.getOpeningCache(key);
          if (hit) {
            const all = JSON.parse(hit.mined || '[]').filter((o) => o && notUsed(o.text));
            if (all.length >= 6) return res.json({ ok: true, cached: true, openings: all.slice(0, want) });
          }
        } catch { /* miss → 深挖 */ }
        // —— 记忆加权打分 ——
        const themeKws = [];
        try {
          for (const t of (this.store.getAllHitThemes?.(50) || []).filter((t) => t.theme_name)) {
            let kw = [];
            try {
              const p = JSON.parse(t.keywords || '[]');
              if (Array.isArray(p)) kw = p;
            } catch { /* ignore */ }
            const w = 0.5 + (Number(t.confidence) || 0.5);
            for (const k of kw) {
              if (String(k).length >= 2) themeKws.push({ kw: String(k), w, theme: String(t.theme_name).slice(0, 20) });
            }
          }
        } catch { /* ignore */ }
        let hooks = [];
        try {
          hooks = this.store.db.prepare(
            "SELECT text_content FROM copywriting_patterns WHERE pattern_type IN ('hook','soft_cta') ORDER BY effectiveness DESC LIMIT 40"
          ).all().map((r) => String(r.text_content || ''));
        } catch { /* ignore */ }
        let recutTitles = [];
        try {
          recutTitles = this.store.db.prepare(
            "SELECT comment FROM review_feedback WHERE decision = 'recut' ORDER BY id DESC LIMIT 30"
          ).all().map((r) => {
            const m = String(r.comment || '').match(/《([^》]{2,40})》/);
            return m ? m[1] : String(r.comment || '').slice(0, 40);
          }).filter(Boolean);
        } catch { /* ignore */ }
        const simHit = (a, b) => {
          a = String(a || ''); b = String(b || '');
          if (!a || !b) return false;
          if (a.includes(b) || b.includes(a)) return true;
          let best = 0;
          const dp = new Array(b.length + 1).fill(0);
          for (let i = 0; i < a.length; i++) {
            let prev = 0;
            for (let j = 0; j < b.length; j++) {
              const tmp = dp[j + 1];
              dp[j + 1] = a[i] === b[j] ? prev + 1 : 0;
              if (dp[j + 1] > best) best = dp[j + 1];
              prev = tmp;
            }
          }
          return best >= 4;
        };
        const scored = [];
        for (const s of segs) {
          if (!notUsed(s.text)) continue;
          let sc = 0;
          const reasons = [];
          const hitThemes = new Set();
          for (const { kw, w, theme } of themeKws) {
            if (kw && s.text.includes(kw)) {
              sc += 3 * w;
              hitThemes.add(theme);
              if (hitThemes.size >= 2) break;
            }
          }
          if (hitThemes.size) {
            sc += 4;
            reasons.push(`贴爆款主题${[...hitThemes].map((t) => `《${t}》`).join('')}`);
          }
          if (hooks.some((h) => h && h.length >= 6 && (s.text.includes(h.slice(0, 12)) || h.includes(s.text)))) {
            sc += 6;
            reasons.push('撞爆款钩子');
          }
          if (/[？?]/.test(s.text)) sc += 3;
          if (/\d/.test(s.text)) sc += 2;
          if (/为什么|怎么|如何|记住|千万|一定|秘密|真相|免费|赚钱|爆款|第一|最后|注意|竟然|居然|绝对|只需|只要|震惊|独家/.test(s.text)) sc += 3;
          if (/^(嗯|啊|呃|那个|然后|就是)/.test(s.text)) sc -= 3;
          if (recutTitles.some((t) => simHit(t, s.text))) {
            sc -= 10;
            reasons.push('撞打回方向');
          }
          if (sc > 2) scored.push({ ...s, sc: Math.round(sc * 10) / 10, reasons: reasons.slice(0, 2) });
        }
        scored.sort((a, b) => b.sc - a.sc);
        const pool = scored.slice(0, 60);
        // —— LLM 精选 ——
        const fmtT = (sec) => {
          sec = Math.max(0, Math.round(sec));
          return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
        };
        let mined = null;
        if (pool.length) {
          try {
            const sys = '你是短视频开头导演。只输出JSON数组，不要解释：[{"id":数字,"reason":"为什么这句做开头能爆（中文，25字内）"}]。标准：悬念/冲突/数字/痛点优先，口水寒暄不要。';
            const out = await this.ollama.generate(sys,
              `候选开场白（id|时间|文本）：\n${pool.map((o) => `${o.id}|${fmtT(o.startSec)}|${o.text}`).join('\n')}\n从中挑出最吸引人的${Math.min(want, pool.length)}句做视频开头。`, {
              parseJson: true, temperature: 0.4, maxTokens: 2048, timeout: 180000,
            });
            const arr = Array.isArray(out) ? out : out.openings || out.items || [];
            const byId = new Map(pool.map((o) => [o.id, o]));
            const seen = new Set();
            mined = [];
            for (const r of arr) {
              const o = byId.get(Number(r.id));
              if (!o || seen.has(o.id)) continue;
              seen.add(o.id);
              mined.push({ id: o.id, startSec: o.startSec, text: o.text, reason: String(r.reason || o.reasons[0] || '记忆加权高分').slice(0, 40) });
              if (mined.length >= want) break;
            }
          } catch (err) {
            console.warn('[Openings] LLM精选失败，用记忆加权兜底:', err.message);
          }
        }
        if (!mined || !mined.length) {
          mined = pool.slice(0, want).map((o) => ({ id: o.id, startSec: o.startSec, text: o.text, reason: (o.reasons[0] || '记忆加权高分') }));
        }
        try {
          this.store.setOpeningCache(key, mined);
        } catch { /* ignore */ }
        res.json({ ok: true, cached: false, openings: mined });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 记忆干涉式重排：检测之后按记忆库动手调顺序/分数 ───
    // GLB 主界面“按记忆重找爆款”流程：bridge-sync → 桌面端AI检测 → 调这里重排 → 回写列表。
    // 纯确定性打分（爆款主题/钩子库/打回撞车/通过加成/时长偏好），稳定可解释，不额外烧大模型。
  this.app.post('/highlight/rerank', this.requireWriteAuth, async (req, res) => {
      try {
        const { candidates, durationMode, videoName } = req.body || {};
        if (!Array.isArray(candidates) || candidates.length === 0) {
          return res.status(400).json({ error: 'candidates required' });
        }
        // 三档时长（桌面端“寻找深度高价值”弹窗）：短 30-60s / 中 1-3min / 长 3-9min。
        // 不传 durationMode 时走老逻辑（爆款中位数时长偏好），完全兼容旧桌面端。
        const MODES = {
          short: { min: 30, max: 60, label: '短视频30-60秒' },
          mid: { min: 60, max: 180, label: '中视频1-3分钟' },
          long: { min: 180, max: 540, label: '长视频3-9分钟' },
        };
        const mode = MODES[durationMode] || null;
        // —— 记忆语料 ——
        const themes = (this.store.getAllHitThemes?.(50) || []).filter((t) => t.theme_name);
        const themeKws = [];
        for (const t of themes) {
          let kw = [];
          try {
            const p = JSON.parse(t.keywords || '[]');
            if (Array.isArray(p)) kw = p;
          } catch { /* ignore */ }
          const w = 0.5 + (Number(t.confidence) || 0.5);
          for (const k of kw) {
            if (String(k).length >= 2) themeKws.push({ kw: String(k), w, theme: String(t.theme_name).slice(0, 20) });
          }
        }
        let hooks = [];
        try {
          hooks = this.store.db.prepare(
            "SELECT text_content, effectiveness FROM copywriting_patterns WHERE pattern_type IN ('hook','soft_cta','value_prop') AND length(text_content) >= 4 ORDER BY effectiveness DESC LIMIT 40"
          ).all();
        } catch { /* ignore */ }
        const titlesOf = (decision, limit) => {
          try {
            return this.store.db.prepare(
              'SELECT comment FROM review_feedback WHERE decision = ? ORDER BY id DESC LIMIT ?'
            ).all(decision, limit).map((r) => {
              const m = String(r.comment || '').match(/《([^》]{2,40})》/);
              return m ? m[1] : String(r.comment || '').slice(0, 40);
            }).filter(Boolean);
          } catch { return []; }
        };
        const recutTitles = titlesOf('recut', 30);
        const approveTitles = titlesOf('approve', 20);

        // —— 记忆挑句（句级）：桌面端把逐句稿传上来时，直接按记忆知识从句子里挑，
        // 跳过"本地检测片段"这个原料限制——这是"按记忆里找爆点"的真正实现。 ——
        // 桌面端没传逐句稿时，兜底从 live_videos 的转写缓存里找（按文件名匹配）。
        let noTranscriptReason = '';
        let rawSegs = Array.isArray(req.body?.transcript?.segments)
          ? req.body.transcript.segments
              .map((s) => ({ start: Math.round((Number(s.startSec) || 0) * 1000), end: Math.round((Number(s.endSec) || 0) * 1000), text: String(s.text || '').trim() }))
              .filter((s) => s.text && s.end > s.start)
          : null;
        if ((!rawSegs || !rawSegs.length) && videoName) {
          try {
            const base = String(videoName).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
            const live = this.store.db.prepare(
              "SELECT asr_path FROM live_videos WHERE (video_name LIKE ? OR video_path LIKE ?) AND asr_path IS NOT NULL ORDER BY id DESC LIMIT 1"
            ).get('%' + base.slice(0, 20) + '%', '%' + base.slice(0, 20) + '%');
            if (live?.asr_path && existsSync(live.asr_path)) {
              const cached = JSON.parse(readFileSync(live.asr_path, 'utf-8'));
              const list = (Array.isArray(cached.segments) ? cached.segments : Array.isArray(cached) ? cached : [])
                .map((s) => {
                  // 四种字段名都要认，而且必须分清秒和毫秒。
                  //
                  // 真实 bug：这里原来只读 startSec/endSec 和 start/end，
                  // 而 ASR 缓存里存的是 start_ms/end_ms（毫秒），两者都不匹配，
                  // 于是走了"兜底失败"。更糟的是另一条路：把毫秒值当成秒直接用，
                  // 3 小时的视频算出 2330000 秒的候选，界面显示 "2330000.0s"。
                  //
                  // 现在按量级判断：超过 100000 的基本不可能是"秒"（那已是 27 小时），
                  // 一定是毫秒。判断错了宁可退回 0，也不要产出荒谬的时间轴。
                  let startMs = null;
                  let endMs = null;
                  if (Number.isFinite(s.startMs)) startMs = Number(s.startMs);
                  else if (Number.isFinite(s.start_ms)) startMs = Number(s.start_ms);
                  else if (Number.isFinite(s.startSec)) startMs = Number(s.startSec) * 1000;
                  else if (Number.isFinite(s.start)) startMs = Number(s.start) * 1000;

                  if (Number.isFinite(s.endMs)) endMs = Number(s.endMs);
                  else if (Number.isFinite(s.end_ms)) endMs = Number(s.end_ms);
                  else if (Number.isFinite(s.endSec)) endMs = Number(s.endSec) * 1000;
                  else if (Number.isFinite(s.end)) endMs = Number(s.end) * 1000;

                  const text = String(s.text || '').trim();
                  if (startMs == null || endMs == null || !text) return null;
                  if (!(endMs > startMs)) return null;
                  return { start: Math.round(startMs), end: Math.round(endMs), text };
                }).filter(Boolean);
              if (list.length) {
                // 单位护栏：ASR 缓存里可能存着毫秒却被当成秒读进来。
                // 不在这里拦住，3 小时的视频会算出 2330000 秒的候选，
                // 界面上显示成 "2330000.0s"，而用户完全看不出是哪一步错的。
                const norm = normalizeToMs(list, 'live asr');
                rawSegs = norm.list;
                if (norm.fixed) {
                  console.warn(`[MemoryPick] ⚠ ${norm.unitNote}（原样透传会产出 2330000 秒这类荒谬候选）`);
                  noTranscriptReason = `逐句稿的时间戳单位不对（最大值 ${norm.maxRaw}），已自动按秒处理，候选时间轴可能仍不准。`;
                } else {
                  console.log(`[MemoryPick] 桌面端未传逐句稿，使用 live 转写缓存: ${list.length} 句`);
                }
              }
            }
          } catch { /* 兜底失败就走原逻辑 */ }
        }
        if ((!rawSegs || !rawSegs.length) && mode) {
          noTranscriptReason = '本次没拿到逐句稿，无法按句挑：请先在 GLB 对这条视频完成转写，或把直播拖进 Hermes 的「整场直播」页分析一次。';
        }
        console.log(`[MemoryPick] 进入句级判定: mode=${!!mode} rawSegs=${rawSegs ? rawSegs.length : 'null'} bodyTranscript=${!!req.body?.transcript}`);
        let sentenceResult = null;
        if (mode && rawSegs && rawSegs.length) {
          const keepExtra = (req.body || {}).keepExtra !== undefined ? !!(req.body || {}).keepExtra : this.getKeepExtra();
          const dedupRepeat = (req.body || {}).dedupRepeat !== undefined ? !!(req.body || {}).dedupRepeat : true;
          const segs = memorySentenceSegments(videoName, rawSegs, mode, themeKws, hooks, { interactionClean: (req.body || {}).interactionClean !== false, keepExtra, dedupRepeat });
          let pieces = packSentencePieces(segs, mode, { keepExtra, droppedRanges: segs.droppedRanges || [] });
          if (pieces.length) {
            // 后台跑 LLM 深度清洗并写缓存：下次点「按记忆里找爆点」就是 LLM 级的挑句
            const vkey = String(videoName || '') + ':' + rawSegs.length + (dedupRepeat ? '' : ':nodup');
            const cached = this.store.db.prepare('SELECT segments FROM sentence_clean_cache WHERE video_key = ?').get(vkey);
            if (!cached) {
              setImmediate(() => {
                this.deepAnalyzer._cleanTranscript(rawSegs, { dedupRepeat }).then((cleaned) => {
                  this.store.db.prepare(`INSERT INTO sentence_clean_cache (video_key, segments) VALUES (?,?)
                    ON CONFLICT(video_key) DO UPDATE SET segments = excluded.segments, updated_at = datetime('now')`)
                    .run(vkey, JSON.stringify(cleaned));
                  console.log(`[MemoryPick] 深度清洗缓存完成: ${vkey} (${cleaned.length} 句)`);
                }).catch((e) => console.warn('[MemoryPick] 深度清洗失败:', e.message));
              });
            } else {
              // 有 LLM 缓存：用 LLM 级清洗结果重新挑（更准），供本次返回
              try {
                const allCleaned = JSON.parse(cached.segments);
                // LLM 判 keep=false 的句子 = 重复话去除剪掉的内容，其时间段必须从音乐空隙保留中排除
                const llmDropped = allCleaned.filter((s) => !s.keep).map((s) => [s.start, s.end]);
                const deepSegs = allCleaned.filter((s) => s.keep);
                const deepScored = memorySentenceSegments(videoName, deepSegs, mode, themeKws, hooks, { interactionClean: (req.body || {}).interactionClean !== false, keepExtra, dedupRepeat });
                const deepPick = packSentencePieces(deepScored, mode, { keepExtra, droppedRanges: llmDropped.concat(deepScored.droppedRanges || []) });
                if (deepPick.length) pieces = deepPick;
              } catch { /* 缓存坏就保持规则版 */ }
            }
            // 按记忆爆款逻辑给候选起新名（LLM 批量起名，失败回退首句）
            if (pieces.length) {
              try {
                pieces = await this.renameMemoryPicksWithLlm(pieces, videoName);
              } catch (e) { console.warn('[MemoryPick] 起名失败，保持首句标题:', e.message); }
            }
            // 防刷屏：最多取 8 条（按分数优先），再按时间顺序排回
            const MAX_PICKS = 8;
            if (pieces.length > MAX_PICKS) {
              pieces = [...pieces].sort((a, b) => b.score - a.score).slice(0, MAX_PICKS).sort((a, b) => a.startSec - b.startSec);
            }
            sentenceResult = { pieces, used: rawSegs.length };
            // 留痕：看板"最近记忆挑句"可直接核对 AI 挑了哪些句子
            try {
              this.store.db.prepare(
                'INSERT INTO memory_picks (video_name, duration_mode, seg_count, sentence_count, items) VALUES (?,?,?,?,?)'
              ).run(String(videoName || ''), durationMode, pieces.length, pieces.reduce((a, m) => a + (m.pieces || []).length, 0), JSON.stringify(pieces));
            } catch (e) { console.warn('[MemoryPick] 留痕失败:', e.message); }
          }
        }
        const simHit = (a, b) => {
          // 最长公共子串>=4 或 共享关键词>=2 即算撞车
          a = String(a || ''); b = String(b || '');
          if (!a || !b) return false;
          if (a.includes(b) || b.includes(a)) return true;
          let best = 0;
          const dp = new Array(b.length + 1).fill(0);
          for (let i = 0; i < a.length; i++) {
            let prev = 0;
            for (let j = 0; j < b.length; j++) {
              const tmp = dp[j + 1];
              dp[j + 1] = a[i] === b[j] ? prev + 1 : 0;
              if (dp[j + 1] > best) best = dp[j + 1];
              prev = tmp;
            }
          }
          return best >= 4;
        };
        // 爆款时长偏好（中位数，钳制15~180秒；durationMode 模式下改用档位区间）
        let idealDur = 60;
        try {
          const rows = this.store.db.prepare(
            "SELECT duration_ms FROM hit_videos WHERE analysis_status = 'completed' AND duration_ms > 0"
          ).all().map((r) => r.duration_ms / 1000).sort((x, y) => x - y);
          if (rows.length) idealDur = Math.max(15, Math.min(180, Math.round(rows[Math.floor(rows.length / 2)])));
        } catch { /* ignore */ }
        // 深度价值关联：按 videoName + 时间重叠连回 Hermes 直播分段，
        // 拿到主题置信度/爆款匹配度/摘要信息量做价值分；连不上就只用文本关键词兜底
        let segByTime = null;
        if (videoName) {
          try {
            const base = String(videoName).split(/[\\/]/).pop();
            const live = this.store.db.prepare(
              'SELECT id FROM live_videos WHERE video_name = ? OR video_path LIKE ? ORDER BY id DESC LIMIT 1'
            ).get(base, `%${base}`);
            if (live) {
              segByTime = this.store.getLiveSegmentsByVideo(live.id) || [];
            }
          } catch { /* ignore */ }
        }
        const joinSeg = (c) => {
          if (!segByTime?.length) return null;
          const s = (Number(c.startSec) || 0) * 1000;
          const e = (Number(c.endSec) || 0) * 1000;
          if (e <= s) return null;
          let best = null;
          let bestOv = 0;
          for (const g of segByTime) {
            const ov = Math.max(0, Math.min(e, g.end_ms) - Math.max(s, g.start_ms)) / (e - s);
            if (ov > bestOv) { bestOv = ov; best = g; }
          }
          return bestOv >= 0.3 ? best : null;
        };
        // —— 逐条打分 ——
        const reranked = candidates.map((c, idx) => {
          const text = `${c.title || ''} ${c.hook || ''}`;
          let delta = 0;
          const reasons = [];
          const hitThemes = new Set();
          for (const { kw, w, theme } of themeKws) {
            if (kw && text.includes(kw)) {
              delta += 3 * w;
              hitThemes.add(theme);
              if (hitThemes.size >= 2) break;
            }
          }
          if (hitThemes.size) {
            reasons.push(`命中爆款主题${[...hitThemes].map((t) => `《${t}》`).join('')}`);
          }
          let hookHit = 0;
          for (const h of hooks) {
            const p = String(h.text_content || '');
            if (p && text.includes(p)) {
              delta += 6 * (Number(h.effectiveness) || 0.7);
              if (++hookHit >= 2) break;
            }
          }
          if (hookHit) reasons.push('钩子贴合记忆爆款话术');
          const bad = recutTitles.find((t) => simHit(t, c.title));
          if (bad) {
            delta -= 25;
            reasons.push(`撞了打回《${String(bad).slice(0, 16)}》，降权`);
          }
          const good = approveTitles.find((t) => simHit(t, c.title));
          if (good && !bad) {
            delta += 10;
            reasons.push('贴近已通过的精选方向');
          }
          const dur = (Number(c.endSec) || 0) - (Number(c.startSec) || 0);
          if (mode) {
            // 档位时长：切合+8，沾边+3，不合-8，离谱-15
            if (dur > 0) {
              if (dur >= mode.min && dur <= mode.max) {
                delta += 8;
                reasons.push(`时长切合${mode.label}`);
              } else if (dur >= mode.min * 0.5 && dur <= mode.max * 1.5) {
                delta += 3;
              } else {
                const far = dur > mode.max * 2 || dur < mode.min * 0.5;
                delta += far ? -15 : -8;
                if (far) reasons.push(`时长不合${mode.label}`);
              }
            }
            // 深度价值：主题置信度 + 爆款匹配度 + 钩子质量 + 摘要信息量
            const g = joinSeg(c);
            if (g) {
              let sim = 0;
              let simTheme = '';
              try {
                const arr = JSON.parse(g.matched_hit_themes || '[]');
                if (Array.isArray(arr) && arr.length) {
                  arr.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0));
                  sim = arr[0].similarity_score || 0;
                  simTheme = arr[0].theme_name || '';
                }
              } catch { /* ignore */ }
              const val = (Number(g.theme_confidence) || 0) * 6 + sim * 8
                + (Number(g.hook_quality) || 0) * 4
                + (String(g.transcript_summary || '').length > 60 ? 2 : 0);
              delta += val;
              c._valScore = Math.round(val * 10) / 10;
              if (val >= 6) reasons.push(`深度价值${c._valScore}《${String(simTheme || g.theme_name || '').slice(0, 12)}》`);
            }
          } else if (dur > 0) {
            if (Math.abs(dur - idealDur) <= 15) {
              delta += 5;
              reasons.push('时长贴近爆款');
            } else if (Math.abs(dur - idealDur) > 90) {
              delta -= 5;
            }
          }
          const newScore = Math.max(0, Math.min(100, Math.round((Number(c.score) || 0) + delta)));
          return { id: c.id, idx, newScore, delta: Math.round(delta), reasons: reasons.slice(0, 3) };
        });
        reranked.sort((a, b) => b.newScore - a.newScore || a.idx - b.idx);
        const up = reranked.filter((r) => r.delta >= 8).length;
        const down = reranked.filter((r) => r.delta <= -8).length;
        // 按档取段：三档是每一条成片的时长——以高价值锚点为中心扩展出符合档位的连续区间
        let modeSegments = [];
        if (mode && sentenceResult) {
          modeSegments = sentenceResult.pieces; // 记忆挑句：句级拼接收官，桌面端按 pieces 出片
        } else if (mode) {
          modeSegments = composeModeSegments(candidates, reranked, mode, segByTime);
        }
        let summary = `记忆干涉完成：${reranked.length}条候选中，${up}条因命中爆款记忆上调，${down}条因撞打回下调；首位《${String((candidates.find((c) => c.id === reranked[0]?.id) || {}).title || '').slice(0, 20)}》。`;
        if (mode) {
          if (noTranscriptReason) summary += noTranscriptReason;
          const fit = reranked.filter((r) => {
            const c = candidates[r.idx];
            const d = (Number(c.endSec) || 0) - (Number(c.startSec) || 0);
            return d >= mode.min && d <= mode.max;
          }).length;
          const deep = candidates.filter((c) => (c._valScore || 0) >= 6).length;
          summary += `${mode.label}模式：${fit}条时长切合，${deep}条深度价值达标。`;
          if (modeSegments.length) {
            summary += `已按${mode.label}取出${modeSegments.length}条（每条约档位时长，列表已替换）。`;
          } else if (!noTranscriptReason) {
            summary += `凑不出${mode.label}的单条，保留重排列表。`;
          }
        }
        res.json({
          ok: true,
          reranked,
          summary,
          mode: durationMode || null,
          modeSegments,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 爆款预测：参照记忆库给每条历史素材估播放/点赞/评论/转发 ───
    // 分析完成自动调（HitAnalyzer hooks），存量缺预测的调度器每轮补一个，记忆页按钮可手动重算
    this.app.post('/hits/:id/predict', this.requireWriteAuth, async (req, res) => {
      try {
        const pred = await this.predictHitVideo(parseInt(req.params.id));
        res.json({ ok: true, prediction: pred });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
      }
    });
    // ─── 发布数据反馈：截图/数字回流，Hermes真正理解爆款 ───
    this.app.post('/hits/:id/feedback', this.requireWriteAuth, async (req, res) => {
      try {
        const hit = this.store.getHitVideoById(parseInt(req.params.id));
        if (!hit) return res.status(404).json({ error: '素材不存在' });
        const { views, likes, comments, shares, favorites, note, screenshot, platform: manualPlatform } = req.body || {};
        const num = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.round(Number(v) || 0)));
        let vals = { views: num(views), likes: num(likes), comments: num(comments), shares: num(shares), favorites: num(favorites) };
        let shotPath = null;
        let ocr = null;
        let ocrPlatform = null;
        let source = 'manual';
        if (screenshot && String(screenshot).length > 100) {
          try {
            const m = String(screenshot).match(/^data:image\/(\w+);base64,(.+)$/);
            const ext = (m?.[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
            const b64 = m ? m[2] : String(screenshot);
            const dir = join(__dirname, '..', '..', 'data', 'feedback');
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            shotPath = join(dir, `hit_${hit.id}_${Date.now()}.${ext}`);
            const { writeFileSync } = await import('fs');
            writeFileSync(shotPath, Buffer.from(b64, 'base64'));
            // 视觉读数 + 平台识别：尽力而为，失败不挡主流程
            try {
              const txt = await this.ollama.describe([b64],
                '你是短视频平台数据截图读取器。看这张截图：1) 识别来自哪个平台，只能填：视频号/抖音/小红书/快手/B站/其他；2) 读出播放量、点赞数、评论数、转发/分享数、收藏数。只返回JSON：{"platform":"平台名","views":数字,"likes":数字,"comments":数字,"shares":数字,"favorites":数字}，读不出的字段写null，中文"万/千"换算成数字。收藏在抖音叫"收藏"、小红书叫"收藏"、B站叫"收藏/收藏数"，别和点赞混。',
                { timeout: 240000, maxTokens: 256 });
              const jb = txt ? txt.match(/\{[\s\S]*\}/) : null;
              if (jb) {
                const o = JSON.parse(jb[0]);
                ocr = { views: num(o.views), likes: num(o.likes), comments: num(o.comments), shares: num(o.shares), favorites: num(o.favorites) };
                ocrPlatform = String(o.platform || '').trim().slice(0, 12) || null;
                for (const k of ['views', 'likes', 'comments', 'shares', 'favorites']) {
                  if (vals[k] == null && ocr[k] != null) vals[k] = ocr[k];
                }
                source = [views, likes, comments, shares, favorites].some((x) => x != null) ? 'manual+ocr' : (ocr.views != null ? 'ocr' : 'manual');
              }
            } catch { /* 视觉失败忽略，用人工数字 */ }
          } catch { /* 存图失败忽略 */ }
        }
        const platform = String(manualPlatform || '').trim().slice(0, 12) || ocrPlatform;
        const perf = this.store.upsertHitPerformance(hit.id, { ...vals, platform, source, screenshotPath: shotPath, note: String(note || '').slice(0, 200) });
        const shown = [platform ? `[${platform}]` : '', `播${vals.views ?? '?'}`, `赞${vals.likes ?? '?'}`, `评${vals.comments ?? '?'}`, `转${vals.shares ?? '?'}`, `藏${vals.favorites ?? '?'}`].join(' ');
        this.store.addReviewLesson(`《${String(hit.video_name).slice(0, 30)}》实际数据：${shown}，已作为爆款校准样本`);
        // 反馈落库后立刻用真实数据重新预测（LLM挂了不挡反馈本身）
        let prediction = null;
        try { prediction = await this.predictHitVideo(hit.id); } catch { /* ignore */ }
        res.json({ ok: true, performance: perf, platform: perf?.platform || null, ocr, prediction });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // ─── 评审闭环：确认包装 / 提意见打回重剪（意见自动成记忆） ───
    this.app.post('/projects/:id/review', this.requireWriteAuth, async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        const { decision, comment, segmentIds, textCuts } = req.body || {};
        const project = this.store.getClipProject(id);
        if (!project) return res.status(404).json({ error: '项目不存在' });

        if (decision === 'approve') {
          // 确认粗剪：记一条通过意见（含备注则顺手学一条），没剪完的先剪完，
          // 然后停下等用户点“生成成片”——确认本身永不自动包装成片。
        // 相同意见不重复入库。
        //
        // 以前每次点"确认通过"都无条件插一条，于是反复点几次就积了 6 条一模一样的。
        // 后果不只是历史难看：记忆注入只取最近 20 条(getFeedbackByLive)，
        // 重复意见会把别的老师的真实反馈挤出窗口，等于把学习信号覆盖掉。
        const approveComment = (comment || '').trim() || '确认粗剪通过';
        const dup = this.store.db
          .prepare("SELECT id FROM review_feedback WHERE clip_project_id = ? AND decision = 'approve' AND comment = ? LIMIT 1")
          .get(id, approveComment);
        /*
         * 三处写入都要去重，不只是 review_feedback。
         *
         * 2026-10-05 修：原来只给 review_feedback 加了 dup 检查，
         * 下面两处仍然无条件写：
         *   addReviewLesson —— 每次 approve 都插一条，而它是按集合限 30 条的，
         *     反复点几次会把**别的老师的真实教训挤出窗口**，等于把学习信号覆盖掉。
         *   addReviewEdits  —— 每段 2 行（segment + keep），重复 approve 会成倍堆积，
         *     直接污染 stage 门槛和画像中位数。
         *
         * 判据：同一工程 + 同一条意见 已经记过就不再写。
         */
        if (dup) {
          console.log(`[Review] 工程#${id} 已有相同的通过意见，跳过重复入库`);
          if (comment) {
            const lesson = `粗剪#${id}通过，备注：${comment}`;
            const hasLesson = this.store.db
              .prepare('SELECT 1 AS x FROM deep_memory WHERE collection = ? AND text = ? LIMIT 1')
              .get(this._collectionOfLiveVideo(project.live_video_id), lesson);
            if (!hasLesson) this.store.addReviewLesson(lesson);
          }
        } else {
          this.store.addReviewFeedback({
        clipProjectId: id, liveVideoId: project.live_video_id,
        decision: 'approve', segmentIds, comment: approveComment,
        // 记到当前选中的 IP 老师名下，让这条意见下次能被"按集合取避免规则"读到。
        // 不传的话会落 collection=NULL,用户明明审阅过,分析时却完全不参考。
        collection: this._collectionOfLiveVideo(project.live_video_id),
      });
          if (comment) this.store.addReviewLesson(`粗剪#${id}通过，备注：${comment}`);
        }

          /*
           * 通过 = 最强的正样本，整条粗剪的内容逻辑都该被学走。
           *
           * 这一点以前完全缺失：只在 review_feedback 留了一句 comment。
           * 但用户点"确认通过"意味着认可**这一版的段落编排** ——
           * 哪段当开场、哪段是主体、哪段收尾，这是最难得的结构样本，
           * 逐句层面根本拿不到。
           *
           * 记两行：
           *   segment —— 段落结构（role + 主题 + 原文 + 评分）
           *   keep    —— 每段的原文，作为内容正样本
           */
          let learned = 0;
          let learnFailed = null;
          try {
            const col = this._collectionOfLiveVideo(project.live_video_id);
            let segs = project.selected_segments;
            if (typeof segs === 'string') { try { segs = JSON.parse(segs); } catch { segs = []; } }
            if (!Array.isArray(segs)) segs = [];
            const liveRow = this.store.db
              .prepare('SELECT asr_path FROM live_videos WHERE id = ?')
              .get(project.live_video_id);
            const transcript = loadTranscript(liveRow?.asr_path,
              this.store.getHotwords(this._collectionOfLiveVideo(project.live_video_id)));
            const rows = [];
            const base = {
              clipProjectId: id, liveVideoId: project.live_video_id, collection: col,
              reason: comment || approveComment || '', by: 'picked'
            };
            for (const s of segs) {
              if (!s) continue;
              const sid = Number(s.segmentId ?? s.id) || null;
              const st = Number(s.startMs ?? 0);
              const en = Number(s.endMs ?? 0);
              const ed = transcript.length ? buildEditableText(transcript, st / 1000, en / 1000) : null;
              rows.push({
                ...base, kind: 'segment', segmentId: sid,
                role: s.role || null, themeName: s.themeName || null,
                text: (ed?.text || '').slice(0, 600),
                startMs: st, endMs: en, score: s.hookQuality ?? null
              });
              if (ed?.text) {
                rows.push({
                  ...base, kind: 'keep', segmentId: sid,
                  role: s.role || null, themeName: s.themeName || null,
                  text: ed.text, startMs: st, endMs: en, score: s.hookQuality ?? null
                });
              }
            }
            const n = this.store.addReviewEdits(rows);
            console.log(`[Review] 通过 #${id}：学习样本 +${n} → collection=${col || '通用'}`);
            learned = n;
          } catch (err) {
            /*
             * 写库失败不能把"已通过"变成"提交失败"（通过本身是成立的），
             * 但**不能骗用户说学到了**。
             *
             * 原来 catch 完直接 ok:true，界面接着显示
             * "下次找爆点会参考这次的意见" —— 而整个正样本
             * （每段 2 行 segment+keep）都在这个 try 里，
             * 一旦抛错就是一条没记成，说的正好是反的。
             */
            learnFailed = err.message;
            console.error('[Review] 写学习样本失败（不影响通过结果）:', err.message);
          }
let p = this.store.getClipProject(id);
          /*
           * 2026-10-05 修：作废的工程不许再被"通过"。
           *
           * 原来的判据是 `!['reviewing','approved','finished'].includes(status)` 才重新出片，
           * 于是 superseded（已打回重剪、被新工程取代）落进了 else 分支 ——
           * 会被**用它自己那份旧 selected_segments 重新切片**，
           * 并把状态改回 approved。
           *
           * 后果是两条 approved 工程并存，而用户刚在重剪版里批准的删字
           * 并不在旧工程里 —— 等于把刚确认的成果覆盖掉了。
           *
           * 来源可复现：ReviewPanel.submit 先 await load() 才让父组件换 projectId，
           * 面板会短暂地服务作废工程，而两个按钮此时都还可用。
           *
           * 所以这里明确拒绝，并告诉界面该用哪一个工程。
           */
          if (p.status === 'superseded') {
            const cur = this.store.db
              .prepare(`SELECT id FROM clip_projects
                         WHERE live_video_id = ? AND status IN ('reviewing','pending_review','approved')
                         ORDER BY id DESC LIMIT 1`)
              .get(project.live_video_id);
            return res.status(409).json({
              ok: false,
              error: '这个粗剪已经被打回重剪取代，不能再确认通过',
              supersededBy: cur?.id ?? null
            });
          }
          if (!['reviewing', 'approved', 'finished'].includes(p.status)) {
            await this.clipper.clip(id);
          }
          this.store.updateClipProject(id, { status: 'approved' });
          // 看板上的确认/打回立刻灌给 GLB 桌面端（不同步等待，不挡响应）
          this.glbBridge?.sync({ pull: false }).catch(() => {});
          this._briefCache = null; // 简报缓存失效：新意见下次找爆点即生效
          /*
           * 如实告诉界面学习到底有没有写成。
           * 界面据此决定说"下次会参考"还是"通过成功但这次没学到"——
           * 少了这个字段，前端只能无脑报成功，而失败的概率不为零。
           */
          return res.json({
            ok: true,
            projectId: id,
            status: 'approved',
            learned,
            learnFailed
          });
        }

        if (decision === 'recut') {
          // 打回：意见入库+成记忆，被点名的段直接拉黑，老项目归档，基于意见重建新项目
          if (!comment) return res.status(400).json({ error: '打回请写一句意见（点快捷标签也行）' });
this.store.addReviewFeedback({
        clipProjectId: id, liveVideoId: project.live_video_id,
        decision: 'recut', segmentIds, comment,
        collection: this._collectionOfLiveVideo(project.live_video_id),
      });
          for (const sid of segmentIds || []) {
            try { this.store.updateLiveSegmentStatus(sid, 'rejected'); } catch { /* ignore */ }
          }
          this.store.addReviewLesson(`粗剪#${id}被打回：${comment}`);

          // 顺序很重要：先建新工程，成功了再归档老的。
          // 原来是先 updateClipProject(superseded) 再 createProject ——
          // 一旦重建失败（点名剔光后没有可用内容），老工程已经是 superseded，
          // 而新工程又没建成，这条粗剪就凭空消失了：既没有能看的，也没有错误提示。
          //
          // 重建必须基于用户刚审过的那条粗剪，而不是从头自动重选：
          //   ① 用户审的是这一版，认可的是这一版的编排。从头重选等于把他已经
          //      点过头的段落全换掉，"打回"变成了"重做"，不是他要的意思。
          //   ② 自动路径会重跑一遍"逐句剔除运营话术"。这条粗剪当初就是从
          //      自动路径出来的，那些段已经剔过一次了；对 superseded 的旧段
          //      再剔一次还会因为段本身零长/过短被判死，于是回一句
          //      "逐句剔除后没有可用内容"，把问题指到素材上，其实是编排问题。
          let origSegs = project.selected_segments;
          if (typeof origSegs === 'string') {
            try { origSegs = JSON.parse(origSegs); } catch { origSegs = []; }
          }
          if (!Array.isArray(origSegs)) origSegs = [];
          const rejectSet = new Set((segmentIds || []).map(Number));
          const keptIds = origSegs
            .map((s) => Number(s.segmentId ?? s.id))
            .filter((n) => Number.isFinite(n) && !rejectSet.has(n));

          if (!keptIds.length) {
            return res.status(400).json({ error: '这条粗剪的段落被你全点名剔掉了，没有可以重建的内容了' });
          }
          /*
           * 上一轮已经剪掉的字必须带过来。
           *
           * 2026-10-05 修：这里原来**不传 cutsByIndex**，于是重建出来的
           * picked 里每段都没有 seg.cuts —— 而下面 textCuts 那段的
           * `normalizeRanges([...(seg.cuts || []), ...merged])`
           * （注释写着"已有 cuts 要一起合并，否则两次删除会嵌套"）
           * 永远在合并一个空数组，是死代码。
           *
           * 后果是真实的数据丢失：用户第一轮删掉的几秒，第二轮打回重剪后
           * **原样复活**在新粗剪里，而新的 review-packet 也看不出任何痕迹。
           *
           * cutsByIndex 的形状是 [{ index: segmentId, cuts: [{st, en}] }]，
           * index 用 segmentId —— live_segments.id 是全局主键，
           * 与 segment_index（直播内局部序号）不是一回事，别用后者。
           */
          const prevCutsBySegId = [];
          try {
            for (const seg0 of (Array.isArray(origSegs) ? origSegs : [])) {
              if (seg0 && seg0.segmentId != null && Array.isArray(seg0.cuts) && seg0.cuts.length) {
                prevCutsBySegId.push({
                  index: Number(seg0.segmentId),
                  cuts: seg0.cuts
                    .map((c) => ({ st: Number(c.st), en: Number(c.en) }))
                    .filter((c) => Number.isFinite(c.st) && Number.isFinite(c.en) && c.en > c.st)
                });
              }
            }
          } catch (err) {
            console.warn('[Review] 读取上一轮 cuts 失败（本次重剪将不带入旧删除）:', err.message);
          }
          if (prevCutsBySegId.length) {
            console.log(`[Review] 带入上一轮 ${prevCutsBySegId.length} 段的文字删除，避免用户已删的内容复活`);
          }
          const picked = this._segmentsByIndex(project.live_video_id, keptIds, prevCutsBySegId);
          if (!picked.length) {
            return res.status(400).json({
              error: `这条粗剪引用的 ${keptIds.length} 个分段在库里都找不到了。`
                + '多半是重分析之后分段被换掉了，请重新出一次粗剪再审。'
            });
          }
          // 把原工程里的角色带过去，否则 createProject 的 toRow 会一律当成 body，
          // 新工程里片头/收尾的角色就没了（顺序还在，顺序本来就是按角色排好的）。
          const roleById = new Map(
            origSegs
              .filter((s) => s && (s.role || s.segmentId != null || s.id != null))
              .map((s) => [Number(s.segmentId ?? s.id), s.role || 'body'])
          );
          for (const seg of picked) {
            if (seg && seg.id != null && roleById.has(Number(seg.id))) seg.role = roleById.get(Number(seg.id));
          }

          // ── 应用用户在审片台做的文本级删除 ──
          //
          // 这是"像剪映智能剪口播那样框选文字删掉"的后端落点。
          // 客户端只传"第几段、哪几个字符"，时间由这里算 —— 因为文本是服务端拼接的，
          // 让客户端算就得知道拼接规则，规则一变它算的秒数全错且不报错。
          //
          // textCuts 形如：
          //   [{ segmentId: 2424, ranges: [{ from: 12, to: 20 }, ...] }]
          let cutReport = { applied: 0, removedMs: 0, segments: 0, skipped: [] };
          if (Array.isArray(textCuts) && textCuts.length) {
            const liveRow = this.store.db
              .prepare('SELECT asr_path FROM live_videos WHERE id = ?')
              .get(project.live_video_id);
            const transcript = loadTranscript(liveRow?.asr_path,
              this.store.getHotwords(this._collectionOfLiveVideo(project.live_video_id)));
            const bySegId = new Map(picked.filter((s) => s && s.id != null).map((s) => [Number(s.id), s]));

            for (const tc of textCuts) {
              const segId = Number(tc?.segmentId);
              const seg = bySegId.get(segId);
              if (!seg) { cutReport.skipped.push(`段#${segId} 不在本次重建范围`); continue; }
              const srcStartMs = Number(seg.start_ms ?? seg.startMs ?? 0);
              const srcEndMs = Number(seg.end_ms ?? seg.endMs ?? 0);
              const editable = buildEditableText(transcript, srcStartMs / 1000, srcEndMs / 1000);
              if (!editable.text) {
                cutReport.skipped.push(`段#${segId} 没有可编辑文本（可能是实操教学段）`);
                continue;
              }
              const segStart = Number(seg.startMs ?? seg.start_ms ?? 0);
              const segEnd = Number(seg.endMs ?? seg.end_ms ?? 0);
              const pieces = [];
              for (const rg of (tc.ranges || [])) {
                const hit = charRangeToTime(editable.sentences, editable.text, rg.from, rg.to, segStart);
                if (!hit) continue;
                // 跨句选区会散成多个子区间，逐个收
                for (const p of (hit.pieces?.length ? hit.pieces : [hit])) {
                  if (p.en <= p.st) continue;
                  // 统一收口到段内：逐句稿的时间戳偶尔不准，
                  // 补零长句时长也可能略微超出。不夹住的话 ffmpeg 会去剪
                  // 一个不存在的位置，表现为这一段花屏或音画不同步。
                  const st = Math.max(segStart, Math.min(p.st, segEnd));
                  const en = Math.max(st, Math.min(p.en, segEnd));
                  /*
             * 最短切分 200ms。
             *
             * 另两条路径（_segmentsByIndex:838、clipper:833）都按 200ms 过滤，
             * 只有这里放行了 1ms 的区间 —— 然后一路走到
             * clipper 的 `clipSegment(... -t 0.001 -c copy)`，
             * 产出的是一帧黑屏或空文件。
             *
             * 统一到同一个下限，三条路径口径一致。
             */
              const MIN_CUT_MS = 200;
                  if (en - st >= MIN_CUT_MS) pieces.push({ st, en });
                  else cutReport.skipped.push(`段#${segId} 有过短的删除（${en - st}ms < ${MIN_CUT_MS}ms），已忽略`);
                }
              }
              if (!pieces.length) { cutReport.skipped.push(`段#${segId} 的选区没有落在有效时间内`); continue; }
              const merged = normalizeRanges(pieces);
              // 已有 cuts（上一轮剪过的）要一起合并，否则两次删除会嵌套
              const all = normalizeRanges([...(seg.cuts || []), ...merged]);
              const removed = all.reduce((n, r) => n + (r.en - r.st), 0);
              const totalMs = Math.max(1, Number(seg.end_ms ?? seg.endMs ?? 0) - segStart);
              // 剪掉超过 90% 这段就没了 —— 与其交给 ffmpeg 去切出黑帧，不如直接拒绝
              if (removed >= totalMs * 0.9) {
                cutReport.skipped.push(`段#${segId} 被删得太多（${Math.round((removed / totalMs) * 100)}%），整段跳过`);
                continue;
              }
              /**
               * cuts 必须存**原素材绝对时间**，不能用相对段首的时间。
               *
               * 下游（_segmentsByIndex 和 clipper.buildSegments）都按绝对时间收口：
               * `st = Math.max(seg.startMs, c.st)`、`en = Math.min(seg.endMs, c.en)`。
               * 所以存相对值（0..2000）会被算成 st=段首、en=2000，
               * 接着被 `c.en - c.st >= 200` 那条过滤掉 —— cuts 凭空消失，
               * 而回执却写着"已生效"。用户看到的是"删了半天，重剪完没区别"。
               *
               * 现存工程里的 cuts（如 live#174 的 {st:1750000,en:1765000}）也是绝对值，
               * 这里保持同一约定，避免新旧数据混用时被 interpret 成两套含义。
               */
              seg.cuts = all.map((r) => ({ st: Math.round(r.st), en: Math.round(r.en) }));
              cutReport.applied += merged.length;
              cutReport.removedMs += merged.reduce((n, r) => n + (r.en - r.st), 0);
              cutReport.segments++;
            }
            console.log(
              `[Review] 文本删除：${cutReport.segments} 段生效，共 ${cutReport.applied} 处、` +
              `${(cutReport.removedMs / 1000).toFixed(1)}s` +
              (cutReport.skipped.length ? `；跳过 ${cutReport.skipped.length} 处：${cutReport.skipped.join('；')}` : '')
            );
          }

          /*
           * 打回的幂等：同一条意见 + 同一批被点名段，只允许生成一个新工程。
           *
           * 2026-10-05 修：原来完全没有去重。触发场景很日常：
           *   - 用户双击了「打回重剪」
           *   - 客户端超时后自动重试
           * 每次都会走完 addReviewFeedback / markSegmentsRejected / addReviewLesson /
           * createProject，于是留下两个内容几乎一样的新工程、两行反馈、两条教训，
           * 而只有第二个 newProjectId 被返回 —— 界面上看着"成功了"，
           * 项目库里却多出一条用户从没要求过的版本。
           *
           * 判据用 review_feedback：它本来就存了 clip_project_id + decision +
           * comment + segment_ids 四要素，而这次打回在**建新工程之前**就会写它。
           * 所以"已经有这行反馈"就等于"这次打回已经开始处理了"。
           *
           * 只在已完成一轮（存在由它建出的、未被作废的工程）时才短路返回，
           * 避免"第一次打回写到一半崩了"之后再也打不回去。
           */
          const alreadyRecut = this.store.db
            .prepare(`SELECT 1 AS x FROM review_feedback
                       WHERE clip_project_id = ? AND decision = 'recut' AND comment = ?
                         AND segment_ids = ? LIMIT 1`)
            .get(id, comment, JSON.stringify(segmentIds || []));
          if (alreadyRecut) {
            const prior = this.store.db
              .prepare(`SELECT id FROM clip_projects
                         WHERE live_video_id = ?
                           AND status != 'superseded'
                           AND created_at >= (SELECT created_at FROM review_feedback
                                               WHERE clip_project_id = ? AND decision = 'recut' AND comment = ?
                                               AND segment_ids = ? LIMIT 1)
                         ORDER BY id ASC LIMIT 1`)
              .get(project.live_video_id, id, comment, JSON.stringify(segmentIds || []));
            if (prior) {
              console.log(`[Review] 工程#${id} 的这条打回已处理过，复用新工程 #${prior.id}，不重复建`);
              return res.json({
                ok: true,
                projectId: id,
                newProjectId: prior.id,
                deduped: true,
                message: '这次打回已经处理过了，没有重复建工程'
              });
            }
          }

          const result = await this.clipper.createProject(project.live_video_id, {
            presetSegments: picked,
            feedback: [comment], excludeSegmentIds: segmentIds || []
          });
          this.store.updateClipProject(id, { status: 'superseded' });

          /*
           * 记学习样本。
           *
           * 必须在 createProject **之后**：picked 里的 cuts 是原地改的，
           * 记完再改的话存下来的时间区间和实际剪掉的不一致。
           *
           * 记三类（不只是删掉的）：
           *   cut     —— 框选删掉的文字，避雷词
           *   keep    —— 同一段里留下的文字，正样本
           *   segment —— 用户勾选保留的整段，段落级内容逻辑
           * 只记删除的话，下次找爆点只能学会"别说什么"，
           * 学不到"该说什么" —— 而后者才是爆款的正向逻辑。
           */
          try {
            /*
             * 归档到"这条直播自己的 IP"，不是当前选中的。
             * 理由同 _collectionOfLiveVideo：审片时用户可能已经切到别的老师了。
             */
            const col = this._collectionOfLiveVideo(project.live_video_id) ?? null;
            /*
             * transcript 只在上面的 textCuts 分支里加载过，而那个分支
             * 是 `if (Array.isArray(textCuts) && textCuts.length)` ——
             * 用户这次没删任何文字时它根本不存在。
             * 直接用会抛 ReferenceError，被下面的 catch 吞掉，
             * 表现为"打回成功但一条学习样本都没有"，而且日志只有一行看不出原因。
             * 所以这里自己加载一次。
             */
            const learnLiveRow = this.store.db
              .prepare('SELECT asr_path FROM live_videos WHERE id = ?')
              .get(project.live_video_id);
            const learnTranscript = loadTranscript(learnLiveRow?.asr_path,
              this.store.getHotwords(this._collectionOfLiveVideo(project.live_video_id)));
            const editableBySeg = new Map();
            const segStartById = new Map();
            for (const s of picked) {
              if (!s || s.id == null) continue;
              const st = Number(s.startMs ?? s.start_ms ?? 0);
              const en = Number(s.endMs ?? s.end_ms ?? 0);
              segStartById.set(Number(s.id), st);
              editableBySeg.set(Number(s.id), buildEditableText(learnTranscript, st / 1000, en / 1000));
            }
            const rec = buildLearningRecord({
              picked,
              rejectedIds: segmentIds || [],
              textCuts: textCuts || [],
              /*
               * 实际落库的 cuts（picked 是合并完成后的）。
               * 学习记录必须拿它核对，否则被 90% 规则、200ms 下限、
               * charRangeToTime 判空拒绝掉的选区，
               * 照样会被记成"避雷词"注入下一次分析 —— 而那内容还在片子里。
               */
              appliedCutsBySeg: new Map(
                picked
                  .filter((s) => s && s.id != null && Array.isArray(s.cuts) && s.cuts.length)
                  .map((s) => [Number(s.id), s.cuts])
              ),
              editableBySeg,
              segStartById,
              liveVideoId: project.live_video_id,
              comment
            });
            const segById = new Map(picked.filter((s) => s && s.id != null).map((s) => [Number(s.id), s]));
            const rows = [];
            const base = { clipProjectId: result.projectId, liveVideoId: project.live_video_id, collection: col, reason: comment || '' };
            for (const c of rec.cuts) {
              const seg = segById.get(c.segmentId);
              rows.push({
                ...base, kind: 'cut', segmentId: c.segmentId,
                role: seg?.role || null, themeName: seg?.themeName || null,
                text: c.text, charFrom: c.fromChar, charTo: c.toChar,
                startMs: c.startMs + (segStartById.get(c.segmentId) || 0),
                endMs: c.endMs + (segStartById.get(c.segmentId) || 0),
                score: seg?.hookQuality ?? null, by: 'edited'
              });
            }
            for (const k of rec.keeps) {
              const seg = segById.get(k.segmentId);
              rows.push({
                ...base, kind: 'keep', segmentId: k.segmentId,
                role: seg?.role || null, themeName: seg?.themeName || null,
                text: k.text,
                startMs: k.startMs + (segStartById.get(k.segmentId) || 0),
                endMs: k.endMs + (segStartById.get(k.segmentId) || 0),
                score: seg?.hookQuality ?? null, by: 'edited'
              });
            }
            // 整段保留：段落级的内容逻辑。by='picked' 表示用户勾选框认可，
            // 和逐字的 'edited' 区分开 —— 信号来源不同，权重也不该一样。
            for (const sg of rec.keptSegments) {
              const seg = segById.get(sg.segmentId);
              const ed = editableBySeg.get(sg.segmentId);
              rows.push({
                ...base, kind: 'segment', segmentId: sg.segmentId,
                role: sg.role || null, themeName: sg.themeName || null,
                // 段落级也存原文：结构判断要能对上具体内容，不然只有 role 太抽象
                text: (ed?.text || '').slice(0, 600),
                startMs: Number(seg?.startMs ?? seg?.start_ms ?? 0),
                endMs: Number(seg?.endMs ?? seg?.end_ms ?? 0),
                score: sg.hookQuality, by: 'picked'
              });
            }
            const n = this.store.addReviewEdits(rows);
            const sum = this.store.getEditStyleSummary(col);
            console.log(
              `[Review] 学习样本 +${n}（删 ${sum.cuts} / 留 ${sum.keeps} / 整段 ${sum.segments}）` +
              ` → collection=${col || '通用'}`
            );
          } catch (err) {
            // 记学习失败**不能**影响剪辑结果：粗剪已经重剪出来了，
            // 因为写库失败就让整个请求 500，用户看到"提交失败"而实际已生效。
            console.error('[Review] 写学习样本失败（不影响剪辑结果）:', err.message);
          }

          let clipped = null;
          if (result.pendingQueries.length === 0) {
            clipped = await this.clipper.clip(result.projectId);
          }
          this.glbBridge?.sync({ pull: false }).catch(() => {});
          this._briefCache = null;
          return res.json({ ok: true, newProjectId: result.projectId, pendingQueries: result.pendingQueries, clipped: !!clipped, cuts: cutReport });
        }

        return res.status(400).json({ error: 'decision 只能是 approve 或 recut' });
      } catch (err) {
        console.error('[Review] failed:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // 某项目的评审记录 + 学到的经验
    this.app.get('/projects/:id/feedback', this.requireReadAuth, (req, res) => {
      try {
        const id = parseInt(req.params.id);
        res.json({ ok: true, feedback: this.store.getFeedbackByProject(id), lessons: this.store.getReviewLessons() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 上传历史爆款或直播视频（octet-stream 直传，无需额外依赖，支持大文件流式落盘）
    // 前端：fetch('/upload/hits', {method:'POST', headers:{'X-Filename': file.name}, body: file})
    // 先写 .part 临时文件、成功后原子改名：中途断线/服务重启不会留下半截 mp4 被调度器误啃；
    // 客户端中断时（req.close 且未收完）顺手删掉 .part。
    this.app.post('/upload/:kind', this.requireWriteAuth, async (req, res) => {
      let tmp = null;
      try {
        const kind = req.params.kind === 'live' ? 'live' : 'hits';
        const rawHeader = req.headers['x-filename'] || req.query.filename || '';
        let rawName = String(rawHeader || '');
        try { rawName = decodeURIComponent(rawName); } catch { /* 非编码名直接用 */ }
        let safe = basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/^\.+/, '').slice(0, 120);
        if (!safe || safe === '.' || safe === '..') return res.status(400).json({ error: '缺少文件名（X-Filename 头或 ?filename=）' });
        if (WINDOWS_RESERVED.has(safe.split('.')[0].toLowerCase())) return res.status(400).json({ error: '非法文件名' });
        if (!/\.(mp4|mov|mkv|webm|flv|avi)$/i.test(safe)) {
          return res.status(400).json({ error: '仅支持视频文件 mp4/mov/mkv/webm/flv/avi' });
        }
        const maxFileBytes = Number(this.config.upload?.maxFileBytes || 8 * 1024 * 1024 * 1024);
        const maxTotalBytes = Number(this.config.upload?.maxTotalBytes || 50 * 1024 * 1024 * 1024);
        let dirTotal = 0; // 上传目录当前已用字节，供流式配额兜底用
        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > maxFileBytes) {
          return res.status(413).json({ error: `单文件上限 ${(maxFileBytes / 1073741824).toFixed(1)}GB` });
        }
        const dir = kind === 'live'
          ? (this.config.upload?.liveDir || join(__dirname, '..', '..', 'upload', 'live'))
          : (this.config.upload?.hitsDir || join(__dirname, '..', '..', 'upload', 'hits'));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        // 目录配额：超配额直接拒绝，避免 D 盘被打满
        try {
          let total = 0;
          for (const f of readdirSync(dir)) {
            try { total += statSync(join(dir, f)).size; } catch { /* ignore */ }
            if (total > maxTotalBytes) break;
          }
          // 2026-09-24：declared 来自 Content-Length，chunked 请求没有它 → need=0 →
          // 下面这条总配额检查永远不触发，磁盘能被灌满。把已用量带出去，流式阶段实时兜底。
          dirTotal = total;
          const need = declared || 0;
          if (total + need > maxTotalBytes) {
            return res.status(413).json({ error: `上传目录已满（配额 ${(maxTotalBytes / 1073741824).toFixed(0)}GB），请先清理` });
          }
        } catch { /* ignore */ }
        let dest = join(dir, safe);
        if (existsSync(dest)) {
          const dot = safe.lastIndexOf('.');
          dest = join(dir, `${safe.slice(0, dot)}_${Date.now()}${safe.slice(dot)}`);
        }
        tmp = dest + '.part';
        try {
          const { unlinkSync } = await import('fs');
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch { /* ignore */ }
        const ws = createWriteStream(tmp);
        let received = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
          received += chunk.length;
          if (dirTotal + received > maxTotalBytes) {
            // chunked 上传（无 Content-Length）时唯一能拦住的地方
            tooLarge = true;
            try { req.destroy(); } catch { /* ignore */ }
            try { ws.destroy(); } catch { /* ignore */ }
          } else if (received > maxFileBytes) {
            tooLarge = true;
            try { req.destroy(); } catch { /* ignore */ }
            try { ws.destroy(); } catch { /* ignore */ }
          }
        });
        req.on('close', () => {
          // 客户端中途断开且包没收完：删掉半截文件
          if (!req.complete) {
            try { ws.destroy(); } catch { /* ignore */ }
            import('fs').then(({ unlinkSync, existsSync }) => {
              try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
            }).catch(() => {});
          }
        });
        try {
          await pipeline(req, ws);
        } catch (err) {
          if (tooLarge || received > maxFileBytes) {
            try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
            tmp = null;
            return res.status(413).json({ error: `单文件上限 ${(maxFileBytes / 1073741824).toFixed(1)}GB` });
          }
          throw err;
        }
        if (tooLarge || received > maxFileBytes) {
          try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
          tmp = null;
          return res.status(413).json({ error: `单文件上限 ${(maxFileBytes / 1073741824).toFixed(1)}GB` });
        }
        if (!req.complete) return; // 已断开，close 回调负责清理
        const { renameSync } = await import('fs');
        renameSync(tmp, dest);
        tmp = null;
        console.log(`[Upload] ${kind}: ${dest} (${statSync(dest).size} bytes)`);
        res.json({ ok: true, kind, path: dest, name: basename(dest) });
      } catch (err) {
        console.error('[Upload] failed:', err.message);
        if (tmp) {
          try {
            const { unlinkSync, existsSync } = await import('fs');
            if (existsSync(tmp)) unlinkSync(tmp);
          } catch { /* ignore */ }
        }
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
    });

    // 上传目录一览（含分析状态）
    this.app.get('/api/uploads', this.requireReadAuth, (req, res) => {
      try {
        const hitsDir = this.config.upload?.hitsDir;
        const liveDir = this.config.upload?.liveDir;
        const listDir = (dir, getRow) => {
          if (!dir || !existsSync(dir)) return [];
          return readdirSync(dir)
            .filter(f => /\.(mp4|mov|mkv|webm|flv|avi)$/i.test(f))
            .map(f => {
              const p = join(dir, f);
              let size = 0;
              try { size = statSync(p).size; } catch { /* ignore */ }
              return { name: f, path: p, size, ...(getRow(p) || {}) };
            });
        };
        const hits = listDir(hitsDir, (p) => {
          const r = this.store.getHitVideo(p);
          if (!r) return { status: 'pending' };
          const perf = this.store.getHitPerformance(r.id);
          const pred = this.store.getHitPrediction(r.id);
          return {
            id: r.id, status: r.analysis_status, genre: r.genre,
            analyzedAt: r.analyzed_at, createdAt: r.created_at,
            collection: r.collection || null,
            durationMs: r.duration_ms || null,
            title: r.title || null,
            // 记忆维度：看板"记忆详情"直接展开用（要点/开头文案/全文案/画面标题/封面/情绪）
            openingScript: r.opening_script || null,
            viralPoints: this._safeJson(r.viral_points, []),
            onScreenTexts: this._safeJson(r.on_screen_texts, []),
            emotionCurve: this._safeJson(r.emotion_curve, []),
            coverFrame: r.cover_frame || null,
            coverText: r.cover_text || null,
            hasFullTranscript: !!r.full_transcript,
            performance: perf ? { views: perf.views, likes: perf.likes, comments: perf.comments, shares: perf.shares, favorites: perf.favorites, platform: perf.platform, source: perf.source, updatedAt: perf.updated_at } : null,
            prediction: pred ? { viewsLow: pred.views_low, viewsHigh: pred.views_high, likes: pred.likes, comments: pred.comments, shares: pred.shares, favorites: pred.favorites, confidence: pred.confidence, rationale: pred.rationale, createdAt: pred.created_at } : null,
          };
        });
        const live = listDir(liveDir, (p) => {
          const r = this.store.getLiveVideo(p);
          if (!r) return { status: 'pending' };
          // 曾在此 parse 整个 asr JSON 只为显示“转写N段”：3小时转写几十MB，每次刷新看板都阻塞事件循环秒级。
          // 分段数 segment_count 已足够判断进度，转写细节看单条分析日志。
          // 2026-09-27：体检结果必须暴露到界面。LLM 分段失败会静默降级成 90 秒等分
          // （段主题全是"待分类"、钩子分写死 0.5），而状态仍是 completed——
          // 不摆出来，老板永远以为是自己素材的问题。
          return {
            id: r.id, status: r.analysis_status, segments: r.segment_count,
            clips: r.clip_count, createdAt: r.created_at,
            health: this._safeJson(r.analysis_health, null),
          };
        });
        res.json({ ok: true, hits, live });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 粗剪项目一览（含可直接播放的片段文件，评审/预览用）
    this.app.get('/api/projects', this.requireReadAuth, (req, res) => {
      try {
        const draftDir = this.config.output?.draftDir;
        const finishedDir = this.config.output?.finishedDir;
        const toUrl = (abs) => {
          const norm = String(abs || '').replace(/\\/g, '/');
          if (draftDir && norm.startsWith(draftDir.replace(/\\/g, '/'))) {
            return '/files/draft/' + norm.slice(draftDir.replace(/\\/g, '/').length).replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
          }
          if (finishedDir && norm.startsWith(finishedDir.replace(/\\/g, '/'))) {
            return '/files/finished/' + norm.slice(finishedDir.replace(/\\/g, '/').length).replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
          }
          return null;
        };
        const rows = this.store.db.prepare(
          `SELECT p.*, l.video_path AS live_path, l.video_name AS live_name
           FROM clip_projects p LEFT JOIN live_videos l ON l.id = p.live_video_id
           ORDER BY p.id DESC LIMIT 50`
        ).all().map(r => {
          const segs = r.selected_segments ? JSON.parse(r.selected_segments) : [];
          // 输出目录里的 mp4 即为可看版本（draft=粗剪片段，finished=最终成片）
          let clips = [];
          try {
            if (r.output_path && existsSync(r.output_path)) {
              clips = readdirSync(r.output_path)
                .filter(f => /\.mp4$/i.test(f))
                // 粗剪完整单文件优先预览
                .sort((a, b) => (/roughcut/i.test(a) ? -1 : /roughcut/i.test(b) ? 1 : a.localeCompare(b)))
                .map(f => ({ name: f, url: toUrl(join(r.output_path, f)) }))
                .filter(c => c.url);
            }
          } catch { /* ignore */ }
          return { ...r, selected_segments: segs, clips };
        });
        res.json({ ok: true, projects: rows });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 成片一览（finished 输出）
    this.app.get('/api/outputs', this.requireReadAuth, (req, res) => {
      try {
        const rows = this.store.db.prepare(
          `SELECT o.*, p.project_name, p.live_video_id FROM clip_outputs o
           LEFT JOIN clip_projects p ON p.id = o.clip_project_id
           ORDER BY o.id DESC LIMIT 100`
        ).all()
          // 过滤测试素材的产物。
          // 验证脚本(verify:wrap / verify:variant-* 等)会跑真实的出片链路,
          // 于是 clip_outputs 里堆满 test-live-01 / _vo_test / _mv_test 的产物。
          // 成片列表按 id 倒序,这些测试记录正好排在最前面 —— 用户打开列表
          // 看到的就是满屏测试视频,还以为是自己的成片。
          .filter((r) => {
            const hay = `${r.project_name || ''} ${r.output_path || ''} ${r.metadata?.source || ''}`;
            return !/\btest-live|_vo_test|_mv_test|probe_fresh|\bedge\.mp4\b|up-test/i.test(hay);
          })
          .map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
        res.json({ ok: true, outputs: rows });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 看板用系统状态（含 ffmpeg / sherpa / ollama / 调度器）
    this.app.get('/api/system', this.requireReadAuth, async (req, res) => {
      try {
        const { FFmpegHelper } = await import('../analyzer/ffmpeg-helper.js');
        const { getSherpaStatus } = await import('../analyzer/sherpa-asr.js');
        const ff = await this._getFF();
        // 看板每 30s 轮询这里：health 缓存 30s，避免每次都连打两发 Ollama
        if (!this._healthCache?.at || Date.now() - this._healthCache.at > 30000) {
          this._healthCache = { at: Date.now(), health: await this.ollama.health() };
        }
        const ollama = this._healthCache.health;
        res.json({
          ok: true,
          ollama,
          ffmpeg: { available: ff.isAvailable, path: ff.ffmpegPath },
          sherpa: getSherpaStatus(),
          scheduler: this.scheduler.getStatus(),
          dirs: {
            hits: this.config.upload?.hitsDir,
            live: this.config.upload?.liveDir,
            finished: this.config.output?.finishedDir,
            draft: this.config.output?.draftDir,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 爆款封面候选帧直出（看板记忆详情里预览"用的哪张封面"）
    // ─── 爆款库导出（给桌面端爆款记忆库同步用）───
    //
    // 为什么要有这个端点：桌面端要求"每个 IP 一个独立文件夹 + 可撤回 + 可叠加校准"，
    // 那套结构在 sqlite 里做不出来（文件夹、逐条文件、批次）。
    // 以前只有 /hits/:id/cover 和 /hits/:id/transcript 这类单条接口，
    // 要拿全量就得逐条轮询，多一次往返且中途失败无法重来。
    //
    // 一次性把结构/主题/文案模式全吐出来，桌面端才建得出可用的画像。
    // 只要 completed 的：skipped/failed 的没有结构数据，导进来只会污染校准。
    this.app.get('/api/hits/export', this.requireReadAuth, (req, res) => {
      try {
        const collection = String(req.query.collection || '').trim();
        const rows = this.store.db
          .prepare(
            `SELECT * FROM hit_videos
              WHERE analysis_status = 'completed'
                ${collection ? 'AND collection = ?' : ''}
              ORDER BY id`
          )
          .all(...(collection ? [collection] : []));

        const hits = rows.map((v) => {
          // JSON 字段库里存的是字符串，坏值不能让整批导出挂掉
          const safeJson = (s, fallback) => {
            if (!s) return fallback;
            try { return JSON.parse(s); } catch { return fallback; }
          };
          const structures = this.store.getHitStructureByVideo(v.id) || [];
          const themes = this.store.getHitThemesByVideo(v.id) || [];
          // copywriting_patterns 挂在 video_records 上，而 video_records 用的是 video_path。
          // 两个来源都查一遍：老数据直接用 hit_videos.id 当 video_id 登记过。
          const patterns = this.store.db
            .prepare(
              `SELECT pattern_type, text_content, effectiveness, time_ms
                 FROM copywriting_patterns
                WHERE video_id IN (SELECT id FROM video_records WHERE video_path = ?)
                   OR video_id = ?`
            )
            .all(v.video_path, v.id);
const perf = this.store.db
            .prepare('SELECT views, likes, comments, shares, favorites FROM hit_performance WHERE hit_video_id = ?')
            .get(v.id);
          /*
           * 爆款预测一起导出。
           * 以前这个接口只给 performance 不给 prediction，于是桌面端
           * 明明有 hit_predictions 表、也有 /hits/:id/predict 可手动重算，
           * 却永远看不到预测值 —— 只能去 Hermes 自己的看板上看。
           */
          const pred = this.store.db
            .prepare(`SELECT views_low, views_high, likes, comments, shares, favorites, confidence, rationale
                        FROM hit_predictions WHERE hit_video_id = ?`)
            .get(v.id);

          return {
            id: v.id,
            videoPath: v.video_path,
            videoName: v.video_name,
            title: v.title || v.video_name,
            collection: v.collection || '',
            genre: v.genre || '',
            durationSec: Math.round((v.duration_ms || 0) / 1000),
            openingScript: v.opening_script || '',
            fullTranscript: v.full_transcript || '',
            viralPoints: safeJson(v.viral_points, []),
            onScreenTexts: safeJson(v.on_screen_texts, []),
            emotionCurve: safeJson(v.emotion_curve, []),
            coverFrame: v.cover_frame || '',
            analyzedAt: v.analyzed_at || '',
            structures: structures.map((s) => ({
              type: s.segment_type,
              startMs: s.start_ms,
              endMs: s.end_ms,
              description: s.description || '',
              keyText: s.key_text || '',
              emotionTag: s.emotion_tag || '',
              intensity: s.intensity ?? null,
              keyframePath: s.keyframe_path || ''
            })),
            themes: themes.map((t) => ({
              themeName: t.theme_name,
              keywords: safeJson(t.keywords, []),
              confidence: t.confidence ?? null
            })),
            patterns: patterns.map((p) => ({
              type: p.pattern_type,
              text: p.text_content || '',
              effectiveness: p.effectiveness ?? null,
              timeMs: p.time_ms ?? null
            })),
            // 真实播放数据。hit_performance 目前是空表（没有截图/后台数据时就是 null），
            // 桌面端要能区分"没数据"和"数据是 0"，所以这里不填 0。
            performance: perf
              ? {
                  views: perf.views ?? null,
                  likes: perf.likes ?? null,
                  comments: perf.comments ?? null,
                  shares: perf.shares ?? null,
favorites: perf.favorites ?? null
                }
              : null,
            // 预测：区间 + 把握度 + 一句话依据
            // 没有就是 null，不能填 0 冒充"预测播放 0"
            prediction: pred
              ? {
                  viewsLow: pred.views_low ?? null,
                  viewsHigh: pred.views_high ?? null,
                  likes: pred.likes ?? null,
                  comments: pred.comments ?? null,
                  shares: pred.shares ?? null,
                  favorites: pred.favorites ?? null,
                  confidence: pred.confidence || '',
                  rationale: pred.rationale || ''
                }
              : null
          };
        });

        res.json({ ok: true, count: hits.length, hits });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/hits/:id/cover', this.requireReadAuth, (req, res) => {
      try {
        const hit = this.store.getHitVideoById(parseInt(req.params.id));
        const p = hit?.cover_frame;
        if (!p || !existsSync(p)) return res.status(404).json({ error: '还没有封面候选帧' });
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.sendFile(p);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    // 完整逐字稿（记忆详情里点开看全文案；列表接口只带 hasFullTranscript，避免每次刷新拉几十 KB）
    this.app.get('/hits/:id/transcript', this.requireReadAuth, (req, res) => {
      try {
        const hit = this.store.getHitVideoById(parseInt(req.params.id));
        if (!hit) return res.status(404).json({ error: '素材不存在' });
        res.json({ ok: true, id: hit.id, title: hit.title || null, transcript: hit.full_transcript || '' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 静态文件：成片预览/下载（防穿越：仅 serve 配置目录；成片不变文件，浏览器缓存 1h，二次点播不走 Node）
    // 注意：draftDir/finishedDir 此前只在 /api/projects 回调闭包里声明过，这里必须在方法作用域重新取
    const staticDraftDir = this.config.output?.draftDir;
    const staticFinishedDir = this.config.output?.finishedDir;
    // draft 目录下 faststart 端点会原地重写同名 mp4，不能 immutable，否则浏览器缓存旧成片
    const staticOpts = { maxAge: '1h', immutable: true, dotfiles: 'deny', index: false, fallthrough: true };
    const draftOpts = { maxAge: 0, dotfiles: 'deny', index: false, fallthrough: true };
    if (staticFinishedDir && existsSync(staticFinishedDir)) this.app.use('/files/finished', express.static(staticFinishedDir, staticOpts));
    if (staticDraftDir && existsSync(staticDraftDir)) this.app.use('/files/draft', express.static(staticDraftDir, draftOpts));
    // 逐句成片输出目录（第一次成片时才创建，这里先建好并挂载）
    const staticSentenceDir = this.config.output?.sentenceDir || join(__dirname, '..', '..', '..', 'output', 'sentence');
    mkdirSync(staticSentenceDir, { recursive: true });
    this.app.use('/files/sentence', express.static(staticSentenceDir, staticOpts));

    // Scan upload directories (manual trigger:只推进分析+粗剪，永不自动包装成片)
    this.app.post('/pipeline/scan', this.requireWriteAuth, async (req, res) => {
      /*
       * 2026-10-05 加互斥。
       *
       * 这个端点直接调 scheduler 的私有处理器，**不经过 _tickRunning**，
       * 而看板上的「扫一遍」按钮绑的是普通 onclick、从不禁用。
       * 于是连点三次就有三个请求同时进来，而 _processReadyProjects 的闸门
       * 是 runningTasks.size >= limit，那时里面只有 1 条 → 三个都过闸门，
       * 各自 add 一个 clip:<id> → 3 个 createProject 并发打 8G 显存。
       * 实测能把 GPU 顶到 96%。
       *
       * 回 409 而不是排队：用户连点的意图很明确是"扫一遍"，
       * 排队只会让后面几次等更久；回一个"已经在扫"更符合预期。
       */
      if (this._scanInFlight) {
        return res.status(409).json({ ok: false, busy: true, error: '正在扫一遍，请等它跑完' });
      }
      this._scanInFlight = true;
      try {
        // 手动"扫一遍"以前直接调 _processPending*，完全不看显卡：
        // 用户开着剪映/游戏点一下，照样起 LLM 任务抢 8G 显存，和自己正在跑的任务打架。
        // 这里补上和自动 tick 完全相同的忙闲判断。
        const gpu = await getGpuState(this.config);
        const limit = this.scheduler._computeLimit(gpu);
        if (gpu.mode === 'busy' || gpu.ollamaBusy || limit <= 0) {
          const why = gpu.ollamaBusy
            ? 'Ollama 正在推理，手动扫描不插队（转写不受影响）'
            : (limit <= 0
              ? `当前 ${gpu.mode} 档并发上限为 ${limit}，不开新的 LLM 任务`
              : `GPU ${gpu.util}% 忙，手动扫描让路`);
          try { await this.scheduler._transcribeIdle(); } catch { /* 转写失败不影响返回 */ }
          return res.json({
            ok: true, limited: true, why,
            gpu: { util: gpu.util, mode: gpu.mode, ollamaBusy: !!gpu.ollamaBusy },
            stats: this.store.getExtendedStats(),
          });
        }
        this.scheduler._effLimit = limit;
        // Use scheduler methods to respect task locks and avoid race conditions
        await this.scheduler._processPendingHits();
        await this.scheduler._processPendingLives();
        await this.scheduler._processReadyProjects();
        const stats = this.store.getExtendedStats();
        res.json({ ok: true, limited: false, gpu: { util: gpu.util, mode: gpu.mode, ollamaBusy: !!gpu.ollamaBusy }, stats });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        // 必须放锁：少这一句，扫一次之后 _scanInFlight 永远是 true，
        // 「扫一遍」从此再也不响应，而且没有任何报错 —— 是最难查的那种故障。
        this._scanInFlight = false;
      }
    });

    // 调度器手动暂停/恢复：在 GLB 桌面端跑“AI找爆点”前先 pause，让出 8G 显存，
    // 跑完再 resume。pause 不杀已在跑的任务，只是不再起新任务。
    this.app.post('/pipeline/scheduler/pause', this.requireWriteAuth, (req, res) => {
      try {
        this.scheduler.stop();
        res.json({ ok: true, paused: true, runningTasks: [...this.scheduler.runningTasks] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    this.app.post('/pipeline/scheduler/resume', this.requireWriteAuth, (req, res) => {
      try {
        this.scheduler.start();
        res.json({ ok: true, paused: false });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 清理冗余（?dry=1 只预览不删）：删的是废弃草稿 + 临时残留 + 超保留期的源视频，
    // 成片（output/finished）以及记忆库永远不动；源视频只回收 completed 且超 retentionDays 的。
    this.app.post('/pipeline/cleanup', this.requireWriteAuth, async (req, res) => {
      try {
        const dry = req.query.dry === '1' || req.body?.dry === true;
        const report = await this._cleanupRedundant(dry, { includeDrafts: true });
        res.json({ ok: true, dry, ...report });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // 记忆桥手动同步（调度器每小时也会自动跑一次）
    this.app.post('/pipeline/bridge-sync', this.requireWriteAuth, async (req, res) => {
      try {
        const report = await this.glbBridge.sync();
        res.json({ ok: true, ...report });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  /**
   * 清理真冗余并返回清单。只删三类东西：
   *  1. upload/temp 里 24h 以上的残留（sherpa_* 空目录、*.part、*.wav）
   *  2. upload/ 里 1h 以上的 *.part（崩溃/中断残留；进行中的很新，不碰）
   *  3. 已作废/失败项目的 draft 草稿目录（打回后重建了新版，旧的几个 GB 纯占地；
   *     严格限定在 output/draftDir 内部，路径不对就跳过，绝不误删）
   *  4. 合成残留小文件（*.filelist.txt、*_raw_frame.jpg，1h 以上）
   * 源视频、成片、记忆库（data/hermes.db）一律不动。
   */
  async _cleanupRedundant(dry = false, opts = {}) {
    const includeDrafts = opts.includeDrafts !== false;
    const now = Date.now();
    const HOUR = 3600e3;
    const deleted = [];
    let freedBytes = 0;
    const show = (abs) => String(abs).replace(/\\/g, '/').split('/').slice(-3).join('/');
    const push = (path, bytes, kind) => {
      deleted.push({ path: show(path), bytes, mb: +(bytes / 1048576).toFixed(1), kind });
      freedBytes += bytes;
    };
    const mtimeOf = (p) => {
      try { return statSync(p).mtimeMs; } catch { return 0; }
    };
    const rmOne = (p) => {
      if (dry) return true;
      try {
        rmSync(p, { recursive: true, force: true });
        return true;
      } catch { return false; }
    };

    // 1) temp 残留（24h+ 才动）。注意：live/hit 表里 asr_path 指向的转写缓存是“热数据”，
    // 以前会被当残留删掉（如 live66 的 3.5 小时转写），删完下次包装/重分析就得花半小时重转。
    // 白名单加过期条件：对应视频已进入保留期（retentionDays 前完成分析，源视频也会被第 5 步删掉）时不再保护，
    // 否则几十 MB 一份的转写 JSON 会永久堆积。
    const retentionDays = Math.max(0, this.config.upload?.retentionDays ?? 7);
    const retentionMs = retentionDays * 24 * HOUR;
    const protectedAsr = new Set();
    try {
      for (const t of ['hit_videos', 'live_videos']) {
        for (const r of this.store.db.prepare(`SELECT asr_path FROM ${t} WHERE asr_path IS NOT NULL`).all()) {
          protectedAsr.add(String(r.asr_path).replace(/\\/g, '/').toLowerCase());
        }
      }
    } catch { /* ignore */ }
    const tempDir = this.config.upload?.tempDir;
    if (tempDir && existsSync(tempDir)) {
      for (const name of readdirSync(tempDir)) {
        const p = join(tempDir, name);
        const pNorm = String(p).replace(/\\/g, '/').toLowerCase();
        if (protectedAsr.has(pNorm)) {
          // 源视频保留期内才豁免；超过保留期的转写缓存跟着源视频一起过期
          const srcStillLive = ['hitsDir', 'liveDir'].some(k => {
            const d = this.config.upload?.[k];
            return d && existsSync(join(d, name.replace(/_asr\.json$/i, '.mp4')));
          });
          if (srcStillLive || retentionDays === 0) continue;
          /*
           * 源视频没了，但这条直播**还有粗剪在等着审**，也不能删。
           *
           * 实际踩过：live#174 的 3 小时转写缓存被删掉后，
           * review-packet 里 15 段的 text 全变成空串 ——
           * 文字精修界面"能框、但一个字符都没有"，
           * 而且不报错（loadTranscript 读不到文件就返回 []）。
           *
           * 源视频删了 ≠ 这条直播没人管了：只要还有 clip_projects
           * 引用它且状态不是 failed，就还得靠逐句稿工作。
           * 所以这里按"是否还有在审/已审的粗剪"再豁免一次。
           */
          try {
            const stillUsed = this.store.db.prepare(`
              SELECT COUNT(*) AS n
              FROM clip_projects p
              JOIN live_videos l ON l.id = p.live_video_id
              WHERE l.asr_path = ? AND p.status IN ('reviewing','approved','finished','exported')
            `).get(String(p).replace(/\\/g, '/'));
            if (stillUsed?.n > 0) continue;
          } catch { /* ignore */ }
        }
        if (now - mtimeOf(p) < 24 * HOUR) continue;
        let bytes = 0;
        try { bytes = statSync(p).isDirectory() ? this._dirSize(p) : statSync(p).size; } catch { continue; }
        if (rmOne(p)) push(p, bytes, 'temp');
      }
    }

    // 2) upload 下的 .part
    for (const key of ['hitsDir', 'liveDir']) {
      const d = this.config.upload?.[key];
      if (!d || !existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        if (!/\.part$/i.test(name)) continue;
        const p = join(d, name);
        if (now - mtimeOf(p) < HOUR) continue;
        let bytes = 0;
        try { bytes = statSync(p).size; } catch { continue; }
        if (rmOne(p)) push(p, bytes, 'part');
      }
    }

    // 3) 作废/失败项目的 draft 草稿
    if (includeDrafts) {
      const draftDir = this.config.output?.draftDir;
      if (draftDir) {
        const normDraft = String(draftDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        let rows = [];
        try {
          rows = this.store.db.prepare(
            "SELECT id, output_path FROM clip_projects WHERE status IN ('superseded','failed')"
          ).all();
        } catch { /* ignore */ }
        for (const r of rows) {
          const cands = [r.output_path, join(draftDir, `project_${r.id}`)].filter(Boolean);
          for (const c of cands) {
            const n = String(c).replace(/\\/g, '/').replace(/\/+$/, '');
            if (n.toLowerCase() === normDraft || !n.toLowerCase().startsWith(normDraft + '/')) continue;
            if (!existsSync(c)) continue;
            const bytes = this._dirSize(c);
            if (rmOne(c)) push(c, bytes, 'draft');
            break;
          }
        }
      }
    }

    // 4) 合成残留小文件
    for (const key of ['draftDir', 'finishedDir']) {
      const base = this.config.output?.[key];
      if (!base || !existsSync(base)) continue;
      const stack = [base];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = join(cur, e.name);
          try {
            if (e.isDirectory()) { stack.push(p); continue; }
            if (!/\.filelist\.txt$/i.test(e.name) && /_raw_frame\.jpg$/i.test(e.name) === false) continue;
            if (now - mtimeOf(p) < HOUR) continue;
            const bytes = statSync(p).size;
            if (rmOne(p)) push(p, bytes, 'leftover');
          } catch { /* ignore */ }
        }
      }
    }

    // 5) 源视频保留期回收：分析 completed 且超过 retentionDays（默认 7 天，0=永不回收）的源视频。
    //    结构/话术已入库、关键帧已拷到 data/frames，几百 MB 一场的原始 mp4 没必要永久留。
    //    只允许删配置目录内的文件，路径异常（外部/相对/缺失）一律跳过。
    if (retentionDays > 0) {
      for (const key of ['hitsDir', 'liveDir']) {
        const d = this.config.upload?.[key];
        if (!d || !existsSync(d)) continue;
        const normDir = String(d).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        let rows = [];
        try {
          rows = this.store.db.prepare(
            `SELECT video_path FROM ${key === 'hitsDir' ? 'hit_videos' : 'live_videos'}
             WHERE analysis_status = 'completed' AND analyzed_at IS NOT NULL
               AND analyzed_at < datetime('now', ?)`
          ).all(`-${retentionDays} days`);
        } catch { /* ignore */ }
        for (const r of rows) {
          if (!r.video_path) continue;
          const n = String(r.video_path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (!n.startsWith(normDir + '/')) continue; // 只动配置目录内的源视频
          if (!existsSync(r.video_path)) continue;
          const bytes = statSync(r.video_path).size;
          if (rmOne(r.video_path)) push(r.video_path, bytes, 'retire-src');
        }
      }
    }

    return { deleted, count: deleted.length, freedBytes };
  }

  /** FFmpegHelper 单例：构造器要做十几次 existsSync 并打日志，别在请求路径上反复 new */
  async _getFF() {
    if (!this._ff) {
      const { FFmpegHelper } = await import('../analyzer/ffmpeg-helper.js');
      this._ff = new FFmpegHelper();
    }
    return this._ff;
  }

  /** 递归统计目录大小（同步，草稿目录条目少，很快） */
  _dirSize(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(cur, e.name);
        try {
          if (e.isDirectory()) stack.push(p);
          else total += statSync(p).size;
        } catch { /* ignore */ }
      }
    }
    return total;
  }

  /**
   * 给一条已分析完的历史爆款素材做播量预测（参照记忆库）。
   * 调用方：分析完成自动触发 / 调度器补存量 / 记忆页手动重算。
   */
  /**
   * 当前"用哪个文件夹的记忆剪片"。存 data/active-collection.json，
   * 这样重启 Hermes 也记得你上次选的是哪个 IP/老师。
   */
  /** 连麦/音乐保留（全局）：true=唱歌/间奏/连麦对话拼进粗剪，false=这些不进。存 data/keep-extra.json */
  getKeepExtra() {
    try {
      const p = join(__dirname, '..', '..', 'data', 'keep-extra.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        return j.keepExtra !== false;
      }
    } catch { /* ignore */ }
    return true;
  }

  setKeepExtra(v) {
    try {
      const dir = join(__dirname, '..', '..', 'data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'keep-extra.json'), JSON.stringify({ keepExtra: v !== false }, null, 2));
    } catch (err) {
      console.warn('[Orchestrator] 保存连麦/音乐设置失败:', err.message);
    }
    return v !== false;
  }

  // 按记忆爆款逻辑给记忆挑句候选起新标题：参考当前文件夹已学爆款的标题风格，LLM 批量起名；失败回退首句
  async renameMemoryPicksWithLlm(groups, videoName) {
    if (!Array.isArray(groups) || !groups.length) return groups;
    try {
      let sampleTitles = [];
      try {
        const active = this.getActiveCollection();
        sampleTitles = this.store.db.prepare(
          "SELECT title FROM hit_videos WHERE analysis_status = 'completed' AND title IS NOT NULL AND title <> ''" +
          (active ? " AND collection = ?" : "") +
          " ORDER BY id DESC LIMIT 8"
        ).all(...(active ? [active] : [])).map((r) => String(r.title).slice(0, 30)).filter(Boolean);
      } catch { /* 样例拿不到就空着，仅按内容起名 */ }
      const items = groups.map((g, i) => ({ id: i, text: String(g.text || '').slice(0, 120) }));
      const cacheKey = String(videoName || '') + '|' + groups.map((g) => g.startSec).join(',') + '|' + items.map((o) => o.text.length).join(',');
      this._memTitleCache = this._memTitleCache || new Map();
      const hit = this._memTitleCache.get(cacheKey);
      if (hit) return groups.map((g, i) => (hit[i] ? { ...groups[i], title: hit[i] } : groups[i]));
      const sys = '你是短视频标题师傅。只输出JSON数组，不要解释：[{"id":数字,"title":"标题"}]。要求：12字内口语短句，带钩子（悬念/数字/痛点/指令式），像直播间高能切片的标题，不带句号书名号。';
      const out = await this.ollama.generate(sys,
        (sampleTitles.length ? '参考这个IP老师的历史爆款标题风格：\n' + sampleTitles.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n\n' : '') +
        '切片内容（id|文本）：\n' + items.map((o) => `${o.id}|${o.text}`).join('\n') + '\n给每个 id 起一个新标题。', {
        // GPU 常满时 Ollama 推理很慢，90s 经常 abort（日志里"LLM起名失败"）。放宽到 5 分钟；真超时还有规则起名兜底
        parseJson: true, temperature: 0.6, maxTokens: 1024, timeout: 300000,
      });
      const arr = Array.isArray(out) ? out : out.titles || out.items || [];
      const byId = new Map(arr.map((r) => [Number(r && r.id), String((r && r.title) || '').replace(/[\r\n"]/g, '').trim().slice(0, 24)]));
      const titles = groups.map((g, i) => byId.get(i) || '');
      this._memTitleCache.set(cacheKey, titles);
      if (this._memTitleCache.size > 50) this._memTitleCache.delete(this._memTitleCache.keys().next().value);
      return groups.map((g, i) => (titles[i] ? { ...groups[i], title: titles[i] } : groups[i]));
    } catch (err) {
      // LLM 起名失败/超时：用规则起名兜底（比"首句硬截断"更像标题，且不依赖 GPU）
      console.warn('[MemoryPick] LLM起名失败，用规则起名兜底:', err.message);
      return groups.map((g) => (g.title ? g : { ...g, title: ruleBasedClipTitle(g.text) }));
    }
  }

  getActiveCollection() {
    if (this._activeCollection !== undefined) return this._activeCollection || '';
    try {
      const p = join(__dirname, '..', '..', 'data', 'active-collection.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        this._activeCollection = String(j?.name || '').trim();
      } else {
        this._activeCollection = '';
      }
    } catch {
      this._activeCollection = '';
    }
    return this._activeCollection || '';
  }

  setActiveCollection(name) {
    this._activeCollection = String(name || '').trim();
    // 立刻同步给记忆层：切换文件夹后，评审经验的归属与读取范围随之切换
    try { this.store.setActiveCollection(this._activeCollection); } catch { /* ignore */ }
    try {
      const dir = join(__dirname, '..', '..', 'data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'active-collection.json'), JSON.stringify({ name: this._activeCollection }, null, 2));
    } catch (err) {
      console.warn('[Orchestrator] 保存当前文件夹失败:', err.message);
    }
    return this._activeCollection;
  }

  /** JSON 字段容错读取：库里可能是空/脏数据，解析失败就退回默认值 */
  _safeJson(str, fallback = null) {
    if (!str) return fallback;
    try {
      const v = JSON.parse(str);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  async predictHitVideo(hitId) {
    const hit = this.store.getHitVideoById(hitId);
    if (!hit) {
      const err = new Error('素材不存在');
      err.status = 404;
      throw err;
    }
    const themes = this.store.getHitThemesByVideo(hit.id);
    const structure = this.store.getHitStructureByVideo(hit.id);
    // 平台已知时优先同平台真实回流数据做基线（视频号/抖音/小红书/快手/B站数据量级差很大）
    const perf = this.store.getHitPerformance(hit.id);
    const platform = perf?.platform || null;
    // 基准只取这位老师自己的真实回流数据（见 store.getPerformanceBaseline 的注释）。
// 以前按 genre 全库混算，等于用别人的爆款标准来衡量他。
const baseline = this.store.getPerformanceBaseline(hit.genre, platform, hit.collection || null);
    const segTypes = {};
    for (const s of structure) segTypes[s.segment_type] = (segTypes[s.segment_type] || 0) + 1;
    const brief = {
      name: hit.video_name,
      title: hit.title || null,
      genre: hit.genre,
      platform,
      durationSec: hit.duration_ms ? Math.round(hit.duration_ms / 1000) : null,
      themes: themes.map((t) => ({ name: t.theme_name, confidence: t.confidence })),
      structure: segTypes,
      viralPoints: this._safeJson(hit.viral_points, []).slice(0, 5),
      openingScript: hit.opening_script || null,
actual: perf ? { views: perf.views, likes: perf.likes, comments: perf.comments, shares: perf.shares, favorites: perf.favorites } : null,
      // 只给这一位老师的真实数据基准（没有就是 null，不拿别人的数据凑）
      ownTeacherActualMedian: baseline,
      teacher: hit.collection || null,
    };
    const sys = '你是短视频爆款数据预测器。只输出JSON，不要解释：{"views_low":数字,"views_high":数字,"likes":数字,"comments":数字,"shares":数字,"favorites":数字,"confidence":"高|中|低","rationale":"一句话依据（中文，40字内）"}。规则：无真实回流数据时按同类记忆保守估计，confidence 填"低"并在rationale注明"样本少，保守估计"；若ownTeacherActualMedian.platform非空（同平台真实数据校准），预测向该中位数收敛，confidence 填"中"或"高"并注明"已按同平台数据校准"；收藏量（favorites）通常介于点赞的 5%~30%，小红书偏高、抖音偏低。';
    console.log(`[Orchestrator] Predicting performance for hit ${hit.id} (${hit.video_name})...`);
    const out = await this.ollama.generate(sys, `素材分析：${JSON.stringify(brief)}`, {
      parseJson: true, temperature: 0.3, maxTokens: 512, timeout: 180000,
    });
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
    // 模型没给把握度时按样本量兜底：有同平台真实数据=中，有全量数据=低，完全没有=低
    const conf = ['高', '中', '低'].includes(String(out.confidence || '')) ? String(out.confidence)
      : (baseline?.platform ? '中' : (baseline?.count ? '低' : '低'));
const pred = this.store.upsertHitPrediction(hit.id, {
      viewsLow: num(out.views_low), viewsHigh: num(out.views_high),
      likes: num(out.likes), comments: num(out.comments), shares: num(out.shares),
      favorites: num(out.favorites), confidence: conf,
      /*
       * 依据里补一句"这位老师自己的数据还差几条"。
       * 因为基准已按 IP 隔离，样本不足时是真的没有参照 ——
       * 不说清楚的话，界面上一个"低"字，用户不知道该去补数据还是该信这个数。
       */
      rationale: String(out.rationale || '').slice(0, 120)
        + (baseline ? '' : (hit.collection
          ? `；${hit.collection}自己的真实数据还不够，需要更多带回流数据的样本`
          : '；还没有任何真实回流数据')),
    });
    console.log(`[Orchestrator] Prediction done for hit ${hit.id}: ${pred.views_low}-${pred.views_high} views`);
    return pred;
  }



  /**
   * Load a JSON file safely.
   */
  _loadJson(path) {
    if (!path || !existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * 周期性复查 LLM 连通性。
   *
   * 起因:启动时只探一次,而 Ollama 常常比 Hermes 晚几秒就绪,
   * 于是 ollamaReady 永久停在 false,界面显示"算力未就绪"、
   * 分析任务无法启动,但用户机器上模型服务其实好好的。
   * 现在持续复查:不可用时每 15s 探一次,恢复的瞬间刷新状态并打印日志,
   * 界面下一轮轮询就能看到绿灯。
   */
  _startLlmWatch() {
    if (this._llmWatchTimer) return;
    this._llmWatchTimer = setInterval(async () => {
      if (this._llmWatchBusy) return;
      this._llmWatchBusy = true;
      try {
        const h = await this.ollama.health();
        if (h.ok && !this.ollamaReady) {
          console.log(`[Orchestrator] LLM 已上线 (v${h.version})，模型: ${h.models.join(', ')}`);
        } else if (!h.ok && this.ollamaReady) {
          console.warn('[Orchestrator] LLM 掉线，等待恢复中…');
        }
        this.ollamaReady = h.ok;
      } catch {
        this.ollamaReady = false;
      } finally {
        this._llmWatchBusy = false;
      }
    }, 15_000);
    this._llmWatchTimer.unref?.();
  }

  /**
   * Start the Hermes server.
   */
  async start() {
    // Check LLM connectivity (warn but don't exit if offline)
    const health = await this.ollama.health();
    this.ollamaReady = health.ok;
    const provider = this.config.llm?.provider || 'ollama';
    if (!health.ok) {
      console.warn(`[Orchestrator] WARNING: LLM (${provider}) is not reachable!`);
      if (provider === 'zen') {
        console.warn('[Orchestrator] 检查 OPENCODE_ZEN_API_KEY 是否已设置（https://opencode.ai/auth 复制），以及免费额度是否用完');
      } else {
        console.warn(`[Orchestrator] Start it with: 启动GLB.cmd`);
        console.warn('[Orchestrator] Expected at:', this.config.ollama.baseUrl);
      }
      console.warn('[Orchestrator] Server will start anyway. LLM features will activate when backend comes online.');
      // 2026-09-30 真的实现"上线后自动激活"。
      // 启动脚本里 Ollama 与 Hermes 是同时拉起的,Hermes 常常先就绪、
      // 5 秒健康检查直接判失败,于是 ollamaReady 永久为 false ——
      // 界面顶栏一直显示"算力未就绪",分析任务也起不来,
      // 而模型服务其实几秒后就上线了。这是"明明装了却用不了"的典型成因。
      this._startLlmWatch();
    } else {
      console.log(`[Orchestrator] LLM (${provider}) connected (v${health.version})`);
      console.log(`[Orchestrator] Available models: ${health.models.join(', ')}`);
      this._startLlmWatch();
    }

    // 崩溃恢复：上次若死在 analyzing 中间，残留 analyzing 会被调度器永远跳过，启动时清回 pending
    try {
      const r1 = this.store.db.prepare("UPDATE hit_videos SET analysis_status='pending' WHERE analysis_status='analyzing'").run();
      const r2 = this.store.db.prepare("UPDATE live_videos SET analysis_status='pending' WHERE analysis_status='analyzing'").run();
      if ((r1.changes + r2.changes) > 0) {
        console.log(`[Orchestrator] Crash recovery: reset ${r1.changes} hit + ${r2.changes} live from 'analyzing' to 'pending'`);
      }
      // clip()/generateAll() 是“创建项目→改 clipping→产出文件→改 reviewing/finished”多步操作，
      // 死在中间会留下 clipping/generating 孤儿：调度器只认 reviewing，没人再碰它们。
      // 置为 failed（看板可见、用户可手动重剪，且不再挡着该直播建新项目）。
      const r3 = this.store.db.prepare("UPDATE clip_projects SET status='failed' WHERE status IN ('clipping','generating')").run();
      if (r3.changes > 0) {
        console.log(`[Orchestrator] Crash recovery: marked ${r3.changes} orphan clip project(s) as 'failed' (was clipping/generating)`);
      }
    } catch (err) {
      console.warn('[Orchestrator] Crash recovery failed:', err.message);
    }



    // Start idle scheduler (new auto-pipeline)
    if (this.config.scheduler?.enabled !== false) {
      this.scheduler.start();
    }

    // Start HTTP server
    const port = this.config.server.port;
    const host = this.config.server.host;
    this.server = this.app.listen(port, host, () => {
      console.log(`[Orchestrator] Hermes server running at http://${host}:${port}`);
      console.log(`[Orchestrator] Webhook endpoint: http://${host}:${port}/webhook`);
      console.log(`[Orchestrator] Health check: http://${host}:${port}/health`);
      console.log(`[Orchestrator] Memory stats: http://${host}:${port}/stats`);
      console.log('[Orchestrator] Ready. Process videos in GLB - Hermes will learn automatically.');
    });

    // 大文件上传需要放宽超时，但不再无限制：30 分钟 + 65s 头超时，防止慢连接占满事件循环
    this.server.requestTimeout = 30 * 60 * 1000;
    this.server.headersTimeout = 65000;
    this.server.maxHeadersCount = 50;

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Orchestrator] Port ${port} is already in use!`);
        console.error('[Orchestrator] Close the other instance and try again, or change server.port in config/default.json');
      } else {
        console.error('[Orchestrator] Server error:', err.message);
      }
      process.exit(1);
    });
  }

  /**
   * 允许媒体操作的根目录白名单（2026-09-24 安全加固）。
   * 服务以当前登录用户身份运行，历史上 /process、/pipeline/analyze-* 的 videoPath 只判了非空，
   * 任何本地进程都能让它去读/转码任意文件；再配合 /hits/delete 的 deleteFiles，能物理删除任意文件。
   * 放行范围：配置里的工作目录 + security.extraAllowedDirs + 数据库里已登记素材的父目录
   * （后者保证老板把源片放在任意盘位、只要投喂过一次就继续可用）。
   */
  _allowedRoots() {
    const now = Date.now();
    if (this.__rootsCache && now - this.__rootsCache.at < 300000) return this.__rootsCache.roots;
    const c = this.config || {};
    const raw = [
      c.upload?.hitsDir, c.upload?.liveDir, c.upload?.tempDir, c.upload?.queryDir,
      c.glb?.outputWatchDir, c.glb?.clipDir, c.glb?.transcriptDir, c.glb?.highlightDir,
      c.output?.finishedDir, c.output?.draftDir, c.output?.sentenceDir,
      ...(Array.isArray(c.security?.extraAllowedDirs) ? c.security.extraAllowedDirs : []),
    ].filter(Boolean);
    try {
      const rows = this.store.db.prepare(
        'SELECT video_path AS p FROM hit_videos UNION SELECT video_path AS p FROM live_videos'
      ).all();
      for (const r of rows) if (r.p) raw.push(dirname(r.p));
    } catch { /* 表不存在时忽略 */ }
    const roots = [...new Set(raw.map((x) => { try { return resolve(x).toLowerCase(); } catch { return ''; } }).filter(Boolean))];
    this.__rootsCache = { at: now, roots };
    return roots;
  }

  /** 该路径是否允许被 Hermes 读取/转码/删除 */
  isAllowedMediaPath(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    let abs;
    try { abs = resolve(p); } catch { return false; }
    // 非媒体扩展名直接拒掉（顺手挡住 *.dll / *.docx / config 之类）
    if (!/\.(mp4|mov|mkv|webm|flv|avi|m4v|ts|mp3|wav|m4a|aac|flac)$/i.test(abs)) return false;
    const low = abs.toLowerCase();
    return this._allowedRoots().some((r) => low === r || low.startsWith(r.endsWith(sep) ? r : r + sep));
  }

  async stop() {
    // 先掐子进程：ffmpeg 一次转写能跑几十分钟，服务停了它还在后台吃 CPU、占着源文件句柄，
    // 后面想删素材/挪盘都会被占用挡住。
    const killed = killAllFfmpeg();
    if (killed > 0) console.log(`[Orchestrator] 停止时清理 ${killed} 个 ffmpeg/ffprobe 子进程`);
    if (this.server) this.server.close();
    this.scheduler.stop();
    this.store.close();
    console.log('[Orchestrator] Hermes stopped');
  }

  /**
   * Hermes 看板：历史爆款上传 → 空闲自动粗剪 → 反问确认 → 成片（字幕/标题/封面）全流程 UI
   * 用法：启动 Hermes 后浏览器打开 http://127.0.0.1:17841
   * 注意：下面是 Node 模板字符串！里面写浏览器 JS 时，换行要写成 \\n（写 \n 会被 Node
   * 先转义成真换行，浏览器端字符串被截断、整个看板点不动）。改完务必抽 script 跑 node --check。
   */
  _getDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hermes AI · 爆款粗剪看板</title>
<style>
/* 设计令牌对齐 GLB 主程序（ink/panel/line/fg/mut/flame/ember） */
:root{--bg:#0a0b0f;--card:#12141a;--card2:#191c24;--line:#262a35;--txt:#f3f4f8;--mut:#8f95a3;--acc:#ff9a3d;--acc2:#ff4d2e;--ok:#34d399;--warn:#ffb020;--bad:#f87171}
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--txt);font-size:13px;min-height:100%}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;color:var(--txt)}header h1 small{color:var(--mut);font-weight:400;font-size:11px;margin-left:8px}
.pill{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid var(--line);color:var(--mut);background:var(--card2)}
.pill.ok{color:var(--ok);border-color:rgba(52,211,153,.35)}.pill.bad{color:var(--bad);border-color:rgba(248,113,113,.35)}.pill.warn{color:var(--warn);border-color:rgba(255,176,32,.35)}
main{max-width:1200px;margin:0 auto;padding:16px 18px 24px}
.tabs{display:flex;gap:6px;margin:4px 0 14px;flex-wrap:wrap}
.tabs button{background:transparent;color:var(--mut);border:1px solid transparent;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;transition:color .15s,background .15s}
.tabs button:hover{color:var(--txt);background:var(--card2)}
.tabs button.active{background:var(--acc);color:#0a0b0f;font-weight:600}
.tabs button .badge{display:inline-block;min-width:18px;background:var(--bad);color:#fff;border-radius:10px;font-size:11px;padding:1px 6px;margin-left:5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:16px}
.card h2{margin:0 0 8px;font-size:14px;color:var(--txt);display:flex;align-items:center;gap:8px}
.card h2::before{content:'';width:3px;height:14px;background:var(--acc);border-radius:2px;flex:none}
.card h2 small{color:var(--mut);font-weight:400;font-size:11px;margin-left:2px}
.card p.desc{color:var(--mut);font-size:12px;margin:0 0 12px;line-height:1.7}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{background:var(--acc);color:#0a0b0f;font-weight:600;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px}.btn:hover{filter:brightness(1.08)}
.btn.ghost{background:var(--card2);border:1px solid var(--line);color:var(--txt);font-weight:400}.btn.ghost:hover{border-color:var(--acc);color:var(--acc)}
.btn.small{padding:4px 10px;font-size:12px;border-radius:7px}.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.danger:hover{border-color:var(--bad);color:var(--bad)}
select.ctl,input.ctl{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12px}
select.ctl:hover{border-color:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
th{padding:6px 8px;text-align:left;color:var(--mut);font-weight:500;font-size:11px;white-space:nowrap;border-bottom:1px solid var(--line)}
td{padding:10px 8px;text-align:left;border-bottom:1px solid rgba(38,42,53,.6);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(255,154,61,.04)}
.st{font-size:11px;padding:2px 8px;border-radius:10px;white-space:nowrap;display:inline-block}.st.completed,.st.finished{background:rgba(52,211,153,.12);color:var(--ok)}.st.analyzing,.st.clipping,.st.generating,.st.reviewing{background:rgba(255,176,32,.14);color:var(--warn)}.st.approved{background:rgba(125,196,255,.14);color:#7cc4ff}.st.failed{background:rgba(248,113,113,.14);color:var(--bad)}.st.pending{background:var(--card2);color:var(--mut)}
.fname{font-size:12px;color:var(--txt);word-break:break-all}
.fmeta{font-size:11px;color:var(--mut);margin-top:3px;line-height:1.6}
.fmeta b{color:var(--txt);font-weight:500}
.fmeta .lb{color:#7cc4ff}.fmeta .la{color:#ffb020}
video{width:100%;max-width:360px;border-radius:8px;background:#000}
.q{border-left:3px solid var(--warn);padding:10px 12px;margin:10px 0;background:var(--card2);border-radius:0 8px 8px 0}
.q .opts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
input[type=file]{display:none}
.drop{border:1.5px dashed var(--line);border-radius:10px;padding:18px;text-align:center;color:var(--mut);cursor:pointer;margin:12px 0;background:var(--card2);transition:border-color .15s,color .15s}
.drop:hover,.drop.over{border-color:var(--acc);color:var(--acc)}
.drop small{font-size:11px}
.progress{height:5px;background:var(--card2);border-radius:3px;overflow:hidden;margin-top:8px;display:none}.progress i{display:block;height:100%;background:var(--acc);width:0}
footer{color:var(--mut);font-size:11px;text-align:center;padding:16px}
code{background:var(--card2);padding:2px 6px;border-radius:4px;font-size:11px}
.tabpage{display:none}.tabpage.active{display:block}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:800px){.grid2{grid-template-columns:1fr}}
/* 内嵌进 GLB 主程序（?embed=1）：铺满 iframe、去掉页脚留白，做到和主界面无缝 */
body.embed{overflow-y:auto}body.embed main{max-width:none;padding:12px 14px 18px}body.embed footer{display:none}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:#2b2f3a;border-radius:5px}::-webkit-scrollbar-thumb:hover{background:#3a3f4d}
/* 页内提示：内嵌 iframe 的 sandbox 没有 allow-modals，alert/confirm/prompt 会被静默吞掉，这里全部用自绘组件替代 */
#toasts{position:fixed;top:12px;right:12px;z-index:99;display:flex;flex-direction:column;gap:8px;max-width:min(420px,80vw)}
.toast{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);color:var(--txt);font-size:12px;line-height:1.6;padding:9px 13px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;animation:tin .18s ease-out;white-space:pre-line}
.toast.err{border-left-color:var(--bad)}.toast.ok{border-left-color:var(--ok)}
@keyframes tin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
#modal{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
#modal.on{display:flex}#modal .box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;width:min(480px,90vw);box-shadow:0 16px 48px rgba(0,0,0,.6)}
#modal .box p{margin:0 0 12px;font-size:13px;line-height:1.7;white-space:pre-line}#modal .box .row{justify-content:flex-end}
#modal .box input{width:100%;background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:14px}
#modal .box input:focus{outline:none;border-color:var(--acc)}
</style>
</head>
<body>
<header>
<h1>🎬 Hermes AI<small>历史爆款学习 · 直播自动粗剪 · 字幕/标题/封面</small></h1>
<span class="pill" id="p-ollama">Ollama …</span>
<span class="pill" id="p-ffmpeg">ffmpeg …</span>
<span class="pill" id="p-sherpa">语音 …</span>
<span class="pill" id="p-sched">调度 …</span>
<span class="pill" id="p-mode">模式 …</span>
<span style="flex:1"></span>
<button class="btn ghost small" onclick="scan()">🔄 扫一遍</button>
<button class="btn ghost small" onclick="loadAll()">↻ 刷新</button>
<button class="btn ghost small" id="btn-hist" onclick="toggleHist()">📦 历史：关</button>
<button class="btn ghost small" onclick="clearDisplay()">🧹 清空显示</button>
</header>
<main>
<div class="tabs">
<button data-t="hits" class="active" onclick="tab('hits')">🔥 历史爆款</button>
<button data-t="live" onclick="tab('live')">📡 整场直播</button>
<button data-t="projects" onclick="tab('projects')">✂️ 粗剪项目</button>
<button data-t="queries" onclick="tab('queries')">❓ 待确认<span class="badge" id="q-badge" style="display:none">0</span></button>
<button data-t="outputs" onclick="tab('outputs')">✅ 成片</button>
</div>

<div class="tabpage active" id="page-hits">
<div class="card"><h2>AI 大脑 <small>粗剪选段/主题理解/字幕纠错用的大模型，接入状态一目了然</small></h2>
<div class="row" style="align-items:center;gap:10px;margin-bottom:8px">
<span class="pill ok" id="llm-status">AI 大脑：加载中…</span>
<span style="font-size:12px;color:var(--mut)">改配置请编辑 Hermes/config/default.json 的 llm.provider 与 deepseek 节点，保存后重启 Hermes 生效</span>
</div></div>
<div class="card"><h2>文件夹 <small>一个 IP / 老师一个文件夹，选中哪个，剪直播素材就用哪套爆款记忆</small></h2>
<div class="row">
<select id="col-pick" class="ctl" onchange="pickCollection(this.value)" style="min-width:200px"></select>
<button class="btn ghost small" onclick="newCollection()">＋ 新建</button>
<button class="btn ghost small" id="btn-rename" onclick="renameCollection()">重命名</button>
<button class="btn ghost small danger" id="btn-delcol" onclick="deleteCollection()">清空此文件夹</button>
<button class="btn ghost small" id="btn-dissolve" onclick="dissolveCollection()">解散文件夹（素材保留）</button>
<span style="flex:1"></span>
<button class="btn ghost small" onclick="purgeOrphans()">自主清理空壳</button>
</div>
<div class="row" id="col-batch" style="margin-top:10px;padding:8px 12px;background:var(--card2);border-radius:8px;display:none">
<span style="font-size:12px;color:var(--acc)" id="col-sel">已选 0 条：</span>
<button class="btn ghost small" onclick="batchMove()">归入文件夹</button>
<button class="btn ghost small" id="btn-undocol" style="display:none" onclick="undoCollection()" title="把上一次批量归入的素材退回原处">↩ 撤销上次归入</button>
<button class="btn ghost small danger" onclick="batchDelete(false)">清除（保留源视频）</button>
<button class="btn ghost small danger" onclick="batchDelete(true)">清除并删源视频</button>
<button class="btn ghost small" onclick="clearSel()">取消</button>
</div></div>

<div class="card"><h2>上传历史爆款视频 <small>建议 3～10 条，3 条起开始生效</small></h2>
<p class="desc">丢进来后 Hermes 空闲时自动拆解：<b>结构（开头钩子 / 铺垫 / 高潮 / 收尾CTA）+ 主题 + 话术</b>，形成你的爆款记忆。已学会的自动归档隐藏（知识保留），右上角 📦 可查看。</p>
<div class="drop" id="drop-hits">📥 点击选择 / 把爆款视频拖到这里<br><small>mp4 / mov / mkv / webm / flv / avi</small><div class="progress" id="pg-hits"><i></i></div><div class="upstat" id="st-hits" style="display:none;font-size:12px;color:#7cc4ff;margin-top:6px"></div></div>
<input type="file" id="file-hits" accept="video/*,.mkv,.flv" multiple>
<table><thead><tr><th style="width:30px"><input type="checkbox" onchange="selAll(this)"></th><th>素材 / 标题 / 记忆</th><th style="width:90px">时长</th><th style="width:90px">状态</th><th style="width:150px">文件夹（IP）</th><th style="width:230px">操作</th></tr></thead><tbody id="tb-hits"><tr><td colspan="6">加载中…</td></tr></tbody></table>
</div></div>

<div class="tabpage" id="page-live">
<div class="card"><h2>第 2 步 · 丢入整场直播（几小时也行）</h2>
<p class="desc">转写<b>双通道自动兜底</b>：① 你在 GLB 里转写过的直接复用（最准免费）；② 没转写过的 Hermes 用 GLB 自带语音模型本地转写，无需另装。之后按爆款逻辑做主题分段 → 自动粗剪。<br>提示：几小时大文件上传要几分钟，传完不用管，切好会出现在「成片」页。</p>
<div class="drop" id="drop-live">📥 点击选择 / 把整场直播拖到这里<div class="progress" id="pg-live"><i></i></div><div class="upstat" id="st-live" style="display:none;font-size:12px;color:#7cc4ff;margin-top:6px"></div></div>
<input type="file" id="file-live" accept="video/*,.mkv,.flv" multiple>
<table><thead><tr><th>文件</th><th>大小</th><th>状态</th><th>分段/成片</th><th>操作</th></tr></thead><tbody id="tb-live"><tr><td colspan="5">加载中…</td></tr></tbody></table>
</div></div>

<div class="tabpage" id="page-projects">
<div class="card"><h2>粗剪项目</h2>
<p class="desc">粗剪片段可直接点开看（悬停按 <code>R</code> 切换倍速）。✅确认就包装字幕+标题+同款封面合成片；✏️不满意就勾段+写意见打回，意见自动记入记忆，下次剪自动遵守，越剪越懂你。<br>打回作废的旧草稿占地方时，点 <button class="btn ghost small" onclick="cleanup()">🗑 清理冗余</button>（先预览、你确认才删，源视频和成片不动）。</p>
<table><thead><tr><th>ID</th><th>来源直播</th><th>状态</th><th>片段</th><th>操作</th></tr></thead><tbody id="tb-projects"><tr><td colspan="5">加载中…</td></tr></tbody></table>
</div></div>

<div class="tabpage" id="page-queries">
<div class="card"><h2>不懂就问（Hermes 的提问）</h2>
<p class="desc">主题拿不准、钩子二选一、标题三选一时，Hermes 会在这里问你。点一下选项即继续流水线。</p>
<div id="q-list">加载中…</div>
</div></div>

<div class="tabpage" id="page-outputs">
<div class="card"><h2>🧵 逐句成片 <small>教学句一句句挑出来，拼成一条完整视频</small></h2>
<p class="desc">自动清洗逐句稿（去重复词 / 留清晰讲解 / 保饱满情感），把值得留的教学句按原顺序一句句拼成<b>一条完整视频</b>。长视频清洗+拼接要几十分钟，完成后出现在这里。直播在「📡 整场直播」页点按钮；其它视频在下面粘贴完整路径。</p>
<div class="row" style="margin-bottom:12px">
<input id="sentence-path" class="ctl" placeholder="粘贴视频完整路径（例如 D:\\录播\\compressO-2026-06-17.mp4）" style="flex:1;min-width:280px">
<button class="btn small" onclick="sentenceCutByPath()">🧵 逐句成片</button>
<label style="font-size:12px;color:var(--txt);display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="interact-clean" checked style="accent-color:#ff9a3d">剪掉直播互动句（灯牌/关注/预约等）</label>
<label style="font-size:12px;color:var(--txt);display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="keep-extra" checked style="accent-color:#ff9a3d" onchange="setKeepExtra(this.checked)">连麦 / 音乐保留（唱歌、间奏、连麦对话也拼进粗剪）</label>
</div>
<div id="sentence-list">加载中…</div>
<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
<div style="font-size:12px;color:var(--txt);margin-bottom:6px">🧠 最近记忆挑句 <span style="color:#8f95a3">（AI 挑了哪些句子，在这里核对）</span></div>
<div id="pick-list" style="font-size:12px;color:#8f95a3">加载中…</div>
</div>
</div>
<div class="card"><h2>成片（字幕烧录 + 顶部标题 + 首帧封面）</h2>
<p class="desc">每个片段产出：<code>*_final.mp4</code>（烧好字幕和标题，直接发）＋ <code>.srt</code> ＋ <code>*_cover.jpg</code>。文件在 <code id="finished-path"></code>。当天成片显示在这里，往期的自动归档（右上角📦可看，文件一直都在）。</p>
<div id="out-list" class="grid2">加载中…</div>
</div></div>
</main>
<footer>Hermes 本地服务 · 数据不出本机 · 调度每 30s 扫一遍 upload/ · 记忆每小时同步给 GLB 桌面端（双向） · <a href="/pipeline/status" style="color:#8f95a3">状态 JSON</a></footer>
<script>try{localStorage.setItem('hermes_show_hist','1')}catch(e){}</script>
<script>
function tab(t){document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.t===t));document.querySelectorAll('.tabpage').forEach(p=>p.classList.toggle('active',p.id==='page-'+t));}
function fmtSize(b){if(!b&&b!==0)return '-';if(b>1e9)return (b/1e9).toFixed(2)+' GB';if(b>1e6)return (b/1e6).toFixed(1)+' MB';return Math.round(b/1e3)+' KB';}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function api(u,o,ms){ms=(ms===undefined?15000:ms);if(!ms){const r=await fetch(u,o);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);window._apiFail=0;hideBanner();return j;}const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(u,{...o,signal:c.signal});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);window._apiFail=0;hideBanner();return j;}catch(e){if(e.name==='AbortError')e=new Error('请求超时（15秒），服务可能正忙，稍后重试');window._apiFail=(window._apiFail||0)+1;if(window._apiFail>=3)showBanner('连不上 Hermes 服务（127.0.0.1:17841），请确认黑窗口里的 Hermes 在运行，或双击全家桶根目录一键启动.cmd 启动');throw e;}finally{clearTimeout(t)}}
function showBanner(t){let b=document.getElementById('api-banner');if(!b){b=document.createElement('div');b.id='api-banner';b.style.cssText='background:#3a1a1a;color:#fca5a5;padding:10px 20px;font-size:13px;text-align:center';document.querySelector('header').after(b);}b.textContent='⚠️ '+t;b.style.display='block';}
function hideBanner(){const b=document.getElementById('api-banner');if(b)b.style.display='none';}
function errRow(n,msg){return '<tr><td colspan="'+n+'" style="color:#f87171">❌ 加载失败：'+esc(msg||'网络错误')+'，<a href="javascript:loadAll()" style="color:#ff9a3d">点我重试</a></td></tr>';}
// ─── 页内提示 ───
// GLB 是用 sandbox iframe 内嵌本页的（sandbox 没有 allow-modals），alert/confirm 会被浏览器静默吞掉，
// 用户点了完全收不到反馈——所以这里改成页内 toast + 自绘确认框：alert 直接接管，confirm 用 askConfirm() 替代。
function toast(msg,kind){let w=document.getElementById('toasts');if(!w){w=document.createElement('div');w.id='toasts';document.body.appendChild(w);}const el=document.createElement('div');el.className='toast'+(kind==='err'?' err':kind==='ok'?' ok':'');el.textContent=String(msg==null?'':msg);el.onclick=()=>el.remove();w.appendChild(el);if(kind!=='err'){setTimeout(()=>{el.style.transition='opacity .3s';el.style.opacity='0';setTimeout(()=>el.remove(),300);},3500);}}
window.alert=function(m){toast(m,'info');};
function askConfirm(msg,okText){return new Promise(function(resolve){let m=document.getElementById('modal');if(!m){m=document.createElement('div');m.id='modal';m.innerHTML='<div class="box"><p id="modal-msg"></p><div class="row"><button class="btn ghost" id="modal-no">取消</button><button class="btn" id="modal-yes">确定</button></div></div>';document.body.appendChild(m);}document.getElementById('modal-msg').textContent=String(msg||'');const yes=document.getElementById('modal-yes');yes.textContent=okText||'确定';const inp=document.getElementById('modal-input');if(inp)inp.style.display='none';const done=v=>{m.classList.remove('on');resolve(v);};yes.onclick=()=>done(true);document.getElementById('modal-no').onclick=()=>done(false);m.onclick=e=>{if(e.target===m)done(false);};m.classList.add('on');});}
// 自绘输入框：内嵌 iframe 的 sandbox 同样没有 allow-modals，prompt() 也会被静默吞掉，
// 点"新建文件夹/归入…"会毫无反应——所以输入框也自己画（返回 null 表示取消）。
function askInput(msg,def,okText,placeholder){return new Promise(function(resolve){let m=document.getElementById('modal');if(!m){m=document.createElement('div');m.id='modal';m.innerHTML='<div class="box"><p id="modal-msg"></p><input id="modal-input"><div class="row"><button class="btn ghost" id="modal-no">取消</button><button class="btn" id="modal-yes">确定</button></div></div>';document.body.appendChild(m);}else if(!document.getElementById('modal-input')){document.querySelector('#modal .box p').insertAdjacentHTML('afterend','<input id="modal-input">');}
 document.getElementById('modal-msg').textContent=String(msg||'');
 const inp=document.getElementById('modal-input');inp.style.display='block';inp.value=def||'';inp.placeholder=placeholder||'';
 const yes=document.getElementById('modal-yes');yes.textContent=okText||'确定';
 const done=v=>{m.classList.remove('on');resolve(v);};
 yes.onclick=()=>done(inp.value);
 document.getElementById('modal-no').onclick=()=>done(null);
 m.onclick=e=>{if(e.target===m)done(null);};
 inp.onkeydown=e=>{if(e.key==='Enter')done(inp.value);if(e.key==='Escape')done(null);};
 m.classList.add('on');setTimeout(()=>{try{inp.focus();inp.select();}catch{}},30);});}
// 历史归档开关：默认只看"没干完的活"，干完的自动归档隐藏（只隐藏显示，数据库/记忆一个不少，
// 新直播剪片时照样调用老经验）。开关状态记在浏览器里，下次打开保持你的选择。
window._showHist=localStorage.getItem('hermes_show_hist')==='1';
function toggleHist(){window._showHist=!window._showHist;localStorage.setItem('hermes_show_hist',window._showHist?'1':'0');paintHistBtn();loadAll();}
function paintHistBtn(){const b=document.getElementById('btn-hist');if(b)b.textContent=window._showHist?'📦 历史：开':'📦 历史：关';}
function isToday(s){try{const d=new Date(String(s||'').replace(' ','T')+'Z');if(isNaN(d))return true;return d.toISOString().slice(0,10)===new Date().toISOString().slice(0,10);}catch{return true;}}
function histHint(n,txt,cols){return (!window._showHist&&n>0)?'<tr><td colspan="'+cols+'" style="color:#8f95a3;font-size:12px">📦 已归档隐藏 '+n+' 条'+txt+'（只隐藏不删除，管家照样记得，右上角📦可打开）</td></tr>':'';}
// 一键清空显示：记下此刻，此刻之前的东西全部从列表消失（显示层 only，
// 数据库/记忆/源文件/成片文件一个不动；新上传、新生成的照常出现；右上角📦可恢复查看）
window._clearedAt=parseInt(localStorage.getItem('hermes_cleared_at')||'0',10)||0;
function clearDisplay(){try{localStorage.setItem('hermes_cleared_at',String(Date.now()));}catch{}window._clearedAt=Date.now();alert('显示已清空（记忆、文件都在，右上角📦可恢复查看）');if(window._showHist){toggleHist();}else{loadAll();}}
function tsOf(s){const t=Date.parse(String(s||'').replace(' ','T')+'Z');return Number.isFinite(t)?t:0;}
function passClear(ts){return window._clearedAt===0||!ts||ts>=window._clearedAt;}
async function loadSys(){try{const s=await api('/api/system'); const po=document.getElementById('p-ollama');po.textContent='Ollama '+(s.ollama.ok?('✅ '+(s.ollama.models[0]||'')):'❌ 未运行');po.className='pill '+(s.ollama.ok?'ok':'bad');
 const pf=document.getElementById('p-ffmpeg');pf.textContent='ffmpeg '+(s.ffmpeg.available?'✅':'❌ 缺失');pf.className='pill '+(s.ffmpeg.available?'ok':'bad');
 const ps=document.getElementById('p-sherpa');ps.textContent='语音 '+(s.sherpa.available?('✅ '+(s.sherpa.senseVoice?'sense-voice':'paraformer')):'❌ 缺模型');ps.className='pill '+(s.sherpa.available?'ok':'warn');
 const pc=document.getElementById('p-sched');const rt=(s.scheduler.runningTasks||[]).length;pc.textContent='调度 '+(s.scheduler.isRunning?('✅ 运行中'+(rt?'（'+rt+' 任务）':'')):'⏸ 停');pc.className='pill '+(s.scheduler.isRunning?'ok':'warn');
 const pm=document.getElementById('p-mode');const mode=s.scheduler.gpu?.mode||'?';const util=s.scheduler.gpu?.util;
 pm.textContent='模式 '+(mode==='idle'?'🚀 空闲拉满x'+(s.scheduler.effLimit||''):(mode==='busy'?'🛟 忙时让路':'⚖️ 常规'))+(util!=null&&util>=0?'（GPU '+util+'%）':'');
 pm.className='pill '+(mode==='busy'?'warn':'ok');
 document.getElementById('finished-path').textContent=s.dirs.finished||'';
}catch(e){for(const id of ['p-ollama','p-ffmpeg','p-sherpa','p-sched','p-mode']){const el=document.getElementById(id);if(el&&el.textContent.endsWith('…')){el.textContent=el.textContent.replace('…','❌');el.className='pill bad';}}}}
async function loadUploads(){
  // 文件夹列表来自 /api/collections（uploads 接口里没有 folders），两个都要拉
  let cols=null;try{cols=await api('/api/collections');}catch{ /* 拉不到就沿用上次渲染，别把下拉清空 */ }
  try{const d=await api('/api/uploads');
  // 已学会（completed）的爆款就是"记忆"本身，默认显示最近 10 条，别藏起来让人找不到反馈按钮
  const allH=(d.hits||[]);
  const pendH=allH.filter(h=>(h.status||'pending')!=='completed'&&passClear(tsOf(h.createdAt)));
  const doneH=allH.filter(h=>(h.status||'pending')==='completed');
  const visH=window._showHist?allH:[...pendH,...doneH.slice(0,10)];
  const hidH=allH.length-visH.length;
  window._hits=window._hits||{};allH.forEach(h=>{if(h.id)window._hits[h.id]=h;});
  window._cols=window._cols||{};
  // 文件夹筛选：选定文件夹后只看这个文件夹的素材
  const cur=window._curCol||'';
  const shownH=cur?visH.filter(h=>(h.collection||'')===cur):visH;
  paintCollections(cols,cur);
  document.getElementById('tb-hits').innerHTML=(shownH.length?shownH.map(h=>'<tr'+(h.id?' data-hrow="'+h.id+'"':'')+'><td style="width:30px"><input type="checkbox" class="hitpick" value="'+esc(h.id||'')+'" onchange="selChange()" '+(h.id?'':'disabled')+' style="accent-color:#ff9a3d"></td><td><div class="fname">'+esc(h.name)+'</div>'+(h.title?'<div class="fmeta"><b>'+esc(h.title)+'</b></div>':'')+memSummary(h)+hitInfo(h)+'</td><td class="fmeta">'+fmtDur(h.durationMs)+'<br>'+fmtSize(h.size)+'</td><td><span class="st '+esc(h.status||'pending')+'">'+esc(h.status||'pending')+'</span></td><td>'+colCell(h)+'</td><td><div class="row" style="gap:5px"><button class="btn ghost small" data-act="analyzeHit" data-p="'+encodeURIComponent(h.path)+'">重新分析</button>'+(h.id&&h.status==='completed'?'<button class="btn ghost small" data-fb="'+h.id+'" onclick="feedbackHit('+h.id+')">数据反馈</button><button class="btn ghost small" data-pd="'+h.id+'" onclick="predictHit('+h.id+')">预测</button>':'')+(h.id?'<button class="btn ghost small danger" onclick="delOne('+h.id+')">清除</button>':'')+'</div></td></tr>').join(''):'<tr><td colspan="6" style="color:#8f95a3;padding:18px;text-align:center">'+(cur?'这个文件夹还是空的 👆':'还没有待办爆款，把你最火的几条拖进来吧 👆')+'</td></tr>')+histHint(hidH,'个已学会爆款',6);
  const visL=(d.live||[]).filter(h=>window._showHist||((h.status||'pending')!=='completed'&&passClear(tsOf(h.createdAt))));
  const hidL=(d.live||[]).length-visL.length;
  document.getElementById('tb-live').innerHTML=(visL.length?visL.map(h=>'<tr><td>'+esc(h.name)+'</td><td>'+fmtSize(h.size)+'</td><td><span class="st '+esc(h.status||'pending')+'">'+esc(h.status||'pending')+'</span>'+(h.transcriptSegments!=null?'<div style="font-size:11px;color:#8f95a3;margin-top:2px">转写'+h.transcriptSegments+'段</div>':'')+healthBadge(h.health)+'</td><td>'+(h.segments||0)+' 段 / '+esc(h.clips||0)+' 片</td><td><button class="btn ghost small" data-act="analyzeLive" data-p="'+encodeURIComponent(h.path)+'">重新分析</button>'+(h.id?' <button class="btn ghost small" onclick="makeClips('+h.id+')">✂️ 粗剪</button>':'')+' <button class="btn ghost small" data-act="sentenceCut" data-p="'+encodeURIComponent(h.path)+'">🧵 逐句成片</button></td></tr>').join(''):'<tr><td colspan="5" style="color:#8f95a3">还没有待办直播，拖进来自动开工 👆</td></tr>')+histHint(hidL,'场已剪完直播',5);
}catch(e){document.getElementById('tb-hits').innerHTML=errRow(6,e.message);document.getElementById('tb-live').innerHTML=errRow(5,e.message);}}
// ─── 爆款数据反馈/预测：截图上传→Hermes视觉读数(自动识别平台)→同平台校准重预测 ───
function fmtW(n){if(n==null||!isFinite(n))return '?';if(n>=1e8)return (n/1e8).toFixed(2)+'亿';if(n>=1e4)return (n/1e4).toFixed(1)+'万';if(n>=1e3)return (n/1e3).toFixed(1)+'k';return String(Math.round(n));}
function hitInfo(h){let s='';
 if(h.prediction){const p=h.prediction;s+='<div style="font-size:11px;color:#7cc4ff;margin-top:2px">🔮 预测'+(p.confidence?'（把握'+esc(p.confidence)+'）':'')+' 播'+fmtW(p.viewsLow)+'-'+fmtW(p.viewsHigh)+' · 赞'+fmtW(p.likes)+' · 评'+fmtW(p.comments)+' · 转'+fmtW(p.shares)+' · 藏'+fmtW(p.favorites)+(p.rationale?'（'+esc(p.rationale)+'）':'')+'</div>';}
 if(h.performance){const p=h.performance;s+='<div style="font-size:11px;color:#ffb020;margin-top:2px">📊 实际'+(p.platform?'['+esc(p.platform)+']':'')+' 播'+fmtW(p.views)+' · 赞'+fmtW(p.likes)+' · 评'+fmtW(p.comments)+' · 转'+fmtW(p.shares)+' · 藏'+fmtW(p.favorites)+'</div>';}
 return s;}
function fmtDur(ms){if(!ms)return '-';const s=Math.round(Number(ms)/1000);if(!isFinite(s)||s<=0)return '-';const m=Math.floor(s/60);return m?(m+'分'+(s%60)+'秒'):(s+'秒');}
// ─── 文件夹：像文件夹一样给素材分类命名；选中哪个文件夹，剪片就用哪套记忆 ───
function paintCollections(d,cur){
 const sel=document.getElementById('col-pick');if(!sel)return;
 // 接口偶尔失败（服务重启中）时保留上次的下拉内容，不要把用户建好的文件夹画没
 if(!d||!d.folders){return;}
 const folders=d.folders;
 const names=folders.map(f=>f.name);
 window._colNames=names;
 const keep=sel.value;
 let html='<option value="">📂 全部素材'+(d.all?'（'+d.all+'）':'')+'</option>';
 html+=folders.map(f=>'<option value="'+esc(f.name)+'">📁 '+esc(f.name)+'（'+f.count+(f.learned?' · 已学会'+f.learned:'')+'）</option>').join('');
 if(cur&&names.indexOf(cur)<0)html+='<option value="'+esc(cur)+'">📁 '+esc(cur)+'（空）</option>';
 sel.innerHTML=html;sel.value=names.indexOf(keep)>=0?keep:(cur||'');
 const act=document.getElementById('col-active');
 if(act)act.textContent=d.active?('当前剪片用的记忆库：'+d.active):'当前剪片用的记忆库：全部素材';
  // 2026-09-27：三个管理按钮改为常驻 + 未选中时置灰。
  // 以前是 display:none，不先选中文件夹根本看不见——老板反馈"没有管理文件夹"，
  // 其实功能一直都在，只是藏起来了。常驻能让人一眼知道有这些能力。
  const rn=document.getElementById('btn-rename'),dc=document.getElementById('btn-delcol'),ds2=document.getElementById('btn-dissolve');
  for(const b of [rn,dc,ds2]){if(b){b.style.display='inline-block';b.disabled=!cur;b.title=cur?'':'先选中一个文件夹';}}
}
async function renameCollection(){
 const old=window._curCol||'';
 if(!old){toast('先选中一个文件夹','err');return;}
 const name=await askInput('把文件夹【'+old+'】改名为：',old,'改名');
 if(name===null)return;
 if(!String(name).trim()||String(name).trim()===old)return;
 const n=String(name).trim().slice(0,40);
 api('/hits/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,byCollection:old})})
  .then(()=>{window._curCol=n;try{localStorage.setItem('hermes_cur_col',n);}catch{}toast('已改名为【'+n+'】','ok');loadAll();})
  .catch(e=>toast('改名失败：'+e.message,'err'));
}
async function deleteCollection(){
 const name=window._curCol||'';
 if(!name){toast('先选中一个文件夹','err');return;}
 const ok=await askConfirm('清空文件夹【'+name+'】？\\n\\n里面所有素材的记忆都会被清除（源视频保留）。\\n相当于把这个文件夹删掉。确定？','清空');
 if(!ok)return;
 try{
  const r=await api('/hits/delete-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})},0);
  toast('已清空文件夹【'+name+'】（'+r.deleted+' 条）','ok');
  window._curCol='';try{localStorage.setItem('hermes_cur_col','');}catch{}
  await api('/api/active-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:''})}).catch(()=>{});
  loadAll();
 }catch(e){toast('清空失败：'+e.message,'err');}
}
// 解散文件夹（2026-09-27）：素材全部移出回未分类，记忆和源视频都保留，只删文件夹本身。
// 和"清空此文件夹"（连记忆一起删）互补——不想动素材、只想去掉文件夹时用这个。
async function dissolveCollection(){
 const name=window._curCol||'';
 if(!name){toast('先选中一个文件夹','err');return;}
 const ok=await askConfirm('解散文件夹【'+name+'】？\\n\\n素材会全部移出（回到未分类），\\n源视频和记忆都保留，只删掉文件夹本身。确定？','解散');
 if(!ok)return;
 try{
  const r=await api('/hits/dissolve-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})},0);
  toast('已解散文件夹【'+name+'】（'+(r.moved||0)+' 条素材移出）','ok');
  window._curCol='';try{localStorage.setItem('hermes_cur_col','');}catch{}
  await api('/api/active-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:''})}).catch(()=>{});
  loadAll();
 }catch(e){toast('解散失败：'+e.message,'err');}
}
function pickCollection(name){
 window._curCol=name;
 try{localStorage.setItem('hermes_cur_col',name||'');}catch{}
 loadUploads();
 if(name){api('/api/active-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}).then(()=>{toast('已切换：剪片将用【'+name+'】的爆款记忆','ok');const a=document.getElementById('col-active');if(a)a.textContent='当前剪片用的记忆库：'+name;}).catch(e=>toast('切换失败：'+e.message,'err'));}
}
async function newCollection(){
 const name=await askInput('给这个文件夹起个名字（建议用 IP / 老师名）','','创建','例如：某老师 / 朱老师 / 轻语IP');
 if(name===null)return;
 if(!String(name).trim())return;
 const n=String(name).trim().slice(0,40);
 try{
  await api('/api/collections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})},0);
  window._curCol=n;try{localStorage.setItem('hermes_cur_col',n);}catch{}
  toast('文件夹【'+n+'】已创建并选中，把素材勾上点「归入文件夹」即可','ok');
  loadAll();
 }catch(e){toast('创建失败：'+e.message,'err');}
}
function colCell(h){
 const cur=h.collection||'';
 // 下拉里直接换文件夹；选「➕ 新建…」就地创建，不用再单独一个"归入"按钮
 let s='<select class="ctl" style="padding:5px 8px;font-size:11px;max-width:140px" onchange="setCol('+esc(h.id)+',this.value)">';
 s+='<option value=""'+(cur?'':' selected')+'>— 未归类 —</option>';
 for(const k of (window._colNames||[])){s+='<option value="'+esc(k)+'"'+(cur===k?' selected':'')+'>'+esc(k)+'</option>';}
 s+='<option value="__new__"'+(cur?'':'')+'>➕ 新文件夹…</option>';
 s+='</select>';
 return s;
}
async function setCol(id,name){
 if(name==='__new__'){
  name=await askInput('归入新文件夹（用 IP / 老师名命名）','','创建','例如：某老师');
  if(name===null){loadUploads();return;}
  if(!String(name).trim()){loadUploads();return;}
  name=String(name).trim().slice(0,40);
 }
 api('/hits/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name})})
  .then(()=>{toast(name?('已归入【'+name+'】'):'已移出文件夹','ok');loadUploads();})
  .catch(e=>toast('设置失败：'+e.message,'err'));
}
async function moveOne(id){
 const name=await askInput('归入文件夹（填新名字就是新建文件夹，留空=移出）','','归入','例如：某老师');
 if(name===null)return;
 api('/hits/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name})})
  .then((r)=>{toast('已归入【'+(name||'未归类')+'】','ok');markUndoable(r);loadUploads();})
  .catch(e=>toast('设置失败：'+e.message,'err'));
}
// 2026-09-27：分析体检徽章。分段 LLM 一旦失败会静默降级成 90 秒等分
// （主题全是"待分类"、钩子分写死 0.5），而状态栏照样显示 completed。
// 这里把真实健康度摆到明面上，鼠标悬停看明细。
function healthBadge(h){
 if(!h||typeof h!=='object')return '';
 const g=h.grade||(h.error?'error':'unknown');
 const parts=[];
 if(h.chunks)parts.push('分段成功 '+h.chunkOk+'/'+h.chunks+' 块');
 if(h.llmSegments)parts.push('LLM 切出 '+h.llmSegments+' 段');
 if(h.fallbackSegments)parts.push('兜底等分 '+h.fallbackSegments+' 段');
 if(h.llmMatched||h.keywordMatched)parts.push('记忆命中 '+h.llmMatched+' / 关键词兜底 '+h.keywordMatched);
 if(h.pendingTheme)parts.push('未分类 '+h.pendingTheme+' 段');
 if(h.chunkRepaired)parts.push('截断修复救回 '+h.chunkRepaired+' 次');
 if(h.error)parts.push('错误：'+String(h.error).slice(0,120));
 const detail=esc(parts.join('；')||'无明细');
 const st='display:inline-block;margin-top:4px;padding:2px 7px;border-radius:5px;font-size:11px;font-weight:600;cursor:help;';
 if(g==='ok')return '<div style="'+st+'background:#e6f6ec;color:#1d7a3f" title="'+detail+'">✓ 体检正常</div>';
 if(g==='warn')return '<div style="'+st+'background:#fdf4e3;color:#96650d" title="'+detail+'">⚠ 部分降级</div>';
 if(g==='error')return '<div style="'+st+'background:#fbe9e7;color:#b3261e" title="'+detail+'">✗ 分析失败</div>';
 return '<div style="'+st+'background:#fbe9e7;color:#b3261e" title="'+detail+'">✗ 结果不可信</div>';
}
// 2026-09-27：归类操作只有"能看见"才谈得上用。接口每次归类后会返回 undoable，
// 这里据此亮出撤销按钮；撤销完重新拉取，按钮自己收起。
function markUndoable(r){
 const b=document.getElementById('btn-undocol');
 if(!b)return;
 if(r&&r.undoable){b.style.display='inline-block';b.textContent='↩ 撤销上次归入（'+r.undoCount+' 条）';}
 else b.style.display='none';
}
async function undoCollection(){
 const btn=document.getElementById('btn-undocol');
 if(btn){btn.disabled=true;btn.textContent='撤销中…';}
 try{
  const r=await api('/hits/undo-collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})},0);
  if(r&&r.ok){toast('已撤销：'+r.restored+' 条素材退回原文件夹','ok');await loadAll();}
  else toast('没有可撤销的归类操作','err');
 }catch(e){toast('撤销失败：'+e.message,'err');}
 finally{if(btn){btn.disabled=false;btn.style.display='none';}}
}
function pickedIds(){return [...document.querySelectorAll('.hitpick:checked')].map(b=>parseInt(b.value,10)).filter(n=>Number.isFinite(n));}
function selChange(){const n=pickedIds().length;const box=document.getElementById('col-batch');if(box)box.style.display=n?'flex':'none';const t=document.getElementById('col-sel');if(t)t.textContent='已选 '+n+' 条';}
function selAll(el){document.querySelectorAll('.hitpick').forEach(b=>{if(!b.disabled)b.checked=el.checked;});selChange();}
function clearSel(){document.querySelectorAll('.hitpick').forEach(b=>b.checked=false);selChange();}
async function batchMove(){
 const ids=pickedIds();if(!ids.length){toast('先勾选素材','err');return;}
 const name=await askInput('把这 '+ids.length+' 条归入文件夹（填新名字就是新建文件夹，留空=移出）','','归入','例如：某老师');
 if(name===null)return;
 api('/hits/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,name})})
  .then((r)=>{toast('已归入【'+(name||'未归类')+'】 '+ids.length+' 条','ok');markUndoable(r);clearSel();loadUploads();})
  .catch(e=>toast('批量归类失败：'+e.message,'err'));
}
async function batchDelete(withFiles){
 const ids=pickedIds();if(!ids.length){toast('先勾选素材','err');return;}
 // 注意：整页是模板字符串，给浏览器 JS 的换行必须写成 \\n（写单反斜杠会被 Node 吃掉 → 整段 script 语法报错）
 const ok=await askConfirm(withFiles
  ? ('将清除 '+ids.length+' 条素材，并删除它们的源视频文件（upload/hits 里的 mp4）。\\n\\n记忆、拆解、预测全部删除，不可恢复。确定？')
  : ('将清除 '+ids.length+' 条素材的记忆（拆解/要点/预测/实际数据）。\\n\\n源视频文件保留不动。确定？'),'确定清除');
 if(!ok)return;
 try{const r=await api('/hits/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,deleteFiles:!!withFiles})},0);
  toast('已清除 '+r.deleted+' 条'+(r.files?('，并删除 '+r.files+' 个源视频'):'（源视频保留）'),'ok');clearSel();loadAll();}
 catch(e){toast('清除失败：'+e.message,'err');}
}
async function delOne(id){
 const h=(window._hits||{})[id];
 const ok=await askConfirm('清除这条素材的记忆？\\n'+(h?(h.name||''):('id '+id))+'\\n\\n只删记忆库里的记录（拆解/要点/预测），源视频保留。确定？','清除');
 if(!ok)return;
 try{await api('/hits/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id]})},0);toast('已清除','ok');loadAll();}
 catch(e){toast('清除失败：'+e.message,'err');}
}
async function purgeOrphans(){
 try{
  const r=await api('/pipeline/purge-orphans',{method:'POST'},0);
  toast(r.deleted?('已清理 '+r.deleted+' 条空壳记忆（源视频早就不在了）'):'很干净，没有空壳记忆','ok');
  loadAll();
 }catch(e){toast('清理失败：'+e.message,'err');}
}
function memSummary(h){const n=(h.viralPoints||[]).length,t=(h.onScreenTexts||[]).length,e=(h.emotionCurve||[]).length;
 let s='<div class="fmeta">';
 if(n||t||e)s+='要点 <b>'+n+'</b> · 画面字 <b>'+t+'</b> · 情绪 <b>'+e+'</b>'+(h.durationMs?' · '+esc(h.genre||''):'');
 else if(h.status==='completed')s+='老素材，重新分析后补齐记忆';
 else s+='分析完成后这里会出记忆摘要';
 s+='</div>';
 if(h.id&&h.status==='completed')s+='<button class="btn ghost small" style="margin-top:4px" onclick="memoryDetail('+h.id+')">📖 记忆详情</button>';
 return s;}
// 记忆详情：把这条爆款学到的东西摊开给人看（要点/开头文案/全文案/画面标题/封面/情绪表情）
function memoryDetail(id){
 const old=document.getElementById('memrow-'+id);
 if(old){old.remove();return;}
 document.querySelectorAll('[id^="memrow-"]').forEach(el=>el.remove());
 const h=(window._hits||{})[id];
 const anchor=document.querySelector('[data-hrow="'+id+'"]');
 if(!anchor)return;
 if(!h){alert('记忆数据还没加载完，刷新一下再点');return;}
 const vp=(h.viralPoints||[]).map(p=>'<div style="margin:2px 0">· '+esc(p.point||'')+(p.evidence?'<span style="color:#8f95a3;font-size:11px">　证据：'+esc(p.evidence)+'</span>':'')+'</div>').join('')||'<div style="color:#8f95a3">暂无（老素材重新分析后会生成）</div>';
 const ost=(h.onScreenTexts||[]).map(t=>'<div style="margin:2px 0">· ['+(t.time_seconds!=null?fmtDur(t.time_seconds*1000):'?')+'] '+esc(t.text||'')+(t.type?'<span style="color:#8f95a3;font-size:11px">（'+esc(t.type)+'）</span>':'')+'</div>').join('')||'<div style="color:#8f95a3">画面没识别到大字/花字</div>';
 const ec=(h.emotionCurve||[]).map(e=>'<div style="margin:2px 0">· '+fmtDur((e.start_seconds||0)*1000)+'—'+fmtDur((e.end_seconds||0)*1000)+' '+esc(e.emotion||'')+(e.facial_expression?' / '+esc(e.facial_expression):'')+(e.voice_tone?' / '+esc(e.voice_tone):'')+(e.intensity!=null?' <span style="color:#ff9a3d">'+Number(e.intensity).toFixed(1)+'</span>':'')+'</div>').join('')||'<div style="color:#8f95a3">暂无</div>';
 const cover=h.coverFrame?'<img src="/hits/'+id+'/cover" style="width:200px;border-radius:8px;margin-top:4px">':'<div style="color:#8f95a3">还没抽出封面帧（重新分析后会生成）</div>';
 anchor.insertAdjacentHTML('afterend','<tr id="memrow-'+id+'"><td colspan="6" style="background:#191c24;padding:12px;border-radius:8px">'
  +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:12px;line-height:1.75">'
  +'<div><div style="color:#ff9a3d;font-weight:600;margin-bottom:4px">📌 爆款要点</div>'+vp
  +'<div style="color:#ff9a3d;font-weight:600;margin:12px 0 4px">🎬 开头文案</div><div>'+(h.openingScript?esc(h.openingScript):'<span style="color:#8f95a3">暂无</span>')+'</div>'
  +(h.hasFullTranscript?'<div style="margin-top:6px"><button class="btn ghost small" onclick="showTranscript('+id+')">📄 看完整逐字稿</button><div id="trbox-'+id+'" style="margin-top:6px;color:#8f95a3;white-space:pre-wrap;max-height:240px;overflow:auto;display:none"></div></div>':'<div style="margin-top:6px;color:#8f95a3;font-size:11px">这条没存到逐字稿</div>')
  +'</div>'
  +'<div><div style="color:#ff9a3d;font-weight:600;margin-bottom:4px">🔤 画面标题 / 花字</div>'+ost
  +'<div style="color:#ff9a3d;font-weight:600;margin:12px 0 4px">🖼️ 用到的封面</div>'+cover+(h.coverText?'<div style="margin-top:4px">封面大字建议：<b>'+esc(h.coverText)+'</b></div>':'')
  +'<div style="color:#ff9a3d;font-weight:600;margin:12px 0 4px">😊 情绪与表情</div>'+ec+'</div>'
  +'</div><div style="margin-top:10px"><button class="btn ghost small" onclick="document.getElementById(\\'memrow-\\'+id+\\'\\').remove()">收起</button></div></td></tr>');
}
async function showTranscript(id){
 const box=document.getElementById('trbox-'+id);if(!box)return;
 if(box.style.display!=='none'){box.style.display='none';return;}
 box.textContent='加载中…';box.style.display='block';
 try{const d=await api('/hits/'+id+'/transcript');box.textContent=d.transcript||'（这条没存到逐字稿）';}
 catch(e){box.textContent='加载失败：'+e.message;}
}
function feedbackHit(id){
 // 已开面板就关掉（再点一次收起）
 const old=document.getElementById('fbrow-'+id);
 if(old){old.remove();return;}
 document.querySelectorAll('[id^="fbrow-"]').forEach(el=>el.remove());
 const anchor=document.querySelector('[data-hrow="'+id+'"]');
 if(!anchor)return;
 anchor.insertAdjacentHTML('afterend','<tr id="fbrow-'+id+'"><td colspan="6" style="background:#191c24;padding:10px;border-radius:8px">'
  +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px">'
  +'<button class="btn ghost small" id="fbpick-'+id+'" onclick="fbPick('+id+')">选数据截图</button>'
  +'<span id="fbfile-'+id+'" style="color:#8f95a3">未选（可选，自动识别平台+读数）</span>'
  +'<input id="fbnum-'+id+'" class="ctl" placeholder="手动填：播放,点赞,评论,转发,收藏（逗号分隔，可留空）" style="flex:1;min-width:260px">'
  +'<button class="btn small" id="fbsend-'+id+'" onclick="fbSend('+id+')">上传反馈</button>'
  // 注意：整页是模板字符串，给浏览器 JS 的单引号必须写成「双反斜杠+引号」（写成单反斜杠会被 Node 吃掉 → 整段 script 语法报错）
  +'<button class="btn ghost small" onclick="document.getElementById(\\'fbrow-\\'+id+\\'\\').remove()">取消</button>'
  +'</div><div id="fbmsg-'+id+'" style="margin-top:6px;font-size:12px;color:#7cc4ff;white-space:pre-line"></div></td></tr>');
 window._fbShot=window._fbShot||{};window._fbShot[id]=null;
}
function fbPick(id){
 const inp=document.createElement('input');inp.type='file';inp.accept='image/*';
 inp.onchange=()=>{const f=inp.files&&inp.files[0];if(!f)return;
  const lb=document.getElementById('fbfile-'+id);if(lb)lb.textContent='已选：'+f.name;
  const rd=new FileReader();rd.onload=()=>{window._fbShot=window._fbShot||{};window._fbShot[id]=rd.result;if(lb)lb.textContent='✅ 已选：'+f.name+'（'+fmtSize(f.size)+'）';};
  rd.onerror=()=>{if(lb)lb.textContent='读取失败，换一张试试';};rd.readAsDataURL(f);};
 inp.click();}
function fbSend(id){
 const msg=document.getElementById('fbmsg-'+id),btn=document.getElementById('fbsend-'+id);
 const numStr=(document.getElementById('fbnum-'+id)||{}).value||'';
 const shot=(window._fbShot||{})[id]||null;
 const parts=String(numStr).split(/[,，]/).map(x=>x.trim());
 const hasManual=parts.some(x=>x!=='');
 if(!shot&&!hasManual){if(msg)msg.style.color='#ffb020',msg.textContent='选一张数据截图，或手填数字，至少给一样';return;}
 const numOrNull=x=>(x===''||x===undefined?null:Math.max(0,Math.round(Number(x)||0)));
 if(btn){btn.disabled=true;btn.textContent='识别中…';}
 if(msg){msg.style.color='#7cc4ff';msg.textContent=shot?'截图已上传，视觉模型识别中（首次约 20~60 秒）…':'上传中…';}
 api('/hits/'+id+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({views:numOrNull(parts[0]),likes:numOrNull(parts[1]),comments:numOrNull(parts[2]),shares:numOrNull(parts[3]),favorites:numOrNull(parts[4]),screenshot:shot})},0)
  // 同上：模板字符串里的换行必须写成「双反斜杠 n」（写成单反斜杠 n 会在浏览器端断成真实换行 → 语法报错）
  .then(r=>{let m='✅ 反馈已入库';if(r.platform)m+='\\n识别平台：'+r.platform;if(r.ocr&&r.ocr.views!=null)m+='\\n截图读数：播'+fmtW(r.ocr.views)+' 赞'+fmtW(r.ocr.likes)+' 评'+fmtW(r.ocr.comments)+' 转'+fmtW(r.ocr.shares)+' 藏'+fmtW(r.ocr.favorites);if(r.prediction)m+='\\n已按真实数据重新预测：播'+fmtW(r.prediction.views_low??r.prediction.viewsLow)+'-'+fmtW(r.prediction.views_high??r.prediction.viewsHigh)+(r.prediction.favorites!=null?' · 藏'+fmtW(r.prediction.favorites):'')+(r.prediction.confidence?'（把握：'+r.prediction.confidence+'）':'');loadUploads();})
  .catch(e=>{if(msg){msg.style.color='#f87171';msg.textContent='反馈失败：'+(e.message||e);}if(btn){btn.disabled=false;btn.textContent='上传反馈';}});
}
async function predictHit(id){const btn=document.querySelector('[data-pd="'+id+'"]');if(btn){btn.disabled=true;btn.textContent='预测中…';}
 try{await api('/hits/'+id+'/predict',{method:'POST'},0);loadUploads();}
 catch(e){alert('预测失败：'+(e.message||e));if(btn){btn.disabled=false;btn.textContent='🔮 重新预测';}}}
async function loadProjects(){try{const d=await api('/api/projects');
  const allP=d.projects||[];
  const visP=allP.filter(p=>window._showHist||(!['finished','superseded'].includes(p.status)&&passClear(tsOf(p.created_at))));
  const hidP=allP.length-visP.length;
  document.getElementById('tb-projects').innerHTML=(visP.length?visP.map(p=>{
  const prev=(p.clips&&p.clips.length)?'<div style="margin-top:6px"><video controls preload="metadata" style="max-width:280px" src="'+p.clips[0].url+'"></video><div style="font-size:11px;color:#8f95a3">'+p.clips.length+' 个可看版本（鼠标悬停+R 键倍速'+(p.clips.length>1?' · <a href="javascript:faststart('+p.id+')" style="color:#7cc4ff">⚡旧片点播慢点我修复</a>':'')+'）</div></div>':'<div style="font-size:11px;color:#8f95a3">暂无可看文件</div>';
  let act='';
  if(p.status==='reviewing'||p.status==='clipping'||p.status==='pending_review'){
   act='<button class="btn small" onclick="reviewApprove('+p.id+')">✅ 确认粗剪</button> <button class="btn ghost small" onclick="toggleRecut('+p.id+')">✏️ 提意见打回</button> <button class="btn ghost small" onclick="viewFeedback('+p.id+')">📝 记录</button>'
    +'<div id="recut-'+p.id+'" style="display:none;margin-top:8px;background:#191c24;padding:10px;border-radius:8px">'
    +'<div style="font-size:12px;color:#8f95a3;margin-bottom:6px">点中不想要的段（可多选），再写一句意见，打回后自动按意见重剪并记入记忆：</div>'
    +'<div>'+(p.selected_segments||[]).map((s,i)=>'<label style="display:inline-block;font-size:12px;margin:2px 6px 2px 0"><input type="checkbox" class="recut-seg-'+p.id+'" value="'+esc(s.segmentId)+'"> '+esc(s.themeName||('段'+(i+1)))+'</label>').join('')+'</div>'
    +'<div style="margin:6px 0">'+window.CHIPS.map((c,i)=>'<button class="btn ghost small" style="margin:2px" data-act="chip" data-id="'+p.id+'" data-i="'+i+'">'+c+'</button>').join('')+'</div>'
    +'<textarea id="recut-text-'+p.id+'" rows="2" style="width:100%;background:#191c24;color:#f3f4f8;border:1px solid #262a35;border-radius:6px;padding:6px" placeholder="例：第二段太水不要，整体再紧凑点"></textarea>'
    +'<div style="margin-top:6px"><button class="btn small" onclick="reviewRecut('+p.id+')">↩️ 打回重剪</button></div></div>'
    +'<div id="fb-'+p.id+'" style="display:none;margin-top:6px;font-size:12px"></div>';
  }else if(p.status==='approved'){act='<span style="color:#7cc4ff;font-size:12px">粗剪已确认（未生成成片）</span> <button class="btn small" onclick="gen('+p.id+')">🎬 生成成片</button> <button class="btn ghost small" onclick="toggleRecut('+p.id+')">✏️ 提意见打回</button> <button class="btn ghost small" onclick="viewFeedback('+p.id+')">📝 记录</button>'
    +'<div id="recut-'+p.id+'" style="display:none;margin-top:8px;background:#191c24;padding:10px;border-radius:8px">'
    +'<div style="font-size:12px;color:#8f95a3;margin-bottom:6px">点中不想要的段（可多选），再写一句意见，打回后自动按意见重剪并记入记忆：</div>'
    +'<div>'+(p.selected_segments||[]).map((s,i)=>'<label style="display:inline-block;font-size:12px;margin:2px 6px 2px 0"><input type="checkbox" class="recut-seg-'+p.id+'" value="'+esc(s.segmentId)+'"> '+esc(s.themeName||('段'+(i+1)))+'</label>').join('')+'</div>'
    +'<div style="margin:6px 0">'+window.CHIPS.map((c,i)=>'<button class="btn ghost small" style="margin:2px" data-act="chip" data-id="'+p.id+'" data-i="'+i+'">'+c+'</button>').join('')+'</div>'
    +'<textarea id="recut-text-'+p.id+'" rows="2" style="width:100%;background:#191c24;color:#f3f4f8;border:1px solid #262a35;border-radius:6px;padding:6px" placeholder="例：第二段太水不要，整体再紧凑点"></textarea>'
    +'<div style="margin-top:6px"><button class="btn small" onclick="reviewRecut('+p.id+')">↩️ 打回重剪</button></div></div>'
    +'<div id="fb-'+p.id+'" style="display:none;margin-top:6px;font-size:12px"></div>';
  }else if(p.status==='superseded'){act='<span style="color:#8f95a3;font-size:12px">已打回，有新版在上</span> ';}
  if(p.status==='pending_review')act+='<div style="color:#ffb020;font-size:12px;margin-top:4px">等你去 ❓ 页确认</div>';
  return '<tr><td>#'+p.id+'</td><td>'+esc(p.live_name||p.live_path||'-')+prev+'</td><td><span class="st '+esc(p.status)+'">'+esc(p.status)+'</span></td><td>'+(p.selected_segments?.length||0)+' 段</td><td>'+act+'</td></tr>'}).join(''):'<tr><td colspan="5" style="color:#8f95a3">暂无进行中的项目，分析完直播后自动创建 👆</td></tr>')+histHint(hidP,'个完结项目',5);
}catch(e){document.getElementById('tb-projects').innerHTML=errRow(5,e.message);}}
function toggleRecut(id){const el=document.getElementById('recut-'+id);el.style.display=el.style.display==='none'?'block':'none';}
window.CHIPS=['钩子不够炸','太长了，剪短','太短了，讲不透','换个主题','节奏太平','不要这几段'];
function addChip(id,i){const ta=document.getElementById('recut-text-'+id);const t=window.CHIPS[i]||'';ta.value=(ta.value?ta.value+'；':'')+t;}
// 事件委托：所有带 data-act 的按钮统一走这里（避免把中文路径拼进 onclick 引号地狱）
document.addEventListener('click',e=>{
 const b=e.target.closest?e.target.closest('[data-act]'):null;if(!b)return;
 const act=b.dataset.act;
 try{
  if(act==='analyzeHit')analyzeHit(decodeURIComponent(b.dataset.p||''));
  else if(act==='analyzeLive')analyzeLive(decodeURIComponent(b.dataset.p||''));
  else if(act==='sentenceCut')sentenceCut(decodeURIComponent(b.dataset.p||''));
  else if(act==='answer')answer(parseInt(b.dataset.id),decodeURIComponent(b.dataset.a||''));
  else if(act==='chip')addChip(parseInt(b.dataset.id),parseInt(b.dataset.i));
 }catch(err){alert(err.message);}
});
async function reviewApprove(id){if(!await askConfirm('确认这版粗剪OK？只锁定粗剪，不会自动生成成片（成片要点“生成成片”）。'))return;try{await api('/projects/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'approve'})},0);alert('粗剪已确认，要出成片请点 🎬 生成成片');loadAll();}catch(e){alert(e.message)}}
async function reviewRecut(id){const boxes=[...document.querySelectorAll('.recut-seg-'+id+':checked')].map(b=>parseInt(b.value));const comment=document.getElementById('recut-text-'+id).value.trim();if(!comment){alert('写一句意见再打回（点快捷标签也行）');return;}try{const r=await api('/projects/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'recut',comment,segmentIds:boxes})},0);alert(r.pendingQueries?.length?'已按意见重建项目，去 ❓ 页回一句继续':'已按意见重剪，意见已记入记忆');loadAll();}catch(e){alert(e.message)}}
async function viewFeedback(id){const box=document.getElementById('fb-'+id);if(box.style.display!=='none'){box.style.display='none';return;}try{const d=await api('/projects/'+id+'/feedback');box.innerHTML=(d.feedback.length?d.feedback.map(f=>'<div>【'+esc(f.decision)+'】'+esc(f.comment)+'</div>').join(''):'<div style="color:#8f95a3">暂无评审记录</div>')+(d.lessons.length?'<div style="margin-top:6px;color:#7cc4ff">已学会的经验：'+d.lessons.slice(-5).map(l=>esc(l.text)).join('；')+'</div>':'');box.style.display='block';}catch(e){alert(e.message)}}
async function loadQueries(){try{const d=await api('/queries');const q=d.queries||[];
 const badge=document.getElementById('q-badge');badge.style.display=q.length?'inline-block':'none';badge.textContent=q.length;
 document.getElementById('q-list').innerHTML=q.length?q.map(x=>{let opts=[];try{opts=JSON.parse(x.options||'[]')}catch{}return '<div class=q><div>📌 #'+x.id+' · '+esc(x.question)+'</div>'+(x.context?'<div style="color:#8f95a3;font-size:12px;margin-top:4px">'+esc(String(x.context).slice(0,200))+'</div>':'')+'<div class=opts>'+opts.map(o=>'<button class="btn small" data-act="answer" data-id="'+x.id+'" data-a="'+encodeURIComponent(o)+'">'+esc(o)+'</button>').join('')+'</div></div>'}).join(''):'<p style="color:#8f95a3">🎉 没有待确认，流水线一路绿灯。有拿不准的 Hermes 会在这里 @你，并“叮”一声。</p>';
 if(q.length&&!window._hadQ){try{new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=').play().catch(()=>{});}catch{}}
 window._hadQ=q.length>0;
}catch(e){document.getElementById('q-list').innerHTML='<p style="color:#f87171">❌ 加载失败：'+esc(e.message)+'，<a href="javascript:loadAll()" style="color:#7cc4ff">点我重试</a></p>';}}
async function loadOutputs(){try{loadSentenceCuts();loadMemoryPicks();loadKeepExtra();const d=await api('/api/outputs');const outs=d.outputs||[];
  let vids=outs.filter(o=>o.output_type==='video');const subs={};outs.filter(o=>o.output_type==='subtitle').forEach(o=>subs[o.clip_project_id]=subs[o.clip_project_id]||[]);let covs=outs.filter(o=>o.output_type==='cover');
  // 默认成片只看今天的：往期的自动归档（文件、记忆都不删，右上角📦可看）
  let hidOut=0;
  if(!window._showHist){const v0=vids.length,c0=covs.length;vids=vids.filter(o=>isToday(o.created_at)&&passClear(tsOf(o.created_at)));covs=covs.filter(o=>isToday(o.created_at)&&passClear(tsOf(o.created_at)));hidOut=(v0-vids.length)+(c0-covs.length);}
 const fileUrl=fp=>{const rel=String(fp||'').replace(/\\\\/g,'/');const m=rel.match(/\\/finished\\/(.+)$/);return m?'/files/finished/'+m[1].split('/').map(encodeURIComponent).join('/'):'#';};
  let html=(hidOut>0)?'<div class=card><div style="color:#8f95a3;font-size:12px">📦 已归档隐藏 '+hidOut+' 个往期文件（只隐藏不删除，右上角📦可查看，源文件一直在 output/finished 文件夹里）</div></div>':'';
 if(covs.length)html+='<div class=card><div style="color:#7cc4ff;font-size:13px;margin-bottom:6px">🖼️ 历史同款封面（点击看大图）</div><div class=row>'+covs.map(c=>'<div style="text-align:center"><a href="'+fileUrl(c.file_path)+'" target="_blank"><img src="'+fileUrl(c.file_path)+'" style="width:120px;border-radius:8px" loading="lazy"></a><div style="font-size:11px;color:#8f95a3;max-width:130px">'+esc(c.metadata?.title||'')+(c.metadata?.retroFrom?'<br>同款：'+esc(c.metadata.retroFrom):'')+'</div></div>').join('')+'</div></div>';
 html+=vids.length?vids.map(v=>{const url=fileUrl(v.file_path);
  return '<div class=card><div style="color:#7cc4ff;font-size:13px;margin-bottom:6px">'+esc(v.project_name||('项目#'+v.clip_project_id))+'</div><video controls preload="metadata" src="'+url+'"></video><div style="margin-top:8px;font-size:12px;color:#8f95a3;word-break:break-all">'+esc(v.file_path)+'</div><div class=row style="margin-top:8px"><a class=btn small style="text-decoration:none" href="'+url+'" download>⬇️ 下载成片</a></div></div>'}).join(''):(covs.length?'':'<p style="color:#8f95a3">成片还在路上…先去上传爆款和直播，调度器会自动推进。</p>');
 document.getElementById('out-list').innerHTML=html;
}catch(e){document.getElementById('out-list').innerHTML='<p style="color:#f87171">❌ 加载失败：'+esc(e.message)+'，<a href="javascript:loadAll()" style="color:#7cc4ff">点我重试</a></p>';}}
function loadAll(){paintHistBtn();loadSys();loadLlmStatus();loadUploads();loadProjects();loadQueries();loadOutputs();}
async function loadLlmStatus(){try{const d=await api('/api/llm-status');const el=document.getElementById('llm-status');if(!el)return;
 const tag=(d.cloud?'☁️ ':'🏠 ')+'AI 大脑：'+(d.providerName||d.provider)+(d.model?('（'+d.model+'）'):'')+(d.cloud?' —— 重决策已上云端大模型':' —— 本地模型');
 el.textContent=tag;el.className='pill '+(d.cloud?'ok':'');}catch(e){const el=document.getElementById('llm-status');if(el)el.textContent='AI 大脑：状态获取失败';}}
async function scan(){try{await api('/pipeline/scan',{method:'POST'},0);loadAll();}catch(e){alert('扫描失败：'+e.message)}}
async function cleanup(){try{
  const prev=await api('/pipeline/cleanup?dry=1',{method:'POST'},0);
  const items=prev.deleted||[];
  if(!items.length){alert('很干净，没有可清理的冗余（废弃草稿/临时文件都没有）');return;}
  const mb=(prev.freedBytes/1048576).toFixed(1);
  const list=items.slice(0,15).map(d=>'· '+d.path+'（'+d.mb+' MB）').join('\\n')+(items.length>15?'\\n…等共 '+items.length+' 项':'');
  if(!await askConfirm('将清理以下冗余，共约 '+mb+' MB：\\n'+list+'\\n\\n只删废弃草稿和临时文件，源视频、成片、记忆库都不动。确定清理？','确定清理'))return;
  const r=await api('/pipeline/cleanup',{method:'POST'},0);
  alert('已清理 '+r.count+' 项，释放约 '+(r.freedBytes/1048576).toFixed(1)+' MB');loadAll();
}catch(e){alert('清理失败：'+e.message)}}
async function analyzeHit(p){try{await api('/pipeline/analyze-hit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoPath:p})},0);alert('已触发分析，看状态变化');loadAll();}catch(e){alert(e.message)}}
async function analyzeLive(p){try{await api('/pipeline/analyze-live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoPath:p})},0);alert('已触发分析（大文件转写+分段要几分钟）');loadAll();}catch(e){alert(e.message)}}
// ─── 逐句成片：按记忆的清洗逻辑，把值得留的教学句一句句挑出来拼成一条完整视频 ───
async function sentenceCut(p){
 if(!p){toast('缺少视频路径','err');return;}
 const mins=await askInput('逐句成片：最多拼多少分钟？（留空=全部教学句拼完）','','开始','例如：5（成片约 5 分钟）');
 if(mins===null)return;
 const targetMinutes=Math.max(0,Math.round(Number(mins)||0));
 const ic=document.getElementById('interact-clean');
 const interactionClean=ic?ic.checked:true;
 try{
  const r=await api('/pipeline/sentence-cut',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoPath:p,targetMinutes,interactionClean})},0);
  if(r.busy){toast('这条已经在逐句成片中了，等它跑完','err');return;}
  toast('已开始逐句成片：清洗逐句稿（去重复/留清晰/保情感）→ 教学句一句句拼成一条完整视频。\\n长视频要几十分钟，完成后出现在「✅ 成片」页顶部并弹提醒，不用等着。','ok');
  tab('outputs');
 }catch(e){toast('启动失败：'+(e.message||e),'err');}
}
async function setKeepExtra(v){
 try{await api('/api/keep-extra',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keepExtra:v})},0);
  toast(v?'连麦/音乐保留：开启（唱歌、间奏、连麦对话拼进粗剪）':'连麦/音乐保留：关闭（这些不进粗剪）','ok');}
 catch(e){toast('设置失败：'+e.message,'err');const ic=document.getElementById('keep-extra');if(ic)ic.checked=!v;}
}
async function loadKeepExtra(){
 try{const r=await api('/api/keep-extra');const ic=document.getElementById('keep-extra');if(ic)ic.checked=r.keepExtra!==false;}catch{}
}
async function sentenceCutByPath(){
 const box=document.getElementById('sentence-path');
 const p=(box?box.value:'').trim().replace(/^\"|\"$/g,'');
 if(!p){toast('先粘贴视频完整路径','err');return;}
 try{if(!await api('/health',{},8))throw new Error('服务不可达');}catch{}
 await sentenceCut(p);
}
async function loadMemoryPicks(){
 try{
  const d=await api('/api/memory-picks');
  const picks=(d.picks||[]).filter(p=>p.items&&p.items.length);
  const box=document.getElementById('pick-list');if(!box)return;
  if(!picks.length){box.innerHTML='还没有记录。对直播点一次「按记忆里找爆点」后，这里会列出 AI 挑的每一句。';return;}
  box.innerHTML=picks.map(p=>{
   const when=(p.created_at||'').slice(5,16);
   const items=p.items.map((m,i)=>{
    const sents=(m.pieces||[]).map(pc=>'『'+(pc.text||'').slice(0,30)+'』').join(' + ');
    return '<div style="margin:4px 0;padding:6px 8px;background:var(--card2);border-radius:6px"><b style="color:#ff9a3d">'+(i+1)+'.</b> '+esc(m.title||'')+' <span style="color:#8f95a3">('+esc(m.reason||'').slice(0,40)+')</span><div style="color:#8f95a3;margin-top:2px">'+esc(sents)+'</div></div>';
   }).join('');
   return '<div style="margin-bottom:10px"><div style="color:#7cc4ff">'+esc(p.video_name||'')+' · '+esc(p.duration_mode||'')+' · '+p.seg_count+' 条 / '+p.sentence_count+' 句 · '+when+'</div>'+items+'</div>';
  }).join('');
 }catch(e){const box=document.getElementById('pick-list');if(box)box.innerHTML='加载失败：'+esc(e.message||e);}
}
async function loadSentenceCuts(){
 try{
  const d=await api('/api/sentence-cuts');
  const failed=(d.cuts||[]).filter(c=>c.status==='failed');
  const cuts=(d.cuts||[]).filter(c=>c.exists&&c.status!=='failed');
  // 完成提醒：发现新成片（比上次见过的多）弹 toast，不用守着页面刷
  try{
   const ids=cuts.map(c=>c.id);
   if(window._seenCuts&&cuts.length>window._seenCuts.length){
    const fresh=cuts.filter(c=>!window._seenCuts.includes(c.id));
    for(const c of fresh.slice(0,2))toast('🧵 逐句成片完成：【'+(c.video_name||'')+'】拼了 '+(c.segments||[]).length+' 段 · 成片 '+Math.round((c.total_secs||0)/60)+' 分钟，在下方可预览/下载','ok');
   }
   window._seenCuts=ids;
  }catch{}
  const box=document.getElementById('sentence-list');if(!box)return;
  if(!cuts.length){box.innerHTML=(failed.length?failed.map(f=>'<p style="color:#f87171;font-size:12px">❌ '+esc(f.video_name||'')+' 逐句成片失败：'+esc(f.note||'未知原因')+'（源文件不受影响，可重试）</p>').join(''):'')+'<p style="color:#8f95a3;font-size:12px">还没有逐句成片。到「📡 整场直播」页点「🧵 逐句成片」：把值得留的教学句一句句挑出来（去重复、留清晰、保情感），拼成一条完整视频。</p>';return;}
  const failHtml=failed.length?failed.map(f=>'<p style="color:#f87171;font-size:12px">❌ '+esc(f.video_name||'')+' 逐句成片失败：'+esc(f.note||'未知原因')+'（源文件不受影响，可重试）</p>').join(''):'';
  box.innerHTML=failHtml+cuts.map(c=>{
   const url='/files/sentence/'+encodeURIComponent((c.output_path||'').split(/[\\\\/]/).pop());
   const segs=(c.segments||[]).length;
   return '<div class="card" style="margin-bottom:10px"><div style="color:#ff9a3d;font-size:12px;margin-bottom:6px">🧵 '+esc(c.video_name||'')+' · 拼了 '+segs+' 段 · 成片 '+Math.round((c.total_secs||0)/60)+' 分钟（精选 '+Math.round((c.kept_secs||0)/60)+' 分钟）</div>'
    +'<video controls preload="metadata" style="max-width:340px" src="'+url+'"></video>'
    +'<div style="margin-top:6px"><a class="btn ghost small" style="text-decoration:none" href="'+url+'" download>⬇️ 下载</a></div></div>';
  }).join('');
 }catch(e){const box=document.getElementById('sentence-list');if(box)box.innerHTML='<p style="color:#f87171;font-size:12px">加载失败：'+esc(e.message||e)+'</p>';}
}
async function makeClips(id){try{const r=await api('/pipeline/clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({liveVideoId:id})},0);alert(r.clipped?'已粗剪，正在生成成片':'已建项目，等你去 ❓ 页确认');tab(r.clipped?'outputs':'queries');loadAll();}catch(e){alert(e.message)}}
async function gen(id){try{await api('/pipeline/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:id})},0);alert('成片生成中，稍后刷新 ✅ 页');loadAll();}catch(e){alert(e.message)}}
async function faststart(id){try{const r=await api('/projects/'+id+'/faststart',{method:'POST'},0);alert('已修复 '+r.fixed+'/'+r.total+' 个，可直接点播');loadAll();}catch(e){alert(e.message)}}
async function answer(id,a){try{await api('/queries/'+id+'/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answer:a})});loadQueries();loadProjects();}catch(e){alert(e.message)}}
function bindDrop(dropId,inputId,kind){
 const drop=document.getElementById(dropId),input=document.getElementById(inputId);
 drop.onclick=()=>input.click();
 ['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));
 ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));
 drop.addEventListener('drop',e=>{if(e.dataTransfer.files.length)uploadFiles(kind,e.dataTransfer.files)});
 input.addEventListener('change',()=>{if(input.files.length)uploadFiles(kind,input.files);input.value=''});
}
function fmtMB(b){return (b/1048576).toFixed(1)+' MB';}
function uploadOne(kind,f,onTick){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/upload/'+kind);
    xhr.setRequestHeader('X-Filename',encodeURIComponent(f.name));
    xhr.timeout=30*60*1000;
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onTick(e.loaded,e.total);};
    xhr.onload=()=>{let j={};try{j=JSON.parse(xhr.responseText||'{}');}catch{return reject(new Error('服务器返回异常（HTTP '+xhr.status+'），请刷新看板重试'));}
      if(xhr.status>=200&&xhr.status<300)resolve(j);else reject(new Error(j.error||('服务器拒绝（HTTP '+xhr.status+'）')));};
    // 连不上服务（黑窗口被关/服务正在重启是最大元凶）：给小白能看懂的提示
    xhr.onerror=()=>reject(new Error('连不上 Hermes 服务：黑窗口可能被关了或正在重启。先确认 Hermes 黑窗口在运行，再点右上↻刷新后重试'));
    xhr.onabort=()=>reject(new Error('上传被中断'));
    xhr.send(f);
  });
}
async function uploadFiles(kind,files){
  const bar=document.getElementById(kind==='live'?'pg-live':'pg-hits');bar.style.display='block';const fill=bar.querySelector('i');
  const stat=document.getElementById(kind==='live'?'st-live':'st-hits');
  const showStat=t=>{stat.style.display='block';stat.textContent=t;};
  const hideStat=()=>{setTimeout(()=>{bar.style.display='none';stat.style.display='none';},1200);};
  let i=0;const uploaded=[];
  for(const f of files){i++;
   const base='('+i+'/'+files.length+') '+f.name+' ';
   try{const r=await uploadOne(kind,f,(loaded,total)=>{const p=Math.round(loaded/total*100);fill.style.width=p+'%';showStat(base+p+'% · '+fmtMB(loaded)+'/'+fmtMB(total));});
    if(r&&r.path)uploaded.push(r.path);}
   catch(e){toast('上传失败 '+f.name+'：'+e.message,'err');showStat('❌ '+f.name+' 上传失败');bar.style.display='none';return;}}
  fill.style.width='100%';showStat('上传完成 ✅');hideStat();
  toast('上传成功 '+files.length+' 个，调度器 30s 内自动开工（也可点右上 🔄 立即扫一遍）','ok');
  // 当前选中了文件夹时，新上传的自动进这个文件夹（省得每次上传完再手动归一次）
  const curCol=window._curCol||'';
  if(curCol&&uploaded.length&&kind==='hits'){
   try{
    const r=await api('/hits/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:uploaded,name:curCol})},0);
    if(r&&r.updated)toast('已自动归入文件夹【'+curCol+'】','ok');
   }catch{ /* 归类失败不影响上传本身，列表刷新后可手动归 */ }
  }
  loadAll();
}
bindDrop('drop-hits','file-hits','hits');bindDrop('drop-live','file-live','live');
try{window._curCol=localStorage.getItem('hermes_cur_col')||'';}catch{window._curCol='';}
loadAll();setInterval(loadAll,30000);/* GLB embed (?embed=1): keep history-hits memory only, hide pipeline entries already covered by the desktop app */try{if(new URLSearchParams(location.search).get('embed')==='1'){document.body.classList.add('embed');document.querySelectorAll('header button').forEach(function(b){b.style.display='none';});document.querySelectorAll('.tabs button').forEach(function(b){if(b.dataset.t!=='hits')b.style.display='none';});document.querySelectorAll('.tabpage').forEach(function(p){if(p.id!=='page-hits')p.style.display='none';});if(window.tab)tab('hits');}}catch(e){}
// R 键倍速：悬停/正在播的视频按 R 循环 1→1.25→1.5→2→3→0.5
(function(){const RATES=[1,1.25,1.5,2,3,0.5];let badge=null;
function showBadge(v){if(!badge){badge=document.createElement('div');badge.style.cssText='position:fixed;right:18px;bottom:18px;background:#ff9a3d;color:#fff;padding:10px 16px;border-radius:10px;font-size:15px;z-index:99;box-shadow:0 4px 16px rgba(0,0,0,.4)';document.body.appendChild(badge);}badge.textContent='▶ '+v.playbackRate+'x';badge.style.display='block';clearTimeout(badge._t);badge._t=setTimeout(()=>badge.style.display='none',1200);}
document.addEventListener('keydown',e=>{if(e.key!=='r'&&e.key!=='R')return;const t=e.target;if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'))return;
 const vids=[...document.querySelectorAll('video')];if(!vids.length)return;
 let v=vids.find(x=>x.matches(':hover'))||vids.find(x=>!x.paused)||window._lastVideo||vids[0];
 const i=RATES.indexOf(v.playbackRate);v.playbackRate=RATES[(i+1)%RATES.length];window._lastVideo=v;showBadge(v);});
document.addEventListener('play',e=>{if(e.target.tagName==='VIDEO')window._lastVideo=e.target;},true);
})();
</script>
</body>
</html>`;
  }
}

export default Orchestrator;
