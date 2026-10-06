/**
 * 全局快捷键
 * © 2026 郭洛斌
 *
 * 选片是高频重复动作("看这条 → 勾/不勾 → 下一条"),全程手在键盘上是效率关键。
 * 没有快捷键时用户不得不反复在鼠标和键盘之间来回切,200 段选 10 条会非常痛苦。
 *
 * 约定(和主流剪辑软件一致,减少学习成本):
 *   空格      播放/暂停
 *   ↑ / ↓     上/下一条候选
 *   X 或 Enter 勾选/取消当前条
 *   A         全选    D  反选
 *   S         只留高分
 *   [/ ]      跳到上一段/下一段开头
 *   , / .     后退/前进 5 秒
 *   E         出片
 *   /         聚焦搜索
 *   ?         快捷键说明
 *   Esc       关闭弹窗/取消焦点
 *
 * 设计要点:所有快捷键都在输入框之外生效。
 * 用户在搜索框打字时按空格必须是空格,不能变成"播放/暂停"——
 * 这是很多网页应用的通病,必须显式排除。
 */
import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  onPlayToggle?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onToggleCurrent?: () => void;
  onSelectAll?: () => void;
  onInvert?: () => void;
  onKeepHigh?: () => void;
  onPrevSegment?: () => void;
  onNextSegment?: () => void;
  onBack5?: () => void;
  onFwd5?: () => void;
  onExport?: () => void;
  onFocusSearch?: () => void;
  onShowHelp?: () => void;
  onEscape?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** false 时本组快捷键全部让位给当前打开的弹窗 */
  enabled?: boolean;
}

/** 判断焦点是否在可输入元素里 */
function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useShortcuts(h: ShortcutHandlers & { enabled?: boolean }): void {
  // handlers 每次渲染都是新对象,若直接进依赖会反复解绑/绑定。
  // 用 ref 固定住,监听器只装一次,调用时读最新值。
  const ref = useRef(h);
  ref.current = h;

useEffect(() => {
    const get = (): ShortcutHandlers => ref.current;

    const onKey = (e: KeyboardEvent): void => {
      // 弹窗(如审片台)打开时要让位。
      //
      // 以前没有这个开关:审片台弹在选片工作台上面,而空格是全局的,
      // 于是"在审片里按空格暂停"实际暂停的是背后那个工作台的播放器 ——
      // 画面纹丝不动,用户以为审片台的播放器坏了。
      // 各弹窗自己接管键盘,同时也避免在审片时误触 A(全选)/D(反选)去改选片结果。
      //
      // 判断放在事件里而不是 effect 里:依赖是 [],挂在 effect 里就只在首次挂载时
      // 读一次,弹窗后开的开关会失效(表现为"关了没反应")。
      if (get().enabled === false) return;

      // Esc 在任何地方都要能用(关弹窗、退出搜索)
      if (e.key === "Escape") {
        get().onEscape?.();
        return;
      }

      // 焦点在输入框时,只保留 Esc,其余按键交还给输入框。
      // 用户在搜索框打空格必须是空格,不能变成"播放/暂停"。
      if (inEditable(e.target)) return;

      // 撤销/重做要在"放行 Ctrl/Alt/Meta"之前拦。
      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 是行业惯例,用户不看说明也会去按;
      // 放到下面那行之后就永远按不到了。
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) get().onRedo?.();
          else get().onUndo?.();
          return;
        }
        if (k === "y") {
          e.preventDefault();
          get().onRedo?.();
          return;
        }
      }

      // Ctrl/Alt/Meta 组合不拦截,留给系统与浏览器
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          get().onPlayToggle?.();
          break;
        case "ArrowDown":
          e.preventDefault();
          get().onNext?.();
          break;
        case "ArrowUp":
          e.preventDefault();
          get().onPrev?.();
          break;
        case "Enter":
        case "x":
        case "X":
          e.preventDefault();
          get().onToggleCurrent?.();
          break;
        case "a":
        case "A":
          e.preventDefault();
          get().onSelectAll?.();
          break;
        case "d":
        case "D":
          e.preventDefault();
          get().onInvert?.();
          break;
        case "s":
        case "S":
          e.preventDefault();
          get().onKeepHigh?.();
          break;
        case "[":
          e.preventDefault();
          get().onPrevSegment?.();
          break;
        case "]":
          e.preventDefault();
          get().onNextSegment?.();
          break;
        case ",":
          e.preventDefault();
          get().onBack5?.();
          break;
        case ".":
          e.preventDefault();
          get().onFwd5?.();
          break;
        case "e":
        case "E":
          e.preventDefault();
          get().onExport?.();
          break;
        case "/":
          e.preventDefault();
          get().onFocusSearch?.();
          break;
        case "?":
          e.preventDefault();
          get().onShowHelp?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** 快捷键说明面板用的清单 */
export const SHORTCUT_LIST: Array<{ keys: string; desc: string }> = [
  { keys: "空格", desc: "播放 / 暂停" },
  { keys: "↑ ↓", desc: "上/下一条候选" },
  { keys: "X / Enter", desc: "勾选 / 取消当前条" },
  { keys: "A / D", desc: "全选 / 反选" },
  { keys: "S", desc: "只留高分(80 分以上)" },
  { keys: "Ctrl+Z", desc: "撤销上一步(勾选/裁剪)" },
  { keys: "Ctrl+Shift+Z", desc: "重做" },
  { keys: "[ ]", desc: "跳到上一段 / 下一段开头" },
  { keys: ", .", desc: "后退 / 前进 5 秒" },
  { keys: "E", desc: "出片" },
  { keys: "/", desc: "聚焦搜索框" },
  { keys: "?", desc: "打开这份说明" },
  { keys: "Esc", desc: "关闭弹窗 / 退出搜索" },
  { keys: "双击候选", desc: "进审阅台(改标题、逐句裁剪)" }
];
