/**
 * DeepSeek LLM Client — OpenAI Chat Completions 协议（api.deepseek.com）
 *
 * 2026-09-27 接入：老板拍板"重决策上 API 大模型"——粗剪选段/主题理解/爆款学习/字幕纠错
 * 这类吃理解力的环节走 DeepSeek；语音转写（sherpa）和视觉理解（本地 qwen2.5vl）保持本地。
 *
 * 接口与 OllamaClient 完全同形（chat/generate/describe/embed/health/resolveModel），
 * Orchestrator 及各模块无需改动调用方式：
 * - describe()：DeepSeek 是纯文本模型，**自动回落本地 qwen2.5vl** 看图（免费且已在跑）
 * - embed()：   同 Zen 的做法，回落本地 Ollama embedding
 * - Key 配置：  config/default.json → deepseek.apiKey（或 {env:DEEPSEEK_API_KEY}）
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { repairJson } from '../utils/json-repair.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
	const configPath = join(__dirname, '..', '..', 'config', 'default.json');
	return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function resolveApiKey(cfg) {
	const raw = cfg?.deepseek?.apiKey ?? '';
	const m = String(raw).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (m) return process.env[m[1]] || '';
	if (raw) return String(raw).trim();
	return process.env.DEEPSEEK_API_KEY || '';
}

/** 从模型输出里抠第一个完整的 JSON 值（对象或数组），容忍 ```json 围栏和前后废话 */
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

export class DeepSeekClient {
	constructor(config = null) {
		const cfg = config || loadConfig();
		const ds = cfg.deepseek || {};
		this.baseUrl = (ds.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
		this.model = ds.model || 'deepseek-chat';
		this.apiKey = resolveApiKey(cfg);
		if (!this.apiKey) {
			throw new Error(
				'DeepSeek API Key 缺失：请在 config/default.json 的 deepseek.apiKey 里填 key，' +
				'或 set DEEPSEEK_API_KEY=你的key。填好前 provider 请保持 ollama。'
			);
		}
		this.timeout = ds.timeout || 300000;
		this.maxTokens = ds.maxTokens || 8192;
		this.temperature = ds.temperature ?? 0.7;
		this._availableModels = [];
		this._visionWarned = false;
	}

	setAvailableModels(models) {
		this._availableModels = models || [];
	}

	/** 与 OllamaClient 同形的分级接口：DeepSeek 单模型，tier 只影响调用方语义 */
	resolveModel(tier = 'heavy') {
		return { model: this.model, tier: tier === 'vision' ? 'vision' : (tier === 'light' ? 'light' : 'heavy') };
	}

	_authHeaders() {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	/**
	 * @param {Array<{role:string, content:string}>} messages
	 * @returns {Promise<string>} 助手回复文本
	 */
	async chat(messages, options = {}) {
		const body = {
			model: options.model || this.model,
			messages: (messages || []).map((m) => ({ role: m.role, content: String(m.content ?? '') })),
			stream: false,
			max_tokens: options.maxTokens ?? this.maxTokens,
		};
		// deepseek-reasoner 不接受 temperature；deepseek-chat 接受
		if (this.model !== 'deepseek-reasoner') {
			body.temperature = options.temperature ?? this.temperature;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
		try {
			const res = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this._authHeaders(),
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => '');
				throw new Error(`DeepSeek error ${res.status}: ${errText.slice(0, 500)}`);
			}
			const data = await res.json();
			const text = data?.choices?.[0]?.message?.content || '';
			if (!text.trim()) throw new Error('DeepSeek 未返回内容');
			return text;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/** 结构化输出：system+user 两段式，parseJson 时自动抠 JSON（容忍围栏/前后废话/输出截断） */
	async generate(systemPrompt, userPrompt, options = {}) {
		const messages = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		];
		const text = await this.chat(messages, options);
		if (options.parseJson) {
			// 2026-09-27：统一走公共修复层（src/utils/json-repair.js）。
			// DeepSeek 很少截断，但本地模型回落到同一套调用时会救回半截 JSON，
			// 避免调用方把整批结果当失败丢掉（该失败正是"143 段全待分类"的成因）。
			const r = repairJson(text);
			if (r.ok) return r.value;
			// 实在解析不出来就返回原文，让调用方自行处理
			return text;
		}
		return text;
	}

	/**
	 * 看图说话：DeepSeek 是纯文本模型 → 自动回落本地 qwen2.5vl（Ollama）。
	 * 这样封面挑选/画面复看继续免费跑，且不受 API 是否支持多模态影响。
	 */
	async describe(images, prompt, options = {}) {
		if (!this._visionWarned) {
			console.warn('[DeepSeek] 纯文本模型，看图任务自动回落本地 qwen2.5vl');
			this._visionWarned = true;
		}
		try {
			if (!this._visionFallback) {
				const { OllamaClient } = await import('./ollama.js');
				this._visionFallback = new OllamaClient();
			}
			return await this._visionFallback.describe(images, prompt, options);
		} catch {
			return null;
		}
	}

	/** DeepSeek 无 embedding：回落本地 Ollama（同 Zen 的降级策略） */
	async embed(_text) {
		if (!this._embedWarned) {
			console.warn('[DeepSeek] 无 embedding 接口，已降级为本地 Ollama 向量（不影响使用）');
			this._embedWarned = true;
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
			const res = await fetch(`${this.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				signal: AbortSignal.timeout(10000),
			});
			if (!res.ok) return { ok: false, version: '', models: [] };
			const data = await res.json();
			const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
			this.setAvailableModels(models);
			return { ok: true, version: 'deepseek', models: models.length ? models : [this.model] };
		} catch {
			return { ok: false, version: '', models: [] };
		}
	}
}

export default DeepSeekClient;
