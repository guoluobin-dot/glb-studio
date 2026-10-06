/**
 * Zen LLM Client — Muse Spark 1.3 Contributor Free via OpenCode Zen
 *
 * 临时云端思考能力：把 Hermes 原来打给本地 Ollama 的 chat/generate/describe
 * 转发到 https://opencode.ai/zen/v1/responses（OpenAI Responses 协议）。
 *
 * 注意：
 * - Free 版只走 /v1/responses，走 /v1/chat/completions 会直接 500，别换端点。
 * - responses 协议没有 temperature 概念（reasoning 模型固定采样），这里不发 temperature。
 * - 没有 /api/embed，embed() 直接返回 null，调用方已降级为按类型检索，不影响使用。
 * - ⚠️ Contributor-Free 会拿 prompt/completion 训练模型，转写全文/截图一律视为敏感数据。
 *   必须在 config/default.json 里显式设置 "zen": { "allowCloud": true } 才允许外发，
 *   否则构造函数直接抛错，Orchestrator 应回退到本地 Ollama。
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, '..', '..', 'config', 'default.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function resolveApiKey(cfg) {
  const raw = cfg?.zen?.apiKey ?? '';
  const m = String(raw).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (m) return process.env[m[1]] || '';
  if (raw) return String(raw);
  return (
    process.env.OPENCODE_ZEN_API_KEY ||
    process.env.ZEN_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    ''
  );
}

const ALLOWED_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

function normalizeEffort(effort, fallback = 'medium') {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (e === 'off' || e === 'none') return 'minimal';
  if (e === 'max') return 'xhigh'; // Free 档不支持 max，降到 xhigh
  if (ALLOWED_EFFORTS.has(e)) return e;
  return fallback;
}

export class ZenClient {
  constructor(config = null) {
    const cfg = config || loadConfig();
    const zen = cfg.zen || {};
    if (zen.allowCloud !== true) {
      throw new Error(
        'Zen 云端默认关闭：Contributor-Free 会用你的 prompt/completion 训练模型。' +
        '如确需外发转写/截图，请在 config/default.json 的 zen 节点加 "allowCloud": true 后再用 provider=zen，默认请用本地 Ollama。'
      );
    }
    this.baseUrl = (zen.baseUrl || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
    this.model = zen.model || 'muse-spark-1.3-contributor-free';
    this.apiKey = resolveApiKey(cfg);
    this.timeout = zen.timeout || cfg.ollama?.timeout || 180000;
    this.maxTokens = zen.maxTokens || 4096;
    this.heavyEffort = normalizeEffort(zen.heavyEffort || zen.reasoningEffort || 'medium', 'medium');
    this.lightEffort = normalizeEffort(zen.lightEffort || 'low', 'low');
    this._availableModels = [];
    this._embedWarned = false;
  }

  setAvailableModels(models) {
    this._availableModels = models || [];
  }

  /** 保持和 OllamaClient 一样的分级接口：heavy=细想，light=快想省额度 */
  resolveModel(tier = 'heavy') {
    if (tier === 'light') return { model: this.model, tier: 'light', effort: this.lightEffort };
    if (tier === 'vision') return { model: this.model, tier: 'vision', effort: this.lightEffort };
    return { model: this.model, tier: 'heavy', effort: this.heavyEffort };
  }

  _effortFor(options = {}) {
    if (options.reasoningEffort) return normalizeEffort(options.reasoningEffort, this.heavyEffort);
    const tier = options.tier || 'heavy';
    if (tier === 'light' || tier === 'vision') return this.lightEffort;
    return this.heavyEffort;
  }

  _authHeaders() {
    if (!this.apiKey) {
      throw new Error(
        'Zen API Key 缺失。请到 https://opencode.ai/auth 复制 Zen Key，' +
        '然后 set OPENCODE_ZEN_API_KEY=你的key，或写进 config/default.json 的 zen.apiKey'
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @returns {Promise<string>}
   */
  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const effort = this._effortFor(options);
    const instructions = (messages || [])
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const input = (messages || [])
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }))
      .filter((m) => m.content.length > 0);
    if (input.length === 0) throw new Error('Zen chat: input 为空');

    const body = {
      model,
      ...(instructions ? { instructions } : {}),
      input,
      reasoning: { effort },
      max_output_tokens: options.maxTokens ?? this.maxTokens,
      store: false,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Zen responses error ${res.status}: ${errText.slice(0, 500)}`);
      }
      const data = await res.json();
      const text = extractOutputText(data);
      if (!text) throw new Error('Zen 未返回内容（免费额度可能用完，稍后重试或切回本地）');
      return text;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 看图说话：Muse Spark 原生支持 image input，base64 按 Responses 协议拼 */
  async describe(images, prompt, options = {}) {
    try {
      const content = [{ type: 'input_text', text: String(prompt || '描述这张图') }];
      for (const b64 of images || []) {
        if (!b64) continue;
        const url = String(b64).startsWith('data:') ? String(b64) : `data:image/jpeg;base64,${b64}`;
        content.push({ type: 'input_image', image_url: url });
      }
      const body = {
        model: options.model || this.model,
        input: [{ role: 'user', content }],
        reasoning: { effort: this._effortFor({ tier: 'light', ...options }) },
        max_output_tokens: options.maxTokens ?? 1024,
        store: false,
      };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
      try {
        const res = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        return extractOutputText(data) || null;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return null;
    }
  }

  /** Zen 无 embedding：返回 null，调用方自动降级为类型检索 */
  async embed(_text) {
    if (!this._embedWarned) {
      console.warn('[Zen] 无 embedding 接口，已降级为类型匹配检索（不影响使用）。向量检索请保持 Ollama 在线或后续加 embedding 模型。');
      this._embedWarned = true;
    }
    // 尝试本地 Ollama 兜底（Ollama 未运行则同样返回 null）；实例复用，别每次读一遍配置文件
    try {
      if (!this._embedFallback) {
        const { OllamaClient } = await import('./ollama.js');
        this._embedFallback = new OllamaClient();
      }
      return await this._embedFallback.embed(_text);
    } catch {
      return null;
    }
  }

  async health() {
    try {
      if (!this.apiKey) return { ok: false, version: '', models: [] };
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, version: '', models: [] };
      const data = await res.json();
      const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
      this.setAvailableModels(models);
      const hasOurs = models.length === 0 || models.some((m) => m.includes('muse-spark'));
      return { ok: hasOurs, version: 'zen', models: models.length ? models : [this.model] };
    } catch {
      return { ok: false, version: '', models: [] };
    }
  }

  async generate(systemPrompt, userPrompt, options = {}) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const text = await this.chat(messages, options);
    if (options.parseJson) {
      const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) {
        try {
          return JSON.parse(fence[1].trim());
        } catch { /* fall through */ }
      }
      const balanced = extractFirstJsonValue(clean);
      if (balanced) {
        try {
          return JSON.parse(balanced);
        } catch { /* fall through */ }
      }
      try {
        return JSON.parse(clean);
      } catch { /* fall through */ }
    }
    return text;
  }
}

function extractOutputText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const out = data.output;
  if (!Array.isArray(out)) return '';
  const parts = [];
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
  }
  return parts.join('').trim();
}

function extractFirstJsonValue(text) {
  const startIdx = (() => {
    const iObj = text.indexOf('{');
    const iArr = text.indexOf('[');
    if (iObj === -1) return iArr;
    if (iArr === -1) return iObj;
    return Math.min(iObj, iArr);
  })();
  if (startIdx === -1) return null;
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
      if (stack.length === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

export default ZenClient;
