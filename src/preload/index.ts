/**
 * 预加载桥:渲染层与主进程之间唯一的通道。
 * 渲染层运行在 contextIsolation 下,只能看到这里显式暴露的方法。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AssetDeleteResult,
  AssetImportResult,
  AssetItem,
  AssetRestoreResult,
  ClipCandidate,
  DetectionRequest,
  EngineSettings,
  EngineSettingsSaveResult,
  EngineTestResult,
  ExportProgress,
  ExportRequest,
  ExportResult,
  HitAttachResult,
  HitCollection,
  TrashItem,
  HitEntry,
  HitImportResult,
  HitProfile,
  MediaFile,
  MediaProbe,
  ProjectSummary,
  ProjectWorkspace,
  ReviewPacket,
  SessionCheckpoint,
  StudioApi,
  Transcript,
  EditArchive,
  EditArchiveListItem,
  EditRecordInput,
  HotwordRule
} from "@shared/api-types";
import { applyHotwordsToTranscript as applyTranscript } from "@shared/hotwords";

const api: StudioApi = {
  /**
   * 拖进来的文件取真实磁盘路径。
   *
   * Electron 32 起移除了 File.path,File 对象上再没有路径 —— 旧代码
   * `f.path` 恒为 undefined,拖拽分支第一步就被过滤空,表现为"拖进来完全没反应"。
   * 现在唯一的正规途径是 webUtils.getPathForFile,且必须在 preload 里调用。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  assetList: (kind) => ipcRenderer.invoke("asset:list", kind) as Promise<AssetItem[]>,
  assetImport: (kind, copy) => ipcRenderer.invoke("asset:import", kind, copy) as Promise<AssetImportResult>,
  assetDelete: (kind, ids) => ipcRenderer.invoke("asset:delete", kind, ids) as Promise<AssetDeleteResult>,
  assetRestore: (kind) => ipcRenderer.invoke("asset:restore", kind) as Promise<AssetRestoreResult>,
  assetPick: (kind, usePath, pick) => ipcRenderer.invoke("asset:pick", kind, usePath, pick) as Promise<AssetItem | null>,

  selectMedia: () => ipcRenderer.invoke("media:select") as Promise<string | null>,  probeMedia: (path) => ipcRenderer.invoke("media:probe", path) as Promise<MediaProbe>,
  listMedia: (dir) => ipcRenderer.invoke("media:list", dir) as Promise<MediaFile[]>,
  defaultOutDir: () => ipcRenderer.invoke("outdir:default") as Promise<string>,
  selectOutDir: () => ipcRenderer.invoke("outdir:select") as Promise<string | null>,
  /** 选 BGM 音频文件 */
  selectAudio: () => ipcRenderer.invoke("audio:select") as Promise<string | null>,

  projectWorkspaceGet: () => ipcRenderer.invoke("project:workspace") as Promise<ProjectWorkspace>,
  projectCreate: (checkpoint) => ipcRenderer.invoke("project:create", checkpoint) as Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint } | null>,
  projectOpen: (id) => ipcRenderer.invoke("project:open", id) as Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint | null } | null>,
  projectClose: () => ipcRenderer.invoke("project:close") as Promise<void>,
  projectSave: (id, checkpoint) => ipcRenderer.invoke("project:save", id, checkpoint) as Promise<boolean>,
  projectDelete: (id) => ipcRenderer.invoke("project:delete", id) as Promise<boolean>,
  projectRename: (id, name) => ipcRenderer.invoke("project:rename", id, name) as Promise<ProjectSummary | null>,
  projectRelink: (id, path) => ipcRenderer.invoke("project:relink", id, path) as Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint } | null>,

  transcribe: (filePath) => ipcRenderer.invoke("algo:transcribe", filePath) as Promise<Transcript>,
  detect: (request_: DetectionRequest) =>
    ipcRenderer.invoke("algo:detect", request_) as Promise<{
      liveVideoId: number | null;
      candidates: ClipCandidate[];
      stats: import("@shared/api-types").DetectionStats;
    }>,
  cancelDetect: (filePath: string) =>
    ipcRenderer.invoke("algo:cancelDetect", filePath) as Promise<{ ok: boolean; aborted: boolean }>,
  rerank: (fileName, durationMode, candidates) =>
    ipcRenderer.invoke("algo:rerank", fileName, durationMode, candidates) as Promise<{ candidates: ClipCandidate[]; summary: string }>,
  /*
    reviewPacket 一并删了：它只被粗剪审片面板用，面板已移除。
    submitReview 保留，但只发 approve —— 打回/重剪那条链路已经删掉。
  */
  submitReview: (projectId, payload) =>
    ipcRenderer.invoke("algo:submitReview", projectId, payload) as Promise<{
      ok: boolean;
      projectId?: number;
      status?: string;
      learned?: number;
      learnFailed?: string | null;
    }>,

  // 剪辑学习样本 + IP 老师档案（学习闭环的读写口）
  recordEditRecords: (payload: Parameters<StudioApi["recordEditRecords"]>[0]) =>
    ipcRenderer.invoke("algo:recordEditRecords", payload) as Promise<{
      ok: boolean;
      written: number;
      collection?: string | null;
    }>,
  editArchive: (collection: string) =>
    ipcRenderer.invoke("algo:editArchive", collection) as Promise<EditArchive | null>,
  listEditArchives: () =>
    ipcRenderer.invoke("algo:listEditArchives") as Promise<EditArchiveListItem[]>,

  // 热词硬纠正（按 IP 老师归档）
  listHotwords: (collection?: string | null) =>
    ipcRenderer.invoke("algo:listHotwords", collection ?? null) as Promise<HotwordRule[]>,
  addHotword: (payload) => ipcRenderer.invoke("algo:addHotword", payload) as Promise<{ ok: boolean; id: number; updated: boolean }>,
  removeHotword: (id: number) => ipcRenderer.invoke("algo:removeHotword", id) as Promise<{ ok: boolean }>,
  /** 纯文本替换，与 Hermes 侧算法一致；渲染层自己也能用，不必回主进程 */
  applyHotwordsToTranscript: (transcript, rules) => applyTranscript(transcript, rules),

  export: (request_: ExportRequest) => ipcRenderer.invoke("export:run", request_) as Promise<ExportResult>,
  onExportProgress: (cb) => {
    const listener = (_event: unknown, progress: ExportProgress): void => cb(progress);
    ipcRenderer.on("export:progress", listener);
    return () => {
      ipcRenderer.removeListener("export:progress", listener);
    };
  },

  localStackStatus: () => ipcRenderer.invoke("stack:status") as Promise<import("@shared/api-types").LocalStackStatus>,
  watchStatus: () => ipcRenderer.invoke("watch:status") as Promise<import("@shared/api-types").WatchStatus>,

  engineSettings: () => ipcRenderer.invoke("engine:get") as Promise<EngineSettings>,
  setEngineSettings: (settings) => ipcRenderer.invoke("engine:set", settings) as Promise<EngineSettingsSaveResult>,
  testEngines: () => ipcRenderer.invoke("engine:test") as Promise<EngineTestResult>,

  memoryBriefs: () => ipcRenderer.invoke("memory:briefs") as Promise<Array<{ id: string; title: string; createdAt: string; items: number }>>,
  memoryLearn: (filePath) => ipcRenderer.invoke("memory:learn", filePath) as Promise<{ id: string; title: string; items: number }>,

  /** 多版本粗剪:一次出多条不同长度/开头的版本,供用户挑 */

  /** 读取已生成的逐句稿(点句子跳画面要用) */
  readTranscript: (filePath) => ipcRenderer.invoke("algo:readTranscript", filePath) as Promise<Transcript>,

  /** 预览取流:主进程登记白名单后返回一个受限协议 URL */
  mediaOpen: (filePath) => ipcRenderer.invoke("media:open", filePath) as Promise<string>,
  mediaClose: (filePath) => ipcRenderer.invoke("media:close", filePath) as Promise<void>,

  openUrl: (url) => ipcRenderer.invoke("shell:openUrl", url) as Promise<void>,

  /** 出片产物:在资源管理器里定位 */
  revealResult: (filePath) => ipcRenderer.invoke("result:reveal", filePath) as Promise<{ ok: boolean; error?: string }>,
  /** 出片产物:用系统默认程序打开 */
  openResultExternal: (filePath) => ipcRenderer.invoke("result:openExternal", filePath) as Promise<{ ok: boolean; error?: string }>,
  /** 打开输出文件夹 */
  openResultFolder: (dirPath) => ipcRenderer.invoke("result:openFolder", dirPath) as Promise<{ ok: boolean; error?: string }>,

  /* ---------- 爆款记忆库 ---------- */
  hitListIps: () => ipcRenderer.invoke("hit:listIps") as Promise<HitCollection[]>,
  hitCreateIp: (name, note) => ipcRenderer.invoke("hit:createIp", name, note) as Promise<(HitCollection & { hermesSynced?: boolean; hermesError?: string }) | null>,
  hitRenameIp: (ipId, name, note) => ipcRenderer.invoke("hit:renameIp", ipId, name, note) as Promise<HitCollection | null>,
  hitDeleteIp: (ipId, toTrash) => ipcRenderer.invoke("hit:deleteIp", ipId, toTrash) as Promise<boolean>,
  hitRestoreIp: () => ipcRenderer.invoke("hit:restoreIp") as Promise<HitCollection | null>,
  hitListTrashItems: () => ipcRenderer.invoke("hit:listTrashItems") as Promise<TrashItem[]>,
  hitRestoreTrashItem: (trashDir: string) => ipcRenderer.invoke("hit:restoreTrashItem", trashDir) as Promise<HitCollection | null>,
  hitPurgeTrashItem: (trashDir: string) => ipcRenderer.invoke("hit:purgeTrashItem", trashDir) as Promise<boolean>,
  hitEmptyTrash: () => ipcRenderer.invoke("hit:emptyTrash") as Promise<number>,
  hitListEntries: (ipId) => ipcRenderer.invoke("hit:listEntries", ipId) as Promise<HitEntry[]>,
  hitImport: (ipId, entries) => ipcRenderer.invoke("hit:import", ipId, entries) as Promise<HitImportResult>,
  hitImportFiles: (ipId, copy) => ipcRenderer.invoke("hit:importFiles", ipId, copy) as Promise<HitAttachResult>,
  hitListBatches: (ipId) => ipcRenderer.invoke("hit:listBatches", ipId) as Promise<Array<{ batchId: string; count: number; at: string; sample: string }>>,
  hitUndoBatch: (ipId, batchId) => ipcRenderer.invoke("hit:undoBatch", ipId, batchId) as Promise<{ ok: boolean; removed: number; error?: string }>,
  hitDeleteEntry: (ipId, entryId) => ipcRenderer.invoke("hit:deleteEntry", ipId, entryId) as Promise<boolean>,
  hitResolveHermesId: (ipName, sourcePath) => ipcRenderer.invoke("hit:resolveHermesId", ipName, sourcePath) as Promise<number | null>,
  hitFeedback: (payload) => ipcRenderer.invoke("hit:feedback", payload) as Promise<{
    ok: boolean; error?: string;
    prediction?: Record<string, unknown> | null;
    ocr?: Record<string, unknown> | null;
    platform?: string | null;
  }>,
  hitProfile: (ipId) => ipcRenderer.invoke("hit:profile", ipId) as Promise<HitProfile | null>,
  hitRebuildProfile: (ipId) => ipcRenderer.invoke("hit:rebuildProfile", ipId) as Promise<HitProfile | null>,
  hitProfileBrief: (ipId) => ipcRenderer.invoke("hit:profileBrief", ipId) as Promise<string>,
  hitSyncFromHermes: (ipName) => ipcRenderer.invoke("hit:syncFromHermes", ipName) as Promise<{ ok: boolean; imported: number; skipped: number; errors: string[]; ipId?: string }>,
  hitActivateIp: (ipId) => ipcRenderer.invoke("hit:activateIp", ipId) as Promise<{ ok: boolean; ipName?: string; entryCount?: number; error?: string }>,
  hitHermesBrief: (ipId) => ipcRenderer.invoke("hit:hermesBrief", ipId) as Promise<string>
};

contextBridge.exposeInMainWorld("studio", api);
