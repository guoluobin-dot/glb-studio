import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuCircleAlert,
  LuMessageSquare,
  LuPlay,
  LuRotateCcw,
  LuX
} from "react-icons/lu";
import { Modal, cx } from "./ui";
import { PreviewPlayer, type PlaybackApi } from "./PreviewPlayer";
import { TextCutter, type Mark } from "./TextCutter";
import { call } from "../lib/bridge";
import type { ClipSegmentMap, ReviewPacket } from "@shared/api-types";

/**
 * 审片台：看粗剪、给意见、通过或打回。
 *
 * 存在的理由：以前"审片"只有一个单候选精调弹窗，而且它写批注时
 * onChange 直接调 onSave、onSave 又会关弹窗 —— 打第一个字窗口就消失了。
 * 更关键的是所有审片意见都写不进 Hermes（打的端点是 404，异常还被 catch 吞掉），
 * 所以桌面上审了半天，对下一次出片零影响。
 *
 * 这里解决三件事：
 *  1. 播粗剪本体（不是原素材）—— 审片审的是成品粗剪，不是两小时直播
 *  2. 段落跟着粗剪时间轴走 —— 粗剪从 0 开始，段落信息来自原素材，两套坐标由服务端换算
 *  3. 通过/打回真正落进 review_feedback —— 打回的意见会成为下次找爆点的避雷词
 */
export function ReviewPanel({
  projectId,
  /** 粗剪文件路径；空表示还没渲染出来，回退播原素材 */
  roughcutPath,
  fallbackPath,
  onClose,
  onRecutDone
}: {
  projectId: number;
  roughcutPath?: string | null;
  fallbackPath?: string;
  onClose: () => void;
  onRecutDone?: (newProjectId: number | undefined, newRoughcutPath?: string | null) => void;
}): React.JSX.Element {
  const [packet, setPacket] = useState<ReviewPacket | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
/**
 * 「确认通过」时若还有待生效的文字删除，先问一句。
 *
 * 数字是处数；确认框会把丢掉多少字算清楚 ——
 * 只说"有 N 处删除"用户多半会直接点确认，等于没拦住。
 */
const [confirmApproveWithCuts, setConfirmApproveWithCuts] = useState(0);
  const [comment, setComment] = useState("");
  const [playTime, setPlayTime] = useState(0);
  const [rejectIds, setRejectIds] = useState<Set<number>>(new Set());
  /**
   * 文本级删除标记（第几段、哪几个字符）。
   *
   * 删除只是标记，不立刻重剪 —— 3 小时直播重剪要几十秒，
   * 每删一下等一次没法用。攒够了随「打回重剪」一起生效。
   */
  const [textCuts, setTextCuts] = useState<Mark[]>([]);

  /**
   * 直接拿播放器的 seek 能力，而不是给 PreviewPlayer 传 seekTo。
   *
   * 原因：seekTo 是"值变了才生效"（useEffect 依赖 [seekTo]），
   * 连点同一行时值没变，第二次点击就毫无反应 —— 而审片时反复点同一段
   * 恰恰是最常见的动作（回听那句话）。
   */
  const playback = useRef<PlaybackApi | null>(null);
  /** 播放器还没挂上时点的段落，挂载后补一次跳转 */
  const pendingSeek = useRef<number | null>(null);
  /** 拿最新的包，submit 里重建后要读新工程的粗剪路径 */
  const packetRef = useRef<ReviewPacket | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setBusy("load");
    try {
      const p = await call((api) => api.reviewPacket(projectId));
      packetRef.current = p;
      setPacket(p);
      setMsg(null);
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 播哪个文件：以服务端回的 packet.roughcutPath 为准，prop 只作兜底。
   *
   * 为什么不能信 prop：打回成功后会 load() 重新拉包、projectId 也换成了新的，
   * 但 prop 里的 roughcutPath 还是上一版的文件 —— 于是"审的是新工程、播的是旧粗剪"，
   * 点名打回也会对不上画面。packet 是唯一跟着工程走的东西。
   */
  const playing = (packet?.roughcutPath || roughcutPath || fallbackPath || "") as string;
  const playingIsRoughcut = Boolean(packet?.roughcutPath || roughcutPath);

  /** 跳到粗剪的某一秒 */
  const seekTo = useCallback((sec: number): void => {
    const api = playback.current;
    if (!api) {
      pendingSeek.current = sec;
      return;
    }
    api.seek(sec);
  }, []);

  /** 当前播放位置落在哪一段 */
  const currentSeg = useMemo(() => {
    if (!packet) return null;
    return (
      packet.segments.find((s) => playTime >= s.roughcutStartSec && playTime < s.roughcutEndSec) ??
      null
    );
  }, [packet, playTime]);

  /** 当前段落在列表里的下标。高亮只认这一个来源，不再另存一份 activeSeg */
  const currentIdx = useMemo(() => {
    if (!packet || !currentSeg) return null;
    return packet.segments.findIndex((s) => s.segmentId === currentSeg.segmentId);
  }, [packet, currentSeg]);

  /** 点行跳段：既跳播放头，也把该段勾成"当前正在看" */
  const jumpTo = (idx: number): void => {
    const s = packet?.segments[idx];
    if (!s) return;
    seekTo(s.roughcutStartSec);
  };

  /** 跳到上一段/下一段开头（[ / ] 键） */
  const stepSeg = (delta: number): void => {
    if (!packet || packet.segments.length === 0) return;
    const base = currentIdx ?? -1;
    const next = Math.min(packet.segments.length - 1, Math.max(0, base + delta));
    jumpTo(next);
  };

  const submit = async (decision: "approve" | "recut", force = false): Promise<void> => {
    setBusy(decision);
    setMsg(null);
    try {
      if (decision === "recut" && !comment.trim()) {
        setMsg({ tone: "warn", text: "打回请写一句意见 —— 意见会成为下次找爆点的避雷词，空意见等于白打回" });
        return;
      }
      // 打回时点名被勾的段：Hermes 会把它们标成 rejected，新工程自动排除
      const ids = [...rejectIds]
        .map((idx) => packet?.segments[idx]?.segmentId)
        .filter((x): x is number => typeof x === "number");
      /**
       * 文本级删除一起提交。
       *
       * 只在打回时带：通过不需要重剪（片段已经在那儿了），带了也是白带。
       * 而且通过意味着"这版就这样"，语义上就不该再有未生效的删除。
       *
       * 2026-10-05 修：这里原来直接丢弃 textCuts 然后 setTextCuts([])，
       * 于是"确认通过"会**静默吃掉已标记的文字删除** ——
       * 底部的说明还写着"随打回一起生效"，而"确认通过"就紧挨在"打回"旁边，
       * 一次误点，框了半天选中的字全没了，界面上一个字都没提。
       *
       * 现在不静默丢：点"确认通过"时若有待生效的删除，要求二次确认。
       */
      // force=true 表示用户已在二次确认框里明确选择"放弃这些删除"
      if (!force && decision === "approve" && textCuts.length > 0) {
        setConfirmApproveWithCuts(textCuts.length);
        return;
      }
      const cuts = (decision === "recut" ? textCuts : [])
        .map((mk) => {
          const seg = packet?.segments[mk.seg];
          if (!seg || seg.segmentId == null) return null;
          return { segmentId: seg.segmentId, ranges: [{ from: mk.from, to: mk.to }] };
        })
        .filter((x): x is { segmentId: number; ranges: Array<{ from: number; to: number }> } => x !== null);

      const r = await call((api) =>
        api.submitReview(projectId, {
          decision,
          comment: comment.trim(),
          segmentIds: decision === "recut" ? ids : [],
          textCuts: decision === "recut" ? cuts : []
        })
      );

      /*
       * 服务端拒绝操作已被取代的工程（409）。
       *
       * 这里原本会继续往下走 setTextCuts([]) + load()，看起来像提交成功了。
       * 必须先停下来，把话说清楚，并且告诉用户该去开哪个工程 ——
       * 否则用户会以为通过了，实际上服务端什么都没改。
       */
      if (!r.ok && r.supersededBy != null) {
        setMsg({
          tone: "warn",
          text: `这个粗剪已经被打回重剪取代了，不能再确认通过。请关掉本窗口，打开新工程 #${r.supersededBy} 继续审。`
        });
        return;
      }

      /**
       * 回执要说清"哪些删掉了、哪些没删掉"。
       *
       * 静默失败最坏：用户精心框选了半天，打回去发现没剪掉，
       * 而界面说"已重建成功" —— 用户只会以为是程序随机。
       */
      const cutMsg =
        decision === "recut" && r.cuts
          ? (() => {
              const { applied, removedMs, segments: segN, skipped } = r.cuts;
              const bits: string[] = [];
              if (segN > 0) bits.push(`剪掉 ${segN} 段共 ${(removedMs / 1000).toFixed(1)}s（${applied} 处）`);
              if (skipped.length > 0) bits.push(`未生效 ${skipped.length} 处：${skipped.slice(0, 2).join("；")}`);
              return bits.length ? `\n文字精修：${bits.join("；")}。` : "";
            })()
          : "";

      /*
       * 通过后的回执必须如实反映"学习到底写成没有"。
       *
       * 服务端现在会回 learned / learnFailed —— 因为整个正样本写入都在
       * 服务端的 try 里，抛错时通过照样成立，但一条都没学到。
       * 以前界面无条件显示"下次找爆点会参考这次的意见"，
       * 失败时说的正好是反的。
       */
      const approveMsg = (() => {
        if (r.learnFailed) {
          return `已确认通过，但这次的意见没记进去（${r.learnFailed}），下次找爆点不会参考它。`;
        }
        if (decision === "approve" && r.learned === 0) {
          return "已确认通过。这次没有新增学习样本（可能之前已经记过同样的意见）。";
        }
        return "已确认通过。下次找爆点会参考这次的意见。";
      })();

      setMsg({
        tone: r.learnFailed ? "warn" : "ok",
        text:
          decision === "approve"
            ? approveMsg
            : `已打回并重建粗剪${r.newProjectId ? `（新工程 #${r.newProjectId}）` : ""}，被点名的 ${ids.length} 段已拉黑。${cutMsg}`
      });
      setComment("");
      setRejectIds(new Set());
      setTextCuts([]);
      await load();
      // 新工程的粗剪路径要一并交出去。工作台只在出片时存过一次 roughcutPath，
      // 打回换了工程却还留着上一版的文件路径，下次开审片就播错了。
      if (decision === "recut") onRecutDone?.(r.newProjectId, packetRef.current?.roughcutPath);
    } catch (err) {
      // 这里必须让错误冒到界面。以前是 .catch(() => undefined)，
      // 结果审了半天一条意见都没写进去，用户完全不知情。
      setMsg({ tone: "warn", text: `提交失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const toggleReject = (idx: number): void => {
    setRejectIds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  /**
   * 审片台自己接管键盘。
   *
   * 原来按空格停的是背后工作台的播放器（快捷键是全局的、没有让位机制），
   * 画面纹丝不动，像播放器坏了。这里改成只留审片真正用得上的几个键，
   * 并且不接 A/D/X —— 在审片时误触全选/反选会把选片结果改掉。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      // 意见输入框里只放行 Esc，其余按键必须是字
      const editable =
        t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (editable) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          playback.current?.toggle();
          break;
        case "[":
          e.preventDefault();
          stepSeg(-1);
          break;
        case "]":
          e.preventDefault();
          stepSeg(1);
          break;
        case ",":
          e.preventDefault();
          playback.current?.seek(playback.current.currentTime - 5);
          break;
        case ".":
          e.preventDefault();
          playback.current?.seek(playback.current.currentTime + 5);
          break;
        default:
          break;
      }
    };

    /**
     * 文字精修区获得焦点（或里面有选区）时，播放快捷键让位。
     *
     * 以前那个判定只挡了输入框。现在正文区域用 div + user-select 实现，
     * 焦点不在 input/textarea 上，所以按空格会变成"播放/暂停"——
     * 用户正在逐句挑字、按空格想选中后面的内容，画面却开始放了。
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      const ae = e.target;
      const inEditor =
        ae instanceof HTMLElement &&
        Boolean(ae.closest("[data-text-editor]")) &&
        (ae.isContentEditable || Boolean(window.getSelection()?.toString()));
      if (inEditor && !["Escape", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      onKey(e);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, currentIdx]);

  // 播放头走到哪，当前行就滚到哪。154 段的长粗剪靠手动滚列表根本跟不住。
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (currentIdx === null) return;
    const el = rowRefs.current.get(currentIdx);
    if (!el) return;
    const box = el.parentElement;
    if (!box) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    // 只在真的看不见的时候动，避免每帧微调导致列表抖动
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: top - box.clientHeight / 2 + el.offsetHeight / 2, behavior: "smooth" });
    }
  }, [currentIdx]);

  return (
    <Modal
      title="审片"
      subtitle={
        packet
          ? `粗剪 ${packet.totalSec.toFixed(1)}s · ${packet.segments.length} 段 · ${statusText(packet.status)}`
          : "正在读取粗剪…"
      }
      onClose={onClose}
      width="max-w-[min(1680px,97vw)]"
      bodyScroll={false}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-mut-2">
            <span className="text-[11px] text-mut-2">
          {rejectIds.size > 0 && `已点名 ${rejectIds.size} 段（打回时会拉黑） · `}
          {textCuts.length > 0 ? `标记了 ${textCuts.length} 处文字删除，随打回一起生效` : "勾选段落可点名打回；框选文字可精修"}
        </span>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submit("recut")}
              disabled={busy !== null || !packet}
              className="flex items-center gap-1.5 rounded-lg border border-bad/50 px-4 py-2 text-[12px] font-bold text-bad transition-colors hover:bg-bad/10 disabled:opacity-40"
            >
              <LuRotateCcw className="h-3.5 w-3.5" />
              {busy === "recut" ? "提交中" : "打回重剪"}
            </button>
            <button
              type="button"
              onClick={() => void submit("approve")}
              disabled={busy !== null || !packet}
              className="flex items-center gap-1.5 rounded-lg bg-ok px-5 py-2 text-[12px] font-bold text-white transition-opacity disabled:opacity-40"
            >
              <LuCheck className="h-3.5 w-3.5" />
              {busy === "approve" ? "提交中" : "确认通过"}
            </button>
          </div>
        </div>
      }
    >
      {/*
        左视频 / 右文案，两栏并排各自滚。
        为什么是这个布局：审片的核心动作是"边看画面边核对口播文案"，
        再加"框选几个字删掉"。这两件事必须在同一屏里同时可见 ——
        文案滚走或画面滚走，这个动作就断了。
      */}
      <div className="flex min-h-0 w-full gap-4">
        {/* 左栏：画面 + 段落列表 */}
        <div className="flex min-h-0 w-[46%] shrink-0 flex-col gap-3 xl:w-[44%]">
        {msg && (
          <div
            className={cx(
              "shrink-0 rounded-lg px-3 py-2 text-[12px] font-semibold",
              msg.tone === "ok" ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
            )}
          >
            {msg.text}
          </div>
        )}

        {/* 播放器 */}
        {playing ? (
          <>
            <PreviewPlayer
              filePath={playing}
              onTime={setPlayTime}
              heightClass="h-[min(44vh,420px)] min-h-[200px]"
              registerApi={(api) => {
                playback.current = api;
                // 播放器比第一次点击晚挂上时，把那次跳转补上
                if (api && pendingSeek.current !== null) {
                  api.seek(pendingSeek.current);
                  pendingSeek.current = null;
                }
              }}
            />
            {!playingIsRoughcut && (
              <div className="flex shrink-0 items-center gap-1.5 rounded-lg bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
                <LuCircleAlert className="h-3.5 w-3.5 shrink-0" />
                粗剪还没渲染出来，先播原始素材。等出片后重开审片就是看粗剪本体。
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-[12px] text-mut-2">
            找不到可播放的文件
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1.5 flex shrink-0 items-center gap-2">
              <LuPlay className="h-3 w-3 text-mut-2" />
              <span className="text-[11.5px] font-bold text-mut">粗剪段落</span>
              <span className="truncate text-[10.5px] text-mut-2">
                点行跳段；勾选框 = 点名打回
              </span>
            </div>
            <div className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {busy === "load" && !packet && <div className="h-16 rounded-lg skeleton" />}
              {packet?.segments.map((s: ClipSegmentMap, idx: number) => {
                const on = currentIdx === idx;
                const rej = rejectIds.has(idx);
                return (
                  <div
                    key={`${s.segmentIndex}-${idx}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(idx, el);
                      else rowRefs.current.delete(idx);
                    }}
                    className={cx(
                      "flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
                      rej ? "border-bad/50 bg-bad/8" : on ? "border-ember/45 bg-ember/8" : "border-line hover:bg-panel-2/50"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleReject(idx)}
                      title={rej ? "取消点名" : "点名打回这一段"}
                      className={cx(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        rej ? "border-bad bg-bad text-white" : "border-line"
                      )}
                    >
                      {rej && <LuX className="h-2.5 w-2.5" strokeWidth={4} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => jumpTo(idx)}
                      title={`跳到粗剪 ${s.roughcutStartSec.toFixed(1)}s`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="tabular w-7 shrink-0 text-right font-mono text-[9.5px] text-mut-2">
                          {s.segmentIndex}
                        </span>
                        <span className="truncate text-[11.5px] font-semibold text-fg">
                          {s.themeName || "未命名片段"}
                        </span>
                        {typeof s.score === "number" && (
                          <span className="tabular shrink-0 font-mono text-[10px] text-mut-2">{s.score}</span>
                        )}
                      </div>
                      <div className="tabular text-[10px] text-mut-2">
                        粗剪 {s.roughcutStartSec.toFixed(1)}s → {s.roughcutEndSec.toFixed(1)}s · 原素材{" "}
                        {s.sourceStartSec.toFixed(0)}s → {s.sourceEndSec.toFixed(0)}s
                      </div>
                    </button>
                  </div>
                );
              })}
              {packet && packet.segments.length === 0 && (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-mut-2">
                  这条粗剪没有分段信息
                </div>
              )}
            </div>
            {/* 当前播放位置落在哪一段，明确写出来：两套时间轴最容易让用户懵 */}
            {currentSeg && (
              <div className="mt-2 rounded-lg bg-panel-2/50 px-2.5 py-1.5 text-[11px] text-mut">
                正在看：<span className="font-semibold text-fg">{currentSeg.themeName || "未命名片段"}</span>
                <span className="tabular ml-1.5 text-mut-2">
                  （粗剪 {currentSeg.roughcutStartSec.toFixed(1)}s，原素材 {currentSeg.sourceStartSec.toFixed(0)}s）
                </span>
              </div>
            )}
          </div>

          {/* 意见 + 历史 */}
          <div className="flex shrink-0 flex-col gap-2">
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <LuMessageSquare className="h-3 w-3 text-mut-2" />
                <span className="text-[11.5px] font-bold text-mut">这次的意见</span>
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="例：开头别用『欢迎新宝宝』，直接进正题；第二节重复了"
                className="w-full resize-none rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] text-fg outline-none focus:border-ember/60"
              />
            </div>
            <div className="text-[11.5px] font-bold text-mut">审片历史（{packet?.feedback.length ?? 0}）</div>
            <div className="scroll-thin max-h-[110px] min-h-0 space-y-1 overflow-y-auto pr-1">
              {packet?.feedback.map((f) => (
                <div
                  key={f.id}
                  className={cx(
                    "rounded-lg border px-2 py-1.5 text-[11px]",
                    f.decision === "approve" ? "border-ok/40 bg-ok/8" : "border-bad/40 bg-bad/8"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cx("font-bold", f.decision === "approve" ? "text-ok" : "text-bad")}>
                      {f.decision === "approve" ? "通过" : "打回"}
                    </span>
                    <span className="text-[9.5px] text-mut-2">{String(f.createdAt).slice(0, 16)}</span>
                  </div>
                  {f.comment && <p className="mt-0.5 leading-snug text-mut">{f.comment}</p>}
                </div>
              ))}
              {packet && packet.feedback.length === 0 && (
                <p className="text-[10.5px] text-mut-2">还没审过。第一次审完的意见会成为后续找爆点的依据。</p>
              )}
            </div>
          </div>
        </div>
        </div>

        {/*
         * 右栏：文字精修
         *
         * 与左边的画面并排。文案跟着播放头推进、正在念的字高亮，
         * 一边听一边看画面核对，删某个字时立刻知道删的是哪句。
         */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {packet && packet.segments.length > 0 ? (
            <TextCutter
              key={packet.roughcutPath || packet.projectId}
              segments={packet.segments}
              marks={textCuts}
              onChange={setTextCuts}
              onPreviewRange={(s) => seekTo(s.roughcutStartSec)}
              playTimeSec={playTime}
              onRequestPause={() => playback.current?.pause?.()}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-line">
              <p className="text-[12px] text-mut-2">这条粗剪没有可编辑的文案</p>
            </div>
          )}
        </div>

      {/*
       * 「确认通过」会丢掉待生效的文字删除 —— 必须问一句。
       *
       * 以前这里是 setTextCuts([]) 直接清空：底部说明写着"随打回一起生效"，
       * 而"确认通过"按钮就紧挨在"打回"旁边。一次误点，
       * 框了半天选中的字全部消失，界面一个字都没提。
       *
       * 两个出口都摆出来：改用打回让删除生效，或者明确放弃。
       */}
      {confirmApproveWithCuts > 0 && (
        <Modal
          title="确认通过会丢掉这些文字删除"
          subtitle={`你标记了 ${confirmApproveWithCuts} 处删除（共 ${textCuts.reduce((s, mk) => s + Math.max(0, mk.to - mk.from), 0)} 个字），但「确认通过」不重剪，这些删除不会生效`}
          onClose={() => setConfirmApproveWithCuts(0)}
          width="max-w-md"
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmApproveWithCuts(0)}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  // 先关掉再提交：否则 submit 的 finally 又去 setBusy，
                  // 与这里的 setState 打架
                  setConfirmApproveWithCuts(0);
                  void submit("recut");
                }}
                className="rounded-lg border border-ember/50 bg-ember/10 px-4 py-2 text-[12.5px] font-bold text-fg transition-colors hover:bg-ember/20"
              >
                改用「打回重剪」（删除会生效）
              </button>
              <button
                type="button"
                onClick={() => void submit("approve", true)}
                className="btn-flame rounded-lg px-4 py-2 text-[12.5px] font-bold text-white"
              >
                放弃删除，直接通过
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-relaxed text-mut">
            如果你是想保留这些删除，应该点「打回重剪」——删除会跟着进新工程。
            只有当你确认这一版就该原样通过时，才放弃它们。
          </p>
        </Modal>
      )}
    </Modal>
  );
}

function statusText(s: string): string {
  switch (s) {
    case "reviewing":
      return "待审";
    case "approved":
      return "已通过";
    case "superseded":
      return "已被打回重建";
    case "finished":
    case "exported":
      return "已成片";
    default:
      return s || "未知";
  }
}