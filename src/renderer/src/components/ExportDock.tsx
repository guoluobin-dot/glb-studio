/**
 * 出片台(右侧常驻)
 * © 2026 郭洛斌
 *
 * 最高频的动作是"出片",所以它固定在右手位、吸底可见、永远不折叠。
 * 自上而下回答四个问题:选了多少 / 什么档 / 存哪 / 现在能不能出。
 * 记忆深找(让引擎按学过的爆款规律重排)放在这里,因为它同样是"决定选什么"的动作。
 */
import { useState } from "react";
import { LuBrain, LuCheck, LuEye, LuFolderOpen, LuLayers, LuScissors, LuSlidersHorizontal, LuSparkles } from "react-icons/lu";
import type { ClipCandidate, EngineSettings } from "@shared/api-types";
import { useSession } from "../stores/session-store";
import { call } from "../lib/bridge";
import { clipDuration, formatClock } from "../lib/format";
import { ResultList, type ExportArtifacts } from "./ResultList";
import { cx, Dot, Modal, Progress } from "./ui";

/** 出片档位:按时长目标,一键重排+自动勾选 */
const TIERS = [
  { id: "short", label: "短视频", range: "30-60 秒", desc: "一个爆点讲透" },
  { id: "mid", label: "中视频", range: "1-3 分钟", desc: "完整小故事" },
  { id: "long", label: "长视频", range: "3-9 分钟", desc: "多爆点串成体系" }
] as const;

type TierId = (typeof TIERS)[number]["id"];

export function ExportDock({
  engine,
  message,
  artifacts,
  onCloseArtifacts,
  disabled = false,
  onOpenOptions,
  onRunExport,
  onRerank,
  clipProjectId,
  onOpenReview,
  reviewHint
}: {
  engine: EngineSettings | null;
  message: { tone: "ok" | "warn"; text: string } | null;
  /** 出片产物:出片完成后可预览/打开/定位,不再只是一行字 */
  artifacts?: ExportArtifacts | null;
  onCloseArtifacts?: () => void;
  /** 没有候选时禁用出片(参数仍可调) */
  disabled?: boolean;
  onOpenOptions: () => void;
  /** 有粗剪可审时才显示 */
  clipProjectId?: number | null;
  onOpenReview?: () => void;
  /** 审片按钮旁的提示，比如上次审到第几轮 */
  reviewHint?: string | null;
  onRunExport: () => Promise<void>;
  onRerank: (tier: TierId) => Promise<string>;
}): React.JSX.Element {
  const session = useSession();
  const { candidates, selected, outDir, stage } = session;
  const picked = (candidates ?? []).filter((c) => selected.has(c.id));
  const totalSec = picked.reduce((sum, c) => sum + clipDuration(c), 0);
  const keptCount = (candidates ?? []).filter((c) => c.gate !== "drop").length;

  const [tierOpen, setTierOpen] = useState(false);
  const [busy, setBusy] = useState<null | "rerank" | "export">(null);

  const runTier = async (tier: TierId): Promise<void> => {
    setTierOpen(false);
    setBusy("rerank");
    try {
      await onRerank(tier);
    } finally {
      setBusy(null);
    }
  };

  const runExport = async (): Promise<void> => {
    setBusy("export");
    try {
      await onRunExport();
    } finally {
      setBusy(null);
    }
  };

  const pickDir = async (): Promise<void> => {
    const dir = await call((api) => api.selectOutDir());
    if (dir) session.setOutDir(dir);
  };

  return (
    <aside className="flex w-[288px] shrink-0 flex-col border-l border-line/70 bg-panel/55">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line/60 px-3.5">
        <LuScissors className="h-3.5 w-3.5 text-ember" />
        <span className="text-[12px] font-extrabold tracking-wide">出片台</span>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* 已选统计 */}
        <div className="rounded-xl border border-line/70 bg-panel-2/60 p-3">
          <div className="flex items-end gap-2">
            <span className="tabular text-[26px] leading-none font-extrabold text-ember">{picked.length}</span>
            <span className="pb-0.5 text-[11px] text-mut">条已选</span>
            <span className="flex-1" />
            <span className="tabular pb-0.5 font-mono text-[12px] font-bold text-fg/90">
              {formatClock(totalSec)}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
            <div
              className="flame-gradient h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.min(100, (picked.length / Math.max(1, keptCount)) * 100)}%` }}
            />
          </div>
        </div>

        {/* 记忆深找:决定"选什么"的高阶入口 */}
        <button
          type="button"
          onClick={() => setTierOpen(true)}
          disabled={busy !== null || stage !== "ready" || disabled}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-ember/45 bg-ember/8 px-3 py-2.5 text-[12px] font-bold text-ember transition-all duration-200 hover:bg-ember/15 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy === "rerank" ? (
            <>
              <Dot tone="busy" />
              重排中…
            </>
          ) : (
            <>
              <LuBrain className="h-4 w-4" />
              用爆款记忆重挑片段
            </>
          )}
        </button>
        {/*
          文案为什么这么写（2026-10-06）：
          原来叫"按记忆重找爆款"，而记忆库面板里有个"从历史爆款库同步"。
          两个都带"爆款记忆"，方向却相反 —— 一个是读记忆来重排当前素材的
          选段，一个是把分析结果写回记忆库。用户分不清哪个是哪个，
          以为导入后没变化就是这个原因（实际记忆库要等分析完成才更新）。

          所以这里明确成"用爆款记忆…"：读、用，都是针对当前这条素材。
          写回记忆的那一步归记忆库面板管，而且它本来就该自动进行 ——
          见 HitVaultPanel 的 syncFromHermes。
        */}
        {message && (
          <div
            role="status"
            className={cx(
              "pop-in whitespace-pre-line rounded-lg border px-2.5 py-2 text-[10.5px] leading-relaxed",
              message.tone === "ok" ? "border-ok/30 bg-ok/8 text-ok/90" : "border-warn/30 bg-warn/8 text-warn"
            )}
          >
            {message.text}
          </div>
        )}

        {/* 产物清单:能直接看/开/定位,不用再去资源管理器翻 */}
        <ResultList artifacts={artifacts ?? null} onClose={onCloseArtifacts ?? ((): void => undefined)} />

        {/* 引擎状态 */}
        <div className="rounded-xl border border-line/70 bg-panel/2 p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[1.2px] text-mut-2">
            <LuSparkles className="h-3 w-3" />
            分析引擎
          </div>
          <div className="mt-1.5 flex flex-col gap-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <Dot tone="ok" />
              <span className="text-mut">本地</span>
              <span className="tabular ml-auto font-mono text-[10px] text-mut-2">
                {engine?.local.model ?? "qwen3:8b-chat"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Dot tone={engine?.cloud.apiKey ? "ok" : "idle"} />
              <span className="text-mut">长上下文</span>
              <span className="tabular ml-auto font-mono text-[10px] text-mut-2">
                {engine?.cloud.model ?? "gemini"}
              </span>
            </div>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-mut-2">
            引擎按素材形态自动分派:短片段走本地,长直播走长上下文。
          </p>
        </div>

        {/* 输出目录 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold tracking-[1.2px] text-mut-2">输出目录</span>
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-2">
            <LuFolderOpen className="h-3.5 w-3.5 shrink-0 text-mut" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mut" title={outDir || undefined}>
              {outDir ? outDir.split(/[\\/]/).slice(-2).join("/") : "未设置"}
            </span>
            <button
              type="button"
              onClick={() => void pickDir()}
              className="shrink-0 text-[10.5px] font-semibold text-ember/90 underline-offset-2 hover:underline"
            >
              更改
            </button>
          </div>
        </div>

        {/* 全部选项 */}
        <button
          type="button"
          onClick={onOpenOptions}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-line px-3 py-2.5 text-[12px] font-semibold text-mut transition-all duration-200 hover:border-mut hover:text-fg"
        >
          <LuSlidersHorizontal className="h-4 w-4" />
          全部出片选项
        </button>
        {/* 审片入口。出过片才有粗剪可审，所以按 projectId 是否存在来显示。
            没有它的话用户只能去输出目录里手动找粗剪文件，
            审片意见也就没法回流到记忆里。 */}
        {clipProjectId && (
          <button
            type="button"
            onClick={onOpenReview}
            title="看粗剪本体、逐段给意见、通过或打回"
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-xl border border-line px-4 py-2.5 text-[12.5px] font-bold text-mut transition-colors hover:border-ember/60 hover:text-ember"
          >
            <LuEye className="h-4 w-4" />
            审片
            {reviewHint && <span className="text-[10.5px] font-normal opacity-75">{reviewHint}</span>}
          </button>
        )}
      </div>

      {/* 吸底主按钮 */}
      <div className="export-dock shrink-0 p-3 pt-2">
        {stage === "exporting" ? (
          <Progress percent={null} label="正在出片…" />
        ) : (
          <>
            <button
              type="button"
              disabled={picked.length === 0 || busy !== null || disabled}
              onClick={() => void runExport()}
              className="btn-export flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-[14px] font-extrabold text-white disabled:cursor-not-allowed"
            >
              {picked.length === 0 ? (
                <>
                  <LuCheck className="h-4 w-4 opacity-50" />
                  先勾选片段
                </>
              ) : (
                <>
                  <LuScissors className="h-4.5 w-4.5" />
                  出片 {picked.length} 条
                </>
              )}
            </button>
          </>
        )}
      </div>

      {/* 档位选择 */}
      {tierOpen && (
        <Modal
          title="用爆款记忆重挑片段"
          subtitle="读这位老师已积累的爆款记忆,按其中的规律重排候选,并自动勾选到目标时长。这一步不修改记忆库。"
          onClose={() => setTierOpen(false)}
          width="max-w-md"
        >
          <div className="flex flex-col gap-2">
            {TIERS.map((tier) => (
              <button
                key={tier.id}
                type="button"
                onClick={() => void runTier(tier.id)}
                className="rounded-lg border border-line bg-panel-2 px-3.5 py-3 text-left transition-colors hover:border-ember/60"
              >
                <div className="text-[13px] font-bold">
                  {tier.label}
                  <span className="ml-2 text-[12px] font-semibold text-ember">{tier.range}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] text-mut">{tier.desc}</div>
              </button>
            ))}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-mut-2">
            <LuLayers className="mt-0.5 h-3 w-3 shrink-0" />
            重排会覆盖当前候选列表与勾选,已改过标题的候选会丢失。
          </p>
        </Modal>
      )}
    </aside>
  );
}
