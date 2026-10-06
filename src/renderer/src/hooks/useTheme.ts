/**
 * 主题（深色 / 浅色）
 *
 * 为什么存 localStorage 而不是让主进程管：主题是纯渲染层的东西，
 * 走 IPC 会多一次往返，而且首屏会闪一下默认色再跳到用户上次选的。
 * 同步读 localStorage 能保证第一帧就是对的。
 *
 * 为什么不放 session-store：那是"剪辑会话"的状态（素材/候选/勾选），
 * 主题是应用偏好，两者生命周期不同，混在一起会让主题被 reset 掉。
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "glb.theme";

function readInitial(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    // 没设置过就跟随系统。用户系统是浅色的却默认深色会很突兀。
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // 隐私模式/存储被禁用时 localStorage 会抛，用默认深色
  }
  return "dark";
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readInitial);

  // 挂载时立刻应用，避免用户看到一帧错误配色
  useEffect(() => {
    apply(theme);
  }, [theme]);

  const toggle = useCallback((): void => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // 存不了就算了，本次会话内仍然有效
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}