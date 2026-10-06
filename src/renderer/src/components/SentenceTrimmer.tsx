/**
 * 逐字逐句裁剪
 * © 2026 郭洛斌
 *
 * 这是"挑爆点"最核心的一步:Hermes 给的段边界是模型猜的,常常把
 * "欢迎新宝宝"这类运营话术一起框进来。用户要能逐句剔除,只留干货。
 *
 * 交互:一句一行,点一下切换去留;全选/全不选一键切换。
 * 结果是若干个"连续留"的区间(manualCuts),出片时按区间分别切再拼,
 * 被剔除的句子不会进成片。
 */
import { useEffect, useMemo, useRef } from "react";
import { LuCheck, LuMinus, LuPlay, LuX } from "react-icons/lu";
import type { Transcript, TranscriptSegment } from "@shared/api-types";
import { cx } from "./ui";
import { formatClock } from "../lib/format";

interface Props {
  clip: { startSec: number; endSec: number; manualCuts?: Array<{ startSec: number; endSec: number }> };
  transcript: Transcript | null;
  onChange: (cuts: Array<{ startSec: number; endSec: number }>) => void;
  onPreview: (sec: number) => void;
  /**
   * 当前正在播的秒数（相对原素材）。用来让"念到哪句"跟着画面走。
   * 为 null 表示没有在播放（比如弹窗刚打开）。
   */
  playSec?: number | null;
  /** 用户开始框选/点句子时请求暂停播放 */
  onRequestPause?: () => void;
}

/** 落在本段内的句子(放宽 0.5s 边界,避免边界句子被漏掉) */
function sentencesInRange(segments: TranscriptSegment[], start: number, end: number): TranscriptSegment[] {
  return segments.filter((s) => s.endSec > start - 0.5 && s.startSec < end + 0.5);
}

export function SentenceTrimmer({
  clip,
  transcript,
  onChange,
  onPreview,
  playSec = null,
  onRequestPause
}: Props): React.JSX.Element | null {
  const sentences = useMemo(
    () => sentencesInRange(transcript?.segments ?? [], clip.startSec, clip.endSec),
    [transcript, clip.startSec, clip.endSec]
  );

  /** 某句是否被保留:有 manualCuts 时按区间判定,没有则默认全留 */
  const kept = useMemo(() => {
    if (!clip.manualCuts || clip.manualCuts.length === 0) {
      return () => true;
    }
    return (s: TranscriptSegment): boolean =>
      clip.manualCuts!.some((r) => s.endSec > r.startSec - 0.05 && s.startSec < r.endSec + 0.05);
  }, [clip.manualCuts]);

  // 句数太少就不给这个能力,免得干扰(单句片段没有"剔除"的概念)
  if (sentences.length < 2) return null;

  const setAll = (on: boolean): void => {
    if (on) {
      onChange([{ startSec: clip.startSec, endSec: clip.endSec }]);
    } else {
      onChange([]);
    }
  };

  const toggleAt = (index: number): void => {
    // 以句子为单位重算保留区间
    const next = sentences.map((s, i) => (i === index ? !kept(s) : kept(s)));
    const ranges: Array<{ startSec: number; endSec: number }> = [];
    let cur: { startSec: number; endSec: number } | null = null;
    sentences.forEach((s, i) => {
      if (next[i]) {
        if (!cur) cur = { startSec: s.startSec, endSec: s.endSec };
        else cur.endSec = s.endSec;
      } else if (cur) {
        ranges.push(cur);
        cur = null;
      }
    });
    if (cur) ranges.push(cur);
    // 区间必须夹在段边界内,否则服务端会算到段外
    onChange(
      ranges
        .map((r) => ({
          startSec: Math.max(clip.startSec, r.startSec),
          endSec: Math.min(clip.endSec, r.endSec)
        }))
        .filter((r) => r.endSec - r.startSec >= 0.2)
    );
  };

  /**
   * 正在念的那一句。
   *
   * 判据用"播放头落在句子的时间范围内"，而不是"离播放头最近" ——
   * 后者在句子之间的停顿里会来回跳两下，看起来像卡住。
   * 边界各放宽 50ms，和 kept 的判定保持一致，避免同一句一半高亮一半不高亮。
   */
  const activeIdx = useMemo(() => {
    if (playSec == null) return null;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s && playSec >= s.startSec - 0.05 && playSec <= s.endSec + 0.05) return i;
    }
    return null;
  }, [sentences, playSec]);

  // 播放头走进另一句时把它滚进视野。用户盯着左边画面时不该还要手动找文字。
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastScrolled = useRef<number | null>(null);
  useEffect(() => {
    if (activeIdx === null) return;
    if (lastScrolled.current === activeIdx) return;
    lastScrolled.current = activeIdx;
    rowRefs.current.get(activeIdx)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const keptCount = sentences.filter(kept).length;
  const dropped = sentences.length - keptCount;
  const totalKeptSec = (clip.manualCuts ?? [{ startSec: clip.startSec, endSec: clip.endSec }])
    .filter(() => keptCount > 0)
    .reduce((a, r) => a + (r.endSec - r.startSec), 0);

  return (
    <div className="rounded-lg border border-line bg-panel-2/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-bold text-mut-2">逐字逐句挑选</span>
        <span className="tabular font-mono text-[10px] text-mut-2">
          留 {keptCount}/{sentences.length} 句
          {dropped > 0 && ` · 剔掉 ${totalKeptSec.toFixed(1)}s`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-[10.5px] font-semibold text-mut transition-colors hover:text-ember"
        >
          全留
        </button>
        <span className="text-mut-2/40">·</span>
        <button
          type="button"
          onClick={() => setAll(false)}
          className="text-[10.5px] font-semibold text-mut transition-colors hover:text-ember"
        >
          全剔
        </button>
      </div>

      <div className="scroll-thin max-h-52 space-y-0.5 overflow-y-auto">
        {sentences.map((s, i) => {
          const on = kept(s);
          const speaking = activeIdx === i;
          return (
            <div
              key={s.id ?? i}
              ref={(el) => {
                if (el) rowRefs.current.set(i, el);
                else rowRefs.current.delete(i);
              }}
              className={cx(
                "group flex items-start gap-2 rounded-md px-2 py-1 transition-colors",
                // 正在念的句给描边，和左边画面的进度对得上；
                // 单纯变底色会和"保留"状态撞色，分不清是在念还是留着的
                speaking && "bg-ember/10 ring-1 ring-inset ring-ember/50",
                !speaking && (on ? "bg-ember/6" : "bg-transparent")
              )}
            >
              <button
                type="button"
                onClick={() => {
                  // 改去留之前先停：句子列表会重排，视频继续播的话
                  // 高亮行和用户刚点的行会对不上，容易误以为点错了
                  onRequestPause?.();
                  toggleAt(i);
                }}
                title={on ? "点击剔除这句" : "点击保留这句"}
                className={cx(
                  "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  on
                    ? "flame-gradient border-transparent text-white"
                    : "border-line text-transparent hover:border-ember/70"
                )}
              >
                {on ? <LuCheck className="h-2.5 w-2.5" strokeWidth={3} /> : <LuMinus className="h-2.5 w-2.5" />}
              </button>
              <button
                type="button"
                onPointerDown={() => onRequestPause?.()}
                onClick={() => onPreview(s.startSec)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
              >
                <span
                  className={cx(
                    "tabular mt-px shrink-0 font-mono text-[9.5px]",
                    on ? "text-ember/80" : "text-mut-2/50 line-through"
                  )}
                >
                  {formatClock(s.startSec)}
                </span>
                <span
                  className={cx(
                    "text-[11.5px] leading-relaxed transition-colors duration-150",
                    // 正在念的这一句提到最亮并加粗，和其余句子拉开层级。
                    // 用颜色 + 字重两个维度区分，不只靠颜色 ——
                    // 逐句裁剪里"念到"和"保留"本来就是两件事。
                    speaking && "font-semibold text-ember",
                    !speaking && (on ? "text-fg/85" : "text-mut-2/55 line-through")
                  )}
                >
                  {s.text || "(无文本)"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onPreview(s.startSec)}
                title="从这句开始看"
                className="mt-px shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <LuPlay className="h-3 w-3 text-mut-2 hover:text-ember" />
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-mut-2">
        <LuX className="h-3 w-3" />
        剔除的句子不会进成片。点击句子左侧方块切换去留,点文字跳到画面。
      </p>
    </div>
  );
}
