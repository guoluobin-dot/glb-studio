#!/usr/bin/env node
/**
 * Hermes - AI Memory & Copywriting Engine for GLB
 *
 * A local-first intelligent companion service that:
 * - Learns from every video processed by GLB
 * - Builds a permanent memory of rhythm, highlights, retention patterns
 * - Generates and embeds sales copywriting into output videos
 * - Feeds learned patterns back to GLB to improve detection
 *
 * Powered by Ollama + Qwen3 8B, fully offline, no external API calls.
 *
 * Usage:
 *   node src/hermes.js              Start the Hermes server
 *   node src/hermes.js --status     Check service status
 *   node src/hermes.js --init       Initialize memory database
 */

import { Orchestrator } from './orchestrator/index.js';
import { createLlmClient } from './llm/router.js';
import { applyProxyEnv, resolveProxy, proxySource } from './llm/proxy.js';
import { MemoryStore } from './memory/store.js';
import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 把 config/secrets.local.json 里的键灌进 process.env —— 必须在任何 LLM 客户端
 * 构造之前跑（它们在构造期就 resolveApiKey，之后就固定了）。
 *
 * 为什么要这个文件：
 * 以前 deepseek.apiKey / gemini.apiKey 是明文躺在 config/default.json 里的。
 * 那个文件是要进版本库的，等于密钥跟着代码一起走。改成 {env:NAME} 占位符之后，
 * 光有占位符还不够 —— 没人会为了跑个本地服务去手工设系统环境变量，那样
 * 换台机器就废了。所以保留一个**被 .gitignore 忽略**的本地文件托底：
 *   - config/default.json 只留 {env:DEEPSEEK_API_KEY} 这类占位符，可安全入库
 *   - 真实 key 放 config/secrets.local.json，不入库、不外传
 *   - 优先级：真实环境变量 > 这个文件（环境变量可以临时覆盖，方便换 key）
 *
 * 文件不存在是正常的（纯本地 Ollama 模式不需要任何 key），不能因此启动失败。
 */
function loadLocalSecrets() {
  const file = join(__dirname, '..', 'config', 'secrets.local.json');
  if (!existsSync(file)) return 0;
  let obj;
  try {
    obj = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.warn(`[Secrets] 读取 ${file} 失败（已忽略）: ${err.message}`);
    return 0;
  }
  let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    // 已有真实环境变量优先，不覆盖：方便临时换 key 而不用改文件
    if (!process.env[k] && typeof v === 'string' && v.trim()) {
      process.env[k] = v.trim();
      n++;
    }
  }
  if (n) console.log(`[Secrets] 已从 secrets.local.json 载入 ${n} 项`);
  return n;
}
loadLocalSecrets();

// 崩溃留痕：任何未捕获异常都写入 data/crash.log，方便排查“静默退出”
// 超 1MB 轮转一次（crash.log.old），避免崩溃循环打满磁盘
function logCrash(prefix, err) {
  try {
    const dataDir = join(__dirname, '..', 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'crash.log');
    try {
      if (existsSync(file) && statSync(file).size > 1024 * 1024) {
        try { renameSync(file, file + '.old'); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    const line = `[${new Date().toISOString()}] ${prefix}: ${err?.stack || err}\n`;
    appendFileSync(file, line);
  } catch { /* ignore */ }
}
// 崩溃时要先收摊：正在跑的 ffmpeg / sherpa 子进程会变成孤儿继续吃 CPU 和文件句柄，
// SQLite 也不关（WAL 留着）。stop() 是同步可等的，这里尽力调用后再退。
let _activeOrchestrator = null;
process.on('uncaughtException', (err) => {
  console.error('[Hermes] UNCAUGHT:', err);
  logCrash('uncaughtException', err);
  const o = _activeOrchestrator;
  if (o?.stop) {
    // stop() 是 async（watcher.close 要等），这里没法 await，但也不能同步 exit 掉——
    // 那会留下孤儿 ffmpeg。给它 1.5s 收摊，超时就强退。
    Promise.resolve(o.stop()).catch(() => {}).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 1500).unref();
    return;
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Hermes] UNHANDLED REJECTION:', reason);
  logCrash('unhandledRejection', reason);
});

function loadConfig() {
  const configPath = join(__dirname, '..', 'config', 'default.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

// Status check mode
if (process.argv.includes('--status')) {
const config = loadConfig();

// 出网代理：必须在任何 fetch 之前灌好。
//
// 为什么放在最前面：Node 内置 fetch 只认环境变量里的代理，不读 Windows 系统代理设置。
// 这台机器开了 Clash（127.0.0.1:4780）而环境变量是空的，于是所有云端请求都在直连——
// 表现为"API 用不了"，实际是连都没连上（连服务端的 401 都拿不到）。
// 优先级：设置里手填 > 环境变量 > Windows 系统代理，所以用户改设置能覆盖系统值。
applyProxyEnv(config);
const _proxy = resolveProxy(config);
console.log(
  _proxy
    ? `Outbound proxy: ${_proxy}  (from ${proxySource()})`
    : 'Outbound proxy: none (direct connection)'
);

const ollama = createLlmClient(config);

  const health = await ollama.health();
  console.log('\n=== Hermes Status ===');
  console.log(`Ollama: ${health.ok ? 'ONLINE (v' + health.version + ')' : 'OFFLINE'}`);
  if (health.models.length > 0) {
    console.log(`Models: ${health.models.join(', ')}`);
  }

  // Check database
  try {
    const store = new MemoryStore(config);
    const stats = store.getStats();
    console.log('\nMemory Database:');
    console.log(`  Videos processed: ${stats.videos}`);
    console.log(`  Highlight patterns: ${stats.highlights}`);
    console.log(`  Retention signals: ${stats.retentionSignals}`);
    console.log(`  Copywriting patterns: ${stats.copywritingPatterns}`);
    console.log(`  Speaker profiles: ${stats.speakers}`);

    if (stats.genreDistribution.length > 0) {
      console.log('\nGenre Distribution:');
      for (const g of stats.genreDistribution) {
        console.log(`  ${g.genre}: ${g.count} patterns`);
      }
    }

    if (stats.peakTypeStats.length > 0) {
      console.log('\nPeak Type Stats:');
      for (const p of stats.peakTypeStats) {
        console.log(`  ${p.peak_type}: ${p.count} patterns, avg intensity ${p.avg_intensity?.toFixed(2)}`);
      }
    }

    if (stats.copywritingTypeDistribution.length > 0) {
      console.log('\nCopywriting Patterns:');
      for (const c of stats.copywritingTypeDistribution) {
        console.log(`  ${c.pattern_type}: ${c.count} patterns, avg effectiveness ${c.avg_effect?.toFixed(2)}`);
      }
    }

    store.close();
  } catch (err) {
    console.log(`Database: NOT INITIALIZED (${err.message})`);
  }

  console.log(`\nServer port: ${config.server.port}`);
  console.log(`LLM provider: ${config.llm?.provider || 'ollama'}`);
  console.log(`Ollama URL: ${config.ollama.baseUrl}`);
  console.log('====================\n');
  process.exit(0);
}

// Initialize database mode
if (process.argv.includes('--init')) {
  const store = new MemoryStore();
  console.log(`\nHermes memory database initialized at: ${store.dbPath}`);
  console.log('All tables created successfully.');
  const stats = store.getStats();
  console.log(`Stats: ${JSON.stringify(stats, null, 2)}`);
  store.close();
  process.exit(0);
}

// Main server mode
const orchestrator = new Orchestrator();
_activeOrchestrator = orchestrator;

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Hermes] Shutting down...');
  await orchestrator.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await orchestrator.stop();
  process.exit(0);
});

// Start the server
orchestrator.start().catch(err => {
  console.error('[Hermes] Failed to start:', err.message);
  console.error('\nTroubleshooting:');
  console.error('  1. Make sure Ollama is running: run 一键启动.cmd from the bundle root');
  console.error('  2. Verify Ollama is healthy: open http://localhost:11434 in browser');
  console.error('  3. Check that no other service is using port', orchestrator.config.server.port);
  process.exit(1);
});
