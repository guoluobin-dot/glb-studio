/**
 * 字幕/标题样式的预设栏：保存当前、套用、删除。
 *
 * 为什么单独一个文件而不是塞进 RenderOptions：
 * 出片选项面板已经很长了，PRESETS 那一节管的是"整体开关组合"，
 * 这里管的是"字体/颜色/位置"这种细粒度样式，两者的粒度和生命周期都不一样。
 *
 * 为什么预设只存样式、不存素材路径：
 * 出片选项里还有封面、带货尾带这类带文件路径的设置。存进去的话，
 * 换台机器路径全失效，预设一用就报错还查不出原因。
 * 样式是纯数据，存了就能用。
 */
import { useState } from "react";
import { LuBookmark, LuCheck, LuSave, LuTrash2 } from "react-icons/lu";
import type { CaptionStyle, TitleStyle } from "@shared/api-types";
import {
  MAX_PRESETS,
  loadPresets,
  makePreset,
  savePresets,
  type StylePreset
} from "../lib/style-presets";
import { cx } from "./ui";

export function StylePresetBar({
  caption,
  title,
  onCaptionChange,
  onTitleChange
}: {
  caption?: CaptionStyle;
  title?: TitleStyle;
  onCaptionChange: (next: CaptionStyle) => void;
  onTitleChange: (next: TitleStyle) => void;
}): React.JSX.Element {
  // 初始值从 localStorage 读。放在 useState 的初始函数里，
  // 而不是 useEffect 里 —— 否则第一帧会先画出"没有预设"再闪一下。
  const [list, setList] = useState<StylePreset[]>(() => loadPresets());
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const flash = (t: string): void => {
    setMsg(t);
    window.setTimeout(() => setMsg(null), 2600);
  };

  const persist = (next: StylePreset[]): boolean => {
    const ok = savePresets(next);
    if (ok) setList(next);
    else flash("预设保存失败：浏览器存储不可用或已满");
    return ok;
  };

  const commit = (): void => {
    const made = makePreset(draft, caption ?? {}, title ?? {});
    if (!made) {
      flash("名字不能为空，而且至少要改一项样式（等于系统默认的不必存）");
      return;
    }
    if (list.length >= MAX_PRESETS) {
      flash(`最多存 ${MAX_PRESETS} 个，先删掉一个再存`);
      return;
    }
    // 新的排前面：刚存的通常是这次要用的
    if (persist([made, ...list])) {
      setDraft("");
      setAdding(false);
      flash(`已保存「${made.name}」`);
    }
  };

  const apply = (p: StylePreset): void => {
    // undefined = 用系统默认，所以这里要传空对象而不是 undefined，
    // 否则点了预设却没反应，用户会以为按钮坏了。
    onCaptionChange({ ...(p.caption ?? {}) });
    onTitleChange({ ...(p.title ?? {}) });
    flash(`已套用「${p.name}」`);
  };

  const remove = (p: StylePreset): void => {
    if (!window.confirm(`删除预设「${p.name}」？`)) return;
    persist(list.filter((x) => x.id !== p.id));
  };

  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
      <LuBookmark className="h-3 w-3 shrink-0 text-mut-2" />
      <span className="shrink-0 text-[10.5px] font-bold tracking-[1.2px] text-mut-2">样式预设</span>

      {list.map((p) => (
        <span key={p.id} className="group inline-flex items-center">
          <button
            type="button"
            onClick={() => apply(p)}
            title={`套用「${p.name}」`}
            className="max-w-[150px] truncate rounded-l-lg border border-line bg-panel-2/40 px-2.5 py-1 text-[11.5px] font-semibold text-fg transition-colors hover:border-ember/50 hover:bg-ember/8"
          >
            {p.name}
          </button>
          <button
            type="button"
            onClick={() => remove(p)}
            title={`删除「${p.name}」`}
            aria-label={`删除预设 ${p.name}`}
            className="rounded-r-lg border border-l-0 border-line bg-panel-2/40 px-1.5 py-1 text-mut-2 transition-colors hover:border-bad/50 hover:text-bad"
          >
            <LuTrash2 className="h-3 w-3" />
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={draft}
            maxLength={24}
            placeholder="预设名字"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            className="w-[130px] rounded-lg border border-line bg-panel-2 px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
          />
          <button
            type="button"
            onClick={commit}
            title="保存"
            className="rounded-lg border border-ember/45 bg-ember/10 p-1 text-ember transition-colors hover:bg-ember/20"
          >
            <LuCheck className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1 text-[11.5px] font-semibold text-mut transition-colors hover:border-ember/50 hover:text-ember"
        >
          <LuSave className="h-3 w-3" />
          保存当前
        </button>
      )}

      {msg && (
        <span role="status" className={cx("text-[10.5px]", msg.startsWith("已") ? "text-ok" : "text-warn")}>
          {msg}
        </span>
      )}
    </div>
  );
}