import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LuCheck,
  LuImage,
  LuTrash2,
  LuUpload,
  LuUndo2,
  LuVideo,
  LuX
} from "react-icons/lu";
import { call } from "../lib/bridge";
import { cx } from "./ui";
import type { AssetItem } from "@shared/api-types";

/**
 * 素材库选择器（封面图 / 结尾藏带货共用一套逻辑，只是图标和文案不同）。
 *
 * 为什么做成"先入库、出片时再引用"而不是每次选完就完事:
 * 同一批候选常常要出三四版，每版都重选一次封面、重新指一次藏带货视频，
 * 几天下来就没人愿意用了。
 *
 * 预览用 glb-media:// 走主进程白名单取流 —— 不能直接读本地文件路径，
 * 渲染层在 contextIsolation 下拿不到 file://。
 */
export function AssetPicker({
  kind,
  title,
  hint,
  /** 当前选中的路径 */
  value,
  onChange,
  /** 缩略图尺寸 */
  compact = false
}: {
  kind: "covers" | "tails";
  title: string;
  hint: string;
  value?: string;
  onChange: (path: string | undefined) => void;
  compact?: boolean;
}): React.JSX.Element {
  const isCover = kind === "covers";
  const [items, setItems] = useState<AssetItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  /** 缩略图 URL，元素卸载时必须 mediaClose，否则白名单一直占着 */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setBusy("load");
    try {
      setItems(await call((api) => api.assetList(kind)));
      setMsg(null);
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  // 缩略图：逐个换成 glb-media:// URL
  useEffect(() => {
    let cancelled = false;
    const opened: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const it of items) {
        if (cancelled) break;
        try {
          const url = await call((api) => api.mediaOpen(it.path));
          opened.push(it.path);
          next[it.path] = url;
        } catch {
          // 单张预览失败不该让整个列表空掉
        }
      }
      if (!cancelled) setThumbs(next);
    })();
    return () => {
      cancelled = true;
      for (const p of opened) void call((api) => api.mediaClose(p)).catch(() => undefined);
    };
  }, [items]);

  const upload = async (): Promise<void> => {
    setBusy("import");
    setMsg(null);
    try {
      const r = await call((api) => api.assetImport(kind, true));
      await load();
      // 导入后自动选第一张：不然用户还要多点一次才看得见效果
      const firstNew = r.imported[0];
      if (firstNew && !value) onChange(firstNew.path);
      if (r.imported.length === 0 && r.errors.length === 0) {
        setMsg({ tone: "ok", text: r.skipped > 0 ? `已跳过 ${r.skipped} 个重复文件` : "没有导入任何文件" });
      } else if (r.errors.length > 0) {
        setMsg({ tone: "warn", text: `导入 ${r.imported.length} 个，失败 ${r.errors.length} 个：${r.errors[0]}` });
      }
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    setBusy("delete");
    setMsg(null);
    try {
      const r = await call((api) => api.assetDelete(kind, ids));
      // 删掉的正好在用的话要把选择清掉，否则出片时会去读一个不存在的文件
      if (value && ids.some((id) => items.find((x) => x.id === id)?.path === value)) {
        onChange(undefined);
      }
      setPicked(new Set());
      await load();
      if (r.errors.length > 0) setMsg({ tone: "warn", text: r.errors[0] ?? "部分素材删除失败" });
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (): Promise<void> => {
    setBusy("restore");
    try {
      const r = await call((api) => api.assetRestore(kind));
      await load();
      setMsg(
        r.restored > 0
          ? { tone: "ok", text: `已恢复 ${r.restored} 个` }
          : { tone: "warn", text: "没有可恢复的素材" }
      );
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allIds = useMemo(() => items.map((x) => x.id), [items]);
  const allPicked = allIds.length > 0 && picked.size === allIds.length;

  return (
    <div className="rounded-xl border border-line bg-panel-2/40 p-3">
      <div className="flex items-center gap-2">
        {isCover ? <LuImage className="h-3.5 w-3.5 shrink-0 text-mut-2" /> : <LuVideo className="h-3.5 w-3.5 shrink-0 text-mut-2" />}
        <span className="text-[12px] font-bold text-fg">{title}</span>
        <span className="truncate text-[10.5px] text-mut-2">{hint}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {items.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => void restore()}
                disabled={busy !== null}
                title="恢复最近一次删除"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-mut-2 transition-colors hover:text-ember disabled:opacity-40"
              >
                <LuUndo2 className="h-3 w-3" />
                恢复
              </button>
              <button
                type="button"
                onClick={() => setPicked(allPicked ? new Set() : new Set(allIds))}
                className="rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-mut-2 transition-colors hover:text-fg"
              >
                {allPicked ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                onClick={() => void remove([...picked])}
                disabled={picked.size === 0 || busy !== null}
                title={`删除选中的 ${picked.size} 个`}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-mut-2 transition-colors enabled:hover:text-bad disabled:opacity-30"
              >
                <LuTrash2 className="h-3 w-3" />
                删除{picked.size > 0 ? ` ${picked.size}` : ""}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void upload()}
            disabled={busy !== null}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] font-semibold text-mut transition-colors hover:border-ember/60 hover:text-ember disabled:opacity-40"
          >
            <LuUpload className="h-3 w-3" />
            {busy === "import" ? "导入中" : isCover ? "上传图片" : "上传视频"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={cx("mt-2 text-[10.5px]", msg.tone === "ok" ? "text-ok" : "text-warn")}>{msg.text}</div>
      )}

      {busy === "load" && items.length === 0 ? (
        <div className="mt-2 h-16 rounded-lg skeleton" />
      ) : items.length === 0 ? (
        <div className="mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-mut-2">
          还没有素材。点「{isCover ? "上传图片" : "上传视频"}」批量导入，可多选。
        </div>
      ) : (
        <div className={cx("mt-2 grid gap-2", compact ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-3 sm:grid-cols-5")}>
          {items.map((it) => {
            const on = value === it.path;
            const checked = picked.has(it.id);
            return (
              <div
                key={it.id}
                className={cx(
                  "group relative overflow-hidden rounded-lg border transition-colors",
                  on ? "border-ember/60 bg-ember/8" : "border-line hover:border-line/80"
                )}
              >
                {/* 勾选框：和"选用"分开。选用=出片用这张，勾选=批量管理时选中 */}
                <button
                  type="button"
                  onClick={() => toggle(it.id)}
                  title={checked ? "取消勾选" : "勾选（用于批量删除）"}
                  className={cx(
                    "absolute top-1 left-1 z-10 flex h-4 w-4 items-center justify-center rounded border transition-colors",
                    checked ? "border-ember bg-ember text-white" : "border-line bg-black/45 opacity-0 group-hover:opacity-100"
                  )}
                >
                  {checked && <LuCheck className="h-2.5 w-2.5" strokeWidth={4} />}
                </button>

                <button
                  type="button"
                  onClick={() => onChange(on ? undefined : it.path)}
                  title={on ? "取消选用" : "出片时用这张"}
                  className="block w-full"
                >
                  <div className={cx("w-full overflow-hidden bg-black/25", compact ? "h-14" : "h-20")}>
                    {thumbs[it.path] ? (
                      isCover ? (
                        <img src={thumbs[it.path]} alt={it.name} className="h-full w-full object-cover" />
                      ) : (
                        <video src={thumbs[it.path]} muted preload="metadata" className="h-full w-full object-cover" />
                      )
                    ) : (
                      <div className="flex h-full items-center justify-center text-mut-2">
                        {isCover ? <LuImage className="h-4 w-4" /> : <LuVideo className="h-4 w-4" />}
                      </div>
                    )}
                  </div>
                </button>

                {on && (
                  <span className="absolute top-1 right-1 rounded bg-ember px-1 py-0.5 text-[9px] font-bold text-white">
                    出片用
                  </span>
                )}

                <div className="flex items-center gap-1 px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] text-mut-2" title={it.name}>
                    {it.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove([it.id])}
                    title="删除"
                    className="shrink-0 text-mut-2 opacity-0 transition-colors group-hover:opacity-100 hover:text-bad"
                  >
                    <LuX className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
