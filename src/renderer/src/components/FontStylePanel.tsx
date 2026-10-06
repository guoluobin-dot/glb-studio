import { LuCaptions, LuHeading, LuRotateCcw } from "react-icons/lu";
import { cx } from "./ui";
import type { CaptionStyle, TitleStyle } from "@shared/api-types";

/**
 * 字幕 / 标题样式。
 *
 * 控件设计上有两个刻意的取舍：
 * 1. 颜色给的是**色板而不是取色器**。用户要的是"橙底白字/黑底黄字"这类
 *    成片配色，不是美术设计；自由取色反而会挑出压不住视频的浅色。
 * 2. 位置用预设（顶/中/底）+ 微调滑块，不让用户填像素 ——
 *    竖屏 1080x1920 和横屏 1080x608 的"顶部"不是同一个 y 值。
 */
const COLORS: Array<{ v: string; label: string }> = [
  { v: "#FFFFFF", label: "白" },
  { v: "#FFD700", label: "金" },
  { v: "#FF6B35", label: "橙" },
  { v: "#FF3B30", label: "红" },
  { v: "#34C759", label: "绿" },
  { v: "#32ADE6", label: "蓝" },
  { v: "#0A84FF", label: "深蓝" },
  { v: "#000000", label: "黑" }
];

const FONTS = [
  "微软雅黑",
  "微软雅黑粗体",
  "黑体",
  "宋体",
  "楷体",
  "仿宋",
  "思源黑体",
  "思源宋体",
  "苹方",
  "Arial",
  "Segoe UI",
  "Impact"
];

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[52px] shrink-0 text-[10.5px] font-semibold text-mut-2">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Swatches({
  value,
  onChange
}: {
  value?: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {COLORS.map((c) => (
        <button
          key={c.v}
          type="button"
          title={c.label}
          onClick={() => onChange(c.v)}
          className={cx(
            "h-5 w-5 rounded border transition-transform hover:scale-110",
            value?.toLowerCase() === c.v.toLowerCase() ? "border-ember ring-1 ring-ember/50" : "border-line"
          )}
          style={{ background: c.v }}
        />
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-ember"
      />
      <span className="tabular w-[46px] shrink-0 text-right font-mono text-[10px] text-mut-2">
        {value}
        {suffix ?? ""}
      </span>
    </div>
  );
}

export function FontStylePanel({
  caption,
  title,
  onCaptionChange,
  onTitleChange,
  onReset
}: {
  caption?: CaptionStyle;
  title?: TitleStyle;
  onCaptionChange: (next: CaptionStyle) => void;
  onTitleChange: (next: TitleStyle) => void;
  onReset: () => void;
}): React.JSX.Element {
  const c = caption ?? {};
  const t = title ?? {};
  const setC = (patch: Partial<CaptionStyle>): void => onCaptionChange({ ...c, ...patch });
  const setT = (patch: Partial<TitleStyle>): void => onTitleChange({ ...t, ...patch });

  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {/* ---------- 字幕 ---------- */}
      <section className="rounded-xl border border-line bg-panel-2/40 p-3">
        <div className="mb-2.5 flex items-center gap-2">
          <LuCaptions className="h-3.5 w-3.5 text-mut-2" />
          <span className="text-[12px] font-bold text-fg">字幕样式</span>
          <span className="ml-auto text-[10px] text-mut-2">字号按 1080p 基准自动缩放</span>
        </div>
        <div className="flex flex-col gap-2">
          <Row label="字体">
            <select
              value={c.font ?? ""}
              onChange={(e) => setC({ font: e.target.value || undefined })}
              className="w-full rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
            >
              <option value="">默认（微软雅黑）</option>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Row>
          <Row label="颜色">
            <Swatches value={c.color} onChange={(v) => setC({ color: v })} />
          </Row>
          <Row label="字号">
            <Slider value={c.size ?? 28} min={14} max={72} onChange={(v) => setC({ size: v })} />
          </Row>
          <Row label="位置">
            <Slider
              value={c.marginV ?? 60}
              min={0}
              max={900}
              step={10}
              suffix="px"
              onChange={(v) => setC({ marginV: v })}
            />
          </Row>
          <Row label="描边">
            <Slider value={c.outline ?? 3} min={0} max={10} step={0.5} onChange={(v) => setC({ outline: v })} />
          </Row>
          <Row label="阴影">
            <Slider value={c.shadow ?? 1} min={0} max={10} step={0.5} onChange={(v) => setC({ shadow: v })} />
          </Row>
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-mut">
              <input
                type="checkbox"
                checked={c.bold === true}
                onChange={(e) => setC({ bold: e.target.checked || undefined })}
                className="accent-ember"
              />
              加粗
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-mut">
              <input
                type="checkbox"
                checked={c.box === true}
                onChange={(e) => setC({ box: e.target.checked || undefined })}
                className="accent-ember"
              />
              底部底条（压住花哨背景）
            </label>
            {c.box === true && (
              <div className="w-[130px]">
                <Slider
                  value={c.boxOpacity ?? 0.5}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => setC({ boxOpacity: v })}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------- 标题 ---------- */}
      <section className="rounded-xl border border-line bg-panel-2/40 p-3">
        <div className="mb-2.5 flex items-center gap-2">
          <LuHeading className="h-3.5 w-3.5 text-mut-2" />
          <span className="text-[12px] font-bold text-fg">标题样式</span>
          <button
            type="button"
            onClick={onReset}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold text-mut-2 transition-colors hover:text-ember"
          >
            <LuRotateCcw className="h-3 w-3" />
            恢复默认
          </button>
        </div>
        <div className="flex flex-col gap-2">
          <Row label="字体">
            <select
              value={t.font ?? ""}
              onChange={(e) => setT({ font: e.target.value || undefined })}
              className="w-full rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
            >
              <option value="">默认（微软雅黑）</option>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Row>
          <Row label="颜色">
            <Swatches value={t.color} onChange={(v) => setT({ color: v })} />
          </Row>
          <Row label="字号">
            <Slider value={t.size ?? 36} min={16} max={120} onChange={(v) => setT({ size: v })} />
          </Row>
          <Row label="位置">
            <div className="flex gap-1">
              {(
                [
                  { k: "top", label: "顶部" },
                  { k: "middle", label: "居中" },
                  { k: "bottom", label: "底部" }
                ] as const
              ).map((p) => (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => setT({ position: p.k })}
                  className={cx(
                    "flex-1 rounded border px-2 py-1 text-[11px] font-semibold transition-colors",
                    (t.position ?? "top") === p.k
                      ? "border-ember/50 bg-ember/8 text-fg"
                      : "border-line text-mut hover:bg-panel-2/60"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="微调">
            <Slider
              value={t.offsetY ?? 0}
              min={-400}
              max={400}
              step={10}
              suffix="px"
              onChange={(v) => setT({ offsetY: v })}
            />
          </Row>
          <Row label="阴影">
            <Slider value={t.shadow ?? 0} min={0} max={10} step={0.5} onChange={(v) => setT({ shadow: v })} />
          </Row>
          <Row label="底板">
            <div className="flex items-center gap-2">
              <select
                value={t.boxColor ?? "#FF6B35"}
                onChange={(e) => setT({ boxColor: e.target.value })}
                className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
              >
                <option value="">不加底板</option>
                {COLORS.map((c2) => (
                  <option key={c2.v} value={c2.v}>
                    {c2.label}
                  </option>
                ))}
              </select>
              {t.boxColor && (
                <div className="w-[110px]">
                  <Slider
                    value={t.boxOpacity ?? 0.8}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(v) => setT({ boxOpacity: v })}
                  />
                </div>
              )}
            </div>
          </Row>
        </div>
      </section>
    </div>
  );
}
