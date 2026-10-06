/**
 * LLM Router — 四通道：本地 Ollama / Gemini 长上下文 / 云端 Zen / DeepSeek
 * © 2026 郭洛斌
 *
 * config/default.json:
 *   "llm": { "provider": "ollama" }   // 默认本地,离线免费
 *   "llm": { "provider": "gemini" }  // 长直播/长上下文增强引擎
 *   "llm": { "provider": "zen" }      // 临时云端思考
 *   "llm": { "provider": "deepseek" } // 重决策
 *
 * provider 缺省为 "auto":由 pickEngineFor() 按内容形态自动分派——
 * 短片段型(带货/卖课,单条几十到几百字)走本地(免费无限);
 * 长直播型(2-5 小时整场,逐句稿 3-6 万字)走 Gemini(百万上下文,能看全局)。
 * 这样既补上本地看不到的全局视角,又不会让短内容白白消耗 API 额度。
 */
import { OllamaClient } from './ollama.js';
import { ZenClient } from './zen.js';
import { DeepSeekClient } from './deepseek.js';
import { GeminiClient } from './gemini.js';
import { pickEngineFor, classifyContent } from './engine-selector.js';

/**
 * provider=auto 的分派代理。
 *
 * 为什么需要它:原来只有 createLlmClientFor(config, shape) 一个入口,
 * 但全链路只在 Orchestrator 构造时 createLlmClient() 一次 —— 长直播/短片段
 * 的判断根本没人做,provider=auto 会一路落到最后的 OllamaClient。
 * 也就是文档里"长直播自动走 Gemini"从来没生效过,配置写 auto 实际等于 ollama。
 *
 * 难点在于分派的粒度:逐句稿是按 10 秒一块调 generate() 的,
 * 单次调用的文本量永远只有几百字。如果按"每次调用"估算形态,
 * 一场 3 小时直播的每一块都会被判成短片段,云端一次都用不上。
 * 所以粒度必须是**任务**:调用方用 setTaskScope() 交代"我这一轮在处理哪份素材",
 * 代理据此选定引擎并在这一轮内锁定;结束后 endTask() 复原。
 * 没交代就直接按本次调用的文本量兜底判断。
 *
 * 兜底:Gemini 构造期缺 key、或运行期请求失败(key 无效/超额/断网),
 * 都自动回落本地,并且本进程内不再重试云端 —— 免得每块分片都失败一次,
 * 把一次分析拖成几百次超时。
 */
export class AutoClient {
	constructor(config = null) {
		this.config = config || {};
		this.local = new OllamaClient(this.config);
		/** 云端可用性:undefined=还没试过,false=试过并失败 */
		this._cloudUsable = undefined;
		this._cloud = null;
		this._scope = null;
		/** 最近一次实际使用的引擎与原因,供看板显示 */
		this.lastEngine = 'ollama';
		this.lastReason = '尚未分派';
	}

	/** @param {import('./engine-selector.js').TranscriptShape} scope */
	setTaskScope(scope) {
		this._scope = scope || null;
		return this;
	}

	endTask() {
		this._scope = null;
		return this;
	}

	/** 当前实际引擎('ollama' | 'gemini'),构造期就能给出准确答案 */
	get engine() {
		return this._plan().engine;
	}

	/** 是否真的在用云端。auto 下不能只看 provider 配置 */
	get usingCloud() {
		return this.engine !== 'ollama';
	}

	/** 云端不可用的原因,给 UI 提示用 */
	get cloudBlockedReason() {
		if (this._cloudUsable === false) return this._cloudError || '云端不可用';
		return '';
	}

	_plan() {
		const provider = String(this.config?.llm?.provider || 'auto').toLowerCase();
		if (provider !== 'auto') return pickEngineFor(this.config, { kind: 'short-clip', reason: '' });
		// setTaskScope 收的是原始素材形态(时长/字数),
		// pickEngineFor 要的是判定后的形态(带 kind)。中间这步分类不能省,
		// 少了它 shape.kind 是 undefined,长直播会被当成短片段静默走本地。
		// classifyContent 的第二个参数是 Hermes 配置：
		// 本地窗口必须按**实际请求值**算（performance.heavyCtx），不能用模型能力上限。
		// 漏传就会退回保守默认 8192 —— 偏保守（更多走云端），不会漏读，但会白烧额度。
		const shape = this._scope
			? classifyContent(this._scope, this.config)
			: classifyContent({ transcriptChars: 0 }, this.config);
		const plan = pickEngineFor(this.config, shape);
		if (plan.engine === 'gemini' && this._cloudUsable === false) {
			return { engine: 'ollama', reason: `${plan.reason};但云端不可用(${this.cloudBlockedReason}),走本地` };
		}
		return plan;
	}

	_cloudClient() {
		if (this._cloud) return this._cloud;
		try {
			this._cloud = new GeminiClient(this.config);
			this._cloudUsable = true;
		} catch (err) {
			this._cloudUsable = false;
			this._cloudError = err.message;
			console.warn(`[LLM] Gemini 不可用(${err.message}),本轮走本地 Ollama`);
		}
		return this._cloud;
	}

	/**
	 * 带兜底地调用云端;失败则回落本地并在本进程内停用云端。
	 * @param {string} method
	 * @param {any[]} args
	 */
	async _call(method, args) {
		const plan = this._plan();
		this.lastReason = plan.reason;
		if (plan.engine === 'gemini') {
			const cloud = this._cloudClient();
			if (cloud) {
				// 额度闸门必须在这里拦。GeminiClient 只负责 spent++ 记账,
				// 从来不检查花超了没有 —— 不拦的话一场 40 分片的直播会打 40+ 次云端,
				// cloudBudgetPerRun 这个配置等于白写。
				if (typeof cloud.budgetLeft === 'function' && cloud.budgetLeft() <= 0) {
					this.lastReason = `云端额度已用完(本轮上限 ${cloud.budget}),剩余分片走本地`;
					console.warn(`[LLM] ${this.lastReason}`);
				} else {
					try {
						const out = await cloud[method](...args);
						this.lastEngine = 'gemini';
						return out;
					} catch (err) {
						this._cloudUsable = false;
						this._cloudError = err.message;
						console.warn(`[LLM] Gemini ${method} 失败(${err.message}),回落本地`);
					}
				}
			}
		}
		this.lastEngine = 'ollama';
		return this.local[method](...args);
	}

	async generate(...args) { return this._call('generate', args); }
	async chat(...args) { return this._call('chat', args); }
	async describe(...args) { return this._call('describe', args); }
	async embed(...args) { return this._call('embed', args); }

	async health() {
		const plan = this._plan();
		const local = await this.local.health();
		if (plan.engine !== 'gemini') return local;
		const cloud = this._cloudClient();
		if (!cloud) return local;
		try {
			const remote = await cloud.health();
			return { ...local, gemini: remote };
		} catch (err) {
			return { ...local, gemini: { ok: false, error: err.message } };
		}
	}

	/** 下游读 client.model 显示当前模型;auto 下要报实际会用的那个 */
	get model() {
		return this.engine === 'gemini' ? (this.config?.gemini?.model || 'gemini-3.5-flash-lite') : this.local.model;
	}

	resolveModel(tier) { return this._call('resolveModel', [tier]); }
	setAvailableModels(models) {
		this.local.setAvailableModels(models);
		if (this._cloud) this._cloud.setAvailableModels(models);
	}

	budgetLeft() { return this._cloud?.budgetLeft?.() ?? 0; }
	resetBudget() { this._cloud?.resetBudget?.(); }
}

/**
 * 内容形态判别 + 引擎分派。
 * @param {object} config
 * @param {import('./engine-selector.js').ContentShape} shape 由 engine-selector 判定的内容形态
 * @returns {{client: object, engine: 'ollama'|'gemini', reason: string}}
 */
export function createLlmClientFor(config, shape) {
	const plan = pickEngineFor(config, shape);
	if (plan.engine === 'gemini') {
		try {
			const client = new GeminiClient(config);
			return { client, engine: 'gemini', reason: plan.reason };
		} catch (err) {
			console.warn(`[LLM] Gemini 不可用(${err.message}),已回退本地 Ollama`);
			return { client: new OllamaClient(config), engine: 'ollama', reason: 'gemini 不可用,回退本地' };
		}
	}
	return { client: new OllamaClient(config), engine: 'ollama', reason: plan.reason };
}

export function createLlmClient(config = null) {
	const provider = config?.llm?.provider || process.env.HERMES_LLM || 'ollama';
	const p = String(provider).toLowerCase();
	if (p === 'auto') {
		// auto 必须真的分派。原先这里直接落到函数末尾的 OllamaClient,
		// 等于把 auto 静默当成 ollama,配置和文档都在骗人。
		return new AutoClient(config);
	}
	if (p === 'gemini') {
		try {
			return new GeminiClient(config);
		} catch (err) {
			console.warn(`[LLM] Gemini 被拒绝(${err.message}),已回退本地 Ollama`);
			return new OllamaClient(config);
		}
	}
	if (p === 'deepseek') {
		try {
			return new DeepSeekClient(config);
		} catch (err) {
			console.warn(`[LLM] DeepSeek 被拒绝(${err.message}),已回退本地 Ollama`);
			return new OllamaClient(config);
		}
	}
	if (p === 'zen') {
		try {
			return new ZenClient(config);
		} catch (err) {
			console.warn(`[LLM] Zen 被拒绝,已回退本地 Ollama:${err.message}`);
			return new OllamaClient(config);
		}
	}
	return new OllamaClient(config);
}

export { OllamaClient, ZenClient, DeepSeekClient, GeminiClient };
export { pickEngineFor };
export default createLlmClient;