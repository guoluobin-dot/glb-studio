/**
 * Hermes MCP Server（零依赖，Node 22+）
 *
 * 作用：让 opencode（或任何 MCP 客户端）通过 stdio JSON-RPC 2.0 调度 Hermes。
 * 架构取舍：这里**不直接碰 sqlite**——Hermes 的 orchestrator 是唯一数据入口
 * （写库、跑 ASR/LLM、防重入锁都在它那边），再开一个进程直接写库会撞
 * better-sqlite3 的写锁并造成数据漂移。所以 MCP 只是 REST 的一个薄壳：
 *   MCP 客户端 → stdio → 本进程 → HTTP(127.0.0.1:17841) → orchestrator
 *
 * 安全性：orchestrator 的鉴权规则是「跨站挡 + 回环放行」，Node 的 fetch
 * 不带 Origin 头，天然满足 requireRead/WriteAuth 的放行条件； secret 不下发，
 * 泄漏面最小。
 *
 * 协议：newline-delimited JSON-RPC（与官方 @modelcontextprotocol/sdk 的
 * StdioServerTransport 一致）。stdout 只输出协议帧；日志一律走 stderr。
 */

import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const HERMES = process.env.HERMES_URL || 'http://127.0.0.1:17841';
const NAME = 'hermes';
const VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const DEBUG = process.env.GLB_HERMES_MCP_DEBUG === '1';
const debugLog = (msg) => {
  if (!DEBUG) return;
  try { appendFileSync(process.env.GLB_HERMES_MCP_DEBUG_FILE || 'mcp-debug.log', `${new Date().toISOString()} ${msg}\n`); } catch {}
};

/* ───────────── Hermes REST 客户端（薄壳）───────────── */

async function hermes(method, path, body, timeoutMs = 20000) {
  const res = await fetch(HERMES + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
  return { status: res.status, ok: res.ok, data };
}

/** 列表类响应用：截断成紧凑文本，防止把 opencode 的上下文撑爆。 */
function compact(value, limit = 6000) {
  const text = JSON.stringify(value);
  return text.length <= limit ? value : { truncated: true, head: text.slice(0, limit) };
}

/* ───────────── 工具清单 ───────────── */

const TOOLS = [
  {
    name: 'hermes_status',
    description: 'Hermes 健康状况 + 当前 LLM 引擎（provider/model/云端开关）。排查问题先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const [health, llm] = await Promise.all([hermes('GET', '/health'), hermes('GET', '/api/llm-status')]);
      return compact({ health: health.data, llmEngine: llm.data });
    },
  },
  {
    name: 'hermes_system',
    description: '系统总览：录播监听是否在跑、Ollama/FFmpeg/ASR 状态、调度器队列、素材与成片目录。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => compact((await hermes('GET', '/api/system')).data),
  },
  {
    name: 'hermes_collections',
    description: '列出爆款记忆库里的 IP 文件夹（含各老师的视频数与当前激活的归属）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => compact((await hermes('GET', '/api/collections')).data),
  },
  {
    name: 'hermes_collection_set',
    description: '切换当前激活的 IP 归属（此后找爆点默认用这位老师的爆款记忆）。传空串关闭归属。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'IP 文件夹名，如「祝老师」；空串=关闭归属' } },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (a) => compact((await hermes('POST', '/api/active-collection', { name: String(a.name || '') })).data),
  },
  {
    name: 'hermes_hits',
    description: '爆款素材与直播素材一览（在 hitsDir/liveDir 目录里登记的分析状态、归属、爆款点）。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['all', 'hits', 'live'], description: 'all=两者都要（默认）' } },
      additionalProperties: false,
    },
    run: async (a) => {
      const data = (await hermes('GET', '/api/uploads')).data || {};
      const kind = a?.kind || 'all';
      const out = { ok: true };
      if (kind !== 'live') out.hits = (data.hits || []).slice(0, 30);
      if (kind !== 'hits') out.live = (data.live || []).slice(0, 30);
      out.hitsTotal = (data.hits || []).length;
      out.liveTotal = (data.live || []).length;
      return compact(out);
    },
  },
  {
    name: 'hermes_projects',
    description: '粗剪项目一览（最近 50 条）：候选分段、输出目录、可播放片段。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => compact((await hermes('GET', '/api/projects')).data),
  },
  {
    name: 'hermes_outputs',
    description: '成片一览（finished 目录产出的最终成片，最近 100 条里过滤测试素材）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => compact((await hermes('GET', '/api/outputs')).data),
  },
  {
    name: 'hermes_hotwords',
    description: '读热词纠错规则（读稿时把 ASR 错词替换回来）。collection 省略=通用+当前 IP；传空串=仅通用。',
    inputSchema: {
      type: 'object',
      properties: { collection: { type: 'string', description: 'IP 名；省略=通用+当前 IP，空串=仅通用' } },
      additionalProperties: false,
    },
    run: async (a) => {
      const q = a?.collection === undefined ? '' : `?collection=${encodeURIComponent(a.collection)}`;
      return compact((await hermes('GET', '/memory/hotwords' + q)).data);
    },
  },
  {
    name: 'hermes_hotword_add',
    description: '加一条热词纠错规则（from=ASR 常写错的词，to=正确写法；对下一次读稿生效）。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '错误写法，如「猪老师」' },
        to: { type: 'string', description: '正确写法，如「祝老师」' },
        collection: { type: 'string', description: '归属 IP；省略=通用' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run: async (a) => compact((await hermes('POST', '/memory/hotwords', { from: a.from, to: a.to, collection: a.collection ?? null })).data),
  },
  {
    name: 'hermes_analyze_start',
    description: '对一条直播素材发起「找爆点」全链分析（ASR→主题分段→粗剪候选）。同步阻塞，长素材可能十几分钟；中途可用 hermes_analyze_result 轮询，超时后也用结果端点回读。',
    inputSchema: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: '视频绝对路径（需在工作目录或已允许清单内）' },
        collection: { type: 'string', description: '绑定哪位老师的爆款记忆；省略=按库里已绑的归属' },
      },
      required: ['videoPath'],
      additionalProperties: false,
    },
    run: async (a) => compact(
      (await hermes('POST', '/pipeline/analyze-live', { videoPath: a.videoPath, collection: a.collection ?? '' }, 25 * 60 * 1000)).data
    ),
  },
  {
    name: 'hermes_analyze_result',
    description: '回读一条直播的分析结果（状态+分段时间轴）。analyze-start 超时后用它取结果。',
    inputSchema: {
      type: 'object',
      properties: { videoPath: { type: 'string', description: '视频绝对路径' } },
      required: ['videoPath'],
      additionalProperties: false,
    },
    run: async (a) => {
      const r = (await hermes('GET', '/pipeline/live-result?videoPath=' + encodeURIComponent(a.videoPath))).data;
      if (Array.isArray(r.segments)) {
        r.segmentCount = r.segments.length;
        r.segments = r.segments.slice(0, 60);
      }
      return compact(r);
    },
  },
  {
    name: 'hermes_analyze_cancel',
    description: '取消一条正在跑的分析（真断开，不是假成功）。',
    inputSchema: {
      type: 'object',
      properties: { videoPath: { type: 'string', description: '视频绝对路径' } },
      required: ['videoPath'],
      additionalProperties: false,
    },
    run: async (a) => compact((await hermes('POST', '/pipeline/analyze-cancel', { videoPath: a.videoPath })).data),
  },
  {
    name: 'hermes_rerank',
    description: '按爆款记忆给候选片段重排（LLM 挑句）。candidates: [{startSec,endSec,text}]；durationMode 可选 short/mid/long。',
    inputSchema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          description: '本地检测出的候选片段',
          items: {
            type: 'object',
            properties: { startSec: { type: 'number' }, endSec: { type: 'number' }, text: { type: 'string' } },
            required: ['startSec', 'endSec'],
          },
        },
        durationMode: { type: 'string', enum: ['short', 'mid', 'long'] },
        videoName: { type: 'string', description: '素材文件名（无逐句稿时按名回读库里的转写缓存）' },
      },
      required: ['candidates'],
      additionalProperties: false,
    },
    run: async (a) => compact((await hermes('POST', '/highlight/rerank', a, 25 * 60 * 1000)).data),
  },
  {
    name: 'hermes_deep_status',
    description: '深度记忆抽取进度（deep_memory 落库了多少、还剩哪些待处理）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => compact((await hermes('GET', '/api/deep-status')).data),
  },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* ───────────── JSON-RPC 2.0 over stdio ───────────── */

function reply(id, result) {
  debugLog(`OUT id=${JSON.stringify(id)} method-result-keys=${typeof result === 'object' && result ? Object.keys(result).join(',') : typeof result}`);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  debugLog(`OUT-ERROR id=${JSON.stringify(id)} code=${code} msg=${message}`);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    /*
     * 原样回应请求里的 protocolVersion 反而失败：opencode 1.18.30 发来
     * "2025-11-25"，client 收到原样回复后直接断开（版本白名单校验）。
     * 按官方 SDK 语义回一个双方都支持的标准版本（2025-06-18）才握手成功。
     */
    const replyVersion = requested === '2025-06-18' ? '2025-06-18' : '2025-06-18';
    debugLog(`INIT requested=${requested} reply=${replyVersion}`);
    return reply(id, {
      protocolVersion: replyVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: NAME, title: 'Hermes 爆款工作流', version: VERSION },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOL_MAP.get(params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(params?.arguments || {});
      const text = JSON.stringify(out, null, 2);
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      const cause = err?.cause?.code ? ` (${err.cause.code})` : '';
      return reply(id, {
        content: [{ type: 'text', text: `调用失败：${err?.message || err}${cause}` }],
        isError: true,
      });
    }
  }
  // 有 id 却不认识的 method：按 JSON-RPC 报 method not found
  if (id !== undefined && id !== null) return replyError(id, -32601, `method not found: ${method}`);
  return undefined; // 纯通知（initialized 等直接忽略）
}

/**
 * stdin 关闭 = 客户端不再发请求。但**不能立刻 exit**：
 * tools/call 还挂着未回完的 HTTP fetch（分析一条直播要几分钟），
 * 一刀切退出会把已收到的请求暴毙成"无响应"。
 * 计数 pending，归零才退；给正常的会话收尾（opencode 常在关闭时把
 * 剩余工具调用抢跑完成）留出空间。
 */
let pendingCalls = 0;
let stdinClosed = false;
const tryExit = () => { if (stdinClosed && pendingCalls <= 0) process.exit(0); };

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  debugLog(`IN-RAW len=${line.length} head=${line.slice(0, 200)}`);
  const trimmed = line.trim();
  if (!trimmed) return;
  let msgs;
  try { msgs = JSON.parse(trimmed); } catch (e) { debugLog(`PARSE-FAIL ${e?.message}`); return; }
  const list = Array.isArray(msgs) ? msgs : [msgs];
  for (const m of list) {
    const isCall = m?.method === 'tools/call';
    if (isCall) pendingCalls++;
    Promise.resolve(handle(m))
      .catch((e) => console.error('[mcp] handler error', e))
      .finally(() => { if (isCall) { pendingCalls--; tryExit(); } });
  }
});
rl.on('close', () => {
  debugLog('STDIN-CLOSE');
  stdinClosed = true;
  tryExit();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.on('beforeExit', () => debugLog('BEFORE-EXIT(natural-drain)'));
process.on('exit', (code) => debugLog(`EXIT code=${code}`));

console.error(`[${NAME}-mcp] v${VERSION} ready (hermes: ${HERMES})`);
