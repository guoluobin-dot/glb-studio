/**
 * Ollama LLM Client
 * Wraps the Ollama API (OpenAI-compatible) for chat completions and embeddings.
 * Fully local - no external API calls.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// 2026-09-27：JSON 修复统一走 src/utils/json-repair.js（本地版实现过于保守，
// 最后一个元素哪怕只差一个引号也会被整条丢掉）。下面保留同名的薄封装，
// 调用点一处不用改，但修复能力提升；详见 utils/json-repair.js 头部说明。
import { repairJson as _repairJson } from '../utils/json-repair.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, '..', '..', 'config', 'default.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

export class OllamaClient {
  constructor(config = null) {
    const cfg = config || loadConfig();
    this.baseUrl = cfg.ollama.baseUrl;
    this.chatModel = cfg.ollama.chatModel;
    this.lightModel = cfg.ollama.lightModel || null;
    this.embeddingModel = cfg.ollama.embeddingModel;
    this.timeout = cfg.ollama.timeout || 120000;
    this.temperature = cfg.ollama.temperature || 0.7;
    this.maxTokens = cfg.ollama.maxTokens || 4096;
    this.lightCtx = cfg.performance?.lightCtx || 4096;
    this.heavyCtx = cfg.performance?.heavyCtx || 8192;
    this.visionModel = cfg.ollama.visionModel || null;
    this.visionCtx = cfg.performance?.visionCtx || 4096;
    this._availableModels = [];
    this._visionWarned = false;
    // 生成式模型（qwen3:8b / chat 版）调 /api/embed 必 501：与 embedding 模型同名时默认即降级，
    // 省掉每进程第一次的失败请求 + 模型加载抖动；换了专用 embedding 模型会自动恢复尝试
    const em = String(this.embeddingModel || '');
    // 空模型名 = 本机没装专用 embedding 模型，直接降级（不再每次进程启动白撞一次 501）；
    // qwen 系列是生成模型，调 /api/embed 必 501，同样直接降级
    this._embeddingsUnsupported = !em || /^(qwen3|qwen2)/i.test(em);
  }

  /** 更新可用模型列表（health() 成功后调用，路由轻任务用） */
  setAvailableModels(models) {
    this._availableModels = models || [];
  }

  /**
   * 任务分级路由：
   * - heavy: 主力 8B + 8K 上下文（结构拆解/主题分段/文案生成）
   * - light: 同一 8B 但只开 4K 上下文（纯分类/匹配/二选一，prefill 少一半，更快更省）
   * - vision: 视觉模型看关键帧/封面（qwen2.5vl:7b，未下载时返回 null，调用方跳过视觉增强）
   */
  resolveModel(tier = 'heavy') {
    if (tier === 'light') {
      return { model: this.chatModel, numCtx: this.lightCtx, tier: 'light' };
    }
    if (tier === 'vision') {
      if (this.visionModel && (this._availableModels.length === 0 || this._availableModels.includes(this.visionModel))) {
        return { model: this.visionModel, numCtx: this.visionCtx, tier: 'vision' };
      }
      if (!this._visionWarned) {
        console.warn(`[Ollama] 视觉模型 ${this.visionModel} 未就绪，跳过画面理解（下载中或未安装）`);
        this._visionWarned = true;
      }
      return null;
    }
    return { model: this.chatModel, numCtx: this.heavyCtx, tier: 'heavy' };
  }

  /** 视觉理解：看图说话（关键帧描述/封面设计），模型缺失时返回 null 而不是报错 */
  async describe(images, prompt, options = {}) {
    const route = this.resolveModel('vision');
    if (!route) return null;
    const baseUrl = this.baseUrl.replace('/v1', '');
    const body = {
      model: route.model,
      messages: [{ role: 'user', content: prompt, images }],
      stream: false,
      // qwen3 系列默认开 thinking，输出会全落在 thinking 字段、content 为空。
      // 不显式关掉，拿到的就是空响应（这正是长直播分析一直失败的原因之一）。
      think: false,
      keep_alive: '5m',
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
        num_ctx: this.visionCtx,
      }
    };
    if (!options.signal) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.message?.content || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // 走信号：让「取消分析」也能打断看图调用，否则视觉复看会拖住收尾
    const ctl = new AbortController();
    const onAbort = () => { try { ctl.abort(); } catch { /* ignore */ } };
    const t2 = setTimeout(() => ctl.abort(), options.timeout || this.timeout);
    if (options.signal.aborted) ctl.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.message?.content || null;
    } catch (err) {
      if (options.signal.aborted) throw err;
      return null;
    } finally {
      clearTimeout(t2);
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Send a chat request to Ollama using the native API (with think disabled).
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - override defaults
   * @returns {Promise<string>} assistant response text
   */
  async chat(messages, options = {}) {
    const baseUrl = this.baseUrl.replace('/v1', '');
    // tier 路由：调用方传 options.tier=light|heavy，不传则 options.model 优先、默认 heavy
    const route = options.model
      ? { model: options.model, numCtx: options.numCtx || this.heavyCtx, tier: 'custom' }
      : this.resolveModel(options.tier || 'heavy');
    const body = {
      model: route.model,
      messages,
      stream: false,
      think: false,
      // 轻/重两个 tier 用的是同一个 8B 模型：keep_alive 分档会让模型被卸载后重新加载，
      // 下面 min 级的耗时全部白送给模型加载；统一常驻 10 分钟
      //
      // 2026-09-30 从 10m 降到 5m。8GB 卡上常驻 10 分钟意味着任何一次超时/取消
      // 都可能留下一个没回收的 llama-server，十几个就吃满显存。
      // 5 分钟仍足以覆盖连续分析(单次调用 5~60s，中间不间隔这么久)，
      // 而显存被提前释放的风险小得多。
      keep_alive: options.keepAlive || '5m',
      options: {
        temperature: options.temperature ?? this.temperature,
        num_predict: options.maxTokens ?? this.maxTokens,
        // 上下文取 8K：本机多为 8GB 显存卡，32K 会把 KV 缓存挤到内存导致 3tok/s；
        // 8K 足够覆盖系统提示词+转写分片+4K 输出，实测 60+tok/s。
        num_ctx: options.numCtx || route.numCtx,
      }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
    // 用户的「取消分析」必须能打断这一次 LLM 调用。
    //
    // 以前只挂自己的超时 controller，跟用户的取消完全无关 ——
    // 本机 8B 跑一个 chunk 要几十秒到几分钟，用户点了取消之后
    // 它照样跑到底，于是"取消"之后界面上分析状态一直停在 analyzing，
    // 整条分析链要等当前这一次调用返回才 unwind。
    // 现象：取消请求 0ms 返回了，分析却 150s 都不结束。
    const onExternalAbort = () => { try { controller.abort(); } catch { /* ignore */ } };
    if (options.signal) {
      if (options.signal.aborted) { controller.abort(); }
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const detach = () => { if (options.signal) options.signal.removeEventListener('abort', onExternalAbort); };

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        // 2026-09-30 CUDA OOM 自动恢复。
        //
        // 现象:ollama 反复起 llama-server 却没回收旧的,十几个僵尸进程各占几 MB 显存,
        // 8GB 卡被吃干,之后每个请求都回 "CUDA error: out of memory",
        // 表现为"模型装了却一直失败",而 ollama health 还显示正常(api/tags 只列模型不占显存)。
        // 这里主动释放已加载模型再重试一次 —— 加载一次要几十秒,
        // 但总好过整条分析链路全部 chunkFailed 走兜底。
        if (res.status === 500 && /out of memory|CUDA error/i.test(errText)) {
          console.warn('[OllamaClient] CUDA OOM，释放已加载模型后重试一次');
          await this._unloadAll().catch(() => {});
          const retry = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // 重试也要能被取消打断，而且不能用 AbortSignal.timeout 单独建一个 ——
            // 那是独立信号，用户点了取消它照旧跑满 60s 以上
            signal: controller.signal
          });
          if (retry.ok) {
            const retryData = await retry.json();
            const c = retryData.message?.content || '';
            if (c) return c;
          }
          const retryErr = retry.ok ? '(空响应)' : await retry.text();
          throw new Error(`Ollama chat error ${retry.status}: ${String(retryErr).slice(0, 200)}（已尝试释放显存）`);
        }
        throw new Error(`Ollama chat error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const content = data.message?.content || '';
      return content;
    } finally {
      clearTimeout(timeoutId);
      detach();
    }
  }

  /**
   * 卸载 Ollama 里所有已加载模型，释放显存。
   *
   * 没有这个能力时，僵尸 llama-server 会一直堆着，8GB 卡很快被吃满。
   * api/generate 传 model:'' + keep_alive:0 是官方释放方式（不同版本略有差异，都试一遍）。
   */
  async _unloadAll() {
    const base = this.baseUrl.replace('/v1', '');
    const attempts = [
      { url: `${base}/api/generate`, body: { model: '', keep_alive: 0 } },
      { url: `${base}/api/chat`, body: { model: '', keep_alive: 0, messages: [] } }
    ];
    for (const a of attempts) {
      try {
        await fetch(a.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a.body),
          signal: AbortSignal.timeout(5000)
        });
      } catch {
        /* 某个端点不支持就试下一个 */
      }
    }
  }

  /**
   * Generate embeddings for a text passage using Ollama native API.
   * NOTE: 生成式模型（如 qwen3:8b）不支持 /api/embed，会报 501。
   * 此时记下 _embeddingsUnsupported，后续直接 fast-fail（返回 null 由调用方降级），
   * 避免每个话术 pattern 都浪费一次请求。向量检索降级为按类型检索，功能不受影响。
   * @param {string} text
   * @returns {Promise<number[]|null>} embedding vector (null if unsupported)
   */
  async embed(text) {
    if (this._embeddingsUnsupported) return null;
    const baseUrl = this.baseUrl.replace('/v1', '');
    const body = {
      model: this.embeddingModel,
      input: text
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 501 || /embedding/i.test(errText)) {
          this._embeddingsUnsupported = true;
          console.warn(`[Ollama] embeddings 不可用（模型 ${this.embeddingModel} 不支持 /api/embed），已降级：话术检索改用类型匹配，不影响使用。如需向量检索请另下一个 embedding 模型（如 nomic-embed-text）。`);
          return null;
        }
        throw new Error(`Ollama embed error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      // 2026-09-24 修：以前失败时返回 []（空数组是真值！），调用方以为拿到了向量、
      // 存成 0 字节 BLOB，检索时 cosine 恒等于 0 —— 错误被当成成功。改为 null 让调用方判断。
      const embedding = data.embeddings?.[0] || data.embedding || null;
      if (!Array.isArray(embedding) || embedding.length === 0) return null;
      return embedding;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if Ollama is running and the model is available.
   * @returns {Promise<{ok: boolean, version: string, models: string[]}>}
   */
  async health() {
    try {
      const base = this.baseUrl.replace('/v1', '');
      // version + tags 并行，各 5s 超时
      const [versionRes, modelRes] = await Promise.all([
        fetch(`${base}/api/version`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!versionRes.ok) return { ok: false, version: '', models: [] };
      const [versionData, modelData] = await Promise.all([
        versionRes.json(),
        modelRes.ok ? modelRes.json() : Promise.resolve({ models: [] }),
      ]);
      const models = (modelData.models || []).map(m => m.name);
      this.setAvailableModels(models);
      return { ok: true, version: versionData.version || '', models };
    } catch {
      return { ok: false, version: '', models: [] };
    }
  }

  /**
   * Generate a structured response using a system prompt + user prompt.
   * Parses JSON from the response if possible.
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {Object} options
   * @returns {Promise<string|Object>} raw text or parsed JSON
   */
  async generate(systemPrompt, userPrompt, options = {}) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const text = await this.chat(messages, options);
    if (options.parseJson) {
      // 去掉思考链（旧版 Ollama 会忽略 think:false，把 <think>…</think> 混进正文）
      const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      // 1) ```json 代码块
      const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) {
        try {
          return JSON.parse(fence[1].trim());
        } catch { /* 掉到下面的括号匹配 */ }
      }
      // 2) 首个完整 JSON 值（花括号/方括号平衡扫描，字符串感知）。
      // 以前的 /{[\s\S]*}/ 贪婪匹配会把数组外层的 [] 吞掉一半（如 [{…},{…}] 被切成 {…},{…}），
      // 数组响应退化成单个对象，话术一次只学到一条。
      const balanced = extractFirstJsonValue(clean);
      if (balanced) {
        try {
          return JSON.parse(balanced);
        } catch { /* fall through */ }
      }
      // 输出被截断（撞 num_predict 上限或超时）时尽量救回已生成的部分，
      // 而不是把整段文本当字符串返回给调用方（调用方只会当成"没有结果"而静默降级）
      const repaired = repairTruncatedJson(clean);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired);
          console.warn('[Ollama] 检测到 JSON 输出被截断，已修复为完整结构返回（条目可能少几条）');
          return parsed;
        } catch { /* fall through */ }
      }
      // 3) 兜底：整体直接 parse
      try {
        return JSON.parse(clean);
      } catch { /* fall through */ }
    }
    return text;
  }
}

/**
 * 修复被 num_predict / 超时截断的 JSON：从尾部剪到最后一个完整值，
 * 再按栈补齐未闭合的括号。让"模型写了一半"的结果也能救回大部分内容，
 * 而不是整批退化成字符串（原来整批匹配就因为这个丢掉）。
 * @returns {string|null} 修复后的 JSON 文本；原本就完整或无法修复时返回 null
 */
/**
 * 兼容封装：保留原函数名与返回契约（string|null），内部委托给公共修复层。
 * 原实现是"丢掉最后一个残缺元素"，新版会区分值截断/key 截断，尽量多留内容。
 */
function repairTruncatedJson(text) {
  const r = _repairJson(text);
  if (!r.ok || typeof r.value === 'undefined' || r.value === null) return null;
  if (typeof r.value === 'string') return null;
  try {
    return JSON.stringify(r.value);
  } catch {
    return null;
  }
}

/**
 * 从文本中提取首个完整的 JSON 对象/数组（括号栈 + 字符串/转义感知）。
 * @returns {string|null}
 */
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

export default OllamaClient;
