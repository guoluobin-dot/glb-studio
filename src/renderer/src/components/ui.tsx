/**
 * 通用 UI 原语
 * © 2026 郭洛斌
 */
import { useEffect, useRef, type ReactNode } from "react";
import { LuX } from "react-icons/lu";

/** 弹层容器:portal 到 body,避免祖先 transform 劫持 fixed 定位。 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "max-w-lg",
  /**
   * 主体要不要整块滚动。
   *
   * 默认 true（弹层内容长时整体滚）。
   * 审片台要设成 false：那里是"左视频 + 右文案"两栏并排，
   * 每栏自己滚。如果还让主体整体滚，右栏文案会连着视频一起滚走 ——
   * 边读文案边核对画面这个基本操作就没法做了。
   */
  bodyScroll = true
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  bodyScroll?: boolean;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`pop-in flex max-h-[86vh] w-full ${width} flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line/70 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-extrabold">{title}</h2>
            {subtitle && <p className="mt-1 text-[12px] leading-relaxed text-mut">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuX className="h-3.5 w-3.5" />
          </button>
        </header>
        <div
          className={
            bodyScroll
              ? "scroll-thin min-h-0 flex-1 overflow-y-auto p-5"
              : "flex min-h-0 flex-1 gap-4 overflow-hidden p-4"
          }
        >
          {children}
        </div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line/70 p-4">{footer}</footer>}
      </div>
    </div>
  );
}

/** 状态点:运行中用呼吸动画。 */
export function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "busy" | "idle" }): React.JSX.Element {
  const cls =
    tone === "ok"
      ? "bg-ok"
      : tone === "warn"
        ? "bg-warn"
        : tone === "bad"
          ? "bg-bad"
          : tone === "busy"
            ? "bg-ember breathe"
            : "bg-mut-2/50";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

/** 空态占位。 */
export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon && <div className="text-mut-2">{icon}</div>}
      <p className="text-[13px] font-semibold text-mut">{title}</p>
      {hint && <p className="max-w-sm text-[11.5px] leading-relaxed text-mut-2">{hint}</p>}
    </div>
  );
}

/** 进度条:percent 为 null 时显示不确定态。 */
export function Progress({ percent, label }: { percent: number | null; label?: string }): React.JSX.Element {
  return (
    <div className="w-full">
      {label && (
        <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
          <span className="text-mut">{label}</span>
          {percent !== null && <span className="tabular font-mono text-fg/80">{Math.round(percent)}%</span>}
        </div>
      )}
      <div className="h-1.5 overflow-hidden rounded-full bg-line/70">
        {percent === null ? (
          <div className="progress-indeterminate h-full w-1/3 rounded-full flame-gradient" />
        ) : (
          <div
            className="h-full rounded-full flame-gradient transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** 工具类:合并 className。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
