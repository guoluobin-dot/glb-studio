/**
 * 出片产物面板
 *
 * 为什么单独做成组件:出片完成后,用户真正要做的三件事是
 * "看一遍成片 / 拿字幕 / 找到文件",而以前只有一行文字
 * "已输出 3 个文件" —— 既看不到是哪些文件,也不能直接打开。
 * 于是每次出片完都要再去资源管理器里翻一遍目录。
 */
import { useEffect, useState } from "react";
import { LuExternalLink, LuFileText, LuFilm, LuFolderOpen, LuImage, LuLoaderCircle, LuMapPin, LuX } from "react-icons/lu";
import { call } from "../lib/bridge";
import { PreviewPlayer } from "./PreviewPlayer";
import { Dot, Modal } from "./ui";

export interface ExportArtifacts {
  files: string[];
  outputDir: string;
}

/** 按扩展名分类,决定图标和能不能在应用内预览 */
function kindOf(p: string): "video" | "subtitle" | "image" | "other" {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm"].includes(ext)) return "video";
  if ([".srt", ".vtt", ".txt"].includes(ext)) return "subtitle";
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return "image";
  return "other";
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

function Icon({ kind }: { kind: ReturnType<typeof kindOf> }): React.JSX.Element {
  const cls = "h-3 w-3 shrink-0";
  if (kind === "video") return <LuFilm className={cls} />;
  if (kind === "subtitle") return <LuFileText className={cls} />;
  if (kind === "image") return <LuImage className={cls} />;
  return <span className="h-3 w-3 shrink-0 rounded-full bg-mut-2/50" />;
}

export function ResultList({
  artifacts,
  onClose
}: {
  artifacts: ExportArtifacts | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 换了产物就把上一次的预览和错误清掉,否则会停在一个已经不存在的文件上
  useEffect(() => {
    setPreview(null);
    setErr(null);
  }, [artifacts]);

  if (!artifacts || artifacts.files.length === 0) return null;

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(key);
    setErr(null);
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "打开失败");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const videos = artifacts.files.filter((f) => kindOf(f) === "video");
  const others = artifacts.files.filter((f) => kindOf(f) !== "video");

  return (
    <>
      <div className="rounded-xl border border-ok/30 bg-ok/6 p-2.5">
        <div className="flex items-center gap-1.5">
          <Dot tone="ok" />
          <span className="text-[11px] font-bold text-fg">出片完成</span>
          <span className="tabular ml-auto font-mono text-[10px] text-mut-2">
            {artifacts.files.length} 个文件
          </span>
          <button
            type="button"
            onClick={onClose}
            title="收起"
            className="rounded p-0.5 text-mut-2 transition-colors hover:text-fg"
          >
            <LuX className="h-3 w-3" />
          </button>
        </div>

        {/* 成片单独一组:这是用户真正会点开看的东西 */}
        {videos.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {videos.map((f) => (
              <li key={f}>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPreview(f)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-mut transition-colors hover:bg-ember/10 hover:text-ember"
                    title="在应用内预览"
                  >
                    <Icon kind="video" />
                    <span className="truncate">{baseName(f)}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy === f}
                    onClick={() => void run(f, () => call((a) => a.openResultExternal(f)))}
                    title="用系统播放器打开"
                    className="shrink-0 rounded p-1 text-mut-2 transition-colors hover:text-fg disabled:opacity-40"
                  >
                    {busy === f ? <LuLoaderCircle className="h-3 w-3 spin-slow" /> : <LuExternalLink className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    disabled={busy === `r${f}`}
                    onClick={() => void run(`r${f}`, () => call((a) => a.revealResult(f)))}
                    title="在资源管理器中定位"
                    className="shrink-0 rounded p-1 text-mut-2 transition-colors hover:text-fg disabled:opacity-40"
                  >
                    {busy === `r${f}` ? <LuLoaderCircle className="h-3 w-3 spin-slow" /> : <LuMapPin className="h-3 w-3" />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {others.length > 0 && (
          <ul className="mt-1 space-y-0.5 border-t border-line/60 pt-1.5">
            {others.map((f) => (
              <li key={f}>
                <div className="flex items-center gap-1.5">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-[10.5px] text-mut-2">
                    <Icon kind={kindOf(f)} />
                    <span className="truncate">{baseName(f)}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy === f}
                    onClick={() => void run(f, () => call((a) => a.revealResult(f)))}
                    title="在资源管理器中定位"
                    className="shrink-0 rounded p-1 text-mut-2 transition-colors hover:text-fg disabled:opacity-40"
                  >
                    {busy === f ? <LuLoaderCircle className="h-3 w-3 spin-slow" /> : <LuMapPin className="h-3 w-3" />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {artifacts.outputDir && (
          <button
            type="button"
            disabled={busy === "dir"}
            onClick={() => void run("dir", () => call((a) => a.openResultFolder(artifacts.outputDir)))}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[10.5px] font-semibold text-mut transition-colors hover:border-ember/50 hover:text-ember disabled:opacity-40"
          >
            {busy === "dir" ? <LuLoaderCircle className="h-3 w-3 spin-slow" /> : <LuFolderOpen className="h-3 w-3" />}
            打开输出文件夹
          </button>
        )}

        {err && <p className="mt-1.5 text-[10.5px] text-bad">{err}</p>}
      </div>

      {preview && (
        <Modal title="预览成片" subtitle={baseName(preview)} onClose={() => setPreview(null)} width="max-w-3xl">
          <PreviewPlayer filePath={preview} autoPlay heightClass="h-[52vh] min-h-[280px]" />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void run(preview, () => call((a) => a.openResultExternal(preview)))}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11px] font-semibold text-mut hover:text-fg"
            >
              <LuExternalLink className="h-3 w-3" />
              用系统播放器打开
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}