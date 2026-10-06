/**
 * Gemini 客户端 — 长上下文增强引擎
 * © 2026 郭洛斌
 *
 * 定位:不是"替代"本地模型,而是补上它看不到的那一段。
 *
 * 本地 qwen3:8b 约 4 万上下文,单条带货/课程片段(几十到几百字)完全够用,
 * 所以短片段型内容一律本地处理——免费、无限、隐私。
 * 但一场 2-5 小时直播的逐句稿是 3-6 万字,超出本地窗口,分块送入会丢掉
 * 全局视角(不知道整场节奏、哪个知识点是核心),这就是"筛出来总不对"的根因。
 * Gemini 系列提供百万级上下文,能一次看完整场,并能直接处理音频/视频,
 * 天然适合知识付费、教学、连麦这类需要"看懂内容形式"的直播。
 *
 * 接口与本地客户端同形(chat/generate/describe/embed/health/resolveModel),
 * Orchestrator 无需改动调用方式:
 * - describe():  Gemini 原生支持图像输入,直接看图,不必回落
 * - embed():     Gemini 无批量 embedding,回落本地向量
 * - key 配置:    config/default.json → gemini.apiKey,或 {env:GEMINI_API_KEY}
 *
 * 成本护栏:单次分析的云端调用次数由 cloudBudgetPerRun 限制,超出即回落本地,
 * 避免长直播场景把额度打光。
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { repairJson } from '../utils/json-repair.js';
import { fetchWithDiagnostics, describeHttpFailure, resolveProxy, proxySource } from './proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
	const configPath = join(__dirname, '..', '..', 'config', 'default.json');
	return JSON.parse(readFileSync(configPath, 'utf-8'));
}

/** apiKey 支持三种写法:直接值、{env:NAME} 占位、环境变量兜底 */
function resolveApiKey(cfg) {
	const raw = cfg?.gemini?.apiKey ?? '';
	const m = String(raw).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (m) return process.env[m[1]] || '';
	if (raw) return String(raw).trim();
	return process.env.GEMINI_API_KEY || '';
}

export class GeminiClient {
	constructor(config = null) {
		const cfg = config || loadConfig();
		const g = cfg.gemini || {};
		/**
		 * 接口协议。
		 *
		 * 'gemini-native'  = Google 官方那套（?key= 认证 + :generateContent）
		 * 'openai-compatible' = 中转服务那套（Bearer 认证 + /chat/completions）
		 *
		 * 为什么必须区分：两者的路径、认证头、请求体、响应结构全都不同。
		 * 只改 baseUrl 去接中转是行不通的 —— 请求会打到不存在的路径上，
		 * 表现为 401/404，而报错信息完全看不出是协议不对。
		 */
		this.protocol = g.protocol === 'openai-compatible' ? 'openai-compatible' : 'gemini-native';
		// OpenAI 兼容的地址通常带 /v1；官方那套是 /v1beta。默认按协议给。
		this.baseUrl = (g.baseUrl || (this.protocol === 'openai-compatible'
			? 'https://api.openai.com/v1'
			: 'https://generativelanguage.googleapis.com/v1beta')).replace(/\/$/, '');
		this.model = g.model || 'gemini-3.5-flash';
		/**
		 * 认证方式 —— 和协议是两个独立的维度，不能混为一谈。
		 *
		 * 文档（APIMart）对 Gemini 原生格式明确写的是 `Authorization: Bearer`，
		 * 而 Google 官方原生是 `?key=` 查询参数。两者请求体完全一样，
		 * 只有认证头不同 —— 所以不能按"是不是 gemini-native"来决定怎么认证。
		 *
		 * 不显式配的话按协议给默认：openai-compatible 本来就是 Bearer，
		 * gemini-native 保持 ?key= 以免影响已经在跑的 Google 直连。
		 * 接 APIMart 这类中转时必须显式写 gemini.auth='bearer'。
		 */
		this.auth = g.auth === 'bearer' ? 'bearer' : g.auth === 'query-key' ? 'query-key'
			: (this.protocol === 'openai-compatible' ? 'bearer' : 'query-key');
		this.apiKey = resolveApiKey(cfg);
		if (!this.apiKey) {
			throw new Error(
				'Gemini API Key 缺失:请在 config/default.json 的 gemini.apiKey 里填 key,' +
				'或 set GEMINI_API_KEY=你的key。填好前 provider 请保持 ollama。'
			);
		}
		this.timeout = g.timeout || 600000;
		// 记下代理，health() 要回报给界面 —— 用户排查时最需要知道的就是"到底走没走代理"。
		this.proxy = resolveProxy(cfg);
		this.proxySource = proxySource();
		this.maxTokens = g.maxTokens || 16384;
		this.temperature = g.temperature ?? 0.6;
		/** 单次分析允许的云端调用上限,超额回落本地,防止额度失控 */
		this.budget = Number(g.cloudBudgetPerRun || 8);
		this.spent = 0;
		this._availableModels = [];
		this._visionWarned = false;
	}

	resetBudget() {
		this.spent = 0;
	}

	budgetLeft() {
		return Math.max(0, this.budget - this.spent);
	}

	setAvailableModels(models) {
		this._availableModels = models || [];
	}

	resolveModel(tier = 'heavy') {
		return { model: this.model, tier: tier === 'vision' ? 'vision' : tier === 'light' ? 'light' : 'heavy' };
	}

	/**
	 * 请求地址与认证头。
	 *
	 * 两种协议的认证方式完全不同：Google 原生用 ?key= 查询参数，
	 * OpenAI 兼容用 Authorization: Bearer 头。搞混了就是 401。
	 */
	_request(pathname) {
		if (this.auth === 'bearer') {
			return {
				url: `${this.baseUrl}/${pathname}`,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`
				}
			};
		}
		return {
			url: `${this.baseUrl}/${pathname}?key=${encodeURIComponent(this.apiKey)}`,
			headers: { 'Content-Type': 'application/json' }
		};
	}

	/**
	 * 剥掉中转服务的响应信封。
	 *
	 * APIMart 这类网关会把真实响应包一层：
	 *   { "code": 200, "data": { "candidates": [...] } }
	 *   { "code": 200, "data": { "choices": [...] } }
	 * 而 Google 官方和 OpenAI 官方都是**不包**的（直接就是 {candidates|choices}）。
	 *
	 * 这里必须做自动判别而不是写死"要不要剥"，因为同一个 GeminiClient 会被
	 * 拿去接不同的服务商（官方直连 / 中转），写死就一定有一种是错的。
	 *
	 * 而且这个 bug 极其隐蔽：剥不剥都**不会报错**，
	 * 只是取内容时拿到 undefined，最后抛一句"未返回内容" ——
	 * 看起来像模型没说话，实际是取错了层级。
	 *
	 * 判据用"内层有没有我们认识的字段"，不只看 data 存不存在：
	 * 免得某些模型自己的返回里正好有个 data 字段就被误剥。
	 */
	_unwrapEnvelope(payload) {
		if (!payload || typeof payload !== 'object') return payload;
		const inner = payload.data;
		if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return payload;
		const looksLikePayload =
			Array.isArray(inner.candidates) || Array.isArray(inner.choices) ||
			Array.isArray(inner.models) || Array.isArray(inner.data);
		if (!looksLikePayload) return payload;
		if (!this._unwrappedOnce) {
			this._unwrappedOnce = true;
			console.log(`[Gemini] 响应带 {code,data} 信封，已自动剥取内层（${this.protocol}）`);
		}
		return inner;
	}

	/**
	 * 从（可能带信封的）响应里取候选文本。
	 * 两种协议的正文位置不同，但剥完信封之后都是各自的老位置。
	 */
	_extractText(raw) {
		const data = this._unwrapEnvelope(raw);
		return this.protocol === 'openai-compatible'
			? String(data?.choices?.[0]?.message?.content ?? '').trim()
			: (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
	}

	/**
	 * 解析响应体。
	 *
	 * 中转站在"默认流式"下会无视 stream:false 仍然返回 SSE 文本：
	 *   data: {"id":"chatcmpl-…","choices":[{…}]}
	 *   data: [DONE]
	 * 直接 res.json() 会抛 "Unexpected token 'd'"，看不出是协议问题。
	 * 所以这里先拿文本，JSON 失败就按 SSE 逐条拆，取最后一条完整增量拼接。
	 */
	_parseBody(text) {
		const raw = String(text || '').trim();
		if (!raw) return null;
		if (raw[0] === '{' || raw[0] === '[') {
			try { return JSON.parse(raw); } catch { /* 落到下面按 SSE 试 */ }
		}
		if (raw.includes('data:')) {
			let acc = null;
			for (const line of raw.split('\n')) {
				const t = line.trim();
				if (!t.startsWith('data:')) continue;
				const chunk = t.slice(5).trim();
				if (!chunk || chunk === '[DONE]') continue;
				try {
					const obj = JSON.parse(chunk);
					const delta = obj?.choices?.[0]?.delta?.content;
					if (typeof delta === 'string' && delta) {
						acc = acc || { id: obj.id, model: obj.model, choices: [{ index: 0, message: { role: 'assistant', content: '' } }] };
						acc.choices[0].message.content += delta;
					} else if (obj?.choices) {
						acc = obj;   // 某些网关只发一次完整体
					}
				} catch { /* 半行/心跳，跳过 */ }
			}
			if (acc) {
				if (!this._streamWarned) {
					this._streamWarned = true;
					console.warn('[Gemini] 服务端返回了流式(SSE)响应，已按增量拼接处理');
				}
				return acc;
			}
		}
		throw new Error(`响应不是合法 JSON，也不是可解析的流式数据：${raw.slice(0, 200)}`);
	}

	/** token 用量（剥信封之后取），拿不到返回 null —— 只用于日志，不参与控制流 */
	_usage(raw) {
		const inner = this._unwrapEnvelope(raw);
		/*
		 * usageMetadata 可能在信封外面 —— APIMart 文档的报文就是：
		 *   { code:200, data:{candidates:…}, usageMetadata:{…} }
		 * 注意 usage 和 candidates 不在同一层。所以两层都要看，
		 * 只看剥完的内层会把用量整个丢掉。
		 */
		const u = inner?.usageMetadata || inner?.usage
			|| raw?.usageMetadata || raw?.usage
			|| raw?.data?.usageMetadata || null;
		if (!u) return null;
		return {
			prompt: u.promptTokenCount ?? u.prompt_tokens ?? null,
			completion: u.candidatesTokenCount ?? u.completion_tokens ?? null,
			total: u.totalTokenCount ?? u.total_tokens ?? null,
			thoughts: u.thoughtsTokenCount ?? null
		};
	}


	/**
	 * 把内部消息格式转成 Gemini 的 contents 结构。
	 * system 角色单独放 systemInstruction(仅取第一条 system)。
	 */
	_toContents(messages) {
		const systemParts = [];
		const contents = [];
		for (const m of messages || []) {
			const text = String(m.content ?? '');
			if (!text) continue;
			if (m.role === 'system') {
				systemParts.push({ text });
				continue;
			}
			contents.push({
				role: m.role === 'assistant' ? 'model' : 'user',
				parts: [{ text }]
			});
		}
		return { systemInstruction: systemParts.length ? { parts: systemParts } : undefined, contents };
	}

	/**
	 * @param {Array<{role:string, content:string}>} messages
	 * @returns {Promise<string>} 模型回复文本
	 */
	async chat(messages, options = {}) {
		const { systemInstruction, contents } = this._toContents(messages);
		const model = options.model || this.model;
		const maxTokens = options.maxTokens ?? this.maxTokens;
		const temperature = options.temperature ?? this.temperature;

		// ── 两种协议的请求体形状不同 ──
		const isOai = this.protocol === 'openai-compatible';
		const body = isOai
			? {
				model,
				messages: [
					...(systemInstruction ? [{ role: 'system', content: systemInstruction.parts.map((p) => p.text).join('') }] : []),
					...contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts.map((p) => p.text).join('') }))
				],
				max_tokens: maxTokens,
				temperature,
				/*
				 * 必须显式声明 stream:false。
				 *
				 * APIMart 的"通用对话接口"文档标题就写着**默认流式**，而我们不传这个字段时
				 * 它就按流式返回 —— 响应体是 SSE 文本（每行 `data: {...}`），
				 * 于是 res.json() 直接抛：
				 *     Unexpected token 'd', "data: {"id"... is not valid JSON
				 * 这个报错完全看不出是"协议没配对"，很容易被误当成 key 或模型的问题。
				 */
				stream: false
			}
			: {
				contents,
				generationConfig: { maxOutputTokens: maxTokens, temperature }
			};
		if (!isOai && systemInstruction) body.systemInstruction = systemInstruction;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
		this.spent++;
		try {
			const { url, headers } = this._request(
				isOai ? 'chat/completions' : `models/${model}:generateContent`
			);
			const res = await fetchWithDiagnostics(
				url,
				{
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: controller.signal
				},
				options.timeout || this.timeout
			);
			if (!res.ok) {
				const errText = await res.text().catch(() => '');
				// 分级报错：401 是 key 的问题、404 是地址/协议的问题、超时是代理的问题，
				// 三者处理办法完全不同。以前一律报"连接失败"，用户只能靠猜。
				throw new Error(`${describeHttpFailure(res.status, res.statusText, errText)}（协议：${this.protocol}）`);
			}
			const data = this._parseBody(await res.text());
			// 响应结构完全不同：OpenAI 兼容在 choices[0].message.content；
			// 而且中转服务（APIMart）还会再包一层 {code,data}，
			// 所以这里必须走 _extractText（会自动剥信封），不能直接取顶层字段。
			const text = this._extractText(data);
			if (!text) {
				throw new Error(`Gemini 未返回内容（${this.protocol}）: ${JSON.stringify(data).slice(0, 200)}`);
			}
			const u = this._usage(data);
			if (u?.total) this.lastUsage = u;
			return text;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * 结构化输出:与本地客户端同形,parseJson 时走公共修复层
	 *
	 * 重试放在这一层而不是 chat()：chat() 是单次 HTTP 调用，
	 * 而"该不该重试"取决于错误类型和这次调用的用途（generate 会再解析 JSON，
	 * 一次 429 就整条分析失败，代价太大）。
	 *
	 * 依据 APIMart 文档的错误码分类：
	 *   429 RESOURCE_EXHAUSTED  请求过于频繁 → 必须退避重试
	 *   500 INTERNAL / 502 BAD_GATEWAY / 503 UNAVAILABLE → 服务端临时故障，退避重试
	 *   400 INVALID_ARGUMENT   → 参数不对，重试多少次都一样
	 *   401 UNAUTHENTICATED    → key 的问题
	 *   402 PAYMENT_REQUIRED   → 余额不足，重试只是白花钱
	 *   403 PERMISSION_DENIED  → 没权限
	 *   404 NOT_FOUND          → 模型名/路径不存在，重试无意义
	 * 所以只对前四类退避重试。
	 */
	async generate(systemPrompt, userPrompt, options = {}) {
		const messages = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt }
		];
		const maxRetry = options.maxRetry ?? 2;
		let text = '';
		for (let i = 0; i <= maxRetry; i++) {
			try {
				text = await this.chat(messages, options);
				break;
			} catch (err) {
				const msg = String(err?.message || err);
				const retryable = this._isRetryable(msg);
				if (!retryable || i === maxRetry) throw err;
				// 指数退避 + 上限，避免把限流打得更狠
				const waitMs = Math.min(30000, 2000 * Math.pow(3, i));
				console.warn(
					`[Gemini] ${msg.split('。')[0]}；${Math.round(waitMs / 1000)}s 后重试 ${i + 1}/${maxRetry}`
				);
				await new Promise((r) => setTimeout(r, waitMs));
			}
		}
		if (options.parseJson) {
			const r = repairJson(text);
			if (r.ok) return r.value;
			return text;
		}
		return text;
	}

	/**
	 * 判断这个错误该不该退避重试。
	 * 只认"重试有可能变好"的：限流与服务端临时故障。
	 */
	_isRetryable(msg) {
		if (/HTTP (429|500|502|503)\b/.test(msg)) return true;
		if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|请求过于频繁|服务暂时不可用|网关错误/i.test(msg)) return true;
		// 明确的不可重试：key / 余额 / 权限 / 模型名 / 参数
		if (/HTTP (400|401|402|403|404)\b/.test(msg)) return false;
		// 余额不足/没权限/模型不存在，即使文本里混了"暂时"也不能重试
		if (/余额不足|没有访问权限|找不到指定的模型|认证失败/i.test(msg)) return false;
		return false;
	}

	/**
	 * 看图。两种协议的图片传法不同：
	 *  - Google 原生：inlineData { mimeType, data } 内联
	 *  - OpenAI 兼容：content 里塞 image_url 的 data URL
	 * 中转服务看图能力不一定全，这个方法失败一律返回 null（调用方会回落本地视觉模型），
	 * 不能因为协议不支持就把整个分析搞挂。
	 */
	async describe(images, prompt, options = {}) {
		try {
			const list = Array.isArray(images) ? images : images ? [images] : [];
			const isOai = this.protocol === 'openai-compatible';
			const model = options.model || this.model;
			let body;
			if (isOai) {
				const content = [];
				if (prompt) content.push({ type: 'text', text: String(prompt) });
				for (const img of list) {
					const b64 = typeof img === 'string' ? img.replace(/^data:[^;]+;base64,/, '') : img?.base64;
					const mime = (typeof img === 'object' && img?.mimeType) || 'image/jpeg';
					if (!b64) continue;
					content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
				}
				if (content.length === 0) return null;
				body = { model, messages: [{ role: 'user', content }] };
			} else {
				const parts = [];
				if (prompt) parts.push({ text: String(prompt) });
				for (const img of list) {
					const b64 = typeof img === 'string' ? img.replace(/^data:[^;]+;base64,/, '') : img?.base64;
					const mime = (typeof img === 'object' && img?.mimeType) || 'image/jpeg';
					if (!b64) continue;
					parts.push({ inlineData: { mimeType: mime, data: b64 } });
				}
				if (parts.length === 0) return null;
				body = { contents: [{ role: 'user', parts }] };
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
			this.spent++;
			try {
				const { url, headers } = this._request(
					isOai ? 'chat/completions' : `models/${model}:generateContent`
				);
				const res = await fetchWithDiagnostics(
					url,
					{ method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal },
					options.timeout || this.timeout
				);
				if (!res.ok) {
					// 不再静默 return null：中转站常常不支持图片模型或 multimodal 端点，
					// 以前这里什么都不记，表现只是"视觉分析好像没结果"，查不到原因。
					// 同一个原因只警告一次，避免每张关键帧刷一行。
					if (!this._visionWarned) {
						const t = await res.text().catch(() => '');
						console.warn(
							`[Gemini] 看图不可用（HTTP ${res.status}），已回落到本地视觉模型：`
							+ `${String(t).slice(0, 160)}`
						);
						this._visionWarned = true;
					}
					return null;
				}
				const data = this._parseBody(await res.text());
				const out = this._extractText(data);
				return out || null;
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (err) {
			if (!this._visionWarned) {
				console.warn(`[Gemini] 看图调用失败，已回落到本地视觉模型：${String(err?.message || err).slice(0, 200)}`);
				this._visionWarned = true;
			}
			return null;
		}
	}

	/** Gemini 无批量 embedding 接口,回落本地向量(不影响使用) */
	async embed(_text) {
		if (!this._visionWarned) {
			console.warn('[Gemini] 无 embedding 接口,已降级为本地向量(不影响使用)');
			this._visionWarned = true;
		}
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
			const isOai = this.protocol === 'openai-compatible';
			// 两种协议的模型列表路径和响应结构都不同：
			//   Google 原生 GET {base}/models        -> { models:[{name}] }
			//   OpenAI 兼容 GET {base}/models        -> { data:[{id}] }
			const { url, headers } = this._request('models');
			const res = await fetchWithDiagnostics(url, { headers }, 10000);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				// 这里必须说清是哪一类问题。"HTTP 401" 让人以为是 key 错，
				// 但同样可能是没走代理导致网关返回的 401；不给原话就只能猜。
				return {
					ok: false,
					version: `gemini/${this.protocol}`,
					models: [],
					error: describeHttpFailure(res.status, res.statusText, body),
					proxy: this.proxy || null,
					proxySource: this.proxySource || null
				};
			}
			const data = await res.json();
			// 中转服务会把模型列表也包进 {code,data}
			const payload = this._unwrapEnvelope(data);
			const models = isOai
				? (payload?.data || []).map((m) => String(m?.id || '')).filter(Boolean)
				: (payload?.models || []).map((m) => String(m?.name || '').replace(/^models\//, '')).filter(Boolean);
			this.setAvailableModels(models);

			/*
			 * 2026-10-05 加：拿到的模型列表必须和配置里写的模型名对一下。
			 *
			 * 以前这一步只是"连上了 + 有 N 个模型"，看起来一切正常，
			 * 但配置里的 model 是写死的 —— 中转站的模型名改名/下架之后，
			 * 每次实际调用都会 404，界面上却完全看不出来。
			 * 实测就踩过：配置写 gemini-3.5-flash-lite，而服务商只有 gemini-3.5-flash。
			 *
			 * 现在对不上就直接在 health 里报出来，并给出可用模型列表，
			 * 让"配错了"在配置检查阶段就暴露，而不是等到素材分析失败。
			 */
			const ok = models.length === 0 || models.includes(this.model);
			if (!ok) {
				return {
					ok: false,
					version: `gemini/${this.protocol}`,
					models,
					error: `配置里的模型 "${this.model}" 服务商那边没有。`
						+ `可用模型：${models.slice(0, 12).join('、')}${models.length > 12 ? ' …' : ''}。`
						+ `请把设置里的模型名改成其中之一，否则每次调用都会 404。`,
					proxy: this.proxy || null,
					proxySource: this.proxySource || null
				};
			}
			return { ok: true, version: `gemini/${this.protocol}`, models: models.length ? models : [this.model] };
		} catch (err) {
			return { ok: false, version: `gemini/${this.protocol}`, models: [], error: String(err?.message || err) };
		}
	}
}

export default GeminiClient;
