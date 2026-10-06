/**
 * 导入页 —— 工作区空态
 * © 2026 郭洛斌
 *
 * 设计意图:把"开始干活"这件事压缩到最少动作。
 * 主路径只有一条:拖进来 / 点按钮选。其余(输出目录、引擎)就地和稀泥,
 * 不在首屏增加决策负担。
 */
import { useCallback, useState } from "react";
import { LuClock, LuFileVideo, LuFolderOpen, LuLayers, LuShieldCheck, LuSparkles } from "react-icons/lu";
import { call } from "../lib/bridge";
import { useSession } from "../stores/session-store";
import { HitVaultPanel } from "./HitVaultPanel";
import { IpPicker } from "./IpPicker";
import type { MediaFile } from "@shared/api-types";

const ACCEPT = ".mp4,.mkv,.mov,.flv,.webm,.avi,.mp3,.m4a,.wav";

const FILE_CHIPS = ["MP4", "MKV", "MOV", "FLV", "MP3", "M4A"];

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * 可接受的直播录像扩展名。
 * 必须和主进程 MEDIA_EXT（main/index.ts）保持一致 —— 两边不一致时会出现
 * "按钮选得到、拖进来却说格式不对"这种自相矛盾的情况。
 */
const VIDEO_SRC = ["mp4", "mkv", "mov", "flv", "webm", "avi", "m4v", "ts"];
const VIDEO_RE = new RegExp(`\\.(${VIDEO_SRC.join("|")})$`, "i");

export function ImportStage(): React.JSX.Element {
  const session = useSession();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 批量拖入时的说明(以前拖一堆进来毫无反馈,像坏了) */
  const [folderHint, setFolderHint] = useState<string | null>(null);
  /**
   * 选了哪位老师。null = 不指定(用通用记忆)。
   * 必须跟着素材一起送到 analyze,并由 Hermes 绑到 live_videos.collection 上 ——
   * 只在界面里记着没用:重开项目、换台机器、或者顺手切了IP,记忆就会变味。
   */
  const [collection, setCollection] = useState<string | null>(null);
/*
 * 双击某位 IP 打开 ta 的爆款记忆素材库。
 *
 * 爆款库面板原本只挂在 Workbench 上，而 Workbench 只在"已经有素材"时出现，
 * 于是"上传前想看看某位老师已经积累了什么"没有任何入口。
 * 这里自己持一份 state，按需盖一层，不依赖出片台。
 */
const [vaultIpId, setVaultIpId] = useState<string | null>(null);
  /** 导入后回显"这批绑给了谁",避免用户不确定 */
  const [boundTo, setBoundTo] = useState<string | null>(null);

  const importPath = useCallback(
    async (path: string): Promise<void> => {
      setBusy("正在读取媒体信息…");
      setError(null);
      try {
        const file = await call((api) => api.probeMedia(path));
        const name = path.split(/[\\/]/).pop() ?? path;
        session.setFile({ ...file, name } as MediaFile, collection ? { collection } : undefined);
        setBoundTo(collection);
        setBusy(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(null);
      }
    },
    [session, collection]
  );

  const pickFile = useCallback(async (): Promise<void> => {
    setError(null);
    const path = await call((api) => api.selectMedia());
    if (path) await importPath(path);
  }, [importPath]);

  /**
   * 重新打开历史项目。
   *
   * 必须走 projectOpen 拿检查点,而不是只重建素材:
   * 只重建素材的话,用户点开上次那条 4 条候选的项目,却要重跑一遍几十分钟的分析。
   */
  const reopen = useCallback(
    async (projectId: string): Promise<void> => {
      setError(null);
      setBusy("正在打开项目…");
      try {
        const opened = await call((api) => api.projectOpen(projectId));
        if (!opened?.project) {
          setError("这条项目已经不在了");
          setBusy(null);
          return;
        }
        const { project, checkpoint } = opened;
        if (checkpoint?.file) {
          // 有检查点:素材/逐句稿/候选/勾选/liveVideoId 全部恢复
          session.restore(checkpoint);
          session.setActiveProjectId(project.id);
          session.setLiveVideoId(checkpoint.liveVideoId ?? null);
          setBusy(null);
          return;
        }
        // 老项目只有索引:至少把素材显示出来,别让用户以为点了没反应
        const sourcePath = project.sourcePath;
        if (!sourcePath) {
          setError("这条项目没有记录素材路径");
          setBusy(null);
          return;
        }
        const probe = await call((api) => api.probeMedia(sourcePath));
        if (!probe || probe.durationSec <= 0) {
          setError(`素材读不出来了：${sourcePath}。可能已被移动或删除，重新导入一次即可。`);
          setBusy(null);
          return;
        }
        session.setFile({ ...probe, name: sourcePath.split(/[\\/]/).pop() ?? sourcePath });
        session.setActiveProjectId(project.id);
        setError(null);
        setBusy(null);
        setFolderHint(`已打开「${project.name}」。这条项目没保存分析结果，需要重新跑一次「找爆点」。`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(null);
      }
    },
    [session]
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="rise-in text-center">
        <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">把直播录像拖进来</h1>
        <p className="mt-2.5 text-[13px] leading-relaxed text-mut">
          转写、找爆点、切片成片都在本地完成。短片段用本地模型,
          <br className="hidden sm:block" />
          长直播自动切到长上下文引擎。
        </p>
      </div>

      {/* IP 选择放在拖拽区**上面**：先说清"这段素材归谁的记忆"，再让人拖文件。
          反过来的话，用户已经把素材交出去了才发现分析用的是别人的爆款库 ——
          而那个错不报错，只会让选出来的片段不对味。 */}
      <div className="mt-6 flex w-full justify-center">
        <IpPicker
        value={collection}
        onChange={setCollection}
        boundName={boundTo}
        onOpenVault={(ip) => setVaultIpId(ip.id)}
      />
      {vaultIpId && (
        <HitVaultPanel
          activeIpId={vaultIpId}
          onClose={() => setVaultIpId(null)}
          /*
           * 本页没有引擎设置面板（那需要 App 层的 engine 状态），
           * 如实说明，别做一个点了没反应的按钮。
           */
          onOpenSettings={() => setError("引擎设置在出片台右上角「引擎」里，本页暂不提供。")}
          onPickIp={async (ip) => {
            /*
             * 在库里换 IP 要同时更新这一页的 collection，
             * 否则用户在这里选了另一位老师、回到上传区还是用原来那位 ——
             * 两边显示不一致，而分析用的归属只有一份。
             */
            setCollection(ip.name);
            setVaultIpId(ip.id);
          }}
        />
      )}
      </div>

      <div
        className="drop-zone rise-in rise-in-1 mt-4 w-full max-w-2xl rounded-3xl p-3"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          // dropEffect 必须显式给,否则光标显示成"禁止"符号 ——
          // 用户会以为这个区域不能拖
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // Electron 32 起 File.path 已被移除,File 对象上没有磁盘路径。
          // 以前这里读 f.path,恒为 undefined,拖进来的文件全被过滤掉 ——
          // 表现为"拖了完全没反应",而且不报错最难查。
          // 唯一的正规途径是 webUtils.getPathForFile(必须经 preload)。
          const dropped = Array.from(e.dataTransfer.files)
            .map((f) => ({ file: f, path: window.studio?.pathForFile(f) ?? "" }))
            .filter((x) => x.path);
          if (dropped.length === 0) {
            setError("没读到拖入文件的路径。试试用「选择视频」按钮。");
            return;
          }
          const video = dropped.find((x) => VIDEO_RE.test(x.path));
          if (!video) {
            setError(
              `拖进来的 ${dropped.length} 个文件里没有视频（支持 ${[...VIDEO_SRC].join(" / ")}）`
            );
            return;
          }
          // 拖一堆视频进来时要给反馈,否则用户以为只处理了一个
          const videos = dropped.filter((x) => VIDEO_RE.test(x.path));
          setFolderHint(
            videos.length > 1 ? `检测到 ${videos.length} 个视频,已导入第一个。` : null
          );
          void importPath(video.path);
        }}
      >
        <div className="drop-zone-inner flex flex-col items-center rounded-2xl px-8 py-10">
          <div className="icon-tile float-y flex h-14 w-14 items-center justify-center rounded-2xl">
            <LuFileVideo className="h-7 w-7" />
          </div>
          <button
            type="button"
            onClick={() => void pickFile()}
            disabled={busy !== null}
            className="btn-flame mt-6 rounded-xl px-10 py-3 text-[15px] font-bold text-white disabled:opacity-50"
          >
            {busy ?? "选择视频文件"}
          </button>
          <p className="mt-3 text-[12.5px] text-mut/80">
            或直接拖拽到此处 · 可以一次拖一整个文件夹
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
            {FILE_CHIPS.map((chip) => (
              <span key={chip} className="chip rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide">
                {chip}
              </span>
            ))}
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-mut">
            <LuShieldCheck className="h-3.5 w-3.5 text-ok" />
            全程本地处理,不上传云端
          </p>
        </div>
      </div>

      <div className="rise-in rise-in-2 mt-6 flex w-full max-w-2xl flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void call((api) => api.selectOutDir()).then((dir) => dir && session.setOutDir(dir))}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
        >
          <LuFolderOpen className="h-3.5 w-3.5" />
          出片目录
          <span className="max-w-[180px] truncate font-mono text-[10.5px] opacity-70">
            {session.outDir ? session.outDir.split(/[\\/]/).slice(-2).join("/") : "…"}
          </span>
        </button>
        <span className="chip flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[11.5px]">
          <LuSparkles className="h-3.5 w-3.5" />
          引擎:自动(按内容形态分派)
        </span>
      </div>

      {folderHint && (
        <p role="status" className="pop-in mt-4 max-w-lg rounded-lg border border-info/25 bg-info/8 px-4 py-2.5 text-center text-[12px] text-info/90">
          {folderHint}
        </p>
      )}

      {error && (
        <p role="alert" className="pop-in mt-5 max-w-lg rounded-lg border border-bad/30 bg-bad/8 px-4 py-2.5 text-center text-[12.5px] text-bad">
          {error}
        </p>
      )}

      {session.file && (
        <p className="tabular mt-4 text-[11.5px] text-mut-2">
          已选:{session.file.name} · {formatDuration(session.file.durationSec)} · {formatSize(session.file.sizeBytes)}
          {session.file.hasVideo ? ` · ${session.file.width}×${session.file.height}` : ""}
        </p>
      )}

      {/* 最近项目
          这个区块之前完全不存在,导致历史项目无法访问:项目库入口只挂在工作台侧栏,
          而工作台必须先有素材才渲染 —— 没项目就打不开项目,死锁。
          首屏必须能直接回到上次的活。 */}
      {session.projects.length > 0 && (
        <section className="rise-in rise-in-3 mt-8 w-full max-w-2xl">
          <div className="mb-2.5 flex items-center gap-2">
            <LuLayers className="h-3.5 w-3.5 text-mut-2" />
            <h2 className="text-[12.5px] font-bold text-fg">最近项目</h2>
            <span className="tabular font-mono text-[10.5px] text-mut-2">
              {session.projects.length} 个
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {session.projects.slice(0, 5).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => void reopen(p.id)}
                  disabled={busy !== null}
                  title="打开这个项目，恢复当时的素材与爆点候选"
                  className="group flex w-full items-center gap-3 rounded-xl border border-line bg-panel-2/50 px-3.5 py-2.5 text-left transition-colors hover:border-ember/45 hover:bg-panel-2 disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-semibold text-fg/90">{p.name}</p>
                    <p className="tabular mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-mut-2">
                      <LuClock className="h-2.5 w-2.5" />
                      {relativeTime(p.lastOpenedAt || p.updatedAt)}
                      {p.hasTranscript && <span>· 有逐句稿</span>}
                      {p.candidateCount > 0 && <span>· {p.candidateCount} 条候选</span>}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] font-semibold text-mut-2 transition-colors group-hover:text-ember">
                    打开
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** 相对时间,比 ISO 时间戳友好 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}
