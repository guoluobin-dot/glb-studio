/**
 * 热词更正面板
 * © 2026 郭洛斌
 *
 * 「猪老师」→「朱老师」这类硬纠正，归档在 IP 老师名下。
 *
 * 设计上的三个取舍：
 *
 * 1. **必须显式归档**，不能只有"通用"。
 *    同一个词在不同老师的语境里正确写法可能不同
 *    （「中音」在一门课里是术语，在另一门里是错听）。
 *    混成通用规则会互相污染，而且用户根本不知道哪条规则在害他。
 *
 * 2. **命中次数要显示**。
 *    长期 0 次的规则是死规则（那个词已经不出现在直播里了）。
 *    不显示命中数，用户会攒下一堆无效规则还以为在生效。
 *
 * 3. **说明生效范围**，不夸大。
 *    已渲染好的成片文件不会变（文件已经写好了），
 *    下一条片子、以及重新出片会用纠正后的文本。
 *    说"立即全生效"会让用户以为旧片也变了，回头发现没变就是失信。
 */
import { useCallback, useEffect, useState } from "react";
import { LuCheck, LuPlus, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import type { HotwordRule } from "@shared/api-types";
import { call } from "../lib/bridge";
import { cx } from "./ui";

interface Props {
  /** 当前选中的 IP 老师；null = 还没选（只能编通用规则） */
  collection: string | null;
  /** 命中数统计用：把当前逐句稿传进来算 */
  sampleText?: string;
}

export function HotwordPanel({ collection, sampleText = "" }: Props): React.JSX.Element {
  const [rules, setRules] = useState<HotwordRule[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRules(await call((api) => api.listHotwords(collection ?? null)));
    } catch (err) {
      setMsg({ tone: "warn", text: `读热词失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }, [collection]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async (): Promise<void> => {
    if (!from.trim() || !to.trim()) {
      setMsg({ tone: "warn", text: "两个都要填" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await call((api) => api.addHotword({ collection: collection ?? null, from: from.trim(), to: to.trim() }));
      setMsg({
        tone: "ok",
        text: r.updated
          ? `已把「${from.trim()}」改成「${to.trim()}」（原来是别的写法，已覆盖）`
          : `已加上：「${from.trim()}」→「${to.trim()}」，立即生效`
      });
      setFrom("");
      setTo("");
      await load();
    } catch (err) {
      setMsg({ tone: "warn", text: `加失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }, [from, to, collection, load]);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      setBusy(true);
      try {
        await call((api) => api.removeHotword(id));
        await load();
      } catch (err) {
        setMsg({ tone: "warn", text: `删失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const hitsOf = useCallback(
    (w: string): number => (sampleText ? sampleText.split(w).length - 1 : 0),
    [sampleText]
  );

  return (
    <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <LuCheck className="h-2.5 w-2.5 text-ember" />
        <span className="text-[10px] font-bold text-mut">热词更正</span>
        <span className="text-[9px] text-mut-2/80">归档：{collection ?? "通用（对所有 IP 生效）"}</span>
      </div>

      {/* 加规则 */}
      <div className="mt-1.5 flex items-center gap-1">
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="听错的"
          className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-1 text-[10.5px] outline-none focus:border-ember/60"
        />
        <span className="shrink-0 text-[10px] text-mut-2">→</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="正确的"
          className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-1 text-[10.5px] outline-none focus:border-ember/60"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !from.trim() || !to.trim()}
          className="flex shrink-0 items-center gap-1 rounded border border-ember/50 bg-ember/10 px-2 py-1 text-[10.5px] font-bold text-ember transition-colors hover:bg-ember/20 disabled:opacity-40"
        >
          <LuPlus className="h-3 w-3" />
          加
        </button>
      </div>

      {msg && (
        <p className={cx("mt-1 text-[9.5px] leading-relaxed", msg.tone === "ok" ? "text-ok" : "text-warn")}>{msg.text}</p>
      )}

      {/* 规则列表 */}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {rules.length === 0 ? (
          <p className="text-[9.5px] text-mut-2">
            还没有热词规则。发现字幕里人名/术语听错了，就在这里改一下。
          </p>
        ) : (
          rules.map((r) => {
            const n = hitsOf(r.from);
            return (
              <div key={r.id} className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-panel/50">
                <span className="truncate text-[10.5px] text-mut-2 line-through">{r.from}</span>
                <span className="shrink-0 text-[10px] text-mut-2">→</span>
                <span className="truncate text-[10.5px] font-semibold text-fg">{r.to}</span>
                <span
                  className={cx(
                    "tabular ml-auto shrink-0 font-mono text-[9px]",
                    n > 0 ? "text-ember" : "text-mut-2/60"
                  )}
                  title={n > 0 ? "本场逐句稿里出现这么多次" : "本场逐句稿里没出现，可能已经不需要这条"}
                >
                  {sampleText ? `${n} 次` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(r.id)}
                  disabled={busy}
                  title="删掉这条规则"
                  className="shrink-0 rounded p-0.5 text-mut-2 opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
                >
                  <LuTrash2 className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* 生效范围：不夸大 */}
      <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-relaxed text-mut-2">
        <LuTriangleAlert className="mt-px h-2.5 w-2.5 shrink-0" />
        立即生效：逐句稿、审阅台文案、分析用的文案。字幕按新文本重出片即可；
        <strong className="font-semibold text-mut">已经渲染好的成片文件不会自动变</strong>。
      </p>
    </div>
  );
}

export default HotwordPanel;