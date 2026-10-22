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
import { CloudChain, cloudSummary } from './cloud-chain.js';

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
		/*
		 * 判死不能一拉到底（2026-10-21）。
		 * 链路有自己的 RETRY_COOLDOWN_MS（10 分钟后把坏路放回来重试），
		 * 但 AutoClient 顶层的 _cloudUsable=false 是粘滞的 —— _plan() 一见 false
		 * 直接绕过云端，链路冷却期结束也轮不到它上场。补一个 同周期的失败时间戳：
		 * 过了 CLOUD_RETRY_MS 就把 _cloudUsable 复位，让 _pickCloud 走链路重新认定。
		 */
		this._cloudFailAt = 0;
		this.CLOUD_RETRY_MS = 10 * 60 * 1000;
		this._cloud = null;
		this._scope = null;
		/** 最近一次实际使用的引擎与原因,供看板显示 */
		this.lastEngine = 'ollama';
		this.lastReason = '尚未分派';
		/*
		 * 多路云端链路（2026-10-12）。
		 *
		 * 原来只有一条云端路（Gemini），一把 key 失效就等于云端整体不可用 ——
		 * 实测就是 APIMart 的 key 被拒之后，长直播全部回落本地，
		 * 而机器上明明还能用别的通道。CloudChain 负责逐路探测与故障转移。
		 */
		this._chain = new CloudChain(this.config);
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
			if (this._cloudFailAt && Date.now() - this._cloudFailAt > this.CLOUD_RETRY_MS) {
				// 冷却到期：给云端再一次机会（_pickCloud 会经链路逐路重新认定），
				// 否则文件夹改了 key、充值完成，云端也得等重启才翻身。
				this._cloudUsable = undefined;
				this._cloudFailAt = 0;
			} else {
				return { engine: 'ollama', reason: `${plan.reason};但云端不可用(${this.cloudBlockedReason}),走本地` };
			}
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
	 * 取一个**当前可用**的云端客户端（多路链路，自动跳过不通的那条）。
	 *
	 * 原来这里是"构造成功就用"，key 构造成功≠key 有效：
	 * 实测 APIMart 那种中转，构造完全正常，发第一个请求才 401。
	 * 于是每一轮都吃一次超时 + 一次失败，整轮分析被拖垮。
	 * 现在构造之后先做一次轻量探测（health），不通就顺延到下一路。
	 */
	async _pickCloud() {
		if (this._cloud) return this._cloud;
		const picked = await this._chain.pick();
		if (!picked) {
			this._cloudUsable = false;
			this._cloudFailAt = Date.now();
			const list = this._chain.list().filter((c) => c.client);
			this._cloudError = list.length
				? `所有云端通道都不通（${list.map((c) => `${c.name}: ${c.error || '未通过探测'}`).join('；')}）`
				: '未配置任何云端通道（缺 API Key）';
			return null;
		}
		this._cloud = picked.client;
		this._cloudName = picked.name;
		this._cloudUsable = true;
		if (this._cloudName !== 'gemini') {
			console.log(`[LLM] 云端改用 ${this._cloudName}（gemini 通道不可用）`);
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
			// 额度闸门必须在这里拦。客户端只负责 spent++ 记账,
			// 从来不检查花超了没有 —— 不拦的话一场 40 分片的直播会打 40+ 次云端,
			// cloudBudgetPerRun 这个配置等于白写。
			const cloud = await this._pickCloud();
			if (cloud) {
				if (typeof cloud.budgetLeft === 'function' && cloud.budgetLeft() <= 0) {
					this.lastReason = `云端额度已用完(本轮上限 ${cloud.budget}),剩余分片走本地`;
					console.warn(`[LLM] ${this.lastReason}`);
				} else {
					try {
						const out = await cloud[method](...args);
						this.lastEngine = this._cloudName === 'gemini' ? 'gemini' : (this._cloudName || 'gemini');
						return out;
				} catch (err) {
					/*
					 * 2026-10-21：用户取消 ≠ 通道故障。
					 * 以前 fetchWithDiagnostics 会把 AbortError 翻译成中文"超时"，
					 * 这里就一路 markFailed('gemini','超时') 把整条链路拉黑 10 分钟 ——
					 * 其实用户只是点了"取消"。现在先放行取消信号：不拉黑、不换路、不回落本地。
					 */
					if (err?.userCancelled || err?.name === 'AbortError') throw err;
					/*
					 * 运行期失败：把这一路标记为不健康并立刻换下一路重试一次。
						 *
						 * 以前这里是"标记 _cloudUsable=false 然后回落本地"，
						 * 而 _cloudUsable 一旦 false 在本进程内永不复位 ——
						 * 也就是说一把 key 失效之后，哪怕你转头把它换好，
						 * 不重启服务就再也不会用云端了（长直播全程走本地，
						 * 用户只能从"分析变慢变差"上感觉到，界面上看不出为什么）。
						 *
						 * 现在交给 CloudChain 冷却：这一轮先换路试一次，
						 * 都试不通才回落本地；冷却期过后各路会重新纳入探测。
						 */
						this._chain.markFailed(this._cloudName || 'gemini', err.message);
						this._cloud = null;
						this._cloudUsable = undefined;
						const alt = await this._pickCloud();
						if (alt) {
							try {
								const out = await alt[method](...args);
								this.lastEngine = this._cloudName || 'gemini';
								console.log(`[LLM] 已切换到云端通道 ${this._cloudName}`);
								return out;
							} catch (err2) {
								// 同上：取消信号要原样上抛，别当成第二路也坏了
								if (err2?.userCancelled || err2?.name === 'AbortError') throw err2;
								this._chain.markFailed(this._cloudName, err2.message);
								this._cloudError = err2.message;
							}
						}
						this._cloudUsable = false;
						this._cloudFailAt = Date.now();
						this._cloudError = err.message;
						console.warn(`[LLM] 云端 ${this._cloudName || 'gemini'} ${method} 失败(${err.message}),回落本地`);
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
		// 逐路探测并回报：以前只回一个"gemini 通/不通"，
		// 多路链路下必须让人看见**是哪一路**不通、为什么不通。
		const cloud = await this.probeCloud();
		return { ...local, cloud };
	}

	/** 逐路探测云端通道（面板/接口用），顺便把第一条可用的设为 active */
	async probeCloud() {
		const results = await this._chain.probeAll();
		this._cloud = this._chain.active?.client || null;
		this._cloudName = this._chain.active?.name || null;
		this._cloudUsable = !!this._chain.active;
		this._cloudError = this._cloudUsable ? '' : (results[0]?.error || '没有可用的云端通道');
		return {
			ok: this._cloudUsable,
			active: this._cloudName,
			providers: results,
			...cloudSummary(this.config, results),
		};
	}

	/** 云端链路现状（不发起请求） */
	cloudChainList() { return this._chain.list(); }

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