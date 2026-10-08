/**
 * 字幕 / 标题样式的用户预设。
 *
 * 为什么存 localStorage 而不是让主进程管：
 * 这一块是纯渲染层的样式偏好，没有任何跨设备同步或导入导出的需求，
 * 走主进程反而多一次 IPC。本项目 Splitter 的分栏比例、useTheme 的主题
 * 都是同一个路子，保持一致。
 *
 * 为什么必须做脏数据兜底：
 * localStorage 里的东西用户可以手改，也可能来自旧版本。
 * 一旦解析失败就抛，出片选项弹窗会整个打不开 —— 而这只是一组样式预设，
 * 坏了最多是"预设没了"，不该连累整个出片流程。
 * 隐私模式下 localStorage.setItem 本身也会抛，同样不能让它冒泡。
 */
import type { CaptionStyle, TitleStyle } from "@shared/api-types";

const STORAGE_KEY = "glb.stylePresets.v1";

/** 预设条数上限。超了就不给存，并告诉调用方为什么。 */
export const MAX_PRESETS = 24;
/** 名字长度上限，避免一个名字撑爆 localStorage 配额。 */
export const MAX_NAME_LEN = 24;

export interface StylePreset {
  /** 用时间戳做 id：同一个名字允许存在两条，不覆盖。 */
  id: string;
  name: string;
  /** 存 undefined 就等于"这项用系统默认"，和面板上的"默认（微软雅黑）"一致。 */
  caption?: CaptionStyle;
  title?: TitleStyle;
  /** 保存时间，只用于排序和展示，不参与渲染。 */
  savedAt: number;
}

/**
 * 只保留"值合理"的字段。
 * 不能整坨 JSON.parse 出来就信：预设是持久化数据，
 * 手改成一个字符串或塞进一个函数体都很容易，而这个对象会被直接丢给渲染层。
 */
const CAPTION_KEYS: Array<keyof CaptionStyle> = [
  "font",
  "color",
  "size",
  "marginV",
  "outline",
  "shadow",
  "bold",
  "box",
  "boxOpacity"
];
const TITLE_KEYS: Array<keyof TitleStyle> = [
  "font",
  "color",
  "size",
  "position",
  "offsetY",
  "shadow",
  "boxColor",
  "boxOpacity"
];

function pick<T extends object>(src: unknown, keys: Array<keyof T>): T | undefined {
  if (!src || typeof src !== "object" || Array.isArray(src)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (src as Record<string, unknown>)[k as string];
    if (v !== undefined) out[k as string] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** 有没有任何一个实际字段。空的 {} 不算"有样式"。 */
function hasAnyField(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
}

/**
 * 一条预设是否有效。无效的直接丢弃，不让脏数据进内存。
 *
 * 判据包含"至少有一项实际样式"：两边都空的预设点了也不会有任何变化，
 * 而面板标题栏本来就有「恢复默认」，再存一份纯属重复、还占名额。
 */
export function isValidPreset(v: unknown): v is StylePreset {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return false;
  if (typeof p.name !== "string" || !p.name.trim()) return false;
  return hasAnyField(p.caption) || hasAnyField(p.title);
}

/** 读取全部预设。任何异常都退化成空数组，绝不抛。 */
export function loadPresets(): StylePreset[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidPreset)
      .map((p) => ({
        id: p.id,
        name: p.name.slice(0, MAX_NAME_LEN),
        savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
        // 重新过一遍字段白名单，不直接用存进来的对象
        caption: pick<CaptionStyle>(p.caption, CAPTION_KEYS),
        title: pick<TitleStyle>(p.title, TITLE_KEYS)
      }))
      .slice(0, MAX_PRESETS);
  } catch {
    // JSON 坏了或者隐私模式不让读 —— 都按"没有预设"处理
    return [];
  }
}

/** 写回。返回是否成功；失败（配额满/隐私模式）由调用方提示。 */
export function savePresets(list: StylePreset[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_PRESETS)));
    return true;
  } catch {
    return false;
  }
}

/** 规范化用户输入的名字。空名字直接拒绝。 */
export function normalizeName(raw: string): string | null {
  const name = raw.trim().slice(0, MAX_NAME_LEN);
  return name.length ? name : null;
}

/** 新建一条预设。name 为空或名字过长被拒时返回 null。 */
export function makePreset(name: string, caption: CaptionStyle, title: TitleStyle): StylePreset | null {
  const clean = normalizeName(name);
  if (!clean) return null;
  const c = pick<CaptionStyle>(caption, CAPTION_KEYS);
  const t = pick<TitleStyle>(title, TITLE_KEYS);
  // 两边都空 = 等于系统默认，存下来没有意义，不给存
  if (!c && !t) return null;
  return {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    savedAt: Date.now(),
    caption: c,
    title: t
  };
}