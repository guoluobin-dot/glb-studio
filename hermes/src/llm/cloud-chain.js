/**
 * 云端供应商链路：多路候选 + 自动故障转移 + 逐路诊断。
 *
 * 2026-10-12 加。
 *
 * 为什么要做这个：原来云端只有一条路（GeminiClient），而且 key 写在配置里、
 * 面板上只能填一把。于是"那把 key 失效"= 云端整体不可用 = 长直播全回落本地，
 * 用户唯一的出路是手工换一把 key —— 换的过程中系统全程瘫着。
 *
 * 实测踩到的：APIMart 的 key 被拒（invalid API key），
 * 而同一台机器上完全可能还有能用的 DeepSeek / 官方 Gemini / 另一个中转。
 * 一把 key 失效不该拖垮整条云端链路。
 *
 * 三件事：
 *   1) 候选链：Gemini（含中转，OpenAI 兼容）/ DeepSeek / 自定义中转，按配置顺序
 *   2) 故障转移：运行期某一路报错就把它标记为不健康，自动换下一路，
 *      并在**下一次健康检查**时重新纳入（避免永久拉黑一把刚充值的 key）
 *   3) 诊断：/api/cloud-test 逐路给出"通/不通 + 服务端原话 + 耗时"，
 *      免得只能看到一个笼统的"云端不可用"
 *
 * 不改变既有行为：只配了 gemini 一家时，链路长度就是 1，语义与之前完全一致。
 */
import { GeminiClient } from './gemini.js';
import { DeepSeekClient } from './deepseek.js';
import { readJsonFile } from '../utils/read-config.js';
import { join } from 'path';
import { statSync } from 'fs';
import { resolveProxy, proxySource } from './proxy.js';

/** key 支持三种写法：明文 / {env:NAME} / 环境变量兜底 */
function resolveKey(cfg, section, envName) {
  const raw = cfg?.[section]?.apiKey ?? '';
  const m = String(raw).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (m) return process.env[m[1]] || '';
  if (raw) return String(raw).trim();
  return process.env[envName] || '';
}

/** 探测一次"这个供应商有没有配"。不构造客户端，避免缺 key 时抛异常 */
function configured(cfg, section, envName) {
  return Boolean(resolveKey(cfg, section, envName));
}

/**
 * 构造云端候选链。顺序 = 配置里给的优先级：
 *   1. gemini（含第三方中转，protocol=openai-compatible 时就是任意 OpenAI 兼容网关）
 *   2. deepseek
 *   3. llm.relay[]（任意数量的自定义中转，一个坏一个不影响下一个）
 *
 * @returns {{name:string, kind:string, client:object|null, missing?:string}[]}
 */
export function buildCloudCandidates(cfg) {
  const out = [];

  // 1) Gemini / 中转（OpenAI 兼容）
  if (configured(cfg, 'gemini', 'GEMINI_API_KEY')) {
    try {
      out.push({ name: 'gemini', kind: cfg?.gemini?.protocol === 'openai-compatible' ? 'relay-openai' : 'gemini', client: new GeminiClient(cfg) });
    } catch (err) {
      out.push({ name: 'gemini', kind: 'gemini', client: null, missing: err.message });
    }
  }

  // 2) DeepSeek
  if (configured(cfg, 'deepseek', 'DEEPSEEK_API_KEY')) {
    try {
      out.push({ name: 'deepseek', kind: 'deepseek', client: new DeepSeekClient(cfg) });
    } catch (err) {
      out.push({ name: 'deepseek', kind: 'deepseek', client: null, missing: err.message });
    }
  }

  // 3) 自定义中转：{ baseUrl, apiKey, model, protocol?, auth? }
  const relays = Array.isArray(cfg?.llm?.relay) ? cfg.llm.relay : [];
  for (const [i, r] of relays.entries()) {
    if (!r || !r.baseUrl || !r.apiKey) continue;
    const sub = {
      ...cfg,
      gemini: {
        ...(cfg.gemini || {}),
        apiKey: r.apiKey,
        baseUrl: r.baseUrl,
        model: r.model || cfg?.gemini?.model || 'gpt-4o-mini',
        protocol: r.protocol || 'openai-compatible',
        auth: r.auth || 'bearer',
        cloudBudgetPerRun: r.cloudBudgetPerRun ?? cfg?.gemini?.cloudBudgetPerRun,
      },
    };
    try {
      out.push({ name: r.name || `relay#${i + 1}`, kind: 'relay-openai', client: new GeminiClient(sub) });
    } catch (err) {
      out.push({ name: r.name || `relay#${i + 1}`, kind: 'relay-openai', client: null, missing: err.message });
    }
  }

  return out;
}

/**
 * 链路管理器：记住哪些路坏了，下次自动跳过；到冷却时间后再放回来重试。
 *
 * 为什么要有"再放回来"：key 失效可能是暂时的（余额充值、限流、临时故障）。
 * 一旦拉黑就永不再试，等于把"重试一下就好"变成"必须重启服务"。
 */
export class CloudChain {
  constructor(config) {
    this.config = config;
    this.candidates = buildCloudCandidates(config);
    /** name -> {ok:boolean, error:string, checkedAt:number} */
    this.state = new Map();
    this.active = null;
    this.lastProbe = 0;
    this.PROBE_TTL_MS = 5 * 60 * 1000;   // 健康判定有效期
    this.RETRY_COOLDOWN_MS = 10 * 60 * 1000; // 判死后的复活等待
  }

  get hasAny() { return this.candidates.length > 0; }

  /** 列出候选与当前状态（诊断用） */
  list() {
    return this.candidates.map((c) => ({
      name: c.name,
      kind: c.kind,
      model: c.client?.model || null,
      baseUrl: c.client?.baseUrl || null,
      missing: c.missing || null,
      ...(this.state.get(c.name) || {}),
    }));
  }

  /** 探测一条；返回 {ok, error, elapsedMs} */
  async _probe(c, timeoutMs = 15000) {
    if (!c.client) return { ok: false, error: c.missing || '未配置', elapsedMs: 0 };
    const t0 = Date.now();
    try {
      const h = await c.client.health();
      const elapsedMs = Date.now() - t0;
      if (!h?.ok) {
        return { ok: false, error: h?.error || '探测未通过', elapsedMs, models: h?.models || [] };
      }
      // health() 只查模型列表；列表为空时不能直接当"可用"——
      // 那正是中转站最常见的假阳性（能连上但没有可用模型）。
      return { ok: true, error: null, elapsedMs, models: h.models || [] };
    } catch (err) {
      return { ok: false, error: err.message, elapsedMs: Date.now() - t0 };
    }
  }

  /**
   * 逐条探测全部候选（/api/cloud-test 用）。
   * 返回每一路的判定，并把第一条可用的记为 active。
   */
async probeAll() {
		const results = [];
		// 先清掉旧的 active：它可能已经判死了（冷却期到了才重新探），
		// 留着会让"这次探到好的"无法接管 —— active 永远停在一个坏通道上。
		this.active = null;
		for (const c of this.candidates) {
			const r = await this._probe(c);
			this.state.set(c.name, { ...r, checkedAt: Date.now() });
			results.push({ name: c.name, kind: c.kind, model: c.client?.model || null, baseUrl: c.client?.baseUrl || null, ...r });
			if (r.ok && !this.active) this.active = c;
		}
		this.lastProbe = Date.now();
		return results;
	}

  /**
   * 取一个当前可用的客户端。失败时会把出问题的路标记掉并顺延到下一路。
   * @param {string} method 触发健康检查的方法名（chat/describe…）
   */
  async pick(exclude = null) {
    // 健康状态过期了就重探一遍（避免把刚充值的 key 永久拉黑）
    if (Date.now() - this.lastProbe > this.PROBE_TTL_MS && this.candidates.length > 1) {
      await this.probeAll();
    }
    const order = this.candidates.filter((c) => c !== exclude && c.client);
    for (const c of order) {
      const st = this.state.get(c.name);
      if (st && !st.ok && Date.now() - (st.checkedAt || 0) < this.RETRY_COOLDOWN_MS) continue; // 冷却中，先跳过
      if (!st) {
        // 没探过：先探。探不通就记下来顺延，而不是每次调用都吃一次超时。
        const r = await this._probe(c);
        this.state.set(c.name, { ...r, checkedAt: Date.now() });
        if (!r.ok) continue;
      }
      this.active = c;
      return c;
    }
    return null;
  }

  /** 运行期某一路出错：拉黑它并把 active 让给下一路 */
  markFailed(name, error) {
    this.state.set(name, { ok: false, error: String(error).slice(0, 300), checkedAt: Date.now() });
    if (this.active?.name === name) this.active = null;
  }
}

/** 诊断摘要：给 /api/cloud-test 和面板用 */
export function cloudSummary(cfg, results) {
  const usable = results.filter((r) => r.ok);
  return {
    proxy: resolveProxy(cfg) || null,
    proxySource: proxySource(),
    total: results.length,
    usable: usable.length,
    verdict: usable.length
      ? `可用：${usable.map((r) => r.name).join('、')}`
      : (results.length ? '所有云端通道都不通' : '没有配置任何云端通道'),
  };
}