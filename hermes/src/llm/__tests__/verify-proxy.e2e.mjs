/**
 * 端到端验证"云端到底能不能连上"，并区分失败原因。
 *
 * 为什么要专门写这个：之前所有失败都被报成同一句"连接失败"，
 * 于是"没走代理"（连都没连上）和"key 无效"看起来一模一样。
 * 实测这台机器直连 443 超时，走本机代理则能拿到服务端的真实 401 JSON 错误体 ——
 * 也就是说直连时根本看不到服务端的任何信息。
 *
 * 本脚本按优先级逐级尝试，并明确报出每一步的结果。
 */
import { resolveProxy, applyProxyEnv, proxySource, describeHttpFailure } from "../proxy.js";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("D:/GLB/Hermes/config/default.json", "utf8"));
const g = cfg.gemini || {};
const oai = (g.protocol || "gemini-native") === "openai-compatible";

const base = (g.baseUrl || (oai ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta")).replace(/\/$/, "");
const url = oai ? `${base}/models` : `${base}/models?key=${encodeURIComponent(g.apiKey || "")}`;
const headers = oai ? { Authorization: `Bearer ${g.apiKey}` } : {};

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? " -> " + e : ""}`); } };

console.log("=== 1. 代理探测 ===");
const detected = resolveProxy(cfg);
const source = proxySource();
console.log(`  探测结果: ${detected || "(无，走直连)"}   来源: ${source || "无"}`);
check("能自动识别到本机代理", Boolean(detected), "未识别到。开着 Clash 时应自动读 Windows 系统代理");
// 来源可以是环境变量或系统代理：手工跑时 shell 里可能已设好 HTTPS_PROXY。
// 关键是"识别到一个可用代理"，而不是识别到哪一个。
check(
  "来源是环境变量或系统代理",
  source === "Windows 系统代理" || source === "环境变量",
  `实际来源: ${source}`
);

// 启动器（hermes-guard.js / start-glb.cmd）会在进程启动前带上这两个变量。
// 手工运行时不会带，所以这里必须显式检查 —— 而且它是"进程启动时解析一次"，
// 运行期再设无效，这正是最容易误判成"代码没生效"的地方。
if (!process.env.NODE_USE_ENV_PROXY) {
  console.log("  提示: 手工运行请先设 NODE_USE_ENV_PROXY=1（只在进程启动时解析一次）");
}
check("进程启用了 NODE_USE_ENV_PROXY", Boolean(process.env.NODE_USE_ENV_PROXY), "未设置");

applyProxyEnv(cfg);
check("代理已灌进环境变量", process.env.HTTPS_PROXY === detected, `HTTPS_PROXY=${process.env.HTTPS_PROXY}`);

console.log(`\n=== 2. 云端探活 (${oai ? "OpenAI 兼容" : "Gemini 原生"}) ===`);
console.log(`  地址: ${url.replace(/key=[^&]+/, "key=***")}`);

const t0 = Date.now();
try {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const ms = Date.now() - t0;
  const body = await res.text();
  console.log(`  HTTP ${res.status}  用时 ${(ms / 1000).toFixed(1)}s`);
  console.log(`  正文: ${body.slice(0, 220)}`);

  check("能收到服务端响应（不再是超时）", true);
  if (res.ok) {
    const data = JSON.parse(body);
    const models = oai
      ? (data?.data || []).map((m) => String(m?.id || "")).filter(Boolean)
      : (data?.models || []).map((m) => String(m?.name || "").replace(/^models\//, "")).filter(Boolean);
    console.log(`  可用模型 ${models.length} 个: ${models.slice(0, 8).join("、")}`);
    check("key 有效（拿到 200）", true);
    check("配置的模型名在列表里", models.includes(g.model), `配置的是 ${g.model}`);
  } else {
    // 分级：这次能明确告诉用户是 key 的问题
    const msg = describeHttpFailure(res.status, res.statusText, body);
    console.log(`\n  分级结论: ${msg}`);
    check("失败原因已分级（不再是一句'连接失败'）", msg.includes("key") || msg.includes("协议") || msg.includes("限流"));
    check("是 401/403 时指向 key 而非网络", res.status !== 401 && res.status !== 403 || /key|鉴权/.test(msg));
  }
} catch (err) {
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  连接失败(${ms}s): ${err?.name} ${err?.message}`);
  check("能连上云端", false, `${err?.name}: ${err?.message}（若本机开了代理，说明 NODE_USE_ENV_PROXY 没生效）`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);