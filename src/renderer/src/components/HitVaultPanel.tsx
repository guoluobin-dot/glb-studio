/**
 * 爆款记忆库面板
 *
 * 按你的要求做成"一个 IP 老师一个独立文件夹",并且全流程在界面上可操作:
 * 新建 / 重命名 / 删除(可撤销) / 从历史库同步 / 批量导入 / 按批撤回 / 单条删除 /
 * 看校准出来的爆款画像。
 *
 * 设计取舍:
 * - IP 列表在最左,选中后右侧显示该 IP 的爆款条目和画像 —— 用户的心智模型是
 *   "先选老师,再看他的爆款",不是"先看所有爆款再筛老师"。
 * - 撤回按"导入批次"而不是单条:一次同步 15 条,如果只能一条条删,
 *   同步错了要删 15 次。批次撤回是这里唯一符合直觉的粒度。
 * - 画像区把"这条结论来自哪几条爆款"直接摊开。没有这个,用户没法质疑画像,
 *   也就没法在画像跑偏时知道该删哪条样本。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
LuArchive, LuArrowLeft, LuBrain, LuCheck, LuCloudDownload, LuFilePlus2, LuFolderOpen,
LuLoaderCircle, LuRefreshCw, LuSettings, LuTrash2, LuUndo2, LuUsers, LuX
} from "react-icons/lu";
import type { HitCollection, HitEntry, HitProfile } from "@shared/api-types";
import { call } from "../lib/bridge";
import { formatDurationCN } from "../lib/format";
import { cx, Dot, Empty, Modal } from "./ui";
import { EditArchivePanel } from "./EditArchivePanel";
import { HitFeedbackDialog } from "./HitFeedbackDialog";

/*
 * 热词更正**不在这个面板里**。
 *
 * 它是干活时的工具，不是档案：用户正在看逐句稿、准备粗剪出片，
 * 看到错字当场改，改完这一片的文案与粗剪立刻用纠正后的文本。
 * 放在爆款记忆库里等于让人翻档案去改一个字，而且这里没有文案可对照，
 * 改完也看不出效果。
 *
 * 编辑入口已挪到出片台的逐句稿正下方（Workbench 里挂 HotwordPanel）。
 * 归档仍然按 IP 老师写在 Hermes 侧 hotwords.collection，
 * 所以"下次再出现同样的错字自动更正"这个记忆能力一点没丢 ——
 * 挪的只是入口，记忆与自动套用照旧。
 */

interface Props {
  onClose: () => void;
  /** 跳设置（引擎 / 分析引擎 / Gemini key 都在那边） */
  onOpenSettings?: () => void;
  /** 关掉面板时通知上层,方便上层把"用哪套记忆"的选择带进分析/出片 */
  onPickIp?: (ip: HitCollection) => void;
  /** 上层当前选中的 IP(通常是上次用的那套记忆) */
  activeIpId?: string | null;
}

type Busy = null | "sync" | "load" | "create" | "delete" | "undo" | "files";

export function HitVaultPanel({ onClose, onOpenSettings, onPickIp, activeIpId }: Props): React.JSX.Element {
  const [ips, setIps] = useState<HitCollection[]>([]);
  const [current, setCurrent] = useState<string | null>(activeIpId ?? null);
  const [entries, setEntries] = useState<HitEntry[]>([]);
  const [profile, setProfile] = useState<HitProfile | null>(null);
  const [batches, setBatches] = useState<Array<{ batchId: string; count: number; at: string; sample: string }>>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // 新建/重命名用的输入框
  const [draft, setDraft] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  /** 正在提交截图更正的那一条 */
  const [feedbackFor, setFeedbackFor] = useState<HitEntry | null>(null);

/** 大数字缩写：12345 -> 1.2万，界面里 8 位数会把整行挤爆 */
function formatCount(n?: number | null): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(Math.round(v));
}

/**
 * 有没有真实回流数据。
 *
 * 必须四个字段全为 0 之外才算"有" ——
 * Hermes 侧没数据时给的是 null 而不是 0，
 * 如果用 `!== undefined` 判断，null 会被算成有数据，
 * 于是界面显示"实际 0 播放"，看着像这条视频没人看。
 */
function hasRealPerformance(e: HitEntry): boolean {
  const m = e.metrics ?? {};
  return [m.views, m.likes, m.shares, m.comments].some((x) => Number.isFinite(Number(x)) && Number(x) > 0);
}

  const loadIps = useCallback(async (): Promise<void> => {
    const list = await call((api) => api.hitListIps());
    setIps(list);
    // 默认选第一个:只有一位老师时不该逼用户先点一次
    setCurrent((prev) => (prev && list.some((i) => i.id === prev) ? prev : list[0]?.id ?? null));
  }, []);

  const loadIp = useCallback(async (ipId: string | null): Promise<void> => {
    if (!ipId) {
      setEntries([]);
      setProfile(null);
      setBatches([]);
      return;
    }
    setBusy("load");
    try {
      const [e, p, b] = await Promise.all([
        call((api) => api.hitListEntries(ipId)),
        call((api) => api.hitProfile(ipId)),
        call((api) => api.hitListBatches(ipId))
      ]);
      setEntries(e);
      setProfile(p);
      setBatches(b);
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadIps();
  }, [loadIps]);
  useEffect(() => {
    void loadIp(current);
  }, [current, loadIp]);

  const ip = useMemo(() => ips.find((i) => i.id === current) ?? null, [ips, current]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await loadIps();
    await loadIp(current);
  }, [loadIps, loadIp, current]);

  /* ---------------- IP 档案操作 ---------------- */

  const submitDraft = async (): Promise<void> => {
    const name = draftName.trim();
    if (!name || draft === null) return;
    setBusy(draft === "create" ? "create" : null);
    try {
      if (draft === "create") {
        const made = await call((api) => api.hitCreateIp(name));
        if (!made) {
          setMsg({ tone: "warn", text: `「${name}」已存在(同名文件夹会抢同一套记忆)` });
          return;
        }
        setCurrent(made.id);
        // Hermes 侧没建成功必须说，不能报"已建好"了事：
        // 本地文件夹在，但学习样本会按"没有归属"落库，
        // 之后这位老师的记忆会一直是空的，而且没有任何报错提示。
        if (made.hermesSynced) {
          setMsg({ tone: "ok", text: `已创建「${name}」,独立文件夹和记忆库都已建好` });
        } else {
          setMsg({
            tone: "warn",
            text: `「${name}」的文件夹建好了,但记忆库没建成功(${made.hermesError ?? "原因不明"})。`
              + `这位老师的样本暂时存不下,稍后可在"从历史爆款库同步"里补上。`
          });
        }
      } else if (draft === "rename") {
        const renamed = await call((api) => api.hitRenameIp(current!, name));
        if (!renamed) {
          setMsg({ tone: "warn", text: "改名失败:可能与已有 IP 重名" });
          return;
        }
        setMsg({ tone: "ok", text: `已改名为「${name}」` });
      }
      setDraft(null);
      setDraftName("");
      await loadIps();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const removeIp = async (): Promise<void> => {
    if (!ip) return;
    setBusy("delete");
    try {
      // 先进回收站,不给用户一个不可逆的按钮
      await call((api) => api.hitDeleteIp(ip.id, true));
      setMsg({ tone: "ok", text: `已删除「${ip.name}」,可用「恢复误删」找回` });
      setCurrent(null);
      await loadIps();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const restoreIp = async (): Promise<void> => {
    setBusy("delete");
    try {
      const back = await call((api) => api.hitRestoreIp());
      if (!back) {
        setMsg({ tone: "warn", text: "没有可恢复的 IP" });
        return;
      }
      setCurrent(back.id);
      setMsg({ tone: "ok", text: `已恢复「${back.name}」` });
      await loadIps();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- 导入 / 撤回 ---------------- */

  const syncFromHermes = async (): Promise<void> => {
    setBusy("sync");
    setMsg(null);
    try {
      const r = await call((api) => api.hitSyncFromHermes());
      if (!r.ok && r.imported === 0) {
        setMsg({ tone: "warn", text: r.errors[0] ?? "同步失败" });
        return;
      }
      const parts = [`导入 ${r.imported} 条`];
      if (r.skipped > 0) parts.push(`跳过已存在 ${r.skipped} 条`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} 条失败`);
      setMsg({ tone: r.errors.length > 0 ? "warn" : "ok", text: parts.join(",") });
      await refreshAll();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const importFiles = async (): Promise<void> => {
    if (!current) return;
    setBusy("files");
    try {
      const r = await call((api) => api.hitImportFiles(current, false));
      if (r.attached.length === 0 && r.errors.length > 0) {
        setMsg({ tone: "warn", text: r.errors[0] ?? "导入失败" });
        return;
      }

      /*
       * 登记 ≠ 学进去。以前这里只报"已登记 N 个素材"就完事，
       * 而登记既不触发分析也不生成条目 —— 用户以为已经学进去了。
       * 现在把 Hermes 那边到底排没排上、为什么没排上，如实说清楚。
       */
      const enq = r.enqueue;
      if (!enq) {
        setMsg({ tone: "warn", text: `已登记 ${r.attached.length} 个素材，但没有排进分析队列，学不进爆款感` });
      } else if (enq.error) {
        setMsg({
          tone: "warn",
          text: `已登记 ${r.attached.length} 个素材，但排进 Hermes 分析队列失败(${enq.error})，`
            + `这些素材暂时学不进爆款感。确认 Hermes 在运行后重试。`
        });
      } else if (enq.queued === 0) {
        const why = enq.rejected[0]?.reason ?? "原因不明";
        setMsg({ tone: "warn", text: `${r.attached.length} 个素材都没排上：${why}` });
      } else {
        const bad = enq.rejected.length
          ? `，${enq.rejected.length} 个没排上（${enq.rejected[0]?.reason ?? ""}）`
          : "";
        setMsg({
          tone: "ok",
          text: `已登记 ${r.attached.length} 个素材，其中 ${enq.queued} 个已进入 Hermes 分析队列${bad}。`
            + `分析在空闲时自动跑，完成后点「从历史爆款库同步」入库，爆款感才会叠加更新。`
        });
      }
      await refreshAll();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const undoBatch = async (batchId: string): Promise<void> => {
    if (!current) return;
    setBusy("undo");
    try {
      const r = await call((api) => api.hitUndoBatch(current, batchId));
      if (!r.ok) {
        setMsg({ tone: "warn", text: r.error ?? "撤回失败" });
        return;
      }
      setMsg({ tone: "ok", text: `已撤回 ${r.removed} 条,画像已重新校准` });
      await refreshAll();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const removeEntry = async (entryId: string, title: string): Promise<void> => {
    if (!current) return;
    try {
      await call((api) => api.hitDeleteEntry(current, entryId));
      setMsg({ tone: "ok", text: `已删除「${title}」,画像已重新校准` });
      await refreshAll();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Modal
      title="爆款记忆库"
      subtitle="每个 IP 老师一个独立文件夹 · 新增爆款会叠加校准"
      onClose={onClose}
      width="max-w-5xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-mut-2">
            {ips.length > 0
              ? `${ips.length} 位老师 · ${ips.reduce((s, i) => s + i.entryCount, 0)} 条爆款`
              : "还没有 IP 档案"}
          </span>
          <div className="flex items-center gap-2">
            {/*
             * 回主界面 + 去设置。
             *
             * 之前这个弹窗只有右上角一个 X 和点遮罩关闭，
             * 打开设置只能：关掉弹窗 → 在左侧导航找设置 → 再打开素材。
             * 而"爆款库 → 设置"是很自然的一跳（引擎、分析引擎、Gemini key 都在那）。
             * 用户反馈"没有返回主界面的功能或设置"，所以显式补上两个出口。
             */}
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11.5px] font-semibold text-mut transition-colors hover:border-ember/50 hover:text-ember"
            >
              <LuArrowLeft className="h-3.5 w-3.5" />
              返回主界面
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11.5px] font-semibold text-mut transition-colors hover:border-ember/50 hover:text-ember"
            >
              <LuSettings className="h-3.5 w-3.5" />
              设置
            </button>
            <button
              type="button"
              onClick={restoreIp}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11.5px] font-semibold text-mut transition-colors hover:text-fg disabled:opacity-40"
            >
              <LuUndo2 className="h-3.5 w-3.5" />
              恢复误删
            </button>
            <button
              type="button"
              onClick={() => void syncFromHermes()}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-lg border border-ember/50 bg-ember/10 px-3.5 py-2 text-[11.5px] font-bold text-ember transition-colors hover:bg-ember/20 disabled:opacity-40"
            >
              {busy === "sync" ? <LuLoaderCircle className="h-3.5 w-3.5 spin-slow" /> : <LuCloudDownload className="h-3.5 w-3.5" />}
              从历史爆款库同步
            </button>
          </div>
        </div>
      }
    >
      <div className="flex min-h-[420px] gap-3">
        {/* ---------- 左:IP 档案 ---------- */}
        <div className="flex w-56 shrink-0 flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[1.2px] text-mut-2">
            <LuUsers className="h-3 w-3" />
            IP 老师
          </div>

          <div className="flex flex-col gap-1 overflow-y-auto">
            {ips.length === 0 && (
              <p className="rounded-lg border border-line/70 px-2.5 py-3 text-[11px] leading-relaxed text-mut-2">
                还没有 IP 档案。先新建一位,或直接「从历史爆款库同步」按集合自动建。
              </p>
            )}
            {ips.map((x) => {
              const on = x.id === current;
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setCurrent(x.id)}
                  className={cx(
                    "rounded-lg border px-2.5 py-2 text-left transition-colors",
                    on ? "border-ember/45 bg-ember/8" : "border-line hover:border-line/80 hover:bg-panel-2/50"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Dot tone={x.entryCount > 0 ? "ok" : "idle"} />
                    <span className={cx("truncate text-[12px] font-bold", on ? "text-fg" : "text-mut")}>
                      {x.name}
                    </span>
                    {on && onPickIp && <LuCheck className="ml-auto h-3 w-3 shrink-0 text-ember" strokeWidth={3} />}
                  </div>
                  <div className="mt-0.5 pl-3 text-[10px] text-mut-2">
                    {x.entryCount} 条 · {x.totalSec > 0 ? formatDurationCN(x.totalSec) : "0s"}
                  </div>
                </button>
              );
            })}
          </div>

          {/* IP 操作 */}
          <div className="mt-auto flex flex-wrap gap-1.5 border-t border-line/60 pt-2">
            <button
              type="button"
              onClick={() => {
                setDraft("create");
                setDraftName("");
              }}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut transition-colors hover:text-fg"
            >
              <LuFilePlus2 className="h-3 w-3" />
              新建
            </button>
            <button
              type="button"
              disabled={!ip}
              onClick={() => {
                setDraft("rename");
                setDraftName(ip?.name ?? "");
              }}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut transition-colors hover:text-fg disabled:opacity-35"
            >
              重命名
            </button>
            <button
              type="button"
              disabled={!ip || busy !== null}
              onClick={() => void removeIp()}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut transition-colors hover:border-bad/50 hover:text-bad disabled:opacity-35"
            >
              <LuTrash2 className="h-3 w-3" />
              删除
            </button>
          </div>
        </div>

        {/* ---------- 中:爆款条目 ---------- */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {draft !== null && (
            <div className="flex items-center gap-2 rounded-lg border border-ember/40 bg-ember/8 px-2.5 py-2">
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitDraft();
                  if (e.key === "Escape") setDraft(null);
                }}
                placeholder="IP 名字(比如:案例老师)"
                className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
              />
              <button
                type="button"
                onClick={() => void submitDraft()}
                disabled={busy !== null || !draftName.trim()}
                className="rounded bg-ember px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
              >
                {draft === "create" ? "创建" : "保存"}
              </button>
              <button type="button" onClick={() => setDraft(null)} className="rounded p-1 text-mut-2 hover:text-fg">
                <LuX className="h-3 w-3" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[1.2px] text-mut-2">
            <LuArchive className="h-3 w-3" />
            爆款条目
            {entries.length > 0 && <span className="tabular font-mono">({entries.length})</span>}
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                disabled={!current || busy !== null}
                onClick={() => void importFiles()}
                className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10.5px] font-semibold text-mut hover:text-fg disabled:opacity-35"
              >
                {busy === "files" ? <LuLoaderCircle className="h-3 w-3 spin-slow" /> : <LuFolderOpen className="h-3 w-3" />}
                批量导入
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void refreshAll()}
                className="rounded border border-line p-1 text-mut-2 hover:text-fg disabled:opacity-35"
                title="刷新"
              >
                <LuRefreshCw className={cx("h-3 w-3", busy === "load" && "spin-slow")} />
              </button>
            </div>
          </div>

          {/* 撤回入口:按批次 */}
          {batches.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line/70 bg-panel-2/40 px-2 py-1.5">
              <span className="text-[10px] text-mut-2">导入批次:</span>
              {batches.slice(0, 4).map((b) => (
                <button
                  key={b.batchId}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void undoBatch(b.batchId)}
                  title={`撤回这批 ${b.count} 条:包含「${b.sample}」`}
                  className="flex items-center gap-1 rounded border border-line bg-panel px-1.5 py-0.5 text-[10px] text-mut transition-colors hover:border-warn/60 hover:text-warn disabled:opacity-35"
                >
                  <LuUndo2 className="h-2.5 w-2.5" />
                  {b.count} 条 · {b.sample.slice(0, 10)}
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <Empty
                title={ip ? `「${ip.name}」还没有爆款` : "先选一位老师"}
                hint={ip ? "点右下「从历史爆款库同步」,或用「批量导入」登记本地素材。" : undefined}
                icon={<LuBrain className="h-6 w-6" />}
              />
            ) : (
              <ul className="flex flex-col gap-1">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="group flex items-start gap-2 rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-1.5 transition-colors hover:border-line"
                  >
<div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11.5px] font-semibold text-fg">{e.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-mut-2">
                <span className="tabular font-mono">{e.totalSec.toFixed(0)}s</span>
                {e.genre && <span>{e.genre}</span>}
                <span>{e.segments.length} 段结构</span>
                {(e.themes?.length ?? 0) > 0 && <span>{e.themes!.length} 主题</span>}
                {e.hooks.length > 0 && <span className="truncate">钩子:{(e.hooks[0] ?? "").slice(0, 18)}</span>}
              </div>
            </div>

            {/*
             * 爆款预测。
             *
             * 只在有预测时显示，且**明确标出这是估的**：
             * 预测和下面"真实回流数据"是两回事，
             * 混在一起用户会当参考，实际是模型猜的。
             *
             * 没有预测时不留空位 —— 那说明这条还没算过，
             * 显示"暂无预测"比空白更让人知道下一步该做什么。
             */}
            {e.prediction?.viewsLow != null && (
              <button
                type="button"
                onClick={() => setFeedbackFor(e)}
                title={e.prediction.rationale || "爆款预测（模型估算，点这里上传截图更正）"}
                className="shrink-0 rounded-md border border-line/70 px-1.5 py-1 text-left transition-colors hover:border-ember/45 hover:bg-panel-2/50"
              >
                <div className="flex items-center gap-1 text-[9px] font-bold text-mut-2">
                  预测
                  <span
                    className={cx(
                      "rounded px-1 font-semibold",
                      e.prediction.confidence === "高"
                        ? "text-ok"
                        : e.prediction.confidence === "中"
                          ? "text-warn"
                          : "text-mut-2"
                    )}
                  >
                    把握{e.prediction.confidence || "低"}
                  </span>
                </div>
                <div className="tabular font-mono text-[11px] font-bold text-fg">
                  {formatCount(e.prediction.viewsLow)}~{formatCount(e.prediction.viewsHigh)}
                </div>
              </button>
            )}
          </div>

          {/* 真实回流数据：预测的对照物。会和预测一起长出来，所以放同一行 */}
          {hasRealPerformance(e) && (
            <div className="tabular mt-1 flex flex-wrap gap-x-2.5 font-mono text-[9.5px] text-ok/85">
              <span>实际 {formatCount(e.metrics.views)} 播放</span>
              <span>赞 {formatCount(e.metrics.likes)}</span>
              <span>评 {formatCount(e.metrics.comments)}</span>
            </div>
          )}
        </div>
                    <button
                      type="button"
                      onClick={() => void removeEntry(e.id, e.title)}
                      title="从库里移除(会重新校准画像)"
                      className="shrink-0 rounded p-1 text-mut-2 opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
                    >
                      <LuTrash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ---------- 右:校准画像 ---------- */}
        <div className="flex w-64 shrink-0 flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[1.2px] text-mut-2">
            <LuBrain className="h-3 w-3" />
            爆款感画像
          </div>

          <EditArchivePanel collection={ip?.name ?? null} />

          {!profile || profile.sampleCount === 0 ? (
            <p className="rounded-lg border border-line/70 px-2.5 py-3 text-[10.5px] leading-relaxed text-mut-2">
              样本不足,还不能校准。每新增一条爆款,这里的基准会按中位数重算。
            </p>
          ) : (
            <div className="flex flex-col gap-2 overflow-y-auto">
              <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
                <div className="text-[10px] text-mut-2">样本量</div>
                <div className="tabular mt-0.5 font-mono text-[13px] font-bold text-fg">
                  {profile.sampleCount} 条
                </div>
                <p className="mt-1 text-[9.5px] leading-relaxed text-mut-2">
                  全部取<strong className="text-mut">中位数</strong>,单条异常值不会带偏基准。
                </p>
              </div>

              {profile.dimensions.length > 0 && (
                <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
                  <div className="mb-1.5 text-[10px] font-bold text-mut">特征基准</div>
                  <ul className="flex flex-col gap-1.5">
                    {profile.dimensions.map((d) => (
                      <li key={d.key} title={`来自:${d.contributing.join(" / ")}`}>
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10.5px] text-mut">{d.label}</span>
                          <span className="tabular ml-auto font-mono text-[11px] font-bold text-ember">
                            {d.value}
                          </span>
                        </div>
                        {/* 相对最强维度的条形,让"哪一维突出"一眼可见 */}
                        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line/50">
                          <div
                            className="h-full rounded-full bg-ember/55"
                            style={{
                              width: `${Math.max(
                                4,
                                Math.min(
                                  100,
                                  (d.value / Math.max(...profile.dimensions.map((x) => Math.abs(x.value) || 1))) * 100
                                )
                              )}%`
                            }}
                          />
                        </div>
                        <div className="mt-0.5 truncate text-[9px] text-mut-2/70">{d.contributing[0] ?? ""}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {profile.topHooks.length > 0 && (
                <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
                  <div className="mb-1 text-[10px] font-bold text-mut">高频钩子句式</div>
                  <ul className="flex flex-col gap-0.5">
                    {profile.topHooks.slice(0, 4).map((h, i) => (
                      <li key={i} className="truncate text-[10px] text-mut-2" title={h}>
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {profile.topThemes.length > 0 && (
                <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
                  <div className="mb-1 text-[10px] font-bold text-mut">高频主题</div>
                  <div className="flex flex-wrap gap-1">
                    {profile.topThemes.slice(0, 8).map((t) => (
                      <span key={t} className="rounded bg-panel px-1.5 py-0.5 text-[9.5px] text-mut-2">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[9.5px] leading-relaxed text-mut-2/70">
                画像由样本反推,不是行业经验值。新增爆款会自动叠加校准;删掉某条它的贡献也会一起撤回。
              </p>
            </div>
          )}

          {ip && onPickIp && (
            <button
              type="button"
              onClick={() => onPickIp(ip)}
              className="mt-auto flex items-center justify-center gap-1.5 rounded-lg border border-ember/50 bg-ember/10 px-2 py-2 text-[11px] font-bold text-ember transition-colors hover:bg-ember/20"
            >
              <LuCheck className="h-3.5 w-3.5" />
              用这套记忆
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div
          role="status"
          className={cx(
            "mt-3 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed",
            msg.tone === "ok" ? "border-ok/30 bg-ok/8 text-ok/90" : "border-warn/30 bg-warn/8 text-warn"
          )}
        >
          {msg.text}
        </div>
      )}

      {/*
       * 截图更正弹窗放在爆款库面板内部（而不是提到 Workbench）：
       * 它要读这里的 entries、current、msg，提到上层就得把三样都传出去。
       * Modal 本身是 fixed 定位的，面板关掉时一起消失，不会留孤儿弹窗。
       */}
      {feedbackFor && (
        <HitFeedbackDialog
          entry={feedbackFor}
          ipName={ip?.name ?? ""}
          onClose={() => setFeedbackFor(null)}
          onDone={async (m) => {
            setMsg(m);
            // 预测已被 Hermes 重算，必须重新读一次条目，
            // 否则界面还显示更正前的数字 —— 用户会以为没生效
            await refreshAll();
          }}
        />
      )}
    </Modal>
  );
}
