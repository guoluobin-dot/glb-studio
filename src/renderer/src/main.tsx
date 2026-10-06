/**
 * 渲染层入口
 * © 2026 郭洛斌
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    {/*
      最外层兜底。App 内部还会给审片台等再套一层带名字的边界，
      这样出错时能直接告诉用户是哪块界面崩的，不用猜。
    */}
    <ErrorBoundary label="GLB Studio">
      <App />
    </ErrorBoundary>
  </StrictMode>
);