/**
 * 剪辑学习档案面板
 * © 2026 郭洛斌
 *
 * 展示"系统从你的剪辑里学到了什么" —— 每位 IP 老师一份。
 *
 * 为什么必须能看到：
 * 学习是隐式的，用户不知道系统在学什么，就没法纠正它。
 * 而且这里显示的都是**事实**（删过哪些开头、留过哪些内容、
 * 标题从什么改成什么），不做任何自动归纳 ——
 * 一旦让模型去编规律，用户就没法判断哪句是真的，档案就废了。
 *
 * 诚实优先：样本少的时候明确说"还很薄"，不假装学到了很多。
 */
import { useCallback, useEffect, useState } from "react";
import { LuFilePen, LuScissors, LuSparkles } from "react-icons/lu";
import type { EditArchive } from "@shared/api-types";
import { call } from "../lib/bridge";
import { cx } from "./ui";

interface Props {
  /** 当前选中的 IP 老师；null = 还没选 */
  collection: string | null;
}

const STAGE_TEXT: Record<EditArchive["stage"], string> = {
  empty: "还没有样本",
  thin: "样本还很少",
  warm: "已形成偏好",
  rich: "样本充足"
};

export function EditArchivePanel({ collection }: Props): React.JSX.Element {
  const [archive, setArchive] = useState<EditArchive | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (name: string): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      setArchive(await call((api) => api.editArchive(name)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setArchive(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!collection) {
      setArchive(null);
      return;
    }
    void load(collection);
  }, [collection, load]);

  if (!collection) {
    return (
      <p className="rounded-lg border border-line/70 px-2.5 py-2.5 text-[10.5px] leading-relaxed text-mut-2">
        先在左边选一位老师，这里会显示从她/他的剪辑里学到的东西。
      </p>
    );
  }

  if (loading) {
    return <div className="h-16 rounded-lg skeleton" />;
  }

  if (err) {
    return (
      <p className="rounded-lg border border-bad/40 bg-bad/8 px-2.5 py-2 text-[10.5px] leading-relaxed text-bad">
        读档案失败：{err}
        <br />
        剪辑本身不受影响，学习只是没记上。
      </p>
    );
  }

  // 后端对"完全没样本"的老师返回 null，不是空档案 ——
  // 区分"没数据"和"数据很少"很重要，不能都显示成 0
  if (!archive) {
    return (
      <div className="rounded-lg border border-dashed border-line px-2.5 py-3 text-[10.5px] leading-relaxed text-mut-2">
        还没有从「{collection}」的剪辑里学到东西。
        <br />
        在审阅台改标题、框选删字或剔除句子之后，这里就会出现内容。
      </div>
    );
  }

  const thin = archive.stage === "thin" || archive.stage === "empty";

  return (
    <div className="flex flex-col gap-2">
      {/* 概览 */}
      <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <LuSparkles className="h-3 w-3 text-ember" />
          <span className="text-[10.5px] font-bold text-fg">剪辑学习档案</span>
          <span
            className={cx(
              "tabular ml-auto rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold",
              thin ? "bg-warn/12 text-warn" : "bg-ok/12 text-ok"
            )}
          >
            {STAGE_TEXT[archive.stage]}
          </span>
        </div>
        <div className="tabular mt-1.5 grid grid-cols-4 gap-1 font-mono text-[10px] text-mut">
          <span>避雷 {archive.summary.cuts}</span>
          <span>保留 {archive.summary.keeps}</span>
          <span>段落 {archive.summary.segments}</span>
          <span>改标题 {archive.summary.titles}</span>
        </div>
        {thin && (
          <p className="mt-1 text-[9.5px] leading-relaxed text-mut-2">
            样本还少，现在只能看出个大概。多改几轮才会准。
          </p>
        )}
      </div>

      {/* 标题改写 —— 最直接的爆款感示范 */}
      {archive.titleEdits.length > 0 && (
        <Section title="标题怎么改的" hint="AI 原本起的 → 你改成什么">
          <ul className="flex flex-col gap-1">
            {archive.titleEdits.slice(0, 6).map((t, i) => (
              <li key={i} className="rounded border border-line/60 bg-panel/40 px-2 py-1">
                {t.oldTitle && (
                  <div className="truncate text-[10px] text-mut-2 line-through">{t.oldTitle}</div>
                )}
                <div className="truncate text-[10.5px] font-semibold text-fg">{t.newTitle}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 避雷：最常被删的开头 */}
      {archive.cutOpenings.length > 0 && (
        <Section title="反复删掉的开场" hint="下次分析会避开这类起手">
          <ul className="flex flex-wrap gap-1">
            {archive.cutOpenings.slice(0, 8).map((c, i) => (
              <li
                key={i}
                title={`删过 ${c.n} 次`}
                className="rounded bg-bad/10 px-1.5 py-0.5 text-[10px] text-bad"
              >
                <LuScissors className="mr-1 inline h-2.5 w-2.5 align-[-1px]" />
                {c.opening}
                <span className="tabular ml-1 font-mono opacity-70">{c.n}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 结构：哪段当开场、哪段是主体 */}
      {archive.roleOrder.length > 0 && (
        <Section title="认可的段落结构" hint="勾选保留的段，按评分排序">
          <ul className="flex flex-col gap-0.5">
            {archive.roleOrder.map((r, i) => (
              <li key={i} className="flex items-baseline gap-1.5 text-[10.5px]">
                <span className="font-semibold text-fg">{roleLabel(r.role)}</span>
                <span className="tabular font-mono text-mut-2">{r.n} 次</span>
                {r.avg_score != null && (
                  <span className="tabular ml-auto font-mono text-ember">
                    均分 {r.avg_score.toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 认可的 hook 主题 */}
      {archive.hookThemes.length > 0 && (
        <Section title="认可的开场主题" hint="被勾选最多的 hook 段落">
          <ul className="flex flex-col gap-0.5">
            {archive.hookThemes.slice(0, 5).map((t, i) => (
              <li key={i} className="flex items-baseline gap-1.5 text-[10.5px]">
                <span className="truncate text-fg/90">{t.theme_name}</span>
                <span className="tabular ml-auto shrink-0 font-mono text-mut-2">{t.n} 次</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 留下的内容形态 —— 正样本 */}
      {archive.keepSamples.length > 0 && (
        <Section title="留下的内容形态" hint="正样本：这类表达被认为有效">
          <ul className="flex flex-col gap-1">
            {archive.keepSamples.slice(0, 5).map((k, i) => (
              <li
                key={i}
                className="rounded border border-ok/30 bg-ok/6 px-2 py-1 text-[10.5px] leading-relaxed text-fg/85"
              >
                {k.text.slice(0, 60)}
                {k.text.length > 60 && <span className="text-mut-2">…</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-line/70 bg-panel-2/30 px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <LuFilePen className="h-2.5 w-2.5 text-mut-2" />
        <span className="text-[10px] font-bold text-mut">{title}</span>
        {hint && <span className="text-[9px] text-mut-2/80">{hint}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function roleLabel(role: string): string {
  if (role === "hook") return "开场钩子";
  if (role === "cta") return "收尾引导";
  if (role === "opening") return "开场";
  if (role === "body") return "内容主体";
  return role || "未分类";
}

export default EditArchivePanel;