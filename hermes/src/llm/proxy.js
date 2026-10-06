/**
 * 出网代理
 * © 2026 郭洛斌
 *
 * 为什么需要这个模块：
 * Node 的 fetch（undici）**不读 Windows 的代理设置**，只认 HTTP_PROXY / HTTPS_PROXY
 * 环境变量。这台机器装了 Clash，Windows 代理已启用在 127.0.0.1:4780，
 * 但环境变量是空的 —— 于是所有云端请求都在直连，表现为"API 用不了"，
 * 实际是连都没连上（连超时都到不了服务端）。
 *
 * 排查这一点花了不少时间：直连 443 超时会被误判成 key 无效或服务商故障，
 * 而用 curl 加 -x 代理立刻就能拿到服务端的真实响应（含 401 的 JSON 错误体）。
 * 所以这里的目标不只是"能连上"，还要把失败原因分清楚。
 *
 * 优先级：设置里手填的地址 > 环境变量 > Windows 系统设置。
 * 手填放最前，是为了让人能覆盖系统设置（Clash 换端口、TUN 模式、
 * 或者临时走另一条线路时不必重新打包）。
 */

import { execFileSync } from 'child_process';

/**
 * Node 22.23+ / 24 自带 fetch 支持按环境变量走代理，只要进程启动时
 * 打开 NODE_USE_ENV_PROXY=1（等价于命令行 --use-env-proxy）。
 * 实测：带代理能拿到服务端真实响应（401 + JSON 错误体），不带代理直接 TypeError。
 *
 * 所以这里不引入 undici —— Node 内置的 EnvHttpProxyAgent 就够，
 * 少一个依赖，也不用改所有调用点传dispatcher。
 */
let cached = null;
let cachedAt = 0;
let cachedFrom = null;
let cachedCfg = null;
const TTL_MS = 60_000;

/**
 * 算出当前该用的代理地址，没有则返回 null（表示直连）。
 * @param {object} cfg Hermes 配置（读 llm.proxy / gemini.proxy）
 */
export function resolveProxy(cfg) {
  if (cfg && cfg !== cachedCfg) {
    cachedCfg = cfg;
    cached = null;
  }
  if (cached && Date.now() - cachedAt < TTL_MS) return cached.value;
  let value = null;
  let from = null;

  const manual = cfg?.llm?.proxy ?? cfg?.gemini?.proxy ?? null;
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;

  if (manual && String(manual).trim()) {
    const m = String(manual).trim();
    value = /^https?:\/\//i.test(m) ? m : `http://${m}`;
    from = "设置里手填";
  } else if (env) {
    value = env;
    from = "环境变量";
  } else {
    const win = readWindowsProxy();
    if (win) {
      value = win;
      from = "Windows 系统代理";
    }
  }

  cached = { value };
  cachedAt = Date.now();
  cachedFrom = from;
  return value;
}

/**
 * 让本进程后续的 fetch 走代理。
 *
 * 注意：NODE_USE_ENV_PROXY 只在进程启动时解析一次，运行期再设无效。
 * 所以真正生效的前提是启动器（hermes-guard.js / start-glb.cmd）已经带上了它；
 * 这个函数负责把探测到的地址灌进环境变量，让启动器与运行时保持一致。
 */
export function applyProxyEnv(cfg) {
  const url = resolveProxy(cfg);
  if (url) {
    process.env.HTTPS_PROXY = url;
    process.env.HTTP_PROXY = url;
    process.env.https_proxy = url;
    process.env.http_proxy = url;
  }
  return url;
}

/** 代理是从哪来的，给「引擎」面板显示用。用户在排查时需要知道它到底连没走代理。 */
export function proxySource() {
  resolveProxy(cachedCfg);
  return cachedFrom;
}

/**
 * 读 Windows 系统代理设置。
 *
 * 用 reg query 而不是读注册表文件：Electron/Node 在打包环境里没有 winreg 依赖，
 * 而 reg.exe 是系统自带的。PAC（AutoConfigURL）不在处理范围内 ——
 * PAC 需要真的去解析 .pac 文件并按规则匹配 URL，成本高、收益低，
 * 这种情况让用户在设置里手填地址更快。
 */
function readWindowsProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    // 必须一条一条查。reg query 的 /v 只能给一次：写 '/v ProxyEnable /v ProxyServer'
    // 会被 reg 判成语法错误（"无效语法"），于是整条命令返回非 0、输出为空 ——
    // 结果是永远探测不到代理，而这恰恰是最需要它工作的场景。
    const q = (name) => {
      try {
        return execFileSync('reg', ['query', KEY, '/v', name], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000
        });
      } catch {
        return '';
      }
    };
    const out = `${q('ProxyEnable')}\n${q('ProxyServer')}`;
    const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (!enable || Number.parseInt(enable[1], 16) === 0) return null;

    const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out);
    if (!server) return null;
    let value = server[1].trim();
    // 系统代理串可能是 "http=127.0.0.1:4780;https=127.0.0.1:4780" 这种分协议形式，
    // Clash 一般写成单个地址。两种都要能认。
    const perProto = value.split(";").map((s) => s.trim()).filter(Boolean);
    if (perProto.length > 1) {
      const https = perProto.find((s) => /^https=/i.test(s));
      value = (https || perProto[0]).replace(/^https?=/i, "").trim();
    } else {
      value = value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    }
    if (!/^[\w.\-]+:\d+$/.test(value)) return null;
    return `http://${value}`;
  } catch {
    return null;
  }
}

/**
 * 分级报错。
 *
 * 之前所有失败都被报成同一句"连接失败"，用户没法判断是哪一步出的问题：
 *   - 401  → key 无效/过期，换key 能解决
 *   - 404  → baseUrl 或协议不对，改设置能解决
 *   - 超时  → 多半是没走代理，或者代理端口变了
 * 三种的处理办法完全不同，混在一起就只能靠猜。
 */
export function describeHttpFailure(status, statusText, bodyText) {
  const snippet = String(bodyText || "").slice(0, 300);
  if (status === 401 || status === 403) {
    const isKeyWord = /api[\s_-]?key|unauthorized|forbidden|token|鉴权|认证/i.test(snippet);
    return `云端拒绝了鉴权（HTTP ${status}）${isKeyWord ? "：key 无效、过期或填错" : ""}。`
      + `这是 key 的问题，不是网络问题 —— 换一个有余额的 key 即可。服务端原话：${snippet}`;
  }
  // 余额不足是独立一类：换 key 没用，必须充值。混进 401 会把人引到错误的方向。
  if (status === 402) {
    return `云端账户余额不足（HTTP 402 / PAYMENT_REQUIRED）：${snippet}。`
      + `key 是有效的，只是没钱了 —— 去服务商后台充值即可，不用换 key。`;
  }
  if (status === 404) {
    // 中转服务（APIMart）的 404 明确是"找不到指定的模型"，
    // 这是配置里的模型 id 拼错/改名了，不是 baseUrl 的问题 —— 两种都报同一句会误导。
    const isModel = /找不到指定的模型|NOT_FOUND.*model|model.*not.*found/i.test(snippet);
    if (isModel) {
      return `云端没有这个模型（HTTP 404 / NOT_FOUND）：${snippet}。`
        + `是配置里的模型 id 不存在或已改名。请把「引擎」设置里的模型名改成服务商`
        + `当前提供的那个（APIMart 的 Gemini 型号如 gemini-3.5-flash / gemini-3.1-pro-preview / gemini-2.5-pro）。`;
    }
    return `接口地址不存在（HTTP 404）：${snippet}。`
      + `多半是 baseUrl 少写了 /v1，或者协议选错了（这个服务是 OpenAI 兼容还是 Gemini 原生要对应）。`;
  }
  if (status === 429) {
    return `被限流或额度用尽（HTTP 429 / RESOURCE_EXHAUSTED）：${snippet}。会自动退避重试；`
      + `若持续出现说明并发太高或该账号每分钟配额太小。`;
  }
  if (status === 400) {
    return `请求参数不对（HTTP 400 / INVALID_ARGUMENT）：${snippet}。`
      + `通常是 max_tokens 超过该模型的限制，或 body 里有它不认识的字段。`;
  }
  if (status >= 500) {
    return `云端服务异常（HTTP ${status}）：${snippet}。可以稍后重试（已自动退避）。`;
  }
  return `云端返回 HTTP ${status} ${statusText || ""}：${snippet}`;
}

/**
 * 带超时的 fetch，并把超时/连接错误翻译成能指方向的话。
 *
 * AbortError 无法区分是"超时"还是"用户主动取消"，这里统一按超时处理 ——
 * 本项目没有取消外部请求的入口，所以这个歧义不会造成实际问题。
 */
export async function fetchWithDiagnostics(url, init = {}, timeoutMs = 15000) {
  try {
    return await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err?.name || "";
    if (name === "TimeoutError" || name === "AbortError") {
      const proxy = resolveProxy(cachedCfg);
      throw new Error(
        `连接 ${new URL(url).host} 超时（${Math.round(timeoutMs / 1000)}s）。`
        + (proxy
          ? `已配置代理 ${proxy} 但仍超时 —— 检查代理软件是否在运行、端口是否变了。`
          : `当前是直连。如果这台机器开了代理（Clash/v2ray 等），`
            + `请在「引擎」面板把代理地址填上（形如 http://127.0.0.1:4780）。`)
      );
    }
    throw new Error(
      `连不上 ${(() => { try { return new URL(url).host; } catch { return url; } })()}：${err?.message || err}`
      + `。这通常是网络/代理问题，不是 key 的问题。`
    );
  }
}

export function resetProxyCache() {
  cached = null;
  cachedAt = 0;
}