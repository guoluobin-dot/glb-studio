/**
 * 多版本粗剪对比
 * © 2026 郭洛斌
 *
 * 用途:一次出多条不同长度/不同开头的粗剪,用户并排看完再挑一版做包装。
 *
 * 为什么值得做:
 * "50 秒投信息流"和"8 分钟沉淀课"用的是同一批片段,
 * 但成片完全不同 —— 而哪种更适合当前平台,不试过不知道。
 * 以前要试就得改配置重跑,来回几轮十分钟就没了。
 *
 * 关键:每版必须有真实差异(时长档位不同),不是把同一个文件复制几份。
 * 所以这里直接展示"目标时长 vs 实际时长",一眼就能看出有没有区别。
 */
import { useState } from "react";
import { LuCheck, LuFilm, LuLoaderCircle, LuPlay, LuX } from "react-icons/lu";
import type { VariantResult } from "@shared/api-types";
import { cx, Dot, Modal } from "./ui";
import { formatDurationCN } from "../lib/format";

interface Props {
  liveVideoId: number | null;
  picked: import("@shared/api-types").ClipCandidate[];
  variants: VariantResult[];
  running: boolean;
  /** 已"选这版"的版本,面板里要标出来,否则用户不知道出片会用哪一版 */
  pickedVariant?: VariantResult | null;
  onClose: () => void;
  onRun: (variantIds: string[]) => Promise<void>;
  onPick: (v: VariantResult) => void;
  onClearPick?: () => void;
}

const ALL = [
  { id: "short", label: "短平快", hint: "50 秒 · 只留最抓人的,适合信息流" },
  { id: "mid", label: "标准", hint: "4 分钟 · 教学主干完整,适合课程分发" },
  { id: "long", label: "长课", hint: "8 分钟 · 保留推导过程,适合沉淀" },
  { id: "specified", label: "指定开头版", hint: "只用我指定的那句开头" }
];

export function VariantPanel({
  liveVideoId,
  picked,
  variants,
  running,
  pickedVariant,
  onClose,
  onRun,
  onPick,
  onClearPick
}: Props): React.JSX.Element {
  const [sel, setSel] = useState<string[]>(["short", "mid"]);
  const byId = new Map(variants.map((v) => [v.id, v]));

  const toggle = (id: string): void =>
    setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // 指定开头版必须真的填了原文,否则和标准版没区别
  const needOpening = sel.includes("specified");

  return (
    <Modal
      title="出多版对比"
      subtitle={`已选 ${picked.length} 条片段 · 一次出多条不同长度的粗剪,看完再挑一版包装`}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-mut-2">
            {running ? "正在切片段,每版要几十秒到几分钟…" : `已选 ${sel.length} 版`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12px] font-semibold text-mut hover:text-fg"
            >
              <LuX className="h-3.5 w-3.5" />
              关闭
            </button>
            <button
              type="button"
              disabled={running || sel.length === 0 || liveVideoId === null || needOpening}
              onClick={() => void onRun(sel)}
              className="btn-flame flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12.5px] font-bold text-white disabled:opacity-45"
            >
              {running ? <LuLoaderCircle className="h-3.5 w-3.5 spin-slow" /> : <LuFilm className="h-3.5 w-3.5" />}
              {running ? "生成中…" : `出 ${sel.length} 版`}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {pickedVariant && (
          <div className="flex items-center gap-2 rounded-lg border border-ember/35 bg-ember/8 px-3 py-2">
            <LuCheck className="h-3.5 w-3.5 shrink-0 text-ember" strokeWidth={3} />
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg">
              出片会用「{pickedVariant.label}」
              {pickedVariant.totalSec ? `（${pickedVariant.totalSec}s）` : ""}
              ，包装的是这一版，不会重新选段。
            </span>
            {onClearPick && (
              <button
                type="button"
                onClick={onClearPick}
                className="shrink-0 rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut hover:text-fg"
              >
                取消
              </button>
            )}
          </div>
        )}

        {needOpening && (
          <p className="rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
            「指定开头版」需要在出片选项里填了指定开头原文,否则它和标准版没有区别。请先取消勾选,或去出片选项里填原文。
          </p>
        )}

        {ALL.map((v) => {
          const on = sel.includes(v.id);
          const done = byId.get(v.id);
          const chosen = pickedVariant?.id === v.id && Boolean(pickedVariant?.projectId);
          return (
            <div
              key={v.id}
              className={cx(
                "rounded-xl border px-3 py-2.5 transition-colors",
                chosen ? "border-ember/60 bg-ember/10" : on ? "border-ember/35 bg-ember/6" : "border-line bg-panel-2/45"
              )}
            >
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => toggle(v.id)}
                  className={cx(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors",
                    on ? "flame-gradient border-transparent text-white" : "border-line text-transparent hover:border-ember/70"
                  )}
                  title={on ? "不生成这版" : "生成这版"}
                >
                  <LuCheck className="h-3 w-3" strokeWidth={3} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-bold text-fg">{v.label}</span>
                    {chosen && (
                      <span className="rounded bg-ember/20 px-1.5 py-0.5 text-[9.5px] font-bold text-ember">出片用这版</span>
                    )}
                    {done && (
                      done.ok ? (
                        <span className="tabular font-mono text-[10px] text-ok">
                          {done.totalSec ? formatDurationCN(done.totalSec) : "已生成"} · {done.elapsedSec}s
                        </span>
                      ) : (
                        <span className="text-[10px] text-bad">失败</span>
                      )
                    )}
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-mut-2">{v.hint}</p>
                  {done?.error && <p className="mt-1 text-[10.5px] text-bad/90">{done.error}</p>}
                  {done?.viralOpening && (
                    <p className="mt-1 text-[10.5px] text-ember/80">开头：{done.viralOpening}</p>
                  )}
                </div>

{done?.ok && done.files.length > 0 && (
                  <button
                    type="button"
                    disabled={!done.projectId}
                    onClick={() => onPick(done)}
                    title={
                      done.projectId
                        ? chosen
                          ? "已选为出片版本,再点一次取消"
                          : "选这版做包装出片"
                        : "这一版没有工程 id,无法用于包装"
                    }
                    className={cx(
                      "flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                      chosen
                        ? "border-ember bg-ember/15 text-ember"
                        : "border-line text-mut hover:border-ember/60 hover:text-ember",
                      !done.projectId && "cursor-not-allowed opacity-40 hover:border-line hover:text-mut"
                    )}
                  >
                    {chosen ? <LuCheck className="h-3 w-3" strokeWidth={3} /> : <LuPlay className="h-3 w-3" />}
                    {chosen ? "已选" : "选这版"}
                  </button>
                )}
              </div>

              {/* 产出文件列表:能直接看到每版切了几段 */}
              {done?.ok && done.files.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-line/60 pt-2">
                  {done.files.slice(0, 4).map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-[10.5px] text-mut-2">
                      <Dot tone="ok" />
                      <span className="truncate">{f.split(/[\\/]/).pop()}</span>
                    </li>
                  ))}
                  {done.files.length > 4 && (
                    <li className="pl-4 text-[10.5px] text-mut-2/70">…另有 {done.files.length - 4} 个</li>
                  )}
                </ul>
              )}
            </div>
          );
        })}

        {variants.length > 0 && (
          <p className="pt-1 text-[10.5px] leading-relaxed text-mut-2">
            提示:各版目标时长不同,产出必然不一样。选一版后再点右下「出片」做字幕/封面/标题包装。
          </p>
        )}
      </div>
    </Modal>
  );
}
