/**
 * Hermes Memory Store
 * SQLite-based persistent memory with vector similarity search.
 * Stores: video records, highlight patterns, retention signals,
 * copywriting patterns, speaker profiles, and embedding vectors.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// unlinkSync：清除素材时可选连源视频一起删；existsSync：找"文件已不在"的空壳记录
// 注意：本文件是 ESM，里面写 require('fs') 会 ReferenceError（会被 try/catch 静默吞掉，排查极坑）
import { mkdirSync, readFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { stat } from 'fs/promises';
import { readJsonFile } from '../utils/read-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, '..', '..', 'config', 'default.json');
  return readJsonFile(configPath);
}

/**
 * 素材路径的唯一归一化入口（2026-10-12）。
 *
 * 之前全文件散着 7 处 `String(p).replace(/\\/g,'/')`，而各处口径还不一样：
 * 有的去尾斜杠、有的 toLowerCase，读路径 (getVideo/getLiveVideo) 干脆不归一。
 *
 * 更要命的是**注释声称已修、实际没修**：至少三处注释写着
 * "调度器扫到 D:////x 时 ON CONFLICT 匹配不上，同一条素材会插出两条记录"，
 * 可代码只换了分隔符 —— `D:////x` 和 `D:/x` 归一之后仍然是两个字符串，
 * UNIQUE(video_path) 照样拦不住，双跑锁照样失效。
 *
 * 现在统一走这里：反斜杠→正斜杠、折叠连续斜杠、去尾斜杠（保留盘符根）。
 * 大小写不动 —— video_path 是 TEXT UNIQUE（BINARY collation），
 * 改成 NOCASE 需要重建表，代价远大于收益；保持原样至少口径一致。
 */
export function normalizeVideoPath(p) {
  let s = String(p ?? '');
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  // 去掉尾斜杠，但 `E:/` 这种盘符根要保住
  if (s.length > 3) s = s.replace(/\/+$/, '');
  return s;
}

/** 需要统一成 SQL datetime 口径的时间列（2026-10-21，见 updateHitVideo 注释） */
const TS_COLUMNS = new Set(['analyzed_at', 'failed_at']);

/**
 * 任意时间值 → 'YYYY-MM-DD HH:MM:SS'（UTC，与 SQLite datetime('now') 同格式）。
 *
 * 背景：hit_videos 的 analyzed_at/failed_at 以前写 JS 的 toISOString()
 *（'2026-10-21T09:30:00.123Z'），deep_memory.updated_at 是 datetime('now')。
 * scheduler 用 `v.analyzed_at > d.updated_at` 字符串比较挑"待补深度分析" ——
 * 同一天里 'T' 恒大于空格，每 30 秒整场重跑，UTC 翻天才停。
 * 解析不动的原样返回（别把未知格式写坏）。
 */
export function normalizeSqlTs(v) {
  if (v == null || v === '' || v === false) return v;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2})(T|\s)\d{2}:\d{2}/.test(v)) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v; // 已是 SQL 口径
    const d = new Date(v.endsWith('Z') || v.includes('+') ? v : v + 'Z');
    if (!Number.isNaN(d.getTime())) return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 向量 ↔ Buffer 的编解码（全库唯一的实现）。
 *
 * 2026-10-12。原来读写各写一份，两份都有坑：
 *
 * 写：Buffer.from(new Float32Array(data.embedding).buffer)
 *   - 传进来的如果是 Buffer/ArrayBuffer（而不是 number[]），
 *     `new Float32Array(buf)` 会按**数组**去迭代它 —— 逐字节当成元素，
 *     3 维向量会变成 12 维的字节值，存进去的是垃圾。
 *   - 传 Float32Array 时又是另一条路径，行为取决于入参类型，调用方没法预期。
 *
 * 读：new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
 *   - byteOffset 非 4 的倍数 → 直接抛
 *     "start offset of Float32Array should be a multiple of 4"。
 *     Buffer 来自 slab 池时很容易出现这种切片。
 *   - 长度不是 4 的倍数 → length/4 取整，静默丢掉尾部字节。
 *
 * 所以这里统一：只认"数值序列"，其余一律拒绝，并且**宁可返回 null 也不写坏数据** ——
 * 一条坏向量会让相似度检索静默失准（命中错的话术），比查不到更糟。
 */

/** number[] | Float32Array | ArrayBuffer | Buffer → Buffer(float32)，无法解释时返回 null */
function toEmbeddingBuffer(input) {
  if (input === null || input === undefined) return null;

  let arr;
  if (input instanceof Float32Array) {
    arr = input;
  } else if (input instanceof ArrayBuffer) {
    if (input.byteLength % 4 !== 0) return null;
    arr = new Float32Array(input);
  } else if (ArrayBuffer.isView(input)) {
    // Buffer / Uint8Array 等：必须按字节解释成 float32，不能按数组迭代
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.length % 4 !== 0) return null;
    arr = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  } else if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    if (!input.length) return null;
    arr = Float32Array.from(input, (x) => {
      const n = Number(x);
      // NaN / Infinity 进了向量会把所有余弦相似度算成 NaN，比较排序直接乱掉
      return Number.isFinite(n) ? n : 0;
    });
  } else {
    return null;
  }
  if (!arr.length) return null;
  // 复制一份再取 buffer：保证 byteOffset 是 0、长度是 4 的倍数，
  // 否则读回来时又会踩上对齐问题
  return Buffer.from(Float32Array.from(arr).buffer);
}

/** Buffer(float32) → number[]；对不齐/不是 4 的倍数时返回 null（跳过该条，不猜） */
function readEmbedding(buf) {
  if (!buf) return null;
  const bytes = buf instanceof Buffer ? buf : Buffer.from(buf);
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  // 不走 new Float32Array(bytes.buffer, bytes.byteOffset, ...) ——
  // byteOffset 可能不是 4 的倍数（pool 切片），那会直接抛 RangeError。
  // 直接复制到 8 字节对齐的独立 buffer 再读。
  const copy = Buffer.allocUnsafeSlow(bytes.length);
  bytes.copy(copy);
  return Array.from(new Float32Array(copy.buffer, 0, bytes.length / 4));
}

export class MemoryStore {
  /**
   * 数值夹取（2026-10-12）。
   *
   * 写进库之前统一过一道，堵住三类脏值：
   *   - NaN / Infinity：Number("1e999") 就是 Infinity，直接写进去会让
   *     所有统计（sum/avg/排序）静默变成 NaN，界面上看不出来
   *   - 超出量程：confidence/intensity 这类 0~1 的值，模型给 5 就该夹到 1
   *   - falsy-zero：`value || 0.5` 会把模型明确给的 0（"完全没信心"）吞成 0.5
   *
   * 全库共用一个实现，避免每个 add* 各写各的（之前就有 5 处口径不一）。
   */
  static num(v, { min = null, max = null, fallback = null, integer = false } = {}) {
    // 布尔必须显式拒绝：Number(true) === 1、Number(false) === 0 是 JS 的类型强转陷阱。
    // 接口直传的字段（segmentIds / views 之类）混进一个 true，
    // 就会静默变成"第 1 段"或"1 次播放"—— 不报错，只是结果完全不对。
    if (typeof v === 'boolean') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    let x = integer ? Math.round(n) : n;
    if (min !== null) x = Math.max(min, x);
    if (max !== null) x = Math.min(max, x);
    return x;
  }

  constructor(config = null) {
    const cfg = config || loadConfig();
    this.dbPath = join(__dirname, '..', '..', cfg.memory.dbPath);
    this.similarityThreshold = cfg.memory.similarityThreshold || 0.75;
    this.maxEntries = cfg.memory.maxMemoryEntries || 100000;

    // Ensure data directory exists
    const dataDir = dirname(this.dbPath);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // 并发优化：调度器(写) + 看板API(读)同进程多路并发，无超时设置会直接 SQLITE_BUSY 报错
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000');
      this.db.pragma('temp_store = MEMORY');
    } catch { /* 老版本 SQLite 忽略不支持的 pragma */ }
    // 启动时先落一次 WAL（运行时由调度器每小时再来一次，见 checkpointWal）
    this.checkpointWal();
    // 补列必须放在 _init() 建表**之后**，否则对全新库是空操作
    // （表还不存在，ALTER 被 catch 吞掉），新装机器上就会缺列。
    // 以前这几条 ALTER 都在 _init() 前面，全新库因此缺 analysis_health，
    // 第一次 INSERT 就报 "no such column: analysis_health"。
    // 老库不受影响：ALTER TABLE ADD COLUMN 是幂等的。
    this._init();
    this._addMissingColumns();
    /*
     * collection 索引必须放在 _addMissingColumns 之后建（2026-10-12）。
     *
     * collection 是记忆隔离的唯一过滤键（多 IP/多老师并行时，取热词/避雷词/素材列表
     * 全靠它筛），而这几个列在线上库里实测一个索引都没有，上万行时每次调用都是全表扫。
     *
     * 为什么不能放进 _init 的索引段：
     *   - review_feedback.collection 是 ALTER 补的，建表语句里没有；
     *   - hotwords 这张表本身就排在索引段之后才 CREATE。
     * 放进同一段会直接 "no such column: collection"，而 _init 是裸 exec，
     * 一个语句失败整段中止 —— 后面所有索引都没建，构造函数抛异常，服务起不来。
     */
    this._ensureCollectionIndexes();
    this._ensureUniqueConstraints();
    // 进程内 profile 缓存：getStyleProfile 全表读+JSON.parse，被 clipper/generator/rerank 高频调用
    this._profileCache = null;
    // 当前活跃文件夹（一个 IP/老师一个文件夹）。评审经验按它隔离——剪哪个老师的片
    // 就只吃哪个老师的经验，避免切文件夹后串味。由 Orchestrator 在启动/切换时同步进来；
    // 为空 = 不隔离（返回全部经验），保证老版本行为不变。
    this.activeCollection = null;
  }

  /**
   * 老库补列。必须在 _init() 之后调用。
   *
   * 为什么集中在这里：这些 ALTER 以前散在构造函数里、建表**之前**，
   * 对全新库全是空操作（表还不存在，异常被 catch 吞掉），
   * 于是新装机器上第一次 INSERT 就报 "no such column"。
   * 新库的列由 _init() 的 CREATE TABLE 声明，老库靠这里补。
   */
  _addMissingColumns() {
    // review_feedback 按文件夹归属（2026-09-25）：有 collection 的意见只在同文件夹生效
    try { this.db.exec('ALTER TABLE review_feedback ADD COLUMN collection TEXT'); } catch { /* 列已存在 */ }
    // 分析健康度（2026-09-27）：存每次直播分析的体检指标 JSON。
    // 起因：LLM 分段失败会静默降级成 90 秒等分，界面却显示"分析完成"，
    // 老板察觉不到结果其实不可用了——历史上一场直播 143/144 段主题"待分类"就是这么攒出来的。
    try { this.db.exec('ALTER TABLE live_videos ADD COLUMN analysis_health TEXT'); } catch { /* 列已存在 */ }
    // 直播归属的老师（2026-10-02）：记忆隔离只认全局 activeCollection 时，
    // 导入 A 老师的直播只要界面停在 B 老师身上就会用错记忆，且不报错。
    try { this.db.exec('ALTER TABLE live_videos ADD COLUMN collection TEXT'); } catch { /* 列已存在 */ }
  }

  /**
   * 建表 + 建索引。
   *
   * 2026-10-12：失败不再"一颗雷炸掉整段"。
   *
   * 原来是一整段 SQL 交给 db.exec，**任何一条语句失败 → 整段中止 → 构造函数抛异常 →
   * 服务起不来**。而这段里最脆的是函数索引：
   *   CREATE UNIQUE INDEX idx_hotword_pair ON hotwords(IFNULL(collection,''), from_word)
   * 只要 hotwords 表里已有重复的 (collection, from_word) 组合（老库很可能有），
   * 这条就建不出来 —— 而它恰好排在整段的**最后**，于是前面所有索引都没建成，
   * 而且一行日志都没有。
   *
   * 现在：先按原来那样整段跑（最快，SQLite 一次解析）；
   * 只有整段失败时才退化成逐条重试 —— 建表失败仍然抛（那是库真的坏了），
   * 索引失败只打 warn 并继续，让后面的索引照样建起来。
   */
  _init() {
    const SCHEMA_SQL = `
      -- Processed video records
      CREATE TABLE IF NOT EXISTS video_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_path TEXT NOT NULL UNIQUE,
        video_name TEXT,
        duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        processed_at TEXT,
        transcript_path TEXT,
        highlight_path TEXT,
        clip_paths TEXT,          -- JSON array of output clip paths
        genre TEXT,               -- game / talkshow / podcast / vlog ...
        source_type TEXT,         -- livestream / long-video / replay
        metadata TEXT             -- JSON blob for extra fields
      );

      -- Learned highlight (explosive moment) patterns
      CREATE TABLE IF NOT EXISTS highlight_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER REFERENCES video_records(id),
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        confidence REAL,
        peak_type TEXT,           -- audio_peak / shot_change / emotion / content_density / llm_match
        intensity REAL,           -- 0-1 normalized intensity
        context_text TEXT,        -- transcript snippet around this moment
        genre TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Retention / drop-off signals extracted from each video
      CREATE TABLE IF NOT EXISTS retention_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER REFERENCES video_records(id),
        time_ms INTEGER NOT NULL,
        signal_type TEXT,        -- engagement / pace / hook_strength / energy
        value REAL,
        confidence REAL,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Copywriting / sales pitch patterns
      CREATE TABLE IF NOT EXISTS copywriting_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER REFERENCES video_records(id),
        pattern_type TEXT NOT NULL,  -- hook / transition / urgency / cta / objection / social_proof
        text_content TEXT NOT NULL,
        time_ms INTEGER,             -- position in video where it appears
        effectiveness REAL,         -- user-rated or heuristic-scored 0-1
        context_text TEXT,           -- surrounding transcript for context
        embedding BLOB,              -- vector embedding for similarity search
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Speaker / personality profiles
      CREATE TABLE IF NOT EXISTS speaker_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        speaker_label TEXT,
        speaker_name TEXT,
        speech_rate REAL,           -- words per minute
        avg_pause_ms INTEGER,
        energy_baseline REAL,
        catchphrases TEXT,          -- JSON array of recurring phrases
        embedding BLOB,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Aggregated user style profile (the "DNA" of this user's content)
      CREATE TABLE IF NOT EXISTS user_style_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_key TEXT UNIQUE NOT NULL,
        profile_value TEXT,        -- JSON serialized
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Hit viral videos (historical bests)
      CREATE TABLE IF NOT EXISTS hit_videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_path TEXT NOT NULL UNIQUE,
        video_name TEXT,
        duration_ms INTEGER,
        file_size INTEGER,
        resolution TEXT,
        fps REAL,
        genre TEXT,
        analysis_status TEXT DEFAULT 'pending',
        analysis_result TEXT,
        asr_path TEXT,
        -- ── 记忆分析维度（拆解后长期留存的"这条为什么爆"的全部细节）──
        title TEXT,              -- 创作者视频标题（LLM 从文案/画面/文件名归纳）
        opening_script TEXT,     -- 开头 3 秒逐字文案（钩子原话）
        full_transcript TEXT,    -- 完整逐字稿全文（记忆用，LLM 分析可抽样但不许丢全文）
        viral_points TEXT,       -- 爆款要点 JSON：[{point, evidence, weight}]
        on_screen_texts TEXT,    -- 画面标题/花字 JSON：[{time_seconds, text, type}]
        cover_frame TEXT,        -- 封面候选帧路径
        cover_text TEXT,         -- 封面建议大字
        emotion_curve TEXT,      -- 情绪/表情曲线 JSON：[{start_seconds, end_seconds, emotion, facial_expression, voice_tone, intensity}]
        collection TEXT,         -- 文件夹（一个 IP/老师一个文件夹，剪片时选哪个文件夹=用哪套记忆）
        -- ── 失败诊断 ──
        -- 只看 analysis_status='failed' 是查不出原因的，得知道它炸在哪一步。
        -- 重试成功后 last_error/failed_at 会被置回 null，不留陈年报错。
        last_error TEXT,
        failed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        analyzed_at TEXT
      );

      -- Hit video structure breakdown
      CREATE TABLE IF NOT EXISTS hit_structure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hit_video_id INTEGER REFERENCES hit_videos(id),
        segment_type TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        duration_ms INTEGER,
        description TEXT,
        key_text TEXT,
        emotion_tag TEXT,
        intensity REAL,
        keyframe_path TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Hit video themes/topics
      CREATE TABLE IF NOT EXISTS hit_themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hit_video_id INTEGER REFERENCES hit_videos(id),
        theme_name TEXT NOT NULL,
        confidence REAL,
        keywords TEXT,
        related_segments TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Live stream videos
      CREATE TABLE IF NOT EXISTS live_videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_path TEXT NOT NULL UNIQUE,
        video_name TEXT,
        duration_ms INTEGER,
        file_size INTEGER,
        analysis_status TEXT DEFAULT 'pending',
        asr_path TEXT,
        segment_count INTEGER DEFAULT 0,
        clip_count INTEGER DEFAULT 0,
        -- 这条直播归属哪位老师。分析时按它取爆款记忆/避雷词,
        -- 而不是靠全局 activeCollection —— 否则导入 A 老师的直播时,
        -- 只要界面当前选中 B 老师,就会用 B 的记忆去分析 A 的素材。
        collection TEXT,
        -- 分析健康度。构造函数里的 ALTER 只对**已存在**的表生效,
        -- 而 CREATE TABLE 跑在 ALTER 之后 —— 所以新库必须在这里把两列都声明出来,
        -- 否则全新安装的库会缺列,INSERT 直接报 no such column。
        analysis_health TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        analyzed_at TEXT
      );

      -- Live stream segments
      CREATE TABLE IF NOT EXISTS live_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        live_video_id INTEGER REFERENCES live_videos(id),
        segment_index INTEGER,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        duration_ms INTEGER,
        theme_name TEXT,
        theme_confidence REAL,
        matched_hit_themes TEXT,
        hook_quality REAL,
        peak_count INTEGER DEFAULT 0,
        transcript_summary TEXT,
        status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Clip projects
      CREATE TABLE IF NOT EXISTS clip_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        live_video_id INTEGER REFERENCES live_videos(id),
        project_name TEXT,
        status TEXT DEFAULT 'pending',
        selected_segments TEXT,
        total_duration_ms INTEGER,
        output_path TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );

      -- Clip outputs
      CREATE TABLE IF NOT EXISTS clip_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clip_project_id INTEGER REFERENCES clip_projects(id),
        output_type TEXT NOT NULL,
        file_path TEXT,
        duration_ms INTEGER,
        file_size INTEGER,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- User queries / confirmations
      CREATE TABLE IF NOT EXISTS user_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        query_type TEXT,
        question TEXT NOT NULL,
        context TEXT,
        options TEXT,
        answer TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        answered_at TEXT
      );

      -- Review feedback: user approves (or a highlight candidate is rejected), becomes memory
      -- 表结构与索引保持不变：approve 学习闭环与 getCollectionAvoidRules() 仍依赖它，
      -- 且库里已有 decision='recut' 的历史行需要继续可读。
      CREATE TABLE IF NOT EXISTS review_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clip_project_id INTEGER REFERENCES clip_projects(id),
        live_video_id INTEGER,
        decision TEXT NOT NULL,        -- approve / recut（粗剪审片打回已下线，recut 现仅来自桌面端爆点候选否决 + 历史数据）
        segment_ids TEXT,              -- JSON array of concerned live_segment ids
        comment TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      /*
       * 剪辑决策学习样本（2026-10-04）
       *
       * 为什么 review_feedback 不够：它只存一句 comment。
       * 但用户精修粗剪时真正的信号是**逐句的选择** ——
       * 哪几个字被框掉、哪几句整段留下。
       *
       * 尤其要注意"保留"必须显式记：
       * 删除是显式动作，保留是默认动作。不记的话库里全是删除记录，
       * 下次找爆点按"什么内容有效"去匹配时一条样本都没有，
       * 学到的只有"别说什么"，学不到"该说什么" —— 后者才是爆款的正向逻辑。
       *
       * kind 三取值：
       *   cut     —— 用户框选删掉的文字（避雷词）
       *   keep    —— 用户明确保留的文字（正样本）
       *   segment —— 用户勾选保留的整段（段落级内容逻辑，最粗也最抗噪）
       *
       * by 字段区分信号强度，必须有：
       *   picked / edited —— 用户主动操作，信号强
       *   passive        —— 只是没反对。把它当正样本是过度解读，会把噪声学进去
       */
      CREATE TABLE IF NOT EXISTS review_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clip_project_id INTEGER REFERENCES clip_projects(id),
        live_video_id INTEGER,
        collection TEXT,
        kind TEXT NOT NULL,
        segment_id INTEGER,
        role TEXT,
        theme_name TEXT,
        text TEXT,
        char_from INTEGER,
        char_to INTEGER,
        start_ms INTEGER,
        end_ms INTEGER,
        score REAL,
        reason TEXT,
        by TEXT NOT NULL DEFAULT 'edited',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- 字段含义（中文说明放在这里而不是行尾，行尾注释里的中文
      -- 会被 SQLite 当作 SQL 的一部分，某些版本直接导致整段建表失败，
      -- 而且报错指向"未闭合的字符串"，很难看出真因）：
      --   collection  归档到哪位 IP 老师
      --   kind        cut / keep / segment
      --   role        hook / body / cta（段落级才有）
      --   text        原文（cut/keep），段落级存该段原文摘要
      --   start/end   原素材绝对时间（毫秒）
      --   reason      用户写的那句话
      --   by          picked = 勾选框认可；edited = 框选文字改动

      -- Hit performance: 真实发布数据回流（用户在记忆页上传截图/数字），校准预测
      CREATE TABLE IF NOT EXISTS hit_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hit_video_id INTEGER UNIQUE REFERENCES hit_videos(id),
        views INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        favorites INTEGER,             -- 收藏（抖音/小红书的核心指标，别再漏了）
        platform TEXT,                 -- 视频号/抖音/小红书/快手/B站/其他（截图OCR识别）
        source TEXT DEFAULT 'manual',  -- manual / ocr / manual+ocr
        screenshot_path TEXT,
        note TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Hit predictions: 每条爆款素材的播放量预测（LLM 参照记忆库估算，仅供参考）
      CREATE TABLE IF NOT EXISTS hit_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hit_video_id INTEGER UNIQUE REFERENCES hit_videos(id),
        views_low INTEGER,
        views_high INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        favorites INTEGER,          -- 预测收藏量
        confidence TEXT,            -- 预测把握：高/中/低（样本少自动降为"低"）
        rationale TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Openings cache: 本场字稿深挖出的好开头（记忆加权+LLM精选），按字稿指纹缓存
      -- Collections: 爆款素材的文件夹（一个 IP/老师一个），新建即落库，空文件夹也保留
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS openings_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT UNIQUE,
        mined TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for fast queries
      CREATE INDEX IF NOT EXISTS idx_highlight_video ON highlight_patterns(video_id);
      CREATE INDEX IF NOT EXISTS idx_highlight_genre ON highlight_patterns(genre);
      CREATE INDEX IF NOT EXISTS idx_retention_video ON retention_signals(video_id);
      CREATE INDEX IF NOT EXISTS idx_copy_type ON copywriting_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_copy_video ON copywriting_patterns(video_id);
      CREATE INDEX IF NOT EXISTS idx_hit_video_path ON hit_videos(video_path);
      CREATE INDEX IF NOT EXISTS idx_hit_structure_video ON hit_structure(hit_video_id);
      CREATE INDEX IF NOT EXISTS idx_hit_theme_video ON hit_themes(hit_video_id);
      CREATE INDEX IF NOT EXISTS idx_live_video_path ON live_videos(video_path);
      CREATE INDEX IF NOT EXISTS idx_live_segment_video ON live_segments(live_video_id);
      CREATE INDEX IF NOT EXISTS idx_clip_project_live ON clip_projects(live_video_id);
      CREATE INDEX IF NOT EXISTS idx_user_query_status ON user_queries(status);
      -- 高频 WHERE 条件补索引：调度器每 30s 全表扫 status，评审页按 live/project/decision 查
      CREATE INDEX IF NOT EXISTS idx_hit_video_status ON hit_videos(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_live_video_status ON live_videos(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_live_segment_status ON live_segments(status);
      CREATE INDEX IF NOT EXISTS idx_clip_project_status ON clip_projects(status);
      CREATE INDEX IF NOT EXISTS idx_hit_theme_name ON hit_themes(theme_name);
      CREATE INDEX IF NOT EXISTS idx_review_live ON review_feedback(live_video_id);
      CREATE INDEX IF NOT EXISTS idx_review_project ON review_feedback(clip_project_id);
      CREATE INDEX IF NOT EXISTS idx_review_decision ON review_feedback(decision);
      -- 学习样本查询：按 IP 老师 + 类型取避雷词/正样本，按场次回溯
      CREATE INDEX IF NOT EXISTS idx_review_edits_coll ON review_edits(collection, kind);
      CREATE INDEX IF NOT EXISTS idx_review_edits_project ON review_edits(clip_project_id);
      -- collection 索引见构造器里的 _ensureCollectionIndexes()：
      -- 那几个列/表此刻还不存在（ALTER 补列 + hotwords 建表都在后面），放这里会报错。

      /*
       * 热词硬纠正（按 IP 老师归档）
       *
       * 人名/术语/课程名是 ASR 最容易听错、而后果最严重的地方：
       * 错字会同时污染粗剪文案、字幕、爆点匹配。
       *
       * 存在 hotwords 表而不是塞进 review_edits：
       *   - 语义不同。review_edits 是"这一次审片的样本"（历史）；
       *     热词是"长期有效的词典"（规则），不该被清理/统计逻辑一起处理。
       *   - 热词要参与匹配（WHERE from = ?），样本表是纯流水。
       *
       * 字段说明放行尾注释（此处用块注释）：
       *   from  听错的写法
       *   to    正确的写法
       *   hits  累计命中次数 —— 长期 0 命中的规则是死规则，应该能被发现
       */
      CREATE TABLE IF NOT EXISTS hotwords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT,
        from_word TEXT NOT NULL,
        to_word TEXT NOT NULL,
        hits INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `;

    /*
     * 快慢两条路，但**两条路都要往下走** —— 下面还有 idx_hotword_pair 和
     * speaker_profiles 迁移，早先我在这条分支里写了 return，
     * 结果成功路径直接跳过它们：老库缺 updated_at 时迁移不跑，
     * upsertSpeaker 会抛 "no such column: updated_at"。
     *
     * 切分只按"分号 + 换行"来分 —— 这段里没有触发器（CREATE TRIGGER 的分号体会被切坏），
     * 字符串字面量里也没有分号，所以这样切是安全的。
     */
    try {
      // 快路径：一次 exec 跑完（SQLite 只解析一次，比逐条 prepare 快很多）
      this.db.exec(SCHEMA_SQL);
    } catch (err) {
      // 慢路径：逐条重试，把失败的那条揪出来
      console.warn(`[MemoryStore] 整段建表脚本失败（${err.message}），改为逐条重试以定位并跳过问题语句`);
      let idxFailed = 0;
      for (const sql of SCHEMA_SQL.split(/;\s*\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        const head = sql.split('\n')[0].trim();
        try {
          this.db.exec(sql);
        } catch (e2) {
          if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(head)) {
            idxFailed++;
            console.warn(`[MemoryStore] 索引未能建立（已跳过，不影响其它）：${head} —— ${e2.message}`);
          } else {
            // 建表失败 → 照旧抛出去。磁盘满/库损坏，继续跑只会把错误推到更远的地方。
            console.error(`[MemoryStore] 建表失败：${head} —— ${e2.message}`);
            throw e2;
          }
        }
      }
      if (idxFailed) {
        console.warn(`[MemoryStore] ${idxFailed} 条索引未能建立；相关查询会退化为全表扫描，功能不受影响`);
      }
    }

    /*
     * 热词的 (文件夹, 原词) 唯一索引单独建 —— 它是**最可能失败**的一条：
     * 老库里只要存在重复的 (collection, from_word) 组合就建不出来。
     * 以前它排在整个大 exec 的**最后**，一旦失败就把前面所有索引一起带走；
     * 现在它失败只影响热词查重的性能。
     */
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hotword_pair
        ON hotwords(IFNULL(collection,''), from_word)`);
    } catch (err) {
      try {
        const dup = this.db.prepare(
          "SELECT IFNULL(collection,'') c, from_word f, COUNT(*) n FROM hotwords GROUP BY c, f HAVING n > 1 LIMIT 5"
        ).all();
        console.warn(
          `[MemoryStore] idx_hotword_pair 建不出来：${err.message}`
          + (dup.length ? `；重复组合 ${dup.map((d) => `${d.f}×${d.n}`).join(', ')}（查重会退化为全表扫描）` : '')
        );
      } catch {
        console.warn(`[MemoryStore] idx_hotword_pair 建不出来：${err.message}`);
      }
    }

    // ── 轻量迁移：老库缺字段/约束时补上（幂等，可重复执行）──
    // speaker_profiles 曾无 UNIQUE(speaker_label) 且无 updated_at，
    // 导致 upsertSpeaker 报 "ON CONFLICT clause does not match..." 或 "no such column: updated_at"。
    try {
      const cols = this.db.prepare(`PRAGMA table_info(speaker_profiles)`).all().map(c => c.name);
      if (!cols.includes('updated_at')) {
        /*
         * 注意：不能写 DEFAULT (datetime('now'))。
         * SQLite 拒绝"非常量默认值"的 ADD COLUMN：
         *   "Cannot add a column with non-constant default"
         * （表里一行数据都没有时才会放行，所以拿空表一测根本看不出来）
         *
         * 而这段是被 try/catch 包住的，于是它**从来没在老库上成功过**，
         * 只有一行没人看的 warn —— 老库 upsertSpeaker 照样抛
         * "no such column: updated_at"，正是这段迁移想修的那个症状。
         * 改成：先加列，再回填。
         */
        this.db.exec(`ALTER TABLE speaker_profiles ADD COLUMN updated_at TEXT`);
        this.db.exec(`UPDATE speaker_profiles SET updated_at = datetime('now') WHERE updated_at IS NULL`);
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_label ON speaker_profiles(speaker_label)`);
    } catch (err) {
      console.warn('[MemoryStore] speaker_profiles migration skipped:', err.message);
    }
    // hit_performance 补 platform 列（截图OCR识别的视频号/抖音/小红书/快手/B站，用于同平台校准）
    try {
      const perfCols = this.db.prepare(`PRAGMA table_info(hit_performance)`).all().map(c => c.name);
      if (!perfCols.includes('platform')) {
        this.db.exec(`ALTER TABLE hit_performance ADD COLUMN platform TEXT`);
      }
    } catch (err) {
      console.warn('[MemoryStore] hit_performance migration skipped:', err.message);
    }
    /*
     * live_segments 补列（2026-10-14）。
     *
     * viral_potential / recommended_action 从来不是"新需求"：
     * live-analyzer 的 _matchAllWithHitThemes 一直在算它们，
     * 只是建表时没给这两列，于是写库那一刻就被丢掉了。
     * 老库更是完全没有 —— 所以先查再补，别让 ALTER 报错把后面截断。
     */
    try {
      const segCols = this.db.prepare('PRAGMA table_info(live_segments)').all().map((c) => c.name);
      if (!segCols.includes('viral_potential')) {
        this.db.exec('ALTER TABLE live_segments ADD COLUMN viral_potential REAL');
      }
      if (!segCols.includes('recommended_action')) {
        this.db.exec('ALTER TABLE live_segments ADD COLUMN recommended_action TEXT');
      }
    } catch (err) {
      console.warn('[Store] live_segments 补列失败（爆款分将不可用）:', err.message);
    }

    // 老库补列：hit_performance.favorites / hit_predictions.favorites+confidence / hit_videos 记忆维度
    // （幂等：缺哪列补哪列，已有库直接升级，不用重建）
    try {
      const has = (t, c) => this.db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name).includes(c);
      if (!has('hit_performance', 'favorites')) this.db.exec(`ALTER TABLE hit_performance ADD COLUMN favorites INTEGER`);
      if (!has('hit_predictions', 'favorites')) this.db.exec(`ALTER TABLE hit_predictions ADD COLUMN favorites INTEGER`);
      if (!has('hit_predictions', 'confidence')) this.db.exec(`ALTER TABLE hit_predictions ADD COLUMN confidence TEXT`);
      for (const [col, type] of [
        ['title', 'TEXT'], ['opening_script', 'TEXT'], ['full_transcript', 'TEXT'],
        ['viral_points', 'TEXT'], ['on_screen_texts', 'TEXT'],
        ['cover_frame', 'TEXT'], ['cover_text', 'TEXT'], ['emotion_curve', 'TEXT'],
        ['collection', 'TEXT'],
        // 失败原因。以前 hit_videos 只有 analysis_status='failed'，
        // 失败之后什么都查不到 —— 这次 3 条素材失败，只能手动跑一遍才拿到真实报错。
        // 有这两列才能在界面上直接说清"这条为什么没学进去"，而不是只给一个 failed。
        ['last_error', 'TEXT'], ['failed_at', 'TEXT'],
      ]) {
        if (!has('hit_videos', col)) this.db.exec(`ALTER TABLE hit_videos ADD COLUMN ${col} ${type}`);
      }
    } catch (err) {
      console.warn('[MemoryStore] memory-dimension migration skipped:', err.message);
    }
  }

  // ──────────────────────────────────────────────
  // Video Records
  // ──────────────────────────────────────────────

  upsertVideo(videoPath, data = {}) {
    // 2026-09-25 修：分隔符统一成正斜杠——接口传 D:/x、调度器扫到 D:////x 时
    // ON CONFLICT(video_path) 匹配不上，同一条素材会插出两条记录、双跑锁失效。
        videoPath = normalizeVideoPath(videoPath);
        /*
         * 2026-10-12：空路径直接拒绝，不能写进库。
         *
         * video_path 是 NOT NULL UNIQUE，而空串**能通过** NOT NULL 检查 ——
         * 于是第一个空路径 upsert 插出一条 video_path='' 的垃圾行，
         * 之后每一次空路径 upsert 都因 UNIQUE 冲突落到同一条 '' 行上互相覆盖。
         * 结果：所有“路径算错了”的调用共用一条记录，谁都能改它，
         * 而 listCollections / getCollectionHits 会把它当成一条真实素材统计进去。
         *
         * 宁可让调用方拿到明确的失败，也不要悄悄写一条共享的垃圾行。
         */
        if (!videoPath) {
          const e = new Error('videoPath 为空，拒绝写入（否则会往库里插一条共享的垃圾行）');
          e.code = 'EMPTY_VIDEO_PATH';
          throw e;
        }
        // 只覆盖传入的非空字段，避免用默认 null 洗掉已有记录（如转写路径、类型等）
    // 只取真正要读的列：SELECT * 在 hit_videos 上会把整场逐字稿（可达上百 KB）
    // 搬进 JS 内存，只为了读几个标量字段。存在性检查同理。
    const cur = this.db.prepare('SELECT * FROM video_records WHERE video_path = ?').get(videoPath);
    const pick = (v, c) => (v !== undefined && v !== null ? v : (c !== undefined && c !== null ? c : null));
    const merged = {
      videoName: pick(data.videoName, cur?.video_name),
      durationMs: pick(data.durationMs, cur?.duration_ms),
      transcriptPath: pick(data.transcriptPath, cur?.transcript_path),
      highlightPath: pick(data.highlightPath, cur?.highlight_path),
      clipPaths: data.clipPaths ? JSON.stringify(data.clipPaths) : (cur?.clip_paths || null),
      genre: pick(data.genre, cur?.genre),
      sourceType: pick(data.sourceType, cur?.source_type),
      metadata: data.metadata ? JSON.stringify(data.metadata) : (cur?.metadata || null),
    };
    const stmt = this.db.prepare(`
      INSERT INTO video_records (video_path, video_name, duration_ms, transcript_path, highlight_path, clip_paths, genre, source_type, metadata)
      VALUES (@videoPath, @videoName, @durationMs, @transcriptPath, @highlightPath, @clipPaths, @genre, @sourceType, @metadata)
      ON CONFLICT(video_path) DO UPDATE SET
        video_name = @videoName,
        duration_ms = @durationMs,
        transcript_path = @transcriptPath,
        highlight_path = @highlightPath,
        clip_paths = @clipPaths,
        genre = @genre,
        source_type = @sourceType,
        metadata = @metadata,
        processed_at = datetime('now')
    `);
    const result = stmt.run({ videoPath, ...merged });
    if (cur) return cur.id;
    return result.lastInsertRowid;
  }

  getVideo(videoPath) {
    // 2026-10-12：读侧也要归一。写侧存的是归一化后的值，读侧拿原样路径查必然查不到 ——
    // 同一个文件里曾有三种口径（upsert 归一 / getHitVideo 归一 / 这两个不归一）。
    const row = this.db.prepare('SELECT * FROM video_records WHERE video_path = ?').get(normalizeVideoPath(videoPath));
    if (row) {
      row.clip_paths = row.clip_paths ? JSON.parse(row.clip_paths) : [];
      row.metadata = row.metadata ? JSON.parse(row.metadata) : {};
    }
    return row;
  }

  getVideoById(id) {
    const row = this.db.prepare('SELECT * FROM video_records WHERE id = ?').get(id);
    if (row) {
      row.clip_paths = row.clip_paths ? JSON.parse(row.clip_paths) : [];
      row.metadata = row.metadata ? JSON.parse(row.metadata) : {};
    }
    return row;
  }

  getAllVideos(limit = 100) {
    return this.db.prepare('SELECT * FROM video_records ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ──────────────────────────────────────────────
  // Highlight Patterns
  // ──────────────────────────────────────────────

  addHighlightPattern(data) {
    const stmt = this.db.prepare(`
      INSERT INTO highlight_patterns (video_id, start_ms, end_ms, confidence, peak_type, intensity, context_text, genre)
      VALUES (@videoId, @startMs, @endMs, @confidence, @peakType, @intensity, @contextText, @genre)
    `);
    return stmt.run({
      videoId: data.videoId,
      /*
       * 2026-10-12：start_ms/end_ms 是 NOT NULL，原来裸传。
       * 值来自模型输出的 JSON，缺一个字段就是 undefined → 绑成 NULL → 抛
       * NOT NULL constraint failed，一路冒到上层把整条素材判 failed。
       * （和 live_segments / hit_structure 是同一类，那两处已修。）
       */
      startMs: MemoryStore.num(data.startMs, { min: 0, integer: true, fallback: 0 }),
      endMs: MemoryStore.num(data.endMs, { min: 0, integer: true, fallback: 0 }),
      // `|| 0.5` 是 falsy-zero：模型明确给 0（"完全没信心"）会被吞成 0.5
      confidence: MemoryStore.num(data.confidence, { min: 0, max: 1, fallback: 0.5 }),
      peakType: String(data.peakType || 'unknown').trim() || 'unknown',
      intensity: MemoryStore.num(data.intensity, { min: 0, max: 1, fallback: 0.5 }),
      contextText: data.contextText || '',
      genre: data.genre || null
    }).lastInsertRowid;
  }

  getHighlightsByGenre(genre, limit = 50) {
    return this.db.prepare(
      'SELECT * FROM highlight_patterns WHERE genre = ? ORDER BY intensity DESC LIMIT ?'
    ).all(genre, limit);
  }

  getHighlightsByVideo(videoId) {
    return this.db.prepare(
      'SELECT * FROM highlight_patterns WHERE video_id = ? ORDER BY start_ms'
    ).all(videoId);
  }

  getAllHighlights(limit = 500) {
    return this.db.prepare(
      'SELECT * FROM highlight_patterns ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  // ──────────────────────────────────────────────
  // Retention Signals
  // ──────────────────────────────────────────────

  addRetentionSignal(data) {
    const stmt = this.db.prepare(`
      INSERT INTO retention_signals (video_id, time_ms, signal_type, value, confidence, note)
      VALUES (@videoId, @timeMs, @signalType, @value, @confidence, @note)
    `);
    return stmt.run({
      videoId: data.videoId,
      timeMs: data.timeMs,
      signalType: data.signalType || 'engagement',
      value: data.value || 0,
      confidence: data.confidence || 0.5,
      note: data.note || ''
    }).lastInsertRowid;
  }

  getRetentionByVideo(videoId) {
    return this.db.prepare(
      'SELECT * FROM retention_signals WHERE video_id = ? ORDER BY time_ms'
    ).all(videoId);
  }

  // ──────────────────────────────────────────────
  // Copywriting Patterns
  // ──────────────────────────────────────────────

  // 同步方法（better-sqlite3 本就是同步的；保持 sync 可避免调用方忘记 await 导致的时序问题）
  addCopywritingPattern(data) {
    const stmt = this.db.prepare(`
      INSERT INTO copywriting_patterns (video_id, pattern_type, text_content, time_ms, effectiveness, context_text, embedding)
      VALUES (@videoId, @patternType, @textContent, @timeMs, @effectiveness, @contextText, @embedding)
    `);
return stmt.run({
    videoId: data.videoId || null,
    // 同 addHitStructure：这两列是 NOT NULL，值来自 LLM 的 JSON。
    // 模型偶尔少给一个字段就会让整条素材的分析前功尽弃（实测踩过），
    // 这里兜底成 unknown / 空串，保证"写不进去"不会升级成"整条失败"。
    patternType: String(data.patternType ?? '').trim() || 'unknown',
    textContent: String(data.textContent ?? '').trim() || '（无原文）',
    timeMs: data.timeMs || null,
    effectiveness: Number.isFinite(Number(data.effectiveness)) ? data.effectiveness : 0.5,
    contextText: data.contextText || '',
    embedding: toEmbeddingBuffer(data.embedding)
  }).lastInsertRowid;
}

  getCopywritingByType(patternType, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM copywriting_patterns WHERE pattern_type = ? ORDER BY effectiveness DESC LIMIT ?'
    ).all(patternType, limit);
  }

  /**
   * Vector similarity search for copywriting patterns.
   * Compares query embedding against all stored embeddings using cosine similarity.
   * @param {number[]} queryEmbedding
   * @param {number} topK
   * @returns {Array<{row: Object, similarity: number}>}
   */
  searchSimilarCopywriting(queryEmbedding, topK = 5) {
    if (!queryEmbedding?.length) return [];
    // 封顶扫最近 500 条：maxEntries 10万时全表 + 4096维 cosine 会把事件循环卡死
    const rows = this.db.prepare(
      'SELECT * FROM copywriting_patterns WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT 500'
    ).all();

    const scored = rows.map((row) => {
      const emb = readEmbedding(row.embedding);
      if (!emb) return { row, similarity: -1 };
      const sim = cosineSimilarity(queryEmbedding, emb);
      return { row, similarity: sim };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).filter((s) => s.similarity >= this.similarityThreshold);
  }

  // ──────────────────────────────────────────────
  // Speaker Profiles
  // ──────────────────────────────────────────────

  upsertSpeaker(data) {
    const stmt = this.db.prepare(`
      INSERT INTO speaker_profiles (speaker_label, speaker_name, speech_rate, avg_pause_ms, energy_baseline, catchphrases, embedding)
      VALUES (@speakerLabel, @speakerName, @speechRate, @avgPauseMs, @energyBaseline, @catchphrases, @embedding)
      ON CONFLICT(speaker_label) DO UPDATE SET
        speaker_name = @speakerName,
        speech_rate = @speechRate,
        avg_pause_ms = @avgPauseMs,
        energy_baseline = @energyBaseline,
        catchphrases = @catchphrases,
        embedding = @embedding,
        updated_at = datetime('now')
    `);
    return stmt.run({
      speakerLabel: data.speakerLabel || 'speaker_0',
      speakerName: data.speakerName || null,
      speechRate: data.speechRate || 0,
      avgPauseMs: data.avgPauseMs || 0,
      energyBaseline: data.energyBaseline || 0,
      catchphrases: data.catchphrases ? JSON.stringify(data.catchphrases) : null,
      embedding: toEmbeddingBuffer(data.embedding)
    }).lastInsertRowid;
  }

  // ──────────────────────────────────────────────
  // User Style Profile (aggregated DNA)
  // ──────────────────────────────────────────────

  getStyleProfile() {
    if (this._profileCache) return this._profileCache;
    const rows = this.db.prepare('SELECT * FROM user_style_profile').all();
    const profile = {};
    for (const row of rows) {
      try { profile[row.profile_key] = JSON.parse(row.profile_value); }
      catch { /* 坏行跳过，避免整个 profile 读不出 */ }
    }
    this._profileCache = profile;
    return profile;
  }

  /**
   * 取某个集合(一个 IP/老师)下的爆款记忆。
   *
   * 为什么要单独一套：getStyleProfile() 返回的是 user_style_profile 全表，
   * 那些 hooks_<genre> 是**跨 IP 混在一起的**全局钩子池。而用户要的是
   * "跟祝老师学爆款感"，混进别的老师的钩子等于学错人。
   *
   * 这里只取 activeCollection 命中的爆款（hit_videos.collection），
   * 没有集合时返回空数组而不是回落到全局池 —— 回落会让"没设集合"看起来
   * 像是"用了某套记忆"，是假象。
   */
  getCollectionHits(collection, limit = 60) {
    const name = String(collection || '').trim();
    if (!name) return [];
    return this.db
      .prepare(
        `SELECT h.id, h.video_path, h.title, h.opening_script, h.genre, h.duration_ms, h.collection
           FROM hit_videos h
          WHERE h.collection = ? AND h.analysis_status = 'completed'
          ORDER BY h.id DESC
          LIMIT ?`
      )
      .all(name, limit);
  }

  /** 某集合下的高频钩子（来自 copywriting_patterns 的 hook 类型，按 effectiveness 排） */
  getCollectionHooks(collection, limit = 12) {
    const name = String(collection || '').trim();
    if (!name) return [];
    return this.db
      .prepare(
        `SELECT p.text_content, p.effectiveness, p.pattern_type
           FROM copywriting_patterns p
           JOIN video_records v ON v.id = p.video_id
          WHERE v.video_path IN (SELECT video_path FROM hit_videos WHERE collection = ?)
            AND p.pattern_type IN ('hook','soft_cta')
            AND p.text_content IS NOT NULL AND LENGTH(p.text_content) > 4
          ORDER BY p.effectiveness DESC NULLS LAST
          LIMIT ?`
      )
      .all(name, limit)
      .map((r) => ({ text: String(r.text_content || '').slice(0, 120), effectiveness: Number(r.effectiveness) || null }));
  }

  /** 某集合下的主题词 */
  getCollectionThemeKeywords(collection, limit = 40) {
    const name = String(collection || '').trim();
    if (!name) return [];
    return this.db
      .prepare(
        `SELECT t.theme_name, t.keywords, t.confidence
           FROM hit_themes t
           JOIN hit_videos h ON h.id = t.hit_video_id
          WHERE h.collection = ?
          ORDER BY t.confidence DESC
          LIMIT ?`
      )
      .all(name, limit)
      .map((r) => {
        let kw = [];
        try { const p = JSON.parse(r.keywords || '[]'); if (Array.isArray(p)) kw = p; } catch { /* ignore */ }
        return { theme: String(r.theme_name || ''), keywords: kw.map(String), confidence: Number(r.confidence) || null };
      })
      .filter((r) => r.theme);
  }

  /**
   * 某集合下被"打回"的意见（用户明确说不要的）。
   *
   * 保留：这是学习闭环的一环（live-analyzer 拿它注入"避雷"）。
   * 粗剪审片的打回重剪已下线，但桌面端爆点候选否决（/highlight/reject）
   * 仍写 decision='recut'，加上库里的历史行，这里必须继续读。
   */
  getCollectionAvoidRules(collection, limit = 20) {
    const name = String(collection || '').trim();
    if (!name) return [];
    return this.db
      .prepare(
        `SELECT f.comment FROM review_feedback f
          WHERE f.collection = ? AND f.decision = 'recut' AND f.comment IS NOT NULL
          ORDER BY f.id DESC LIMIT ?`
      )
      .all(name, limit)
      .map((r) => String(r.comment || '').trim())
      .filter(Boolean);
  }

  setStyleProfile(key, value) {
    const stmt = this.db.prepare(`
      INSERT INTO user_style_profile (profile_key, profile_value)
      VALUES (@key, @value)
      ON CONFLICT(profile_key) DO UPDATE SET
        profile_value = @value,
        updated_at = datetime('now')
    `);
    stmt.run({ key, value: JSON.stringify(value) });
    this._profileCache = null;
  }

  // ──────────────────────────────────────────────
  // Statistics & Summary
  // ──────────────────────────────────────────────

  getStats() {
    const videoCount = this.db.prepare('SELECT COUNT(*) as count FROM video_records').get().count;
    const highlightCount = this.db.prepare('SELECT COUNT(*) as count FROM highlight_patterns').get().count;
    const retentionCount = this.db.prepare('SELECT COUNT(*) as count FROM retention_signals').get().count;
    const copyCount = this.db.prepare('SELECT COUNT(*) as count FROM copywriting_patterns').get().count;
    const speakerCount = this.db.prepare('SELECT COUNT(*) as count FROM speaker_profiles').get().count;

    // Genre distribution
    const genreDist = this.db.prepare(`
      SELECT genre, COUNT(*) as count FROM highlight_patterns
      WHERE genre IS NOT NULL GROUP BY genre ORDER BY count DESC
    `).all();

    // Average highlight intensity by peak type
    const peakTypeStats = this.db.prepare(`
      SELECT peak_type, AVG(intensity) as avg_intensity, COUNT(*) as count
      FROM highlight_patterns GROUP BY peak_type ORDER BY avg_intensity DESC
    `).all();

    // Copywriting type distribution
    const copyTypeDist = this.db.prepare(`
      SELECT pattern_type, AVG(effectiveness) as avg_effect, COUNT(*) as count
      FROM copywriting_patterns GROUP BY pattern_type ORDER BY avg_effect DESC
    `).all();

    return {
      videos: videoCount,
      highlights: highlightCount,
      retentionSignals: retentionCount,
      copywritingPatterns: copyCount,
      speakers: speakerCount,
      genreDistribution: genreDist,
      peakTypeStats,
      copywritingTypeDistribution: copyTypeDist
    };
  }

  // ──────────────────────────────────────────────
  // Hit Video Records
  // ──────────────────────────────────────────────

  upsertHitVideo(videoPath, data = {}) {
    // 2026-09-25 修：分隔符统一成正斜杠——接口传 D:/x、调度器扫到 D:////x 时
    // ON CONFLICT(video_path) 匹配不上，同一条素材会插出两条记录、双跑锁失效。
        videoPath = normalizeVideoPath(videoPath);
        /*
         * 2026-10-12：空路径直接拒绝，不能写进库。
         *
         * video_path 是 NOT NULL UNIQUE，而空串**能通过** NOT NULL 检查 ——
         * 于是第一个空路径 upsert 插出一条 video_path='' 的垃圾行，
         * 之后每一次空路径 upsert 都因 UNIQUE 冲突落到同一条 '' 行上互相覆盖。
         * 结果：所有“路径算错了”的调用共用一条记录，谁都能改它，
         * 而 listCollections / getCollectionHits 会把它当成一条真实素材统计进去。
         *
         * 宁可让调用方拿到明确的失败，也不要悄悄写一条共享的垃圾行。
         */
        if (!videoPath) {
          const e = new Error('videoPath 为空，拒绝写入（否则会往库里插一条共享的垃圾行）');
          e.code = 'EMPTY_VIDEO_PATH';
          throw e;
        }
        // 合并语义：只覆盖传入字段，防止 analyzing/completed 两次 upsert 互相清空
    /*
     * 2026-10-12：不再 SELECT *。
     *
     * hit_videos 带 full_transcript（整场逐字稿，几 MB~十几 MB），
     * SELECT * 会把整份全文稿复制进 JS 内存 —— 而这里只是为了读十几个标量字段
     * 做 merge。素材上万行时，每次 upsert 都是一次大 blob 拷贝。
     */
    const cur = this.db.prepare(
      'SELECT id, video_name, duration_ms, file_size, resolution, fps, genre, analysis_status,'
      + ' asr_path, collection, title FROM hit_videos WHERE video_path = ?'
    ).get(videoPath);
    const pick = (v, c) => (v !== undefined && v !== null ? v : (c !== undefined && c !== null ? c : null));
    const merged = {
      videoName: pick(data.videoName, cur?.video_name),
      durationMs: pick(data.durationMs, cur?.duration_ms),
      fileSize: pick(data.fileSize, cur?.file_size),
      resolution: pick(data.resolution, cur?.resolution),
      fps: pick(data.fps, cur?.fps),
      genre: pick(data.genre, cur?.genre),
      analysisStatus: pick(data.analysisStatus, cur?.analysis_status || 'pending'),
      analysisResult: pick(data.analysisResult, cur?.analysis_result),
      asrPath: pick(data.asrPath, cur?.asr_path),
      // 记忆维度：拆解结果留痕，重分析时被新值覆盖，否则保留旧值
      title: pick(data.title, cur?.title),
      openingScript: pick(data.openingScript, cur?.opening_script),
      fullTranscript: pick(data.fullTranscript, cur?.full_transcript),
      viralPoints: pick(data.viralPoints, cur?.viral_points),
      onScreenTexts: pick(data.onScreenTexts, cur?.on_screen_texts),
      coverFrame: pick(data.coverFrame, cur?.cover_frame),
      coverText: pick(data.coverText, cur?.cover_text),
      emotionCurve: pick(data.emotionCurve, cur?.emotion_curve),
    };
    const stmt = this.db.prepare(`
      INSERT INTO hit_videos (video_path, video_name, duration_ms, file_size, resolution, fps, genre, analysis_status, analysis_result, asr_path,
        title, opening_script, full_transcript, viral_points, on_screen_texts, cover_frame, cover_text, emotion_curve)
      VALUES (@videoPath, @videoName, @durationMs, @fileSize, @resolution, @fps, @genre, @analysisStatus, @analysisResult, @asrPath,
        @title, @openingScript, @fullTranscript, @viralPoints, @onScreenTexts, @coverFrame, @coverText, @emotionCurve)
      ON CONFLICT(video_path) DO UPDATE SET
        video_name = @videoName,
        duration_ms = @durationMs,
        file_size = @fileSize,
        resolution = @resolution,
        fps = @fps,
        genre = @genre,
        analysis_status = @analysisStatus,
        analysis_result = @analysisResult,
        asr_path = @asrPath,
        title = @title,
        opening_script = @openingScript,
        full_transcript = @fullTranscript,
        viral_points = @viralPoints,
        on_screen_texts = @onScreenTexts,
        cover_frame = @coverFrame,
        cover_text = @coverText,
        emotion_curve = @emotionCurve,
        -- 2026-09-24 修：以前每次 upsert（哪怕只是登记成 analyzing）都刷新 analyzed_at，
        -- 而 scheduler 用 analyzed_at > deep_memory.updated_at 挑"补深解"对象 → 反复重跑。
        -- 只有真正分析完成时才记时间。
        analyzed_at = CASE WHEN @analysisStatus = 'completed' THEN datetime('now') ELSE analyzed_at END
    `);
    stmt.run({ videoPath, ...merged });
    const row = this.db.prepare('SELECT id FROM hit_videos WHERE video_path = ?').get(videoPath);
    return row?.id;
  }

  updateHitVideo(id, data) {
    const fields = [];
    const params = { id };
    /*
     * 2026-10-21 修：时间列统一口径。
     *
     * 以前 analyzed_at / failed_at 经这里直接写 JS 的 toISOString()
     *（'2026-10-21T09:30:00.123Z'），而 deep_memory.updated_at 是 SQL 的
     * datetime('now')（'2026-10-21 09:30:05'）。scheduler 的深度补全判断
     * `v.analyzed_at > d.updated_at` 是 SQLite 的**字符串字典序**：
     * 同一天里 'T' (0x54) 恒大于 ' ' (0x20)，于是"同日永远判定更新过" ——
     * 每 30 秒把同一条素材重新完整跑一遍深度分析，直到 UTC 翻天才消停。
     * 统一成 SQL 的 'YYYY-MM-DD HH:MM:SS'（UTC）假象格式（datetime('now') 同口径）。
     */
    for (const [key, value] of Object.entries(data)) {
      // 2026-10-12 修：原来把 data 的键直接拼进 SET 子句，而 params 是 {id} 起步的 ——
      // 于是 data 里只要带 id（`{...req.body}` 这种写法很常见）就会把 params.id 覆盖掉，
      // 生成 `UPDATE hit_videos SET id = @id WHERE id = @id`：改的是**另一行**，
      // 而调用方以为改成功了。静默改错行比抛异常难查得多。
      if (key === 'id') continue;
      const dbKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
      fields.push(`${dbKey} = @${dbKey}`);
      params[dbKey] = TS_COLUMNS.has(dbKey) && value ? normalizeSqlTs(value) : value;
    }
    if (fields.length === 0) return;
    const sql = `UPDATE hit_videos SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  // 历史上并发 upsert 曾给同一路径留下多行（新分析写进新行、列表读旧行 → 永远显示 failed）。
  // 统一取 id 最大的那行，保证"刚分析完"的结果能被读到。
  getHitVideo(videoPath) {
    return this.db.prepare('SELECT * FROM hit_videos WHERE video_path = ? ORDER BY id DESC LIMIT 1').get(normalizeVideoPath(videoPath));
  }

  /**
   * 只要分析状态（2026-10-12）。
   *
   * 调度器每 30 秒对**每个**候选文件调一次 getHitVideo —— 而 hit_videos 带
   * full_transcript（整场逐字稿，几 MB~十几 MB），SELECT * 一次就是一份大 blob
   * 拷贝扔掉。热路径只需要 status，投影两个列就够。
   */
  getHitVideoStatus(videoPath) {
    return this.db.prepare('SELECT analysis_status FROM hit_videos WHERE video_path = ? ORDER BY id DESC LIMIT 1')
      .get(normalizeVideoPath(videoPath));
  }

  getHitVideoById(id) {
    return this.db.prepare('SELECT * FROM hit_videos WHERE id = ?').get(id);
  }

  // ──────────────────────────────────────────────
  // 文件夹（一个 IP/老师一个文件夹；剪片时选哪个文件夹 = 用哪套爆款记忆）
  // 文件夹是真实的实体（collections 表）：点"新建"就落库，哪怕里面还没素材也一直在列表里，
  // 不会出现"建完却看不到"的情况。素材归属记在 hit_videos.collection 上，两边名字对应。
  // ──────────────────────────────────────────────

  /** 文件夹名规范：去首尾空格、限长；空名返回 null */
  _normCollection(name) {
    // 'null' / 'undefined' 这类字符串不是文件夹名。
    // 调用方经常写 String(x ?? null) 之类的转换，传进来就是字符串 "null"，
    // 而它能通过 `collection ? ... : null` 的真值判断，于是被当成一个真实文件夹存进库 ——
    // 之后按真实名字查询永远查不到，也不报任何错。
    //（addHotword 早就单独防了这��，而同类路径没有，属于防护不一致。）
    if (name === null || name === undefined) return null;
    const raw = typeof name === 'string' ? name : String(name);
    if (/^(null|undefined|NULL|UNDEFINED)$/.test(raw.trim())) return null;
    const n = raw.trim().slice(0, 40);
    return n || null;
  }

  /**
   * collection 入参的统一解析（2026-10-12）。
   *
   * 三态约定（全库只有这一处实现，之前散着 9 份各自的 inline 归一）：
   *   undefined → 用当前活跃文件夹（省略 = 跟随当前）
   *   null      → 通用（对所有文件夹生效）
   *   '字符串'  → 该文件夹（trim + 限长 40）
   *
   * 为什么必须统一：归一口径不一致时，`upsertLiveVideo` 写进去的名字
   * 和 renameCollection / getEditArchive 用 _normCollection 规范化后的名字对不上 ——
   * 于是改名/归档**静默失效**，界面显示改成功了，记忆还留在旧名下。
   */
  _resolveCollection(collection) {
    if (collection === undefined) return this.activeCollection ?? null;
    if (collection === null) return null;
    return this._normCollection(collection);
  }

  createCollection(name) {
    const n = this._normCollection(name);
    if (!n) return { ok: false, error: '文件夹名不能为空' };
    this.db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(n);
    return { ok: true, name: n };
  }

  /** 重命名文件夹：表记录和素材归属一起改 */
  renameCollection(oldName, newName) {
    const o = this._normCollection(oldName);
    const n = this._normCollection(newName);
    if (!o || !n) return { ok: false, error: '名字不能为空' };
    if (o === n) return { ok: true, name: n, updated: 0 };
    /*
     * 必须把所有带 collection 的表一起改。
     *
     * 以前只改 hit_videos，结果"祝老师"改名后：
     *   - 爆款素材跟着走了
     *   - review_feedback / review_edits 还挂在旧名下 → 归档断裂，
     *     用户以为学到的偏好跟着老师一起搬过去了，实际没有
     *   - live_videos 同样掉队 → 之后新建的审片又记回旧名
     *
     * 表现是"改了名之后记忆好像失忆了"，而且不报任何错。
     * 列在这里是刻意的：以后加带 collection 的表，忘了加进来就会重现同样的问题。
     */
    const COLLECTION_TABLES = ['hit_videos', 'live_videos', 'review_feedback', 'review_edits', 'hotwords'];
    this.db.transaction(() => {
      // 新名已存在时把旧文件夹的素材并进去，再删掉旧记录
      this.db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(n);
      this.db.prepare('DELETE FROM collections WHERE name = ?').run(o);
      for (const t of COLLECTION_TABLES) {
        try {
          this.db.prepare(`UPDATE ${t} SET collection = ? WHERE collection = ?`).run(n, o);
        } catch (err) {
          /*
           * 2026-10-12：这个 catch 原来完全为空，连消息都没有。
           * 注释说"老库可能还没建这张表，跳过即可"，但它同时吞掉了
           * SQLITE_BUSY / SQLITE_CORRUPT / 磁盘满 / 语法错误 ——
           * 而外层是事务，任何一张表改名失败都会导致**全部回滚**，
           * 表却照样返回 ok:true。表现就是"改了名之后记忆好像失忆了，而且不报任何错"。
           *
           * 至少要区分"表不存在"（可忽略）和"真的写失败了"（必须让人看见）。
           */
          const msg = String(err?.message || err);
          const ignorable = /no such table/i.test(msg);
          if (ignorable) {
            // 老库缺表：跳过，下面的 _addMissingColumns 会补
          } else {
            console.error(`[Store] renameCollection 在 ${t} 上失败：${msg}`);
            throw err; // 让事务回滚，不要留下改了一半的库
          }
        }
      }
    })();
    return {
      ok: true,
      name: n,
      updated: this.db.prepare('SELECT COUNT(*) c FROM hit_videos WHERE collection = ?').get(n).c
    };
  }

  /** 删除文件夹记录本身（素材归属清不清由调用方决定） */
  deleteCollectionRecord(name) {
    const n = this._normCollection(name);
    if (!n) return { ok: false, error: '名字不能为空' };
    this.db.prepare('DELETE FROM collections WHERE name = ?').run(n);
    return { ok: true };
  }

  listCollections() {
    try {
      // 表里的文件夹（可能为空）∪ 素材实际归属的文件夹，合并成完整列表
      const agg = this.db.prepare(
        `SELECT collection AS name, COUNT(*) AS count,
                SUM(CASE WHEN analysis_status = 'completed' THEN 1 ELSE 0 END) AS learned
         FROM hit_videos WHERE collection IS NOT NULL AND collection <> ''
         GROUP BY collection`
      ).all();
      const byName = new Map(agg.map((r) => [r.name, r]));
      let rows = [];
      try {
        rows = this.db.prepare('SELECT name FROM collections ORDER BY name').all();
      } catch { /* 老库还没有 collections 表 */ }
      for (const r of rows) {
        if (!byName.has(r.name)) byName.set(r.name, { name: r.name, count: 0, learned: 0 });
      }
      const folders = [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const total = this.db.prepare('SELECT COUNT(*) c FROM hit_videos').get().c || 0;
      return { all: total, folders };
    } catch {
      return { all: 0, folders: [] };
    }
  }

  /**
   * 批量归入文件夹，并把改动前的归属记进 undo 栈。
   *
   * 2026-09-27：以前这函数直接 UPDATE，改错了没法还原——批量操作尤其致命
   * （一勾十来条点错文件夹就是一整批素材的归属错乱）。
   * 这里把每条素材的旧 collection 存进内存栈，接口层暴露"撤销上一次归类"。
   * 只存最近一次批量操作（老板反馈的场景就是"刚点错了想退回"），进程重启即失效，
   * 不往库里塞表，保持轻量。
   */
  setHitCollection(ids, name) {
    const val = this._normCollection(name);
    if (val) this.db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(val);
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
    if (!list.length) return 0;

    // 先记录旧值，再改
    const prev = [];
    try {
      const q = this.db.prepare('SELECT id, collection FROM hit_videos WHERE id = ?');
      for (const id of list) {
        const row = q.get(id);
        if (row) prev.push({ id, collection: row.collection ?? null });
      }
    } catch { /* 读不到旧值不影响归类本身 */ }

    // 2026-10-12 补事务：原来 N 条 UPDATE 各自独立自动提交。
    // 批量归类跑到一半失败/进程被杀，就留下"一半新文件夹、一半旧文件夹"的混合态，
    // 而接口照样回 ok 并弹出"可撤销" —— 用户以为整个文件夹都归好了。
    // better-sqlite3 的 transaction() 是同步的，这里没有 await，不会被打断。
    const applyAll = this.db.transaction((ids) => {
      const stmt = this.db.prepare('UPDATE hit_videos SET collection = ? WHERE id = ?');
      let n = 0;
      for (const id of ids) n += stmt.run(val, id).changes;
      return n;
    });
    let n = 0;
    try {
      n = applyAll(list);
    } catch (err) {
      console.warn(`[Store] 批量归类失败，已回滚（${err.message}）`);
      throw err;
    }

    if (n > 0 && prev.length) {
      this._lastCollectionUndo = { at: Date.now(), to: val, items: prev };
    }
    return n;
  }

  /** 上一次归类操作的摘要（供界面判断是否显示"撤销"按钮） */
  peekCollectionUndo() {
    const u = this._lastCollectionUndo;
    if (!u || !u.items?.length) return null;
    return { at: u.at, to: u.to, count: u.items.length };
  }

  /**
   * 撤销上一次归类：把每条素材的 collection 恢复成改动前的值。
   * @returns {{restored:number, to:string|null}}
   */
  undoLastCollection() {
    const u = this._lastCollectionUndo;
    if (!u || !u.items?.length) return { restored: 0, to: null };
    // 同 setHitCollection：批量撤销也必须在事务里。
    // 否则撤到一半失败 → 素材处于新旧文件夹混合状态，而 _lastCollectionUndo
    // 又被置空（下面那行），用户连重试的机会都没有。
    const restoreAll = this.db.transaction((items) => {
      const stmt = this.db.prepare('UPDATE hit_videos SET collection = ? WHERE id = ?');
      let n = 0;
      for (const it of items) n += stmt.run(it.collection, it.id).changes;
      return n;
    });
    let n = 0;
    try {
      n = restoreAll(u.items);
    } catch (err) {
      console.warn(`[Store] 撤销归类失败，已回滚（${err.message}）`);
      throw err; // 保留 _lastCollectionUndo，让用户还能再试一次
    }
    this._lastCollectionUndo = null; // 一次操作只撤销一次，避免来回抖动
    return { restored: n, to: u.to };
  }

  /**
   * 物理删除前的最后一道闸（2026-09-24 安全加固）。
   * 扩展名必须是媒体，且不能落在系统盘目录 / 程序目录 / 用户配置目录。
   * 正常删素材走的是 upload/hits，不受影响。
   */
  _isSafeToUnlink(p) {
    const low = String(p || '').toLowerCase();
    if (!/\.(mp4|mov|mkv|webm|flv|avi|m4v|ts|mp3|wav|m4a|aac|flac)$/.test(low)) return false;
    /*
     * 2026-10-12 修：判定恒为 false，等于这道闸门从来没生效。
     *
     * 所有写入路径都做了 replace(/\\/g,'/')（见三个 upsert），
     * 所以这里的 low 一定是正斜杠；而 forbidden 来自环境变量，是反斜杠，
     * 原判定 `low.startsWith(d + '\\')` 在 'c:/windows/…' 和 'c:\windows' 之间比 ——
     * 分隔符不一致，永远匹配不上，任何系统目录都能通过。
     *
     * 修法：两边都归一成正斜杠再去掉尾斜杠，然后比前缀。
     */
    const norm = (s) => normalizeVideoPath(s).toLowerCase();
    const target = norm(low);
    const forbidden = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
      process.env.ProgramData, process.env.USERPROFILE, process.env.LOCALAPPDATA]
      .filter(Boolean).map(norm).filter(Boolean);
    return !forbidden.some((d) => target === d || target.startsWith(d + '/'));
  }

  /**
   * 删关联表时容错"表还没建"。
   * deep_memory / sentence_cuts / sentence_clean_cache 都是各模块按需 CREATE 的，
   * 用户一次都没用过对应功能时这几张表根本不存在 —— 直接 prepare 会抛 no such table，
   * 而这是在 db.transaction 里，一次抛出会让整条素材删除全部回滚（等于删不掉素材）。
   */
  _safeDelete(sql, ...params) {
    try {
      this.db.prepare(sql).run(...params);
    } catch (err) {
      if (!/no such table/i.test(String(err?.message || ''))) throw err;
    }
  }

  /**
   * 清除素材：只删这条素材在记忆库里的一切（记录 + 拆解 + 主题 + 预测 + 实际数据），
   * deleteFiles=true 时连 upload/hits 里的源视频一起删（默认不动源文件）。
   */
  deleteHits(ids, deleteFiles = false) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
    if (!list.length) return { deleted: 0, files: 0, paths: [] };
    const paths = [];
    let files = 0;
    let deletedRows = 0; // 真实删掉的行数（以前直接返回请求条数，界面上"已清除 N 条"可能是假的）
    const run = this.db.transaction(() => {
      for (const id of list) {
        const row = this.db.prepare('SELECT id, video_path FROM hit_videos WHERE id = ?').get(id);
        const p = row?.video_path || null;
        if (p) paths.push(p);
        this.db.prepare('DELETE FROM hit_performance WHERE hit_video_id = ?').run(id);
        this.db.prepare('DELETE FROM hit_predictions WHERE hit_video_id = ?').run(id);
        this.db.prepare('DELETE FROM hit_structure WHERE hit_video_id = ?').run(id);
        this.db.prepare('DELETE FROM hit_themes WHERE hit_video_id = ?').run(id);
        // 深解记录：deep-analyzer 自己建的表，以前删素材时漏删，残留会让"深解进度"虚高、
        // 也会让补深解任务挑到一条主记录已经不存在的孤儿。
        this._safeDelete('DELETE FROM deep_memory WHERE hit_video_id = ?', id);
        // 转写/话术这些挂在 video_records 上，按路径一起清，避免留下孤儿
        if (p) {
          // 逐句成片留痕
          this._safeDelete('DELETE FROM sentence_cuts WHERE video_path = ?', p);
          // 挑句清洗缓存：key 是 'path:'+路径+':'+句数，同路径重投喂会命中上次结果。
          // 不删的话，素材删掉再传同名文件，会直接复用旧清洗结果（且不报任何提示）。
          // LIKE 的通配符必须转义：Windows 路径里 _ 和 % 很常见（D:\a_b\c.mp4），
          // 不转义会被当成"单字符/任意字符"通配，把别的视频的清洗缓存一起删掉。
          const likeKey = `path:${String(p).replace(/[\\%_]/g, (m) => `\\${m}`)}:%`;
          this._safeDelete('DELETE FROM sentence_clean_cache WHERE video_key LIKE ? ESCAPE \'\\\'', likeKey);
          const vr = this.db.prepare('SELECT id FROM video_records WHERE video_path = ?').get(p);
          if (vr) {
            this.db.prepare('DELETE FROM copywriting_patterns WHERE video_id = ?').run(vr.id);
            this.db.prepare('DELETE FROM retention_signals WHERE video_id = ?').run(vr.id);
            this.db.prepare('DELETE FROM video_records WHERE id = ?').run(vr.id);
          }
        }
        deletedRows += this.db.prepare('DELETE FROM hit_videos WHERE id = ?').run(id).changes || 0;
        if (deleteFiles && p) {
          try {
            // 2026-09-24 加固：video_path 来自接口入参，以前直接 unlinkSync，
            // 配合 /pipeline/analyze-hit 能造记录删任意文件。这里只放行媒体文件且避开系统目录。
            if (existsSync(p) && this._isSafeToUnlink(p)) { unlinkSync(p); files++; }
            else if (existsSync(p)) console.warn('[Store] 拒绝删除非媒体/敏感路径:', p);
          } catch { /* 删不掉就算了，记忆已经清了 */ }
        }
      }
    });
    run();
    // 关键帧目录（data/frames/hit_<id>）不跟着删会一直堆：素材早删了，几百 MB 的 png 还在。
    // 放在事务外：文件系统删除不该占着写锁。
    let frameDirs = 0;
    for (const id of list) {
      try {
        const d = join(__dirname, '..', '..', 'data', 'frames', `hit_${id}`);
        if (existsSync(d)) { rmSync(d, { recursive: true, force: true }); frameDirs++; }
      } catch { /* 删不掉不影响记忆已清 */ }
    }
    return { deleted: deletedRows, requested: list.length, files, frameDirs, paths };
  }

  /** 文件已经不在磁盘上的素材记录（上传后又手工删了文件留下的空壳） */
  findOrphanHits(collection) {
    const rows = collection === undefined || collection === null
      ? this.db.prepare('SELECT id, video_path, video_name, analysis_status, collection FROM hit_videos').all()
      : this.db.prepare('SELECT id, video_path, video_name, analysis_status, collection FROM hit_videos WHERE collection = ?')
          .all(this._resolveCollection(collection));
    return rows.filter((r) => r.video_path && !existsSync(r.video_path));
  }

  /**
   * 清掉"文件已不在磁盘"的空壳记录。
   *
   * 2026-10-12 改成异步。
   *
   * 原来对每行同步调 existsSync，在 Node 单线程里就是 N 次阻塞 syscall：
   * 网络盘/机械盘上一次 stat 几毫秒，几百条素材就是一秒多的事件循环卡死 ——
   * 而这个接口是**看板按钮 + 调度器每天一次**都会调用的，卡住的是整个服务。
   *
   * 三个改法：
   *   - fs.promises.stat：交给线程池，不再堵事件循环
   *   - 按目录去重：素材通常成堆放在少数几个目录里，原来同一个目录被反复 stat
   *   - 限制并发：一次几百个 stat 会把线程池打满，反而更慢
   *
   * collection 缺省时**只清当前文件夹**，不再跨文件夹扫 ——
   * 之前全库扫意味着：任一文件夹的素材被移走，另一个文件夹的正常记录也会被当成孤儿删掉。
   */
  async purgeOrphanHits(collection) {
    /*
     * 作用范围（这决定了"会不会删到别人的东西"）：
     *
     *   undefined / 某文件夹名 → 该文件夹 **+ 通用（collection IS NULL）**
     *   null（显式）           → 只清通用
     *
     * 为什么把通用一起带上：hit_videos.collection 是靠 setHitCollection 事后归类的，
     * 新素材入库时是 NULL，也就是"通用"—— 它在每个文件夹下都能看到，
     * 不属于任何一个具名文件夹，没有别的归属需要保护。文件真没了就是没了。
     *
     * 为什么绝不碰别的具名文件夹：原来是一条 SELECT 全库扫，
     * 任何一个文件夹的素材被移走/换盘，另一个文件夹的正常记录也会被当孤儿删掉，
     * 而且没有任何提示。
     */
    const col = this._resolveCollection(collection);
    const scope = col ? "(IFNULL(collection,'') = ? OR collection IS NULL)" : 'collection IS NULL';
    const args = col ? [col] : [];

    // 排除正在分析的：分析中的文件可能正在下载/移动，stat 不到是正常的
    const rows = this.db.prepare(
      `SELECT id, video_path FROM hit_videos
       WHERE ${scope} AND IFNULL(analysis_status,'') != 'analyzing'`
    ).all(...args);
    if (!rows.length) return { deleted: 0, found: 0, scanned: 0, dirs: 0 };

    // 按目录归组：同一目录下只 stat 一次目录本身，命中就整组判死
    const byDir = new Map();
    for (const r of rows) {
      if (!r.video_path) continue;
      const dir = dirname(r.video_path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(r);
    }
    // 目录太多的库不该靠调并发硬扛，先看现有素材量
    const dirs = [...byDir.keys()];
    const CONCURRENCY = 16;
    const dirGone = new Array(dirs.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, async () => {
        while (cursor < dirs.length) {
          const i = cursor++;
          try {
            // 先看目录还在不在：目录整个没了/换盘了，里面所有记录都是孤儿
            dirGone[i] = !(await stat(dirs[i]));
          } catch {
            // EACCES / EBUSY 之类拿不准的，当作"还在"，宁可留着也不误删
            dirGone[i] = false;
          }
        }
      })
    );

    const orphanIds = [];
    let scanned = 0;
    for (let i = 0; i < dirs.length; i++) {
      const group = byDir.get(dirs[i]);
      if (dirGone[i]) { orphanIds.push(...group.map((r) => r.id)); continue; }
      // 目录还在，逐条 stat
      for (const r of group) {
        scanned++;
        try { await stat(r.video_path); } catch { orphanIds.push(r.id); }
      }
    }

    if (!orphanIds.length) return { deleted: 0, found: 0, scanned, dirs: dirs.length };
    const result = this.deleteHits(orphanIds, false);
    return { ...result, found: orphanIds.length, scanned, dirs: dirs.length };
  }

  getAllHitVideos(limit = 100) {
    return this.db.prepare('SELECT * FROM hit_videos ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  getHitVideosByGenre(genre, limit = 50) {
    return this.db.prepare('SELECT * FROM hit_videos WHERE genre = ? ORDER BY analyzed_at DESC LIMIT ?').all(genre, limit);
  }

  // ──────────────────────────────────────────────
  // Hit Structure
  // ──────────────────────────────────────────────

  addHitStructure(data) {
    const stmt = this.db.prepare(`
      INSERT INTO hit_structure (hit_video_id, segment_type, start_ms, end_ms, duration_ms, description, key_text, emotion_tag, intensity, keyframe_path)
      VALUES (@hitVideoId, @segmentType, @startMs, @endMs, @durationMs, @description, @keyText, @emotionTag, @intensity, @keyframePath)
    `);
    /*
     * segment_type 是 NOT NULL，而它的值来自 LLM 的 JSON。
     * 以前这里不做任何兜底：模型某一段少给一个字段，SQLite 直接抛
     * NOT NULL constraint failed，异常一路冒到 analyze() 的 catch ——
     * 整条素材判 failed，前面已经算好的标题/要点/主题全部作废。
     * 一段结构写不进去，代价却是整条素材，这在结构上就不成比例。
     *
     * 归一化放在分析器里做（能按时长/位置推断类型，见 normalizeStructureSegment）；
     * 这里是最后一道闸：宁可写成 unknown 也不让整条分析陪葬。
     */
    const type = String(data.segmentType ?? '').trim() || 'unknown';
    const startMs = Math.round(Number(data.startMs) || 0);
    const endMs = Math.round(Number(data.endMs) || 0);
    const intensity = Number(data.intensity);
    return stmt.run({
      hitVideoId: data.hitVideoId,
      segmentType: type,
      startMs,
      endMs,
      durationMs: Number.isFinite(Number(data.durationMs)) && data.durationMs > 0
        ? Math.round(data.durationMs)
        : Math.max(0, endMs - startMs),
      description: data.description || '',
      keyText: data.keyText || '',
      emotionTag: data.emotionTag || '',
      intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5,
      keyframePath: data.keyframePath || null
    }).lastInsertRowid;
  }

  getHitStructureByVideo(hitVideoId) {
    return this.db.prepare('SELECT * FROM hit_structure WHERE hit_video_id = ? ORDER BY start_ms').all(hitVideoId);
  }

  // ──────────────────────────────────────────────
  // Hit Themes
  // ──────────────────────────────────────────────

  addHitTheme(data) {
    const stmt = this.db.prepare(`
      INSERT INTO hit_themes (hit_video_id, theme_name, confidence, keywords, related_segments)
      VALUES (@hitVideoId, @themeName, @confidence, @keywords, @relatedSegments)
    `);
    return stmt.run({
      hitVideoId: data.hitVideoId,
      // theme_name 是 NOT NULL。上游有 normalizeThemeName 兜底，
      // 但它也可能被绕过（比如以后新增一条写入路径），所以这里再兜一层。
      themeName: String(data.themeName ?? '').trim() || '未归类',
      // 夹到 0~1：模型返回 5 / -1 时直接落库的话，
      // getAllHitThemes 按 confidence 排序会把假数据排到最前
      confidence: MemoryStore.num(data.confidence, { min: 0, max: 1, fallback: 0.5 }),
      keywords: data.keywords ? JSON.stringify(data.keywords) : null,
      relatedSegments: data.relatedSegments ? JSON.stringify(data.relatedSegments) : null
    }).lastInsertRowid;
  }

  getHitThemesByVideo(hitVideoId) {
    return this.db.prepare('SELECT * FROM hit_themes WHERE hit_video_id = ?').all(hitVideoId);
  }

  getAllHitThemes(limit = 200) {
    return this.db.prepare('SELECT * FROM hit_themes ORDER BY confidence DESC LIMIT ?').all(limit);
  }

  // ──────────────────────────────────────────────
  // Live Videos
  // ──────────────────────────────────────────────

  /** 按路径反查直播 id:分析前绑定归属时用（那时 upsert 可能还没跑） */
  getLiveVideoIdByPath(videoPath) {
    if (!videoPath) return null;
    try {
      const p = normalizeVideoPath(videoPath);
      const row = this.db.prepare('SELECT id FROM live_videos WHERE video_path = ?').get(p);
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 这条直播归属哪位老师。
   *
   * 返回 undefined 表示"没绑定" —— 调用方据此回落到全局 activeCollection。
   * 刻意区分 undefined 和 null：前者是"不知道，用默认"，
   * 后者是"明确要用通用记忆"，两者混为一谈会让老数据全部失效。
   * @param {number} liveVideoId
   * @returns {string|undefined}
   */
  getLiveVideoCollection(liveVideoId) {
    if (!liveVideoId) return undefined;
    try {
      const row = this.db.prepare('SELECT collection FROM live_videos WHERE id = ?').get(liveVideoId);
      if (!row || row.collection === null || row.collection === undefined) return undefined;
      const v = String(row.collection).trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  /** 只要分析状态（2026-10-12，理由同 getHitVideoStatus） */
  getLiveVideoStatus(videoPath) {
    return this.db.prepare('SELECT analysis_status FROM live_videos WHERE video_path = ? LIMIT 1')
      .get(normalizeVideoPath(videoPath));
  }

  /** 把直播绑定到某位老师的记忆库。传 null/空 = 解绑（退回全局） */
  bindLiveVideoCollection(liveVideoId, collection) {
    if (!liveVideoId) return { ok: false, error: '缺少 liveVideoId' };
    // 统一走 _normCollection：这里原来只 trim 不限长 40，
    // 而 renameCollection / listCollections 用的是限长的口径 —— 超长名会两边对不上
    const col = this._normCollection(collection);
    try {
      const r = this.db.prepare('UPDATE live_videos SET collection = ? WHERE id = ?').run(col, liveVideoId);
      if (r.changes === 0) return { ok: false, error: `找不到直播 ${liveVideoId}` };
      return { ok: true, collection: col };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  upsertLiveVideo(videoPath, data = {}) {
    // 2026-09-25 修：分隔符统一成正斜杠——接口传 D:/x、调度器扫到 D:////x 时
    // ON CONFLICT(video_path) 匹配不上，同一条素材会插出两条记录、双跑锁失效。
        videoPath = normalizeVideoPath(videoPath);
        /*
         * 2026-10-12：空路径直接拒绝，不能写进库。
         *
         * video_path 是 NOT NULL UNIQUE，而空串**能通过** NOT NULL 检查 ——
         * 于是第一个空路径 upsert 插出一条 video_path='' 的垃圾行，
         * 之后每一次空路径 upsert 都因 UNIQUE 冲突落到同一条 '' 行上互相覆盖。
         * 结果：所有“路径算错了”的调用共用一条记录，谁都能改它，
         * 而 listCollections / getCollectionHits 会把它当成一条真实素材统计进去。
         *
         * 宁可让调用方拿到明确的失败，也不要悄悄写一条共享的垃圾行。
         */
        if (!videoPath) {
          const e = new Error('videoPath 为空，拒绝写入（否则会往库里插一条共享的垃圾行）');
          e.code = 'EMPTY_VIDEO_PATH';
          throw e;
        }
        // 合并语义：同上。分析中/建项目/回填分段数多次 upsert 不再互相清零，
    // 否则调度器会陷入“重分析→clip_count归零→重复建项目”死循环。
    // 同 upsertHitVideo：不 SELECT *（live_videos 也有 full_transcript）
    // 注意 live_videos 没有 genre / resolution / fps 这几列，别照抄 hit_videos 的列表
    const cur = this.db.prepare(
      'SELECT id, video_name, duration_ms, file_size, analysis_status, asr_path,'
      + ' collection, segment_count, clip_count FROM live_videos WHERE video_path = ?'
    ).get(videoPath);
    const pick = (v, c) => (v !== undefined && v !== null ? v : (c !== undefined && c !== null ? c : null));
    const merged = {
      videoName: pick(data.videoName, cur?.video_name),
      durationMs: pick(data.durationMs, cur?.duration_ms),
      fileSize: pick(data.fileSize, cur?.file_size),
      analysisStatus: pick(data.analysisStatus, cur?.analysis_status || 'pending'),
      asrPath: pick(data.asrPath, cur?.asr_path),
      segmentCount: pick(data.segmentCount, cur?.segment_count ?? 0),
      clipCount: pick(data.clipCount, cur?.clip_count ?? 0),
      // 2026-09-27：分析健康度（JSON 字符串）。传了才写，不传保留旧值，
      // 避免"登记成 analyzing"这种中途 upsert 把上一轮的体检结果冲掉。
      //
      // 收对象也要能正确序列化。以前只写 String(data.analysisHealth)，
      // 而取消分析那处传的是 health 对象 —— String({}) 得到 "[object Object]"，
      // 于是这一轮的体检记录整个报废（grade/error 都没了）。
      // 调度器和"重新分析"提示都靠读这个字段判断该不该重跑，记录没了它就瞎猜。
      analysisHealth: data.analysisHealth !== undefined && data.analysisHealth !== null
        ? (typeof data.analysisHealth === 'string' ? data.analysisHealth : JSON.stringify(data.analysisHealth))
        : (cur?.analysis_health ?? null),
      // 归属老师：只在显式传值时改。
      // 分析过程中会多次 upsert（登记 analyzing / 回填分段数），不显式传就沿用旧值，
      // 否则分析到一半绑定关系被抹掉，等于白绑。
      collection: data.collection !== undefined && data.collection !== null
        ? String(data.collection)
        : (cur?.collection ?? null),
    };
    const stmt = this.db.prepare(`
      INSERT INTO live_videos (video_path, video_name, duration_ms, file_size, analysis_status, asr_path, segment_count, clip_count, analysis_health, collection)
      VALUES (@videoPath, @videoName, @durationMs, @fileSize, @analysisStatus, @asrPath, @segmentCount, @clipCount, @analysisHealth, @collection)
      ON CONFLICT(video_path) DO UPDATE SET
        video_name = @videoName,
        duration_ms = @durationMs,
        file_size = @fileSize,
        analysis_status = @analysisStatus,
        asr_path = @asrPath,
        segment_count = @segmentCount,
        clip_count = @clipCount,
        analysis_health = @analysisHealth,
        collection = @collection,
        -- 2026-09-24 修：以前每次 upsert（哪怕只是登记成 analyzing）都刷新 analyzed_at，
        -- 而 scheduler 用 analyzed_at > deep_memory.updated_at 挑"补深解"对象 → 反复重跑。
        -- 只有真正分析完成时才记时间。
        analyzed_at = CASE WHEN @analysisStatus = 'completed' THEN datetime('now') ELSE analyzed_at END
    `);
    stmt.run({ videoPath, ...merged });
    const row = this.db.prepare('SELECT id FROM live_videos WHERE video_path = ?').get(videoPath);
    return row?.id;
  }

  getLiveVideo(videoPath) {
    return this.db.prepare('SELECT * FROM live_videos WHERE video_path = ?').get(normalizeVideoPath(videoPath));
  }

  getLiveVideoById(id) {
    return this.db.prepare('SELECT * FROM live_videos WHERE id = ?').get(id);
  }

  getAllLiveVideos(limit = 100) {
    return this.db.prepare('SELECT * FROM live_videos ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /**
   * 回填 UNIQUE 约束所依赖的唯一索引（2026-10-12）。
   *
   * `ON CONFLICT(col) DO UPDATE` 要求 col 上真的有 UNIQUE 约束。
   * 新库的建表语句带 UNIQUE，没问题；但**老库**是当年先建的表、后加的 UNIQUE
   * （或者压根没有），于是 upsert 会抛
   * "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"，
   * 而且每次调用都抛 —— 功能整个不可用。
   *
   * speaker_profiles 上这个坑踩过一次并修过（见 _init 里的 idx_speaker_label），
   * 但同样的补丁**没打到下面这三张表**。这里统一回填，并做前置去重 ——
   * 有重复行时建唯一索引会失败，必须先合并/删除，否则索引永远建不出来。
   */
  _ensureUniqueConstraints() {
    const specs = [
      { table: 'hit_performance', col: 'hit_video_id' },
      { table: 'hit_predictions', col: 'hit_video_id' },
      { table: 'openings_cache', col: 'cache_key' },
      // 注意是 speaker_label，不是 profile_key（那是 style_profile 的列）
      { table: 'speaker_profiles', col: 'speaker_label' },
    ];
    for (const { table, col } of specs) {
      try {
        /*
         * 已经有覆盖该列的唯一索引就别再建。
         *
         * 判据不能只看 origin='u'：UNIQUE **约束**生成的 sqlite_autoindex_* 是 'u'，
         * 而 CREATE UNIQUE INDEX 建出来的是 'c' —— idx_speaker_label 就属于后者。
         * 只认 'u' 的话会给已经有唯一索引的表再补一份完全重复的 B 树，
         * 每次 INSERT 都得多维护一次（这台的库里 idx_speaker_label 就是这个情况）。
         */
        const covered = this.db.prepare(
          `SELECT 1 FROM pragma_index_list(?) AS l
           WHERE l."unique" = 1
             AND EXISTS (SELECT 1 FROM pragma_index_info(l.name) AS ii WHERE ii.name = ?)`
        ).get(table, col);
        if (covered) continue;
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_${col} ON ${table}(${col})`);
      } catch (err) {
        // 多半是已有重复数据 —— 明确报出来，不要静默：
        // 静默的后果是每次 upsert 都抛，而错误信息指向 upsert，根本查不到这里。
        //
        // 诊断查询自己也要 try：表不存在 / 列还没有时 prepare 会抛，
        // 那样会把原本的 warn 变成一次启动失败（构造函数里没有兜底）。
        let dupNote = '';
        try {
          const dup = this.db.prepare(
            `SELECT ${col} k, COUNT(*) c FROM ${table} WHERE ${col} IS NOT NULL GROUP BY ${col} HAVING c > 1 LIMIT 5`
          ).all();
          if (dup.length) dupNote = `；已有重复值 ${dup.map((d) => `${d.k}×${d.c}`).join(', ')}（upsert 会因此报错）`;
        } catch { /* 表/列还没建，按无重复处理 */ }
        console.warn(`[Store] ${table}.${col} 的唯一索引建不出来：${err.message}${dupNote}`);
      }
    }
  }

  /**
   * 建 collection 相关索引（2026-10-12）。
   *
   * 单独拎出来、放在 _addMissingColumns 之后，理由见调用处注释。
   * 逐条 try：某一张表/列在极老的库上不存在时，只跳过那一条，
   * 不能因此让整个索引段失败（_init 里就是踩这个坑）。
   */
  _ensureCollectionIndexes() {
    const pairs = [
      ['idx_hit_video_collection', 'hit_videos'],
      ['idx_live_video_collection', 'live_videos'],
      ['idx_review_feedback_collection', 'review_feedback'],
      ['idx_hotwords_collection', 'hotwords'],
    ];
    for (const [idx, table] of pairs) {
      try {
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table}(collection)`);
      } catch (err) {
        // 表或列不存在（极老的库）：跳过这一条，不影响其余
        console.warn(`[Store] 建索引 ${idx} 失败: ${err.message}`);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Live Segments
  // ──────────────────────────────────────────────

  addLiveSegment(data) {
    const stmt = this.db.prepare(`
      INSERT INTO live_segments (live_video_id, segment_index, start_ms, end_ms, duration_ms, theme_name, theme_confidence, matched_hit_themes, hook_quality, peak_count, transcript_summary, status, viral_potential, recommended_action)
      VALUES (@liveVideoId, @segmentIndex, @startMs, @endMs, @durationMs, @themeName, @themeConfidence, @matchedHitThemes, @hookQuality, @peakCount, @transcriptSummary, @status, @viralPotential, @recommendedAction)
    `);
    /*
     * start_ms / end_ms 是 NOT NULL，值来自 LLM 的 JSON（live-analyzer 传
     * Math.round(seg.start_seconds * 1000)）。模型少给一个字段 → NaN →
     * better-sqlite3 把 undefined/NaN 绑成 NULL → 直接抛
     * NOT NULL constraint failed → 整场直播分析判 failed。
     *
     * 这和 hit_structure.segment_type 是同一个坑（已修），这里还没修。
     * 一场 3 小时直播的分段是几十上百条，为其中一条的时间戳把整场扔掉不成比例。
     *
     * 时间轴也要自洽：end < start 的段会让下游 ffmpeg 切出负时长，
     * 直接把 end 夹到 start（写成零长度段），比写脏数据安全。
     */
    const rawStart = Math.round(Number(data.startMs));
    const rawEnd = Math.round(Number(data.endMs));
    const startMs = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
    const endMs = Number.isFinite(rawEnd) ? Math.max(startMs, rawEnd) : startMs;
    const rawDur = Math.round(Number(data.durationMs));
    const conf = Number(data.themeConfidence);
    const hook = Number(data.hookQuality);
    return stmt.run({
      liveVideoId: data.liveVideoId,
      segmentIndex: Number.isFinite(Number(data.segmentIndex)) ? Number(data.segmentIndex) : 0,
      startMs,
      endMs,
      durationMs: Number.isFinite(rawDur) && rawDur > 0 ? rawDur : (endMs - startMs),
      themeName: data.themeName || null,
      // `|| 0.5` 是 falsy-zero 陷阱：模型明确给 0（"完全没信心"）会被吞成 0.5
      themeConfidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,      matchedHitThemes: data.matchedHitThemes ? JSON.stringify(data.matchedHitThemes) : null,
      hookQuality: Number.isFinite(hook) ? Math.min(1, Math.max(0, hook)) : 0.5,      peakCount: Number.isFinite(Number(data.peakCount)) ? Math.max(0, Number(data.peakCount)) : 0,
      transcriptSummary: data.transcriptSummary || '',
      /*
       * 爆款价值分与建议动作（2026-10-14 补）。
       *
       * live-analyzer 的 _matchAllWithHitThemes 早就把这两项算出来了
       * （拿爆款主题库 + 创作者历史评判去匹配每一段），
       * 但表里没有这两列、也没往接口返回，于是它们在写库那一刻被丢掉。
       *
       * 后果就是界面只能拿 hook_quality 当分数，
       * 而默认勾选判据是 `score100 >= 60` —— 于是只要钩子分过 60 就默认选中。
       * 一场 3 小时直播的 255 段里有 190 段中招，
       * 而爆款素材的时长中位数是 554 秒，选中的却是清一色 20 秒的段。
       * 用户看到的"全是垃圾"，根因就在这里：**爆款逻辑算了，但没有出口。**
       */
      viralPotential: Number.isFinite(Number(data.viralPotential))
        ? Math.min(1, Math.max(0, Number(data.viralPotential)))
        : null,
      recommendedAction: data.recommendedAction || null,
      status: data.status || 'draft'
    }).lastInsertRowid;
  }

  /**
   * 这条直播的活跃分段。
   *
   * 必须过滤 status='draft'：重新分析时若检测到有未完成的粗剪项目引用旧分段，
   * 会跳过清空（防止 selected_segments 悬空）并把旧批次标成 superseded。
   * 不加这个过滤，同一个 segment_index 会返回新旧两条 ——
   * 按 index 取分段时拿到的是上一轮内容，剪出来的东西不对还不报错。
   */
  getLiveSegmentsByVideo(liveVideoId) {
    return this.db
      .prepare(
        "SELECT * FROM live_segments WHERE live_video_id = ? AND status = 'draft' ORDER BY segment_index"
      )
      .all(liveVideoId);
  }

  /**
   * 按 id 取段，不过滤 status。
   *
   * 用途：按工程里记的 segmentId 找回段（orchestrator._segmentsByIndex）。
   * 打回重剪已下线，但 /pipeline/clip 与 /pipeline/set-selection 仍走这条回捞。
   *
   * 为什么不能只靠 getLiveSegmentsByVideo：它只返回 draft。
   * 而一场直播重分析后，旧段会被标成 superseded（同一条视频、起止时间没变，
   * 只是内容描述换了一批），此时重分析之前建的粗剪工程引用的正是那批旧段 id。
   * 只认 draft 的话，用户在审一条旧粗剪、说"把开头那句去掉"，
   * 却收到"这段素材没有可用内容"，逼他把两小时的直播重新分析一遍。
   *
   * 代价可控：源视频文件是同一个，起止时间没变，切出来仍然是当初那段内容。
   */
  getLiveSegmentsByIds(ids) {
    /*
     * 2026-10-12：只接受正整数 id。
     *
     * 原来 .map(Number).filter(Number.isFinite) 会放过一批垃圾输入：
     *   Number(true)=1  → 静默返回 id=1 的段（！）
     *   Number(null)=0  → 虽然查不到，但混在列表里不好排查
     *   Number('12abc')=12
     * 上游是接口直传的 segmentIds，这种输入现实存在（前端 bug / 手改请求）。     */
    const list = [...new Set(
      (Array.isArray(ids) ? ids : [ids])
        .map((n) => MemoryStore.num(n, { integer: true, fallback: null }))
        .filter((n) => n !== null && n > 0)
    )];
    if (!list.length) return [];
    const CHUNK = 500;
    const out = [];
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      out.push(
        ...this.db
          .prepare(
            `SELECT * FROM live_segments WHERE live_video_id IS NOT NULL AND id IN (${part.map(() => "?").join(",")})`
          )
          .all(...part)
      );
    }
    return out;
  }

  updateLiveSegmentStatus(id, status) {
    this.db.prepare('UPDATE live_segments SET status = ? WHERE id = ?').run(status, id);
  }

  // ──────────────────────────────────────────────
  // Clip Projects
  // ──────────────────────────────────────────────

  createClipProject(data) {
    const stmt = this.db.prepare(`
      INSERT INTO clip_projects (live_video_id, project_name, status, selected_segments, total_duration_ms, output_path)
      VALUES (@liveVideoId, @projectName, @status, @selectedSegments, @totalDurationMs, @outputPath)
    `);
    return stmt.run({
      liveVideoId: data.liveVideoId,
      projectName: data.projectName || null,
      status: data.status || 'pending',
      selectedSegments: data.selectedSegments ? JSON.stringify(data.selectedSegments) : null,
      totalDurationMs: data.totalDurationMs || 0,
      outputPath: data.outputPath || null
    }).lastInsertRowid;
  }

  getClipProject(id) {
    const row = this.db.prepare('SELECT * FROM clip_projects WHERE id = ?').get(id);
    if (row) {
      row.selected_segments = row.selected_segments ? JSON.parse(row.selected_segments) : [];
    }
    return row;
  }

  updateClipProject(id, data) {
    const fields = [];
    const params = { id };
    for (const [key, value] of Object.entries(data)) {
      // 同 updateHitVideo：data 里带 id 会覆盖 params.id，改到别的行上去
      if (key === 'id') continue;
      const dbKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
      fields.push(`${dbKey} = @${dbKey}`);
      params[dbKey] = value;
    }
    if (fields.length === 0) return;
    const sql = `UPDATE clip_projects SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  // ──────────────────────────────────────────────
  // Clip Outputs
  // ──────────────────────────────────────────────

  addClipOutput(data) {
    const stmt = this.db.prepare(`
      INSERT INTO clip_outputs (clip_project_id, output_type, file_path, duration_ms, file_size, metadata)
      VALUES (@clipProjectId, @outputType, @filePath, @durationMs, @fileSize, @metadata)
    `);
    return stmt.run({
      clipProjectId: data.clipProjectId,
      outputType: data.outputType,
      filePath: data.filePath,
      durationMs: data.durationMs || 0,
      fileSize: data.fileSize || 0,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null
    }).lastInsertRowid;
  }

  getClipOutputsByProject(clipProjectId) {
    return this.db.prepare('SELECT * FROM clip_outputs WHERE clip_project_id = ?').all(clipProjectId);
  }

  // ──────────────────────────────────────────────
  // User Queries
  // ──────────────────────────────────────────────

  addUserQuery(data) {
    const stmt = this.db.prepare(`
      INSERT INTO user_queries (project_id, query_type, question, context, options, answer, status)
      VALUES (@projectId, @queryType, @question, @context, @options, @answer, @status)
    `);
    return stmt.run({
      projectId: data.projectId || null,
      queryType: data.queryType,
      question: data.question,
      context: data.context ? JSON.stringify(data.context) : null,
      options: data.options ? JSON.stringify(data.options) : null,
      answer: data.answer || null,
      status: data.status || 'pending'
    }).lastInsertRowid;
  }

  getUserQuery(id) {
    const row = this.db.prepare('SELECT * FROM user_queries WHERE id = ?').get(id);
    if (row) {
      row.context = row.context ? JSON.parse(row.context) : {};
      row.options = row.options ? JSON.parse(row.options) : [];
    }
    return row;
  }

  getPendingUserQueries(limit = 20) {
    return this.db.prepare('SELECT * FROM user_queries WHERE status = ? ORDER BY created_at LIMIT ?').all('pending', limit);
  }

  answerUserQuery(id, answer) {
    this.db.prepare(`
      UPDATE user_queries SET answer = ?, status = 'answered', answered_at = datetime('now') WHERE id = ?
    `).run(answer, id);
  }

  // ──────────────────────────────────────────────
  // Review Feedback (approve / recut -> memory)
  // ──────────────────────────────────────────────

  addReviewFeedback({ clipProjectId, liveVideoId, decision, segmentIds, comment, collection = undefined }) {
    // 归属规则与 addReviewLesson 一致：省略 = 当前活跃文件夹；显式 null = 通用（所有文件夹生效）
    const col = this._resolveCollection(collection);
    return this.db.prepare(`
      INSERT INTO review_feedback (clip_project_id, live_video_id, decision, segment_ids, comment, collection)
      VALUES (@clipProjectId, @liveVideoId, @decision, @segmentIds, @comment, @collection)
    `).run({
      clipProjectId: clipProjectId || null,
      liveVideoId: liveVideoId || null,
      decision,
      segmentIds: segmentIds ? JSON.stringify(segmentIds) : null,
      comment: comment || '',
      collection: col || null
    }).lastInsertRowid;
  }

  getFeedbackByProject(clipProjectId) {
    return this.db.prepare('SELECT * FROM review_feedback WHERE clip_project_id = ? ORDER BY id').all(clipProjectId);
  }

  getFeedbackByLive(liveVideoId, limit = 20) {
    return this.db.prepare('SELECT * FROM review_feedback WHERE live_video_id = ? ORDER BY id DESC LIMIT ?').all(liveVideoId, limit);
  }

  /**
   * 写入一批剪辑决策学习样本。
   *
   * 为什么必须整体事务：一次审片会产生几十条记录（切 5 句 = 5 条 cut + 十几条 keep + 8 条 segment）。
   * 中途失败留下半批数据比一条不写更糟 —— 因为"这批删除只学到了避雷、
   * 对应的保留样本丢了"，下次匹配就会得出"这类内容都别要"的反向结论。
   *
   * @param rows cut/keep/segment 混合的样本行
   */
  addReviewEdits(rows) {
    const list = (rows || []).filter((r) => r && r.kind && (r.text || r.themeName));
    if (!list.length) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO review_edits
        (clip_project_id, live_video_id, collection, kind, segment_id, role, theme_name,
         text, char_from, char_to, start_ms, end_ms, score, reason, by)
      VALUES
        (@clipProjectId, @liveVideoId, @collection, @kind, @segmentId, @role, @themeName,
         @text, @charFrom, @charTo, @startMs, @endMs, @score, @reason, @by)
    `);
    const run = this.db.transaction((items) => {
      let n = 0;
      for (const r of items) {
        stmt.run({
          clipProjectId: r.clipProjectId ?? null,
          liveVideoId: r.liveVideoId ?? null,
          collection: r.collection ?? null,
          kind: r.kind,
          segmentId: r.segmentId ?? null,
          role: r.role ?? null,
          themeName: r.themeName ?? null,
          text: r.text ?? null,
          charFrom: r.charFrom ?? null,
          charTo: r.charTo ?? null,
          startMs: r.startMs ?? null,
          endMs: r.endMs ?? null,
          score: r.score ?? null,
          reason: r.reason ?? null,
          // 默认 'edited'（用户主动框选）；段落级是 'picked'（勾选框打勾）
          by: r.by || 'edited'
        });
        n++;
      }
      return n;
    });
    return run(list);
  }

  /**
   * 取某位老师的剪辑偏好：避雷词（cut）+ 正样本（keep）+ 段落结构（segment）。
   *
   * collection 为 null/空 表示要"通用"经验（对所有 IP 生效），
   * 所以要并上 collection IS NULL 的那批 —— 与 getReviewLessons 的约定保持一致。
   */
  getReviewEdits(collection = undefined, limit = 300) {
    const col = this._resolveCollection(collection);
    return this.db.prepare(`
      SELECT * FROM review_edits
      WHERE (@col IS NULL OR collection IS NULL OR collection = @col)
      ORDER BY id DESC
      LIMIT @limit
    `).all({ col: col || null, limit });
  }

  /**
   * 按类型取样本。
   * kind 传 'segment' 拿整段保留的内容逻辑（结构层），传 'cut' 拿避雷词。
   */
  getReviewEditsByKind(kind, collection = undefined, limit = 200) {
    const col = this._resolveCollection(collection);
    return this.db.prepare(`
      SELECT * FROM review_edits
      WHERE kind = @kind AND (@col IS NULL OR collection IS NULL OR collection = @col)
      ORDER BY id DESC
      LIMIT @limit
    `).all({ kind, col: col || null, limit });
  }

/**
   * 按路径反查直播记录，**忽略路径分隔符和大小写差异**。
   *
   * 为什么不能直接 `WHERE video_path = ?`：
   * 桌面端拿到的是 Windows 原生路径（E:\直播\a.mp4），
   * 而库里存的是规范化后的（E:/直播/a.mp4）。
   * 精确匹配必然查不到 → liveId 为 null → 归档 collection 退化成 NULL（通用）
   * → 这位老师的剪辑样本被记成"对所有人生效"。
   *
   * 症状极其隐蔽：功能看着能用（样本确实入库了），
   * 但归属全错 —— 正是"串档"。
   * 而且不报错，所以永远发现不了。
   */
  _findLiveByPath(videoPath) {
    if (!videoPath) return null;
    const norm = (p) => normalizeVideoPath(p).toLowerCase();
    const want = norm(videoPath);
    // 先精确（快路径），再退化到归一化比较
    const exact = this.db.prepare('SELECT * FROM live_videos WHERE video_path = ?').get(videoPath);
    if (exact) return exact;
    /*
     * 2026-10-12：兜底扫描原来 SELECT * 全表拉 —— 上万行时
     * 每个请求都把上万行（含 full_transcript，几 MB 级别的 blob）搬进 JS 内存，
     * 只为了在 JS 里逐行比一次路径。
     *
     * 现在只扫 id + video_path 两列（几 KB），命中后再按 id 取完整行。
     */
    const hit = this.db.prepare('SELECT id, video_path FROM live_videos WHERE video_path IS NOT NULL').all()
      .find((r) => norm(r.video_path) === want);
    return hit ? this.db.prepare('SELECT * FROM live_videos WHERE id = ?').get(hit.id) : null;
  }

  /**
   * 这条直播归哪位 IP 老师。
   *
   * 放在 store 里而不是 orchestrator：归属判定是**数据问题**，
   * 放 orchestrator 会出现两处各判一次、结论不一致的情况。
   *
   * 优先级：素材自己的 collection > 当前选中的集合 > null。
   * 素材自己的优先，是因为分析时就是"针对某位老师"做的；
   * 审片往往发生在几天之后，那时用户早就切到别的 IP 了。
   * 用当前选中会把「祝老师」的口播删减记到「李老师」名下，
   * 而且不报错，错误规则会持续累积。
   */
  _ownerOfLive(liveVideoId) {
    try {
      const row = this.db
        .prepare('SELECT collection FROM live_videos WHERE id = ?')
        .get(liveVideoId);
      const own = row?.collection ? String(row.collection).trim() : '';
      if (own) return own;
    } catch { /* 老库没有该列，往下回落 */ }
    return this.activeCollection || null;
  }

  /**
   * 取某位老师的热词纠正规则。
   * collection 为 null 时取"通用"规则（对所有 IP 生效），与 getReviewEdits 同一约定。
   */
  getHotwords(collection = undefined) {
    const col = this._resolveCollection(collection);
    const rows = this.db.prepare(`
      SELECT * FROM hotwords
      WHERE (@col IS NULL OR collection IS NULL OR collection = @col)
      ORDER BY LENGTH(from_word) DESC
    `).all({ col: col || null });
    return rows.map((r) => ({ id: r.id, collection: r.collection, from: r.from_word, to: r.to_word, hits: r.hits }));
  }

  /**
   * 加一条纠正规则。
   * 同一 collection + from 只保留一条（改成 to），避免建出两条互相打架的规则。
   * updated=true 表示这是修改了已有规则，UI 要如实告诉用户。
   */
  addHotword(collection, from, to) {
    /*
     * collection 归一统一交给 _normCollection（2026-10-12）。
     *
     * 这里的注释记录了一个很有价值的坑：`collection ? ... : null` 这种写法里
     * String(null) === 'null' 真的成立 —— 调用方只要在外面多包一层 String()，
     * null 就变成了字符串 'null' 存进库，之后所有 collection = NULL 的查询都匹配不上，
     * 这条规则就变成"添加成功、读不回来、也不生效"的孤儿数据。
     *
     * 原来只有这一个方法做了防护，同类路径（upsertLiveVideo / addReviewEdits…）都没有 ——
     * 属于"修了一处没修同类"。现在把防护上收到 _normCollection，
     * 顺带把限长 40 也统一了（原来这里不截断，别的入口截断）。
     */
    const col = this._normCollection(collection);
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f) return { ok: false, error: '要改哪个词？' };
    if (!t) return { ok: false, error: '要改成什么？' };
    if (f === t) return { ok: false, error: '改前改后一样' };
    const existing = this.db
      .prepare("SELECT id FROM hotwords WHERE IFNULL(collection,'') = IFNULL(?,'') AND from_word = ?")
      .get(col, f);
    if (existing) {
      this.db.prepare('UPDATE hotwords SET to_word = ? WHERE id = ?').run(t, existing.id);
      return { ok: true, id: existing.id, updated: true };
    }
    const r = this.db
      .prepare('INSERT INTO hotwords (collection, from_word, to_word) VALUES (?, ?, ?)')
      .run(col, f, t);
    return { ok: true, id: Number(r.lastInsertRowid), updated: false };
  }

  deleteHotword(id) {
    return this.db.prepare('DELETE FROM hotwords WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 某位 IP 老师的完整剪辑档案。
 *
 * 这是"归档"的落点：不是每次查询时临时拼几段文字，
 * 而是把一位老师的剪辑偏好聚成一份**可复用的结构**，
 * 供分析爆点时直接读。包含四层：
 *
 *   避雷词  cut      —— 用户明确删掉的起手式/话术
 *   正样本  keep     —— 用户明确留下的内容形态
 *   结构    segment  —— 哪些 role（开场/主体/收尾）被勾选认可 + 主题 + 评分
 *   统计    summary  —— 删留比、平均评分、样本量
 *
 * 为什么必须预先聚合而不是每次现查：
 * 找爆点时要对每个候选段做"这段像不像他以前的爆款"，
 * 一次分析几百个候选段。逐段现查 review_edits 会把分析拖垮，
 * 而这些数据是审完片就不再变的，缓存没有失效风险。
 */
getEditArchive(collection, { limit = 30 } = {}) {
const name = this._normCollection(collection);
    if (!name) return null;

    /*
     * 完全没有样本的老师返回 null，而不是一份全 0 的空档案。
     *
     * 区别很实际：空档案会被前端渲染成"已学会 N 条"，
     * 让用户以为系统确实分析过这位老师；而真相是压根没有数据。
     * null 让调用方能明确区分"没数据"和"数据很少"。
     */
    const probe = this.db.prepare(
      'SELECT COUNT(*) AS n FROM review_edits WHERE collection = ?'
    ).get(name);
    if (!probe?.n) return null;

    const summary = this.getEditStyleSummary(name);
  const cuts = this.db.prepare(`
    SELECT text, COUNT(*) AS n, MAX(created_at) AS last_at
    FROM review_edits
    WHERE kind = 'cut' AND collection = ? AND text IS NOT NULL AND LENGTH(text) >= 4
    GROUP BY text
    ORDER BY n DESC, last_at DESC
    LIMIT ?
  `).all(name, limit);

  const keeps = this.db.prepare(`
    SELECT text, role, theme_name, COUNT(*) AS n
    FROM review_edits
    WHERE kind = 'keep' AND collection = ? AND text IS NOT NULL AND LENGTH(text) >= 8
    GROUP BY substr(text, 1, 40)
    ORDER BY n DESC
    LIMIT ?
  `).all(name, limit);

  const segments = this.db.prepare(`
    SELECT role, theme_name, COUNT(*) AS n,
           ROUND(AVG(score), 3) AS avg_score,
           ROUND(AVG(end_ms - start_ms) / 1000.0, 1) AS avg_sec,
           MAX(created_at) AS last_at
    FROM review_edits
    WHERE kind = 'segment' AND collection = ?
    GROUP BY COALESCE(role, 'body'), COALESCE(theme_name, '')
    ORDER BY n DESC, avg_score DESC
    LIMIT ?
  `).all(name, limit);

  /*
   * 结构偏好：这位老师认可最多的 role 排序，以及 hook 的典型主题。
   *
   * 这是"整段保留的粗剪内容逻辑"的直接产物 ——
   * 比逐字层面抗噪得多，因为它来自用户反复勾选同一类段落。
   */
  const roleOrder = this.db.prepare(`
    SELECT COALESCE(role, 'body') AS role, COUNT(*) AS n,
           ROUND(AVG(score), 3) AS avg_score
    FROM review_edits
    WHERE kind = 'segment' AND collection = ?
    GROUP BY COALESCE(role, 'body')
    ORDER BY avg_score DESC, n DESC
  `).all(name);

  const hookThemes = this.db.prepare(`
    SELECT theme_name, COUNT(*) AS n, ROUND(AVG(score), 3) AS avg_score
    FROM review_edits
    WHERE kind = 'segment' AND collection = ? AND role = 'hook' AND theme_name IS NOT NULL
    GROUP BY theme_name
    ORDER BY n DESC, avg_score DESC
    LIMIT 10
  `).all(name);

  const cutOpenings = this.topCutOpenings(name, 10);

  /**
   * 标题改写记录（AI 原标题 → 用户改成什么）。
   *
   * 这是"爆款感"里最直接的一层学习：避雷词只是排除项，
   * 标题改写是**正向示范** —— 用户亲手示范了"这类标题能爆"。
   *
   * 约定：text 存用户改后的新标题，theme_name 存 AI 原本起的老标题。
   * 两者都留着才能做对照；只留一个就没有基线了。
   * （沿用现有列而不是加新表：新表要多一套迁移，收益不抵。）
   */
  const titleEdits = this.db.prepare(`
    SELECT text AS newTitle, theme_name AS oldTitle, reason, created_at
    FROM review_edits
    WHERE kind = 'title' AND collection = ? AND text IS NOT NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(name, limit);

  // 一句话状态：样本够不够，不够就要老实说"还没学到什么"
  const total = summary.cuts + summary.keeps + summary.segments + summary.titles;
  const stage = total === 0 ? 'empty' : total < 10 ? 'thin' : total < 40 ? 'warm' : 'rich';

  return {
    collection: name,
    stage,
    totalSamples: total,
    summary,
    cutOpenings,
    cutPhrases: cuts,
    keepSamples: keeps,
    segments,
    roleOrder,
    hookThemes,
    titleEdits,
    // 直接可用的注入片段：给分析时的提示词，省得调用方每次自己拼
    promptHints: {
      avoid: cutOpenings.map((r) => r.opening),
      preferHooks: hookThemes.map((r) => r.theme_name).filter(Boolean),
      structure: roleOrder.map((r) => `${r.role}(${r.n}次${r.avg_score != null ? `,均分${r.avg_score}` : ''})`)
    }
  };
}

/**
 * 列出所有有剪辑档案的 IP 老师。
 *
 * 和 listCollections 的区别：那个列的是"文件夹"（可能一条样本都没有），
 * 这个列的是"真的学到过剪辑偏好"的。做记忆页展示时用后者，
 * 否则会给用户看一堆空档案。
 */
listEditArchives() {
  return this.db.prepare(`
    SELECT collection AS name,
           COUNT(*) AS samples,
           SUM(CASE WHEN kind = 'cut' THEN 1 ELSE 0 END) AS cuts,
           SUM(CASE WHEN kind = 'keep' THEN 1 ELSE 0 END) AS keeps,
           SUM(CASE WHEN kind = 'segment' THEN 1 ELSE 0 END) AS segments,
           MAX(created_at) AS last_at
    FROM review_edits
    WHERE collection IS NOT NULL AND collection <> ''
    GROUP BY collection
    ORDER BY last_at DESC
  `).all();
}

/**
 * 某位老师的剪辑习惯摘要：给审片台和记忆页展示"系统学到了什么"。
 *
 * 刻意不做自动归纳（"你好像不喜欢开场问候"之类）——
 * LLM 一旦开始编规律，用户就没法判断哪句是真的了。
 * 这里只统计**事实**：删了多少字、留了多少段、最常被删的开头是什么。
 */
getEditStyleSummary(collection = undefined) {
    const col = this._resolveCollection(collection);
    const base = { collection: col, cuts: 0, keeps: 0, segments: 0, cutChars: 0, keepChars: 0 };
    const q = (kind) => this.db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars
      FROM review_edits
      WHERE kind = @kind AND (@col IS NULL OR collection IS NULL OR collection = @col)
    `).get({ kind, col: col || null });
    const c = q('cut');
    const k = q('keep');
    const s = q('segment');
    const t = q('title');
    return {
      ...base,
      cuts: c?.n ?? 0,
      cutChars: c?.chars ?? 0,
      keeps: k?.n ?? 0,
      keepChars: k?.chars ?? 0,
      segments: s?.n ?? 0,
      // 标题改写是最直接的爆款感输入：AI 起了什么、用户改成什么
      titles: t?.n ?? 0
    };
  }

  /**
   * 最常被删的句子开头。
   *
   * 用户删的是"同学们欢迎大家"这种**起手式**，特征在前几个字。
   * 所以统计时取开头 6 字做聚类，而不是整句 ——
   * 整句几乎各不相同，聚不出任何东西。
   */
  topCutOpenings(collection = undefined, limit = 10) {
    const col = this._resolveCollection(collection);
    return this.db.prepare(`
      SELECT substr(text, 1, 6) AS opening, COUNT(*) AS n
      FROM review_edits
      WHERE kind = 'cut' AND text IS NOT NULL AND length(text) >= 4
        AND (@col IS NULL OR collection IS NULL OR collection = @col)
      GROUP BY opening
      ORDER BY n DESC
      LIMIT @limit
    `).all({ col: col || null, limit });
  }

  /**
   * 把 WAL 落一次到主库。
   * 为什么必须做：① WAL 只增不减，hermes.db-wal 会一直涨（曾见到 WAL 4MB / 主库 1MB）；
   * ② 更要命的——各模块按需建的表（deep_memory / sentence_cuts / sentence_clean_cache）
   *    可能只存在于 WAL 里，此时直接 copy hermes.db 得到的是"缺表的残库"，
   *    备份恢复会踩空。PASSIVE = 不阻塞读写，能落多少落多少。
   * 调度器每小时还会再调一次（见 scheduler 的 _tickInner）。
   * 注意：这里必须容错——旧版 SQLite 不认这个 pragma，绝不能因此拖垮启动。
   */
  checkpointWal(mode = 'PASSIVE') {
    /*
     * 2026-10-12：mode 加白名单。
     *
     * `db.pragma()` 是直接执行任意 SQL 的，而 mode 被字符串拼进去。
     * 现在两个调用点都不传参（不可达），但只要有人写一句
     * `checkpointWal(req.query.mode)` 就立刻是一条注入路径 ——
     * "目前没被调用"不是防护，是运气。这里把可接受的值钉死。
     */
    const safe = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']
      .includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : 'PASSIVE';
    try {
      this.db.pragma(`wal_checkpoint(${safe})`);
      return true;
    } catch {
      return false;
    }
  }

  /** 切换当前活跃文件夹（由 Orchestrator 调用，用来给评审经验定归属） */
  setActiveCollection(name) {
    this.activeCollection = name ? String(name).trim() : null;
    return this.activeCollection;
  }

  /** 本文件夹的评审经验上限。全局只留 30 条会被某个高频文件夹占满、把别的文件夹经验挤掉 */
  static LESSONS_PER_COLLECTION = 30;
  /** 所有文件夹相加的硬上限，防止文件夹越建越多、profile 无限膨胀 */
  static LESSONS_TOTAL_CAP = 300;

  /**
   * 意见成记忆：追加一条评审经验，下次粗剪自动遵守。
   * @param {string} lesson 经验正文
   * @param {string|null|undefined} collection 归属文件夹。
   *   省略 = 用当前活跃文件夹（绝大多数调用走这条）；
   *   显式传 null = 通用经验（对所有文件夹生效）。
   */
  addReviewLesson(lesson, collection = undefined) {
    const col = this._resolveCollection(collection);
    // 必须拷贝：getStyleProfile 返回的是进程内缓存里的数组，直接 push 等于在 setStyleProfile
    // 之前就把缓存改了 —— 中途有读者会看到尚未落库的中间状态（单测踩到过）。
    let lessons = [];
    try {
      lessons = [...(this.getStyleProfile()['review_lessons'] || [])];
    } catch { /* ignore */ }
    lessons.push({ text: lesson, at: new Date().toISOString(), collection: col || null });

    // 按归属分桶各留 30 条：只丢本桶最旧的，不碰别的文件夹
    const key = col || null;
    const bucket = lessons.filter((l) => (l && typeof l === 'object' ? (l.collection || null) : null) === key);
    if (bucket.length > MemoryStore.LESSONS_PER_COLLECTION) {
      const drop = new Set(bucket.slice(0, bucket.length - MemoryStore.LESSONS_PER_COLLECTION));
      lessons = lessons.filter((l) => !drop.has(l));
    }
    if (lessons.length > MemoryStore.LESSONS_TOTAL_CAP) lessons = lessons.slice(-MemoryStore.LESSONS_TOTAL_CAP);

    this.setStyleProfile('review_lessons', lessons);
  }

  /**
   * 读取评审经验。
   * @param {string|null|undefined} collection 省略 = 用当前活跃文件夹过滤；
   *   显式传 null/'' = 不过滤，返回全部（看板汇总、诊断用）。
   * 过滤规则：「本文件夹的」+「无归属的(占位/通用)」——老数据没归属时不会凭空消失。
   */
  getReviewLessons(collection = undefined) {
    let all = [];
    try {
      all = this.getStyleProfile()['review_lessons'] || [];
    } catch {
      return [];
    }
    const col = this._resolveCollection(collection);
    if (!col) return all;
    return all.filter((l) => {
      const c = l && typeof l === 'object' ? (l.collection || null) : null;
      return !c || c === col;
    });
  }

  /**
   * 记忆里的"指定开头"硬约束（全局，不分本场）。
   *
   * 背景：桌面端（GLB）打回时写的评审意见 live_video_id 是 NULL，
   * 而 Clipper 原来只扫 getFeedbackByLive(本场) + review_lessons，
   * 于是"AI 指定开头《…》必须放第一段"这类硬约束读不到，
   * 成片开头仍由算法随机决定 —— 这是"记忆没接上剪辑"的关键断点之一。
   * 这里按时间倒序扫最近 20 条全局反馈，返回最新的"指定开头《…》"文本。
   */
  getOpeningPreference() {
    // 严格式（"开头《x》"）
    const strict = [
      /(?:指定|要求|必须|请|要)?\s*开头(?:用|要|是|为|使用)?\s*[《【"“]([^》】"”]{1,40})[》】"”]/,
      /[《【"“]([^》】"”]{1,40})[》】"”]\s*(?:作为|当|做)\s*(?:开头|片头|首段|第一段)/,
    ];
    // 窗口法兜底：遍历书名号内容，看它前后 12 字窗口里有没有"开头/开场/首段/片头"。
    // 桌面端真实写法是"[桌面端指定开头]…以它为开头剪出完整爆款：《我的老师是如何训练？》"，
    // 严格式匹配不到（"开头"与《》之间隔了字）→ 硬约束静默失效；
    // 而"《直播分享故事》…指定新开头重找"这类打回意见窗口里没有"开头"，不会被误判。
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
    const pick = (text) => {
      const t = String(text || '');
      if (!t) return null;
      for (const re of strict) {
        const m = t.match(re);
        if (m && m[1]) return m[1].trim();
      }
      return pickWindow(t);
    };
    try {
      // 指定开头强绑定具体素材/老师：按当前文件夹过滤，切老师后不再吃到别的老师的硬约束。
      // collection 为空的旧记录视为通用，继续生效。
      const hasCol = !!this.activeCollection;
      const rows = this.db.prepare(
        'SELECT comment FROM review_feedback' +
        (hasCol ? ' WHERE (collection IS NULL OR collection = ?)' : '') +
        ' ORDER BY id DESC LIMIT 20'
      ).all(...(hasCol ? [this.activeCollection] : []));
      for (const r of rows) {
        const hit = pick(r.comment);
        if (hit) return hit;
      }
    } catch { /* ignore */ }
    try {
      for (const l of this.getReviewLessons().slice().reverse()) {
        const hit = pick(typeof l === 'object' ? (l.text || '') : l);
        if (hit) return hit;
      }
    } catch { /* ignore */ }
    return null;
  }

  // ──────────────────────────────────────────────
  // Hit Performance & Predictions（发布数据回流 + 爆款预测）
  // ──────────────────────────────────────────────

  upsertHitPerformance(hitVideoId, data = {}) {
    const cur = this.db.prepare('SELECT * FROM hit_performance WHERE hit_video_id = ?').get(hitVideoId);
    const pick = (v, c) => (v !== undefined && v !== null ? v : (c !== undefined && c !== null ? c : null));
    /*
     * 2026-10-12：计数列夹一次。
     *
     * 上游 orchestrator 的 num() 只做了 Math.max(0, Math.round(Number(v)||0))，
     * 而 Number("1e999") = Infinity、Infinity || 0 还是 Infinity —— **上限没封**，
     * 于是 POST {views:"1e999"} 就能把 Infinity 写进库，之后所有统计静默变 NaN。
     * store 层这里兜住，任何调用方都绕不过去。
     */
    const cnt = (v, c) => MemoryStore.num(v ?? c, { min: 0, max: 1e9, integer: true, fallback: null });
    const merged = {
      views: cnt(data.views, cur?.views),
      likes: cnt(data.likes, cur?.likes),
      comments: cnt(data.comments, cur?.comments),
      shares: cnt(data.shares, cur?.shares),
      favorites: cnt(data.favorites, cur?.favorites),
      platform: pick(data.platform, cur?.platform),
      source: pick(data.source, cur?.source || 'manual'),
      screenshotPath: pick(data.screenshotPath, cur?.screenshot_path),
      note: pick(data.note, cur?.note),
    };
    this.db.prepare(`
      INSERT INTO hit_performance (hit_video_id, views, likes, comments, shares, favorites, platform, source, screenshot_path, note, updated_at)
      VALUES (@hitVideoId, @views, @likes, @comments, @shares, @favorites, @platform, @source, @screenshotPath, @note, datetime('now'))
      ON CONFLICT(hit_video_id) DO UPDATE SET
        views = @views, likes = @likes, comments = @comments, shares = @shares, favorites = @favorites,
        platform = @platform, source = @source, screenshot_path = @screenshotPath, note = @note,
        updated_at = datetime('now')
    `).run({ hitVideoId, ...merged });
    return this.getHitPerformance(hitVideoId);
  }

  getHitPerformance(hitVideoId) {
    return this.db.prepare('SELECT * FROM hit_performance WHERE hit_video_id = ?').get(hitVideoId) || null;
  }

  /**
   * 同类型已回流数据的中位数，用于校准预测。
   * platform 给定时优先只统计同平台样本（视频号/抖音/小红书/快手/B站数据量级差很大），
   * 同平台没样本再退回全量。返回 platform 字段标明基线是"同平台"还是"全平台"。
   */
/**
 * 预测基准：这位老师自己的爆款真实数据中位数。
 *
 * 【为什么必须按 collection 隔离】
 * 以前只按 genre(题材) 过滤、完全不看 collection。后果是：
 * 祝老师的爆款感标准，会被其他老师的同题材数据稀释 ——
 * 而"这位老师自己的爆款感"正是这个功能存在的理由。
 * 素材少的时候掺进别人的数据，比没有基准更糟：
 * 看起来有参照，其实参照的是别人的标准，会系统性地把预测带偏。
 *
 * 所以传了 collection 就**只看这一位老师**的数据，绝不混别人。
 * 代价是样本少时基准为 null、预测只能靠 LLM 冷估（confidence 会标"低"），
 * 这比拿别人的标准来衡量他更诚实。
 *
 * @param {string|null} genre 题材（仅在不指定 collection 时作为兼容口径）
 * @param {string|null} platform 平台，优先取同平台
 * @param {string|null} collection IP 老师；给了就只看这位老师
 */
getPerformanceBaseline(genre, platform = null, collection = null) {
    try {
      const med = (arr) => {
        const a = arr.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
        return a.length ? a[Math.floor(a.length / 2)] : 0;
      };
      const calc = (rows, plat) => {
        if (!rows.length) return null;
        return {
          count: rows.length,
          views: med(rows.map((r) => r.views)),
          likes: med(rows.map((r) => r.likes)),
          comments: med(rows.map((r) => r.comments)),
          shares: med(rows.map((r) => r.shares)),
          favorites: med(rows.map((r) => r.favorites)),
          platform: plat,
          // 基准只来自这一位老师时，标出来给上层提示用
          scopedTo: collection || null
        };
      };

      // 按 IP 隔离：条件只有 collection，没有 genre 也没有"全库兜底"
      if (collection) {
        const byCol = `SELECT p.views, p.likes, p.comments, p.shares, p.favorites
                         FROM hit_performance p JOIN hit_videos v ON v.id = p.hit_video_id
                        WHERE p.views > 0 AND v.collection = ?`;
        if (platform) {
          const same = calc(this.db.prepare(byCol + ' AND p.platform = ?').all(collection, platform), platform);
          if (same) return same;
        }
        return calc(this.db.prepare(byCol).all(collection), null);
      }

      // 没指定 IP（通用素材）才走原来的题材口径
      const baseSql = `
        SELECT p.views, p.likes, p.comments, p.shares, p.favorites
        FROM hit_performance p JOIN hit_videos v ON v.id = p.hit_video_id
        WHERE p.views > 0 AND (? IS NULL OR v.genre = ? OR v.genre = 'other' OR v.genre IS NULL)`;
      // 1) 同平台优先
      if (platform) {
        const rows = this.db.prepare(baseSql + ' AND p.platform = ?').all(genre || null, genre || null, platform);
        const same = calc(rows, platform);
        if (same) return same;
      }
      // 2) 退回全库
      const rows = this.db.prepare(baseSql).all(genre || null, genre || null);
      return calc(rows, null);
    } catch {
      return null;
    }
  }

  upsertHitPrediction(hitVideoId, data = {}) {
    this.db.prepare(`
      INSERT INTO hit_predictions (hit_video_id, views_low, views_high, likes, comments, shares, favorites, confidence, rationale, created_at)
      VALUES (@hitVideoId, @viewsLow, @viewsHigh, @likes, @comments, @shares, @favorites, @confidence, @rationale, datetime('now'))
      ON CONFLICT(hit_video_id) DO UPDATE SET
        views_low = @viewsLow, views_high = @viewsHigh, likes = @likes,
        comments = @comments, shares = @shares, favorites = @favorites, confidence = @confidence,
        rationale = @rationale,
        created_at = datetime('now')
    `).run({
      hitVideoId,
      /*
       * 2026-10-12：数值列统一夹一次。
       * 直通 INTEGER 列有两个问题：字符串 "abc" 会因 affinity 保持 TEXT（下游比较全错），
       * Infinity 会污染所有统计（getPerformanceBaseline 的 avg/sum 静默变 NaN）。
       */
      viewsLow: MemoryStore.num(data.viewsLow, { min: 0, max: 1e12, integer: true, fallback: null }),
      viewsHigh: MemoryStore.num(data.viewsHigh, { min: 0, max: 1e12, integer: true, fallback: null }),
      likes: MemoryStore.num(data.likes, { min: 0, max: 1e9, integer: true, fallback: null }),
      comments: MemoryStore.num(data.comments, { min: 0, max: 1e9, integer: true, fallback: null }),
      shares: MemoryStore.num(data.shares, { min: 0, max: 1e9, integer: true, fallback: null }),
      favorites: MemoryStore.num(data.favorites, { min: 0, max: 1e9, integer: true, fallback: null }),
      /*
       * confidence 在这张表里是 **TEXT**，线上存的是 '低'/'中'/'高' 这种定性档位，
       * 不是 0~1 的小数（PRAGMA table_info 确认过）。
       * 所以这里绝不能按数值夹 —— Number('低') 是 NaN，一夹就变 null，
       * 等于把真数据抹掉。（差点就改错了，是回归用例逼出来的。）
       */
      confidence: data.confidence === null || data.confidence === undefined
        ? null
        : String(data.confidence).trim().slice(0, 40) || null,
      rationale: String(data.rationale || '').slice(0, 2000),
    });
    return this.getHitPrediction(hitVideoId);
  }

  getHitPrediction(hitVideoId) {
    return this.db.prepare('SELECT * FROM hit_predictions WHERE hit_video_id = ?').get(hitVideoId) || null;
  }

  // ──────────────────────────────────────────────
  // Openings Cache（本场好开头深挖结果）
  // ──────────────────────────────────────────────

  getOpeningCache(key) {
    return this.db.prepare('SELECT * FROM openings_cache WHERE cache_key = ?').get(key) || null;
  }

  /**
   * 单行几 MB 的两个大缓存表按 30 天 TTL 清理（2026-10-21）。
   *
   * sentence_clean_cache / openings_cache 的 value 是整份逐句 JSON（一部长视频几 MB），
   * 只增不减 —— 服务跑几个月就能把 DB 顶到几百 MB，VACUUM 都救不回。
   * 三个写入点（store:2994 / orchestrator:2879 / sentence-cutter:166）的 upsert
   * 都带 datetime('now') 刷新，所以 TTL 过期即"30 天没再用"，热缓存不会被误清。
   */
  pruneBigCaches(maxAgeDays = 30) {
    let n = 0;
    try {
      n += this.db.prepare(
        "DELETE FROM sentence_clean_cache WHERE updated_at < datetime('now', ?)"
      ).run(`-${maxAgeDays} day`).changes;
      n += this.db.prepare(
        "DELETE FROM openings_cache WHERE created_at < datetime('now', ?)"
      ).run(`-${maxAgeDays} day`).changes;
      if (n) console.log(`[Store] 大缓存清理（${maxAgeDays} 天 TTL）：共删 ${n} 行`);
    } catch { /* 表还没建就跳过 */ }
    return n;
  }

  setOpeningCache(key, mined) {
    this.db.prepare(`
      INSERT INTO openings_cache (cache_key, mined, created_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET mined = excluded.mined, created_at = datetime('now')
    `).run(key, JSON.stringify(mined || []));
  }

  // ──────────────────────────────────────────────
  // Extended Stats
  // ──────────────────────────────────────────────

  getExtendedStats() {
    // 看板 loadAll 一次刷 5 个接口都会调到这里，9 个 COUNT 全扫太贵，缓存 10s
    const now = Date.now();
    if (this._extStatsCache && now - this._extStatsAt < 10000) return this._extStatsCache;
    const base = this.getStats();
    const hitCount = this.db.prepare('SELECT COUNT(*) as count FROM hit_videos').get().count;
    const hitCompleted = this.db.prepare("SELECT COUNT(*) as count FROM hit_videos WHERE analysis_status = 'completed'").get().count;
    const liveCount = this.db.prepare('SELECT COUNT(*) as count FROM live_videos').get().count;
    const liveCompleted = this.db.prepare("SELECT COUNT(*) as count FROM live_videos WHERE analysis_status = 'completed'").get().count;
    // 只算活跃批次：superseded 是上一轮的分段，算进总数会让界面显示的分段数虚高
    const segmentCount = this.db.prepare("SELECT COUNT(*) as count FROM live_segments WHERE status = 'draft'").get().count;
    const projectCount = this.db.prepare('SELECT COUNT(*) as count FROM clip_projects').get().count;
    const finishedCount = this.db.prepare("SELECT COUNT(*) as count FROM clip_projects WHERE status = 'finished'").get().count;
    const queryCount = this.db.prepare('SELECT COUNT(*) as count FROM user_queries').get().count;
    const pendingQueryCount = this.db.prepare("SELECT COUNT(*) as count FROM user_queries WHERE status = 'pending'").get().count;

    const topThemes = this.db.prepare(`
      SELECT theme_name, COUNT(*) as count, AVG(confidence) as avg_confidence
      FROM hit_themes GROUP BY theme_name ORDER BY count DESC LIMIT 10
    `).all();

    const out = {
      ...base,
      hits: { total: hitCount, analyzed: hitCompleted },
      live: { total: liveCount, analyzed: liveCompleted, segments: segmentCount },
      clips: { projects: projectCount, finished: finishedCount },
      queries: { total: queryCount, pending: pendingQueryCount },
      topThemes
    };
    this._extStatsCache = out;
    this._extStatsAt = now;
    return out;
  }

  close() {
    this.db.close();
  }
}

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity 0-1
 */
function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// CLI: initialize database
if (process.argv[2] === '--init') {
  const store = new MemoryStore();
  console.log(`Hermes memory database initialized at: ${store.dbPath}`);
  const stats = store.getStats();
  console.log('Tables created. Current stats:', stats);
  store.close();
}

export default MemoryStore;
