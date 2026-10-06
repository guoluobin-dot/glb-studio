/**
 * 验证 provider=auto 真的会分派,而不是静默退化成 ollama。
 *
 * 背景:文档承诺"长直播自动走 Gemini",但 createLlmClientFor 无人调用,
 * createLlmClient 里 'auto' 又直接落到末尾的 OllamaClient ——
 * 配置写 auto 实际等于 ollama,看板还显示"云端在线"。
 *
 * 这里全部离线跑(不联网、不需要 key),只验分派决策和兜底行为。
 */
import { describe, it, expect } from "vitest";
// Hermes 是独立工程,不在 GLB-NEW 的 tsconfig roots 里,
// 所以这里直接引它的源码来验真实行为(不复制逻辑,避免测的是副本)。
// 路径从 tests/ 上溯两级到 D:\,再进 GLB\Hermes。
// @ts-expect-error Hermes 是纯 JS 工程,没有 .d.ts
import { createLlmClient, AutoClient } from "../../GLB/Hermes/src/llm/router.js";
// @ts-expect-error 同上
import { classifyContent } from "../../GLB/Hermes/src/llm/engine-selector.js";

// OllamaClient 构造时直接读 cfg.ollama.*,不能省 —— 少了会在建对象时就崩,
// 跟被测的 auto 逻辑无关。
const cfg = (provider: string) => ({
  llm: { provider },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    chatModel: "qwen3:8b",
    lightModel: "qwen3:4b",
    embeddingModel: "bge-m3",
    timeout: 120000
  },
  performance: { lightCtx: 4096, heavyCtx: 8192, visionCtx: 4096 },
  gemini: { apiKey: "", model: "gemini-3.5-flash-lite", cloudBudgetPerRun: 8 }
});

describe("provider=auto 真的分派", () => {
  it("auto 不再被静默当成 ollama", () => {
    const c = createLlmClient(cfg("auto"));
    expect(c).toBeInstanceOf(AutoClient);
  });

  it("短片段任务 -> 本地", () => {
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 300, transcriptChars: 800 });
    expect(c.engine).toBe("ollama");
    expect(c.usingCloud).toBe(false);
  });

  it("长直播任务 -> 选中云端", () => {
    // 3 小时 / 38k 字：engine-selector 明确判 long-form
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 38000 });
    expect(c.engine).toBe("gemini");
    expect(c.usingCloud).toBe(true);
  });

  it("纯画面长视频不该被送去烧额度", () => {
    // 时长到 3 小时但几乎无语音 —— engine-selector 里明确处理过的坑
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 200 });
    expect(c.engine).toBe("ollama");
  });

  it("显式指定 ollama 时 auto 分派不生效", () => {
    const c = createLlmClient(cfg("ollama"));
    c.setTaskScope?.({ durationSec: 3 * 3600, transcriptChars: 38000 });
    expect(c).not.toBeInstanceOf(AutoClient);
  });
});

describe("云端不可用时的兜底", () => {
  it("无 key 时回落本地并说明原因,不崩", async () => {
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 38000 });
    expect(c.engine).toBe("gemini"); // 决策仍然是云端
    // 实际调用时才发现没 key
    const gen = c.local.generate.bind(c.local);
    c.local.generate = async () => "LOCAL_RESULT";
    const out = await c.generate("sys", "user");
    expect(out).toBe("LOCAL_RESULT");
    expect(c.lastEngine).toBe("ollama");
    c.local.generate = gen;
    expect(c.cloudBlockedReason).toMatch(/Key/);
  });

  it("云端失败后本进程内不再重试,避免每块分片都超时一次", async () => {
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 38000 });
    c.local.generate = async () => "LOCAL";
    await c.generate("s", "u"); // 第一次:试云端 -> 失败 -> 本地
    expect(c.lastEngine).toBe("ollama");
    await c.generate("s", "u"); // 第二次:应直接本地
    expect(c.lastEngine).toBe("ollama");
    expect(c.cloudBlockedReason).toBeTruthy();
  });
});

describe("作用域复原", () => {
  it("endTask 后不再继承长直播判断", () => {
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 38000 });
    expect(c.engine).toBe("gemini");
    c.endTask();
    // 没有作用域时按"无内容"处理 -> 本地
    expect(c.engine).toBe("ollama");
  });

  it("没有 setTaskScope 的老调用方不会崩", () => {
    const c = createLlmClient(cfg("auto"));
    expect(() => c.engine).not.toThrow();
    expect(() => c.endTask()).not.toThrow();
  });
});

describe("云端额度闸门", () => {
  it("打满预算后剩余分片走本地,不继续烧额度", async () => {
    // cloudBudgetPerRun 是用户唯一的钱包保护,必须在调用前拦。
    // GeminiClient 只做 spent++ 记账,不检查 —— 拦在这里。
    const c = createLlmClient(cfg("auto"));
    c.setTaskScope({ durationSec: 3 * 3600, transcriptChars: 38000 });
    let localCalls = 0;
    c.local.generate = async () => { localCalls++; return "LOCAL"; };
    // 假装云端可用,并且额度只剩 1
    c._cloud = { generate: async () => "CLOUD", budgetLeft: () => 1, budget: 8 };
    c._cloudUsable = true;

    expect(await c.generate("s", "u")).toBe("CLOUD"); // 用掉最后 1 次额度
    c._cloud.budgetLeft = () => 0;
    expect(await c.generate("s", "u")).toBe("LOCAL"); // 超额 -> 本地
    expect(localCalls).toBe(1);
    expect(c.lastReason).toMatch(/额度/);
  });
});

describe("分派判据本身", () => {
  it("同一份内容切成 10 分钟和 5 小时,结论不同", () => {
    const short = classifyContent({ durationSec: 600, transcriptChars: 800 });
    const long = classifyContent({ durationSec: 5 * 3600, transcriptChars: 38000 });
    expect(short.kind).toBe("short-clip");
    expect(long.kind).toBe("long-form");
  });

  it("给的理由要能让人看懂为什么走云端", () => {
    const s = classifyContent({ durationSec: 3 * 3600, transcriptChars: 38000 });
    expect(s.reason).toMatch(/字|分钟/);
  });
});