import type { StudioApi } from "@shared/api-types";

declare global {
  interface Window {
    /** 预加载桥注入的主进程 API。浏览器预览时为 undefined。 */
    studio?: StudioApi;
  }
}

export {};
