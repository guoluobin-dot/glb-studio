/**
 * API 访问层。
 * 渲染层不直接碰 IPC,统一经这里;浏览器预览时给出可读的降级提示,
 * 避免"白屏 + 控制台报错"这种最难查的状态。
 */
import type { StudioApi } from "@shared/api-types";

export class BridgeUnavailableError extends Error {
  constructor(readonly hint: string) {
    super("未连接到主进程");
    this.name = "BridgeUnavailableError";
  }
}

export function bridge(): StudioApi {
  if (typeof window === "undefined" || !window.studio) {
    throw new BridgeUnavailableError(
      "预加载桥(window.studio)没有注入成功。常见原因:主进程配置的 preload 路径与实际产物文件名不一致" +
        "(应为 out/preload/index.js),或预加载脚本本身抛错。可用 GLB_STUDIO_DEBUG=1 启动查看主进程日志。"
    );
  }
  return window.studio;
}

export function hasBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.studio);
}

/** 包一层错误归一:界面只需要展示 message,不必处理各种异常类型。 */
export async function call<T>(fn: (api: StudioApi) => Promise<T>): Promise<T> {
  try {
    return await fn(bridge());
  } catch (err) {
    if (err instanceof BridgeUnavailableError) throw err;
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}
