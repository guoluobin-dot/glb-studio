import { LuCaptions, LuEye, LuHeading, LuRotateCcw } from "react-icons/lu";
import { cx } from "./ui";
import { REF_HEIGHT, layoutFor } from "../lib/text-layout";
import type { CaptionStyle, TitleStyle } from "@shared/api-types";

/**
 * 字幕 / 标题落在画面哪儿的实时预览。
 *
 * 为什么必须有：这一块原来只有滑块和色板，全是抽象值。
 * "位置 60px"到底是离底 60 还是离顶 60？"底部"到底在多下面？
 * 用户调完只能出一次片才知道 —— 而出一次片要几分钟。
 *
 * 关键是这个预览的位置**必须和成片一致**，所以几何公式不在这里写，
 * 而是共用 lib/text-layout.ts，那边和服务端烧字公式是一套。
 * 各写一份的话，预览和成片就会不一致，而这种不一致用户根本查不出来。
 */
function TextLayoutPreview({
  caption,
  title,
  frameHeight,
  width = 176
}: {
  caption: CaptionStyle;
  title: TitleStyle;
  /** 素材画面高度，用来把 1920 基准的 px 值缩到真实比例 */
  frameHeight: number;
  /** 预览宽度（px）。高度按 9:16 推出来，和素材真实比例无关 */
  width?: number;
}): React.JSX.Element {
  const W = width;
  const H = Math.round(W / 0.5625);
  // 位置按百分比下，和预览实际尺寸无关
  const geo = layoutFor(H, caption, title);

  const capColor = caption.color ?? "#FFFFFF";
  const ttlColor = title.color ?? "#FFFFFF";
  const capText = "同学们看这里，字会出现在这个位置";
  const ttlText = "标题出现在这里";

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <LuEye className="h-3.5 w-3.5 shrink-0 text-mut-2" />
        <span className="text-[11.5px] font-bold text-fg">位置示意</span>
      </div>

      <div
        className="relative mx-auto overflow-hidden rounded-lg border border-line bg-gradient-to-b from-panel-2 to-panel"
        style={{ height: H, width: W }}
        aria-label="字幕与标题位置示意"
      >
        {/* 三条参考线：顶部/中间/底部，方便判断"居中"到底偏不偏 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line/60" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-line/40" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-dashed border-line/60" />

        {/* 标题 */}
        <div
          className="absolute inset-x-0 flex justify-center px-3"
          style={{ top: geo.title.topPct }}
        >
          <span
            className="text-center font-bold leading-tight"
            style={{
              fontSize: Math.max(8, geo.title.fontPx),
              color: ttlColor,
              textShadow: geo.title.shadowPx > 0
                ? `${geo.title.shadowPx}px ${geo.title.shadowPx}px 0 rgba(0,0,0,0.85)`
                : "none",
              background: title.boxOpacity !== undefined && title.boxOpacity > 0
                ? `rgba(0,0,0,${title.boxOpacity})`
                : undefined,
              padding: title.boxOpacity !== undefined && title.boxOpacity > 0 ? "1px 6px" : undefined,
              borderRadius: title.boxOpacity !== undefined && title.boxOpacity > 0 ? 3 : undefined
            }}
          >
            {ttlText}
          </span>
        </div>

        {/* 字幕：ASS 的 MarginV 量到文字底缘，所以按 bottom 定位 */}
        <div
          className="absolute inset-x-0 flex justify-center px-3"
          style={{ bottom: geo.caption.bottomPct }}
        >
          <span
            className="text-center font-bold leading-tight"
            style={{
              fontSize: Math.max(8, geo.caption.fontPx),
              color: capColor,
              fontWeight: caption.bold ? 800 : 500,
              // 描边用 text-shadow 近似（四边），服务端是 ASS Outline
              textShadow: caption.outline !== undefined || caption.shadow !== undefined
                ? [
                    ...(Number(caption.outline) > 0
                      ? [
                          `${geo.caption.outlinePx}px 0 #000`,
                          `-${geo.caption.outlinePx}px 0 #000`,
                          `0 ${geo.caption.outlinePx}px #000`,
                          `0 -${geo.caption.outlinePx}px #000`
                        ]
                      : []),
                    ...(Number(caption.shadow) > 0 ? [`${geo.caption.shadowPx * 2}px ${geo.caption.shadowPx * 2}px 0 rgba(0,0,0,0.6)`] : [])
                  ].join(", ")
                : undefined,
              background: caption.box
                ? `rgba(0,0,0,${caption.boxOpacity ?? 0.5})`
                : undefined,
              padding: caption.box ? "1px 8px" : undefined,
              borderRadius: caption.box ? 3 : undefined
            }}
          >
            {capText}
          </span>
        </div>
      </div>

      <p className="mt-1.5 text-[9.5px] leading-relaxed text-mut-2/80">
        按素材画面 {Math.round(frameHeight)}p 等比缩放 · 与成片一致。虚线是画面顶部 / 中间 / 底部。
      </p>
    </div>
  );
}

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
  onReset,
  previewHeight
}: {
  caption?: CaptionStyle;
  title?: TitleStyle;
  onCaptionChange: (next: CaptionStyle) => void;
  onTitleChange: (next: TitleStyle) => void;
  onReset: () => void;
  /** 素材画面高度（px）。标题/字幕的位置都按它缩放，不传就按竖屏 1920 示意 */
  previewHeight?: number;
}): React.JSX.Element {
  const c = caption ?? {};
  const t = title ?? {};
  const setC = (patch: Partial<CaptionStyle>): void => onCaptionChange({ ...c, ...patch });
  const setT = (patch: Partial<TitleStyle>): void => onTitleChange({ ...t, ...patch });

  return (
    /*
     * 预览必须和控件**并排**，不能放在上面。
     *
     * 原来预览在上、控件在下，结果是：拖动"位置"滑块时，预览早就滚出屏幕了，
     * 调完要往上滑一屏才能看到效果 —— 那就等于没有预览，用户还是不知道
     * 字落在哪儿。反馈"放在这个位置不是很好调"说的正是这个。
     *
     * 所以左边一列固定（sticky），右边控件随便滚，永远能同时看见两边。
     */
    <div className="flex items-start gap-3">
      <div className="w-[176px] shrink-0 self-sticky top-0">
        <TextLayoutPreview caption={c} title={t} frameHeight={previewHeight ?? REF_HEIGHT} />
      </div>

      <div className="grid min-w-0 flex-1 gap-2.5">
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
    </div>
  );
}
