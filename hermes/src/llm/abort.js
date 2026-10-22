/**
 * 请求取消：把调用方的 signal 接进"带超时"的 controller。
 *
 * 2026-10-12 加。这个坑在三个客户端里各犯过一次：
 *   - ollama.js 实现了（:182-186）
 *   - gemini.js / deepseek.js 早先只用自己的超时 controller，**完全无视 options.signal**
 *     结果：用户点"取消"，正在跑的云端请求断不掉，整场直播跑到自然结束才停，
 *     还在继续烧 token。分段阶段走本地还能断，一进云端就断不掉了。
 *
 * 所以抽到这里而不是留在 gemini.js —— 让 deepseek.js 从 gemini.js 导入
 * 会把两个毫不相干的服务商客户端绑在一起，以后谁动了 gemini.js 就可能弄坏 deepseek。
 */
export function makeRequestController(externalSignal, timeoutMs) {
	const controller = new AbortController();
	/*
	 * 2026-10-21：给 controller 记一个"为什么中止"的原因标记（_abortedBy）。
	 *
	 * 为什么要记：proxy.js 的 fetchWithDiagnostics 原来把 AbortError 一律翻译成
	 * 中文"连接 xxx 超时"，用户主动取消和真超时就再也没有区别 —— gemini.js 的
	 * `err.name === 'AbortError'` 取消分支永远进不去，把"已取消"当成故障
	 * 退避重试，最后还把云端链路拉黑十分钟。
	 * fetch 的 signal 上只有 reason，分不清是哪个 Timer/AbortController 干的，
	 * 所以只能在"干活的地方"（这里就是合并点）顺手记下原因。
	 * 注意标记要挂在 **controller.signal** 上（proxy 只拿得到 signal 这个对象，
	 * controller 和 signal 是两个不同的宿主，标记打错宿主就等于没打）。
	 */
	const markAbortBy = (reason) => {
		try { controller._abortedBy = reason; } catch { /* 不可写也不致命 */ }
		try { controller.signal._abortedBy = reason; } catch { /* 同上 */ }
	};
	const timer = setTimeout(() => {
		markAbortBy('timeout');
		controller.abort();
	}, timeoutMs);
	let onAbort = null;
	if (externalSignal && typeof externalSignal.addEventListener === 'function') {
		// 已经取消的信号要立刻生效：晚一步就会白等一个完整超时
		if (externalSignal.aborted) {
			markAbortBy('user');
			controller.abort();
		} else {
			onAbort = () => {
				markAbortBy('user');
				controller.abort();
			};
			externalSignal.addEventListener('abort', onAbort, { once: true });
		}
	}
	return {
		controller,
		/** 必须在 finally 里调用，否则监听器会随请求数累积到触发 MaxListeners 警告 */
		detach() {
			clearTimeout(timer);
			if (onAbort && externalSignal?.removeEventListener) externalSignal.removeEventListener('abort', onAbort);
		},
	};
}

export default makeRequestController;