/**
 * 出片选项
 * © 2026 郭洛斌
 *
 * 33 个开关不该铺满屏幕:日常只暴露"最常改的 6 个",其余进"高级"折叠。
 * 预设是一组开关的快照,选中即整体套用,不用逐项点。
 */
import { useState, useCallback } from "react";
import { LuChevronDown, LuLayers } from "react-icons/lu";
import { Modal, cx } from "./ui";
import { StylePresetBar } from "./StylePresetBar";
import { AssetPicker } from "./AssetPicker";
import { FontStylePanel } from "./FontStylePanel";
import type { RenderOptions, CopySuggestResult } from "@shared/api-types";
import { useSession } from "../stores/session-store";
import { call } from "../lib/bridge";

export interface Preset {
  id: string;
  name: string;
  hint: string;
  options: RenderOptions;
}

export const DEFAULT_RENDER: RenderOptions = {
  vertical: true,
  captionStyle: "auto",
  coldOpen: false,
  autoZoom: true,
  sfx: false,
  bgmPath: undefined,
  bgmVolume: 0.22,
  duckBgm: true,
  // 响度标准化默认开:口播忽大忽小是"一眼毛坯感"的来源,开着的收益远大于风险
  audioNormalize: true,
  watermark: undefined,
  // 标题卡定版:链路是通的(generator 真的会渲染)。默认关 ——
  // 它会占掉开头 1.8 秒,默认关掉才不会削弱冷开场。
  titleCard: false,
  // 包装默认全开:这是"出片"≠"剪出片段"的区别,默认就该给成片
  subtitles: true,
  covers: true,
  title: true,
  titleText: undefined,
  // 爆款开头默认开:用户要的就是"能直接发的爆款",不是原始片段
  viralOpening: true,
  viralOpeningSeconds: 15,
  openingText: undefined
};

export const PRESETS: Preset[] = [
  {
    id: "short-commerce",
    name: "带货短视频",
    hint: "竖屏 · 冷开场 · 强字幕",
    // 只列**后端真的实现了**的项。
    // 以前这里还顺手设了 jumpCut/cleanFillers/cutRetakes/openingHook 全为 true,
    // 而 Hermes 的 generator 里根本没有对应实现 —— 预设宣传"去废话",
    // 实际勾了不生效也不报错。用户拿到的片子跟没点这个预设一样。
    options: {
      ...DEFAULT_RENDER,
      vertical: true,
      coldOpen: true,
      autoZoom: true,
      captionStyle: "bold"
    }
  },
  {
    id: "course-clip",
    name: "课程切片",
    hint: "竖屏 · 保留讲解节奏 · 字幕优先",
    options: {
      ...DEFAULT_RENDER,
      vertical: true,
      coldOpen: true,
      autoZoom: false,
      captionStyle: "auto",
      titleCard: false
    }
  },
  {
    id: "live-highlight",
    name: "直播高光",
    hint: "横屏 · 保留原声 · 情绪片段",
    options: {
      ...DEFAULT_RENDER,
      vertical: false,
      autoZoom: false,
      titleCard: false
    }
  }
];

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line/70 bg-panel-2/40 px-3 py-2.5 transition-colors hover:border-line">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          "check-box relative mt-0.5 h-5 w-9 shrink-0 rounded-full",
          checked ? "flame-gradient" : "bg-panel-3"
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200",
            checked ? "left-[18px]" : "left-0.5"
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-mut-2">{hint}</span>}
      </span>
    </label>
  );
}

export function RenderOptionsPanel({
  options,
  onChange,
  onClose,
  frameHeight
}: {
  options: RenderOptions;
  onChange: (next: RenderOptions) => void;
  onClose: () => void;
  /** 素材画面高度（px），用于字幕/标题位置示意 */
  frameHeight?: number;
}): React.JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 2026-10-21：AI 文案套装。取当前勾选片段覆盖到的逐句稿文本喂给 Hermes 的
  // /pipeline/copy-suggest（本地 LLM），生成标题候选/简介/话题标签。
  // 结果直接可点：点标题即填入标题框，其余一键复制。
  // 复制失败不拦流程（Electron 渲染层无剪贴板权限时给行内提示）。
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<CopySuggestResult | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const aiGenerate = useCallback(async (): Promise<void> => {
    if (aiBusy) return;
    setAiErr(null);
    setAiResult(null);
    setAiBusy(true);
    setCopied(null);
    try {
      const st = useSession.getState();
      const sel = Array.from(st.selected ?? []);
      const cands = (st.candidates ?? []).filter((c) => sel.includes(c.id));
      const picked = cands.length ? cands : st.candidates ?? [];
      const ranges: Array<[number, number]> = picked.map((c) => [Number(c.startSec) || 0, Number(c.endSec) || 0]);
      // checkpoint 里的 transcript 可能是 { language, segments[...], … }
      // 包装对象或旧版裸数组 —— 两种形态都认，裸取 .filter 会当场炸。
      const txRaw: unknown = st.transcript ?? null;
      const segs = (
        Array.isArray(txRaw)
          ? txRaw
          : Array.isArray((txRaw as { segments?: unknown[] } | null)?.segments)
            ? (txRaw as { segments: unknown[] }).segments
            : []
      ) as Array<{ text?: string; startSec?: number; endSec?: number }>;
      const beats = segs
        .filter((s) => {
          const st0 = Number(s.startSec) || 0;
          const en0 = Number(s.endSec) || st0;
          return ranges.some(([a, b]) => st0 >= a && st0 <= b);
        })
        .map((s) => s.text ?? String(s));
      const text = beats.join(" ") || segs.slice(0, 40).map((s) => s.text ?? s).join(" ");
      if (!text) {
        setAiErr("逐句稿是空的，先转写一次再生成文案");
        return;
      }
      const api = window.studio;
      if (!api) throw new Error("应用桥未就绪");
      const r = await api.copySuggest({
        transcript: text,
        titleText: options.titleText ?? "",
        durationSec: picked.reduce((s, c) => s + (Number(c.endSec) - Number(c.startSec) || 0), 0) || 45
      });
      if (!r?.ok) throw new Error(r?.error ?? "文案生成失败");
      setAiResult(r);
    } catch (err) {
      setAiErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  }, [aiBusy, options.titleText]);
  const copyText = useCallback(async (t: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(t);
      setCopied(t);
    } catch {
      setCopied("copy-failed");
    }
  }, []);
  const set = <K extends keyof RenderOptions>(key: K, value: RenderOptions[K]): void =>
    onChange({ ...options, [key]: value });

  // 2026-10-21：active 判定剔除响度开关 —— 它不属于预设风格组合，
  // 不剔除的话只要动过这个开关，预设高亮就再也不亮了
  const sceneOf = (o: RenderOptions): string => JSON.stringify({ ...o, audioNormalize: 0 });
  const active = PRESETS.find((p) => sceneOf(p.options) === sceneOf(options));

  return (
    <Modal
      title="出片选项"
      subtitle="日常只需要改这几项;其余在高级里。选预设可整体套用一组开关。"
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="space-y-4">
        {/* 预设 */}
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold tracking-[1.2px] text-mut-2">
            <LuLayers className="h-3 w-3" />
            预设
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                // 2026-10-21：响度标准化不属于任何预设的"画面风格组合"，
                // 套预设时沿用当前开关，别被 preset.options 抹掉
                // （undefined 会落回默认开，但用户明确关过的话会被偷偷打开）
                onClick={() =>
                  onChange({ ...preset.options, audioNormalize: preset.options.audioNormalize ?? options.audioNormalize })
                }
                className={cx(
                  "rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active?.id === preset.id
                    ? "border-ember/50 bg-ember/8"
                    : "border-line bg-panel-2/40 hover:border-ember/40"
                )}
              >
                <div className={cx("text-[12.5px] font-bold", active?.id === preset.id && "text-ember")}>{preset.name}</div>
                <div className="mt-0.5 text-[10.5px] leading-relaxed text-mut-2">{preset.hint}</div>
              </button>
            ))}
          </div>
        </section>

        {/* 常用
            这里只放**后端真的实现了**的开关。
            以前这里还列了"去废话/智能跳剪/闪回预告/删重录/开场钩子/字幕翻译"，
            但 Hermes 的 generator 里从来没有对应实现 —— 勾了不生效也不报错，
            用户拿到的片子跟没勾一样。假开关比缺功能更糟，已移除。 */}
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Toggle
            label="竖屏输出"
            hint="9:16,适合手机端分发"
            checked={options.vertical}
            onChange={(v) => set("vertical", v)}
          />
          <Toggle
            label="自动字幕"
            hint="识别语音生成字幕并烧录"
            checked={options.captionStyle !== "none"}
            onChange={(v) => set("captionStyle", v ? "auto" : "none")}
          />
          <Toggle
            label="加粗字幕"
            hint="立体描边,知识类更醒目"
            checked={options.captionStyle === "bold"}
            onChange={(v) => set("captionStyle", v ? "bold" : "auto")}
          />
          <Toggle
            label="自动变焦"
            hint="在能量峰处轻微推近"
            checked={options.autoZoom}
            onChange={(v) => set("autoZoom", v)}
          />
          <Toggle
            label="音效点缀"
            hint="在爆点插入提示音"
            checked={options.sfx}
            onChange={(v) => set("sfx", v)}
          />
          <Toggle
            label="冷开场"
            hint="开头定格首帧 1.2 秒"
            checked={options.coldOpen}
            onChange={(v) => set("coldOpen", v)}
          />
          <Toggle
            label="响度标准化"
            hint="把口播音量拉齐到 -16LUFS，忽大忽小不再有"
            checked={options.audioNormalize !== false}
            onChange={(v) => set("audioNormalize", v)}
          />
        </section>

        {/* 高级 */}
        <section>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-line/70 bg-panel-2/30 px-3 py-2.5 text-[12px] font-semibold text-mut transition-colors hover:text-fg"
          >
            高级选项
            <LuChevronDown className={cx("h-3.5 w-3.5 transition-transform duration-200", showAdvanced && "rotate-180")} />
          </button>
          {showAdvanced && (
            <div className="mt-2 grid list-in grid-cols-1 gap-2 sm:grid-cols-2">
              {/* 这里同样只放真实现的开关。
                  原来的"闪回预告/删重录/开场钩子/字幕翻译"后端都没有实现,
                  勾了等于没勾,已移除。等后端真做了再加回来。 */}
              <Toggle
                label="人声压低 BGM"
                hint="有人说话时自动把音乐压下去"
                checked={options.duckBgm !== false}
                onChange={(v) => set("duckBgm", v)}
              />
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-[11px] font-bold text-mut-2">背景音乐</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void call(async (api) => {
                        const p = await api.selectAudio();
                        set("bgmPath", p ?? "");
                      });
                    }}
                    className="shrink-0 rounded-lg border border-line px-3 py-2 text-[11.5px] font-semibold text-mut transition-colors hover:text-fg"
                  >
                    {options.bgmPath ? "换一首" : "选择 BGM"}
                  </button>
                  {options.bgmPath && (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mut-2" title={options.bgmPath}>
                        {options.bgmPath.split(/[\\/]/).pop()}
                      </span>
                      <button
                        type="button"
                        onClick={() => set("bgmPath", "")}
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-mut-2 hover:text-bad"
                      >
                        移除
                      </button>
                    </>
                  )}
                </div>
                {options.bgmPath && (
                  <label className="mt-1.5 flex items-center gap-2">
                    <span className="shrink-0 text-[10.5px] text-mut-2">音量</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((options.bgmVolume ?? 0.22) * 100)}
                      onChange={(e) => set("bgmVolume", Number(e.target.value) / 100)}
                      className="flex-1 accent-[#FF6B35]"
                    />
                    <span className="tabular w-9 shrink-0 text-right font-mono text-[10.5px] text-mut-2">
                      {Math.round((options.bgmVolume ?? 0.22) * 100)}%
                    </span>
                  </label>
                )}
              </label>
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-[11px] font-bold text-mut-2">水印文字</span>
                <input
                  value={options.watermark ?? ""}
                  onChange={(e) => set("watermark", e.target.value)}
                  placeholder="留空不加水印；例：@某某老师"
                  className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] outline-none focus:border-ember/60"
                />
              </label>
            </div>
          )}

          <section className="flex flex-col gap-2">
            <div className="text-[11px] font-bold tracking-[1.2px] text-mut-2">开头处理</div>
            <div className="grid list-in grid-cols-1 gap-2 sm:grid-cols-2">
              <Toggle
                label="爆款开头前置"
                hint="从全场挑钩子最强的一段剪到片头（会动用你没勾选的段）"
                checked={options.viralOpening !== false}
                onChange={(v) => set("viralOpening", v)}
              />
              <Toggle
                label="指定开头"
                hint="只找这句,找到就放到片头"
                checked={Boolean(options.openingText)}
                onChange={(v) => set("openingText", v ? "请在下方填写" : "")}
              />
            </div>
            {options.viralOpening !== false && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-mut-2">开头片段长度(秒)</span>
                <input
                  type="number"
                  min={3}
                  max={60}
                  value={options.viralOpeningSeconds ?? 15}
                  onChange={(e) => set("viralOpeningSeconds", Math.max(3, Math.min(60, Number(e.target.value) || 15)))}
                  className="tabular rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[12.5px] outline-none focus:border-ember/60"
                />
              </label>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-mut-2">指定开头原文</span>
              <input
                value={options.openingText ?? ""}
                onChange={(e) => set("openingText", e.target.value)}
                placeholder="例：我的老师是如何训练？"
                className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] outline-none focus:border-ember/60"
              />
              <span className="text-[10.5px] text-mut-2">
                留空则由引擎从全场挑最抓人的一句。填了只认这一句,找不到就不前置。
              </span>
            </label>
          </section>

          {/* 成片包装
              这一组是真正会改变交付物的开关(字幕/封面/标题)。
              以前界面上没有它们,而 titleCard 之类只改本地状态、根本没传给
              Hermes,用户勾了什么出片都一样。现在这三个直连 generator。 */}
          <section className="flex flex-col gap-2">
            <div className="text-[11px] font-bold tracking-[1.2px] text-mut-2">成片包装</div>
            <div className="grid list-in grid-cols-1 gap-2 sm:grid-cols-2">
              <Toggle
                label="烧录字幕"
                hint="按逐句稿生成字幕并压进画面"
                checked={options.subtitles !== false}
                onChange={(v) => set("subtitles", v)}
              />
              <Toggle
                label="生成封面"
                hint="选一帧做封面并烧标题"
                checked={options.covers !== false}
                onChange={(v) => set("covers", v)}
              />
              <Toggle
                label="顶部标题"
                hint="在画面顶部常驻标题横幅"
                checked={options.title !== false}
                onChange={(v) => set("title", v)}
              />
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-mut-2">标题文案(留空则由模型生成)</span>
              <input
                value={options.titleText ?? ""}
                onChange={(e) => set("titleText", e.target.value)}
                placeholder="例:3 个动作让你一学就会"
                className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] outline-none focus:border-ember/60"
              />
            </label>
            {/* 2026-10-21：AI 文案套装入口 —— 标题候选/简介/话题标签一键生成，
                结果里点标题直接填入上面的输入框，其余内容一键复制。 */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void aiGenerate()}
                disabled={aiBusy}
                className="self-start rounded-lg border border-ember/40 bg-ember/10 px-3 py-1.5 text-[11.5px] font-bold text-ember transition-colors hover:bg-ember/20 disabled:opacity-50"
              >
                {aiBusy ? "本地模型生成中…（十几秒到一分钟）" : "AI 帮我写标题和文案"}
              </button>
              {aiErr && <p className="text-[11px] leading-relaxed text-warn">文案生成失败：{aiErr}</p>}
              {aiResult && !aiBusy && (
                <div className="space-y-2 rounded-lg border border-line bg-panel px-3 py-2.5">
                  <div className="space-y-1">
                    {aiResult.titles.map((t, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            set("titleText", t);
                            setCopied(t);
                          }}
                          title="点击填入标题框"
                          className="flex-1 truncate text-left text-[12.5px] font-semibold text-fg hover:text-ember"
                        >
                          {t}
                        </button>
                        <span className="shrink-0 text-[10px] text-mut-2">{copied === t ? "已填入" : `候选${i + 1}`}</span>
                      </div>
                    ))}
                  </div>
                  {aiResult.desc && (
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11.5px] leading-relaxed text-mut">{aiResult.desc}</p>
                      <button
                        type="button"
                        onClick={() => void copyText(aiResult.desc ?? "")}
                        className="shrink-0 text-[10.5px] font-semibold text-mut-2 hover:text-fg"
                      >
                        {copied === aiResult.desc ? "已复制" : "复制"}
                      </button>
                    </div>
                  )}
                  {aiResult.tags && aiResult.tags.length > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[11.5px] text-ember/90">{aiResult.tags.join(" ")}</p>
                      <button
                        type="button"
                        onClick={() => void copyText(aiResult.tags?.join(" ") ?? "")}
                        className="shrink-0 text-[10.5px] font-semibold text-mut-2 hover:text-fg"
                      >
                        {copied === aiResult.tags?.join(" ") ? "已复制" : "复制标签"}
                      </button>
                    </div>
                  )}
                  {aiResult.hook && (
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11.5px] leading-relaxed text-mut">开场钩子：{aiResult.hook}</p>
                      <button
                        type="button"
                        onClick={() => void copyText(aiResult.hook ?? "")}
                        className="shrink-0 text-[10.5px] font-semibold text-mut-2 hover:text-fg"
                      >
                        {copied === aiResult.hook ? "已复制" : "复制"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="text-[10.5px] leading-relaxed text-mut-2">
              字幕与标题都关掉时,直接用粗剪当成片,不再重编码一遍。
            </p>
          </section>

          {/* ---------- 上传封面图 ----------
              单独成块而不是塞进"成片包装"里：它和"生成封面"是两件不同的事 ——
              生成封面是从视频里挑一帧产出独立 jpg，上传封面图是直接进正片首帧。
              混在一起用户会以为是一回事。 */}
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-fg">上传封面图</h3>
            <AssetPicker
              kind="covers"
              title="封面图"
              hint="出片时文案烧在图中下位置，这张图作为成片第一帧"
              value={options.coverImage?.usePath}
              onChange={(p) =>
                onChange({ ...options, coverImage: { ...options.coverImage, usePath: p } })
              }
              compact
            />
            {options.coverImage?.usePath && (
              <div className="mt-2 grid gap-2.5 rounded-lg border border-line/70 bg-panel-2/20 px-3 py-2.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-bold text-mut-2">首帧停留（秒）</span>
                  <input
                    type="number"
                    min={0.2}
                    max={10}
                    step={0.1}
                    value={options.coverImage.seconds ?? 1.5}
                    onChange={(e) =>
                      onChange({
                        ...options,
                        coverImage: { ...options.coverImage, seconds: Number(e.target.value) || 1.5 }
                      })
                    }
                    className="tabular rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-bold text-mut-2">
                    文案位置：{(options.coverImage.textY ?? 0.68).toFixed(2)}（0 顶 · 1 底）
                  </span>
                  <input
                    type="range"
                    min={0.05}
                    max={0.95}
                    step={0.01}
                    value={options.coverImage.textY ?? 0.68}
                    onChange={(e) =>
                      onChange({
                        ...options,
                        coverImage: { ...options.coverImage, textY: Number(e.target.value) }
                      })
                    }
                    className="accent-ember"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-bold text-mut-2">
                    文案字号（相对图高千分比，当前 {options.coverImage.textSize ?? 46}）
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={120}
                    step={2}
                    value={options.coverImage.textSize ?? 46}
                    onChange={(e) =>
                      onChange({
                        ...options,
                        coverImage: { ...options.coverImage, textSize: Number(e.target.value) }
                      })
                    }
                    className="accent-ember"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-bold text-mut-2">
                    压暗底色（浅色封面必需，当前 {Math.round((options.coverImage.scrim ?? 0.25) * 100)}%）
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={0.8}
                    step={0.05}
                    value={options.coverImage.scrim ?? 0.25}
                    onChange={(e) =>
                      onChange({
                        ...options,
                        coverImage: { ...options.coverImage, scrim: Number(e.target.value) }
                      })
                    }
                    className="accent-ember"
                  />
                </label>
                <p className="text-[10.5px] leading-relaxed text-mut-2 sm:col-span-2">
                  烧在封面上的文案和「标题文案」是同一句。封面图那几秒是静音的 —— 藏带货/封面不带原声，避免和正片人声打架。
                </p>
              </div>
            )}
          </section>

          {/* ---------- 结尾藏带货 ---------- */}
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-fg">结尾藏带货</h3>
            <AssetPicker
              kind="tails"
              title="藏带货视频"
              hint="拼在成片最后，可以每次随机换一个"
              value={options.tailVideo?.usePath}
              onChange={(p) =>
                onChange({ ...options, tailVideo: { ...options.tailVideo, usePath: p } })
              }
              compact
            />
            {options.tailVideo?.usePath && (
              <div className="mt-2 flex flex-col gap-2.5 rounded-lg border border-line/70 bg-panel-2/20 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] font-bold text-mut-2">选片方式</span>
                  {(
                    [
                      { k: "first", label: "固定用选中的" },
                      { k: "last", label: "用素材库最后一条" },
                      { k: "random", label: "每次随机挑一个" }
                    ] as const
                  ).map((p) => {
                    const on = (options.tailVideo?.pick ?? "first") === p.k;
                    return (
                      <button
                        key={p.k}
                        type="button"
                        onClick={() =>
                          onChange({ ...options, tailVideo: { ...options.tailVideo, pick: p.k } })
                        }
                        className={cx(
                          "rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                          on ? "border-ember/50 bg-ember/8 text-fg" : "border-line text-mut hover:bg-panel-2/60"
                        )}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  {options.tailVideo?.pick === "random" && (
                    <span className="text-[10px] text-mut-2">出片时才知道用哪条，出完会显示实际用的那条</span>
                  )}
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-bold text-mut-2">结尾标签文案（留空不烧）</span>
                  <input
                    value={options.tailVideo.labelText ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...options,
                        tailVideo: { ...options.tailVideo, labelText: e.target.value }
                      })
                    }
                    placeholder="例：戳主页链接下单"
                    className="rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
                  />
                </label>
              </div>
            )}
          </section>

          {/* ---------- 字幕 / 标题样式 ---------- */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-fg">字幕与标题样式</h3>
              <span className="text-[10.5px] text-mut-2">字体 · 颜色 · 字号 · 位置 · 描边 · 阴影</span>
            </div>
            <StylePresetBar
              caption={options.captionFontStyle}
              title={options.titleFontStyle}
              onCaptionChange={(next) => onChange({ ...options, captionFontStyle: next })}
              onTitleChange={(next) => onChange({ ...options, titleFontStyle: next })}
            />
            <FontStylePanel
              caption={options.captionFontStyle}
              title={options.titleFontStyle}
              onCaptionChange={(next) => onChange({ ...options, captionFontStyle: next })}
              onTitleChange={(next) => onChange({ ...options, titleFontStyle: next })}
              previewHeight={frameHeight}
              onReset={() =>
                onChange({ ...options, captionFontStyle: undefined, titleFontStyle: undefined })
              }
            />
          </section>
        </section>
      </div>
    </Modal>
  );
}
