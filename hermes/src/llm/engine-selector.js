/**
 * 内容形态判别 + 引擎分派
 * © 2026 郭洛斌
 *
 * 为什么要分派:
 * 本地 qwen3:8b 约 4 万上下文。带货/卖课这类内容,单条片段文本只有几十到
 * 几百字,本地逐条打分绰绰有余——免费、无限、隐私,没必要碰云端。
 * 但一场 2-5 小时直播的逐句稿是 3-6 万字,整段塞不进本地窗口;硬塞就得
 * 切块,而切块后每块独立判断,模型看不到整场节奏,选出来的片段"局部像对的、
 * 整体不成立"——这是筛片总出错的真正原因,不是模型不够聪明,是它只看到了局部。
 *
 * 所以这里只回答一个问题:这份素材需要看全局吗?
 * - 短片段型(总时长小 / 单段文本量小)→ 本地
 * - 长直播型(总时长大 / 整场逐句稿接近或超过本地窗口)→ Gemini 长上下文
 *
 * 判别用可解释的数值阈值,不猜内容题材:同样的知识付费内容,切成 10 分钟
 * 和切成 5 小时,该不该用云端是不一样的。
 */

/**
 * 本地模型上下文窗口 —— **必须读配置里实际请求的那个值,不能用模型能力值。**
 *
 * 2026-10-05 修一个会造成"结果看着正常、其实只读了一部分"的严重 bug：
 *
 * 原来这里写死 `const LOCAL_CONTEXT_TOKENS = 40_960`，注释还说"本地约 4 万上下文"。
 * 40,960 确实是 qwen3:8b 的**能力上限**（ollama /api/show 里的
 * qwen3.context_length），但**实际每次调用只按 performance.heavyCtx 请求**，
 * 当时配置是 8192。两者差了 5 倍。
 *
 * 后果：分派器认为"本地能装 46,080 字"，于是把 3 万字的直播判成短片段型、
 * 走本地。而本地只读得进约 9,216 字 —— 剩下的**被静默截断**：
 * 不报错、不提示、日志里也看不出来。实测 Ollama 只读了 4,098 token，
 * 且在文本末尾放唯一标记让模型复述，四次都没读到。
 *
 * 也就是说：分析结果"看着挺正常"，其实漏掉了大部分内容。
 * 这比"云端慢"严重得多 —— 慢你还能等，截断你根本看不出来。
 *
 * 所以现在一律从 config.performance.heavyCtx 取，取不到才用保守默认 8192。
 */
const DEFAULT_LOCAL_CONTEXT_TOKENS = 8192;

/**
 * 实际可用的本地 token 窗口。
 * @param {any} config Hermes 配置
 * @returns {number}
 */
function localContextTokens(config) {
  const cfg = Number(config?.performance?.heavyCtx);
  // 明确给 0/false 表示"不限制"？—— 不允许。0 会被 max(1) 兜成 1 反而更糟。
  if (Number.isFinite(cfg) && cfg >= 2048) return Math.floor(cfg);
  return DEFAULT_LOCAL_CONTEXT_TOKENS;
}

/**
 * 本地安全字数：按中英混排约 1.5 字/token 折算，再留 25% 余量给输出。
 * （输出也要占窗口，全塞满输入会让模型没地方写。）
 */
function localSafeChars(config) {
  return Math.floor(localContextTokens(config) * 0.75 * 1.5);
}

/** 超过这个秒数就当作"整场直播",需要全局视角 */
const LONG_FORM_SEC = 45 * 60; // 45 分钟

/**
 * 速度阈值(实测校准):
 * 一场 3 小时直播(552 段 / 38k 字)走本地 qwen3:8b,GPU 满载 40 分钟仍未出结果。
 * 装得下不等于等得起 —— 本地 8B 的生成速度是体验瓶颈,超过这个体量就该上云端。
 */
/**
 * 速度阈值 —— **必须跟着本地真实窗口走，不能写死一个更大的数。**
 *
 * 原来这里是 `LOCAL_FAST_CHARS = 12000`（"约 8k token，本地秒级完成"）。
 * 但当时本地窗口只请求 8192，安全可读约 9,216 字 —— 12,000 本身就超了。
 * 于是 10,000~12,000 字的素材被判"本地跑得完"，实际进去就被截断。
 * 和上面的窗口 bug 是**同一个病**：拿一个比实际能力大的数字当门槛。
 *
 * 所以这里改成按 localSafeChars 推导，永远不会超过真实窗口。
 * 另有一个下限，避免配置被调得极小时门槛跟着塌到 0。
 */
const LOCAL_FAST_CHARS_FLOOR = 4000;

const LOCAL_FAST_SEC = 30 * 60;  // 30 分钟内:本地跑得完

/** 本地"跑得完"的字数上限（按真实窗口推导，见上） */
function localFastChars(config) {
  return Math.max(LOCAL_FAST_CHARS_FLOOR, Math.floor(localSafeChars(config) * 0.95));
}

/**
 * @typedef {Object} TranscriptShape
 * @property {Array<{text?: string}>} [segments] 单条逐句稿文本(用于估算密度)
 * @property {number} [transcriptChars] 整场逐句稿总字数(若已统计好可直接给,省一次遍历)
 * @property {number} [durationSec] 媒体总时长(秒)
 */

/**
 * @typedef {Object} ContentShape
 * @property {'short-clip'|'long-form'} kind
 * @property {number} durationSec
 * @property {number} transcriptChars
 * @property {number} estimatedTokens 预计本地 token 用量,用于界面显示"上下文用了多少"
 * @property {number} overflowRatio 超出本地窗口的倍数(>1 表示本地装不下)
 * @property {string} reason
 */

/** @param {TranscriptShape} shape @returns {ContentShape} */

/** @param {TranscriptShape} shape @returns {number} */
function countChars(shape) {
	if (typeof shape.transcriptChars === 'number' && shape.transcriptChars > 0) {
		return shape.transcriptChars;
	}
	if (!Array.isArray(shape.segments)) return 0;
	let total = 0;
	for (const s of shape.segments) {
		total += (s?.text ?? '').length;
	}
	return total;
}

/**
 * 判定内容形态:这份素材要不要用云端长上下文
 *
 * @param {TranscriptShape} shape
 * @param {any} [config] Hermes 配置 —— 决定本地真实窗口，必须传，否则会用保守默认
 * @returns {ContentShape}
 */
export function classifyContent(shape, config = null) {
  const durationSec = Number(shape.durationSec ?? 0);
  const transcriptChars = countChars(shape);
  const estimatedTokens = Math.ceil(transcriptChars / 1.5);
  // 关键：按**配置里实际请求的**窗口算，不是模型能力上限
  const safeChars = localSafeChars(config);
  const overflowRatio = transcriptChars / safeChars;

  const longByDuration = durationSec >= LONG_FORM_SEC;
  const longByText = overflowRatio >= 1;

	// 速度维度:装得下但跑太久,用户等不起,一样该走云端。
	// 但必须同时看"有没有内容"——纯画面长视频(几乎无语音)本地秒过,
	// 按时长判会把它白白送去云端烧额度,这是上一版的 bug。
	const fastChars = localFastChars(config);
	const hasSubstance = transcriptChars > fastChars * 0.3;
	const slowLocally = hasSubstance && (durationSec > LOCAL_FAST_SEC || transcriptChars > fastChars);

	// 时长到了但没多少字(比如纯画面无语音):不需要云端
	const longForm = longByText || slowLocally || (longByDuration && hasSubstance);


	let reason;
	if (longByText) {
		reason = `逐句稿 ${formatCount(transcriptChars)} 字,约为本地窗口的 ${overflowRatio.toFixed(1)} 倍,本地装不下`;
	} else if (slowLocally) {
		reason = `${formatCount(transcriptChars)} 字 / ${formatDuration(durationSec)}:本地虽装得下,但按实测速度要跑几十分钟,改用长上下文引擎`;
	} else if (longByDuration) {
		reason = `整场 ${formatDuration(durationSec)},但几乎无语音,本地视觉分析即可`;
	} else {
		reason = `短片段型(${formatCount(transcriptChars)} 字),本地逐条打分足够`;
	}

	return {
		kind: longForm ? 'long-form' : 'short-clip',
		durationSec,
		transcriptChars,
		estimatedTokens,
		overflowRatio,
		reason
	};
}

/**
 * @typedef {Object} EnginePlan
 * @property {'ollama'|'gemini'} engine
 * @property {string} reason
 */

/**
 * 引擎分派。
 * - provider=ollama/gemini/zen/deepseek:用户强制指定,尊重设置
 * - provider=auto(默认):按内容形态自动选
 *
 * @param {any} config
 * @param {ContentShape} shape
 * @returns {EnginePlan}
 */
/** @param {any} config @param {ContentShape} shape @returns {EnginePlan} */
export function pickEngineFor(config, shape) {
	const provider = String(config?.llm?.provider || 'auto').toLowerCase();

	if (provider === 'gemini') return { engine: 'gemini', reason: '设置指定使用 Gemini 长上下文' };
	if (provider === 'ollama' || provider === 'zen' || provider === 'deepseek') {
		return { engine: 'ollama', reason: `设置指定使用 ${provider}` };
	}

	// auto:长直播走云端,短片段走本地
	if (shape.kind === 'long-form') {
		return { engine: 'gemini', reason: shape.reason };
	}
	return { engine: 'ollama', reason: shape.reason };
}

/** @param {number} n @returns {string} */
function formatCount(n) {
	if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** @param {number} sec @returns {string} */
function formatDuration(sec) {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (h > 0) return `${h} 小时${m ? ` ${m} 分` : ''}`;
	if (m > 0) return `${m} 分钟`;
	return `${Math.round(sec)} 秒`;
}
