/**
 * 主进程入口。
 * 职责:窗口生命周期、媒体探测、项目持久化、Hermes 编排、导出进度转发。
 * 算法能力不写在主进程,全部委派本地 Hermes 服务。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { join, basename, extname, resolve } from "node:path";
import { existsSync, readdirSync, rmSync, statSync, createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfprobe } from "./binaries";
import { HermesClient } from "./hermes-client";
import { registerVaultIpc } from "./vault-ipc";
import { registerAssetIpc } from "./asset-ipc";
import type {
  EngineSettings,
  ExportProgress,
  ExportRequest,
  MediaFile,
  MediaProbe,
  ProjectSummary,
  ProjectWorkspace,
  SessionCheckpoint,
  StudioApi
} from "@shared/api-types";

const execFileAsync = promisify(execFile);

const hermes = new HermesClient();
let mainWindow: BrowserWindow | null = null;

/** 预览协议白名单:只有用户当前打开的素材可被渲染层取流 */
const allowedMediaFiles = new Set<string>();

/** ---------- 用户数据目录(项目数据的唯一落盘位置) ---------- */
function userDataDir(): string {
  return app.getPath("userData");
}
function projectsDir(): string {
  return join(userDataDir(), "projects");
}
function settingsFile(): string {
  return join(userDataDir(), "engine-settings.json");
}

const MEDIA_EXT = new Set([".mp4", ".mkv", ".mov", ".flv", ".webm", ".avi", ".mp3", ".m4a", ".wav", ".aac", ".flac"]);

/** ---------- 窗口 ---------- */
function createWindow(): void {
  // 单独留一份常量:桥接自检要报告"我们配的路径是什么",而不只是"失败了"。
  const preloadPath = join(__dirname, "../preload/index.js");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: "#08090d",
    title: "GLB Studio",
    webPreferences: {
      // electron-vite 预加载产物是 index.js(CJS 语义),不是 index.mjs——
      // 写成 .mjs 会静默加载失败,渲染层拿不到 window.studio,界面卡在"未连接到主进程"。
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 桥接自检:preload 路径写错是静默失败(不报错、界面直接空),
  // 这里在渲染层就绪后实测 window.studio 是否挂上,挂不上就把真实原因打到 stderr。
  // 之所以必须自检:此前只验证"进程在、窗口标题对",漏掉了桥本身,
  // 结果界面停在"未连接到主进程"却一直被判 PASS。
  mainWindow.webContents.on("did-finish-load", () => {
    void mainWindow?.webContents
      .executeJavaScript("Boolean(window.studio)")
      .then((ok: unknown) => {
        if (ok === true) {
          console.log("[bridge] 预加载桥已就绪 window.studio OK");
          return;
        }
        console.error(
          "[bridge] 预加载桥未注入!渲染层拿不到 window.studio,界面会停在'未连接到主进程'。\n" +
            `  主进程配置的 preload: ${preloadPath}\n` +
            `  该文件是否存在: ${existsSync(preloadPath) ? "是" : "否(构建产物缺失)"}\n` +
            "  排查方向:① 路径后缀是否与 electron-vite 产物一致(应 index.js 而非 .mjs);" +
            "② 预加载脚本内部是否抛错(contextIsolation=true 时不共享全局作用域)。"
        );
      })
      .catch((err: unknown) => console.error("[bridge] 自检执行失败:", err));
  });

  // 预加载脚本自身抛错时的主进程侧线索(路径问题靠上面那条,抛错靠这条)
  mainWindow.webContents.on("preload-error", (_e, errorPath, error) => {
    console.error(`[bridge] preload 加载出错: ${errorPath}\n  ${error.message}`);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * 工作区归属。
 *
 * Electron 默认把 userData 定在 %APPDATA%\<packageName>,即 glb-studio。
 * 但用户的历史项目一直存在 %APPDATA%\glb\projects(迁移期沿用下来的),
 * 结果就是:程序能启动,侧栏项目列表却永远是空的,像是把用户的东西丢了。
 * 这里在 app ready 之前改回旧路径,让历史项目原地可见,不做数据搬迁。
 *
 * 必须在 whenReady 之前调用——ready 之后 userData 已被多处缓存。
 */
function adoptLegacyWorkspace(): void {
  const appData = app.getPath("appData");
  const legacy = join(appData, "glb");
  const current = app.getPath("userData");
  if (legacy === current) return;
  // 旧目录不存在就不改,避免造出空壳路径
  if (!existsSync(legacy)) return;
  app.setPath("userData", legacy);
  console.log(`[workspace] 工作区指向历史目录: ${legacy}`);

  // Electron 在 ready 之前就会按 packageName 建出 userData 空目录,
  // setPath 之后那个空壳没人再用。清掉,免得用户以为数据被分家了。
  // 只删空目录:万一里面有东西(用户手动放过文件)一律保留。
  const stale = current;
  if (stale !== legacy) {
    try {
      if (readdirSync(stale).length === 0) {
        rmSync(stale, { recursive: true, force: true });
        console.log(`[workspace] 已清理空壳目录: ${stale}`);
      }
    } catch (err) {
      // 清理失败不影响主流程,只记录
      console.warn(`[workspace] 未能清理空壳目录 ${stale}: ${String(err)}`);
    }
  }
}

adoptLegacyWorkspace();

/**
 * 预览协议必须在 app ready 之前登记。
 * Chromium 只在启动早期接受这个声明,放在 ready 之后会静默失效。
 *
 * privileges 里 stream + bypassCSP 是必须的:
 * - 不给 bypassCSP,Chromium 的 URL 安全检查会直接拒绝加载本地文件,
 *   报 "Media load rejected by URL safety check",画面永远黑着。
 * - 不给 stream,3 小时直播没法按需读取,得整段进内存。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "glb-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);

void app.whenReady().then(() => {
  // 协议的实际处理逻辑:只有当前打开的素材在白名单里
  protocol.handle("glb-media", async (request) => {
    const target = new URL(request.url).searchParams.get("path") ?? "";
    if (!target) return new Response("no path", { status: 400 });
    const abs = resolve(target);
    if (!allowedMediaFiles.has(abs)) {
      // 白名单外一律拒绝:裸注册协议会让渲染层读到磁盘任意文件
      return new Response("forbidden", { status: 403 });
    }

    const range = request.headers.get("Range");
    if (!range) {
      // 没有 Range 也要自己回文件,net.fetch(file://) 会丢响应头,
      // 而且 3.5 小时素材会一次性读进内存。
      return streamFile(abs, 0, undefined);
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return new Response("bad range", { status: 416 });
    const size = statSync(abs).size;
    let start: number;
    let end: number;
    if (m[1] === "") {
      // "bytes=-N" 形式:最后 N 字节。N 在 m[2] 里,不是起点。
      // 之前把 end 当成 100 再去比 start,必然 start>end 而误回 416。
      const n = Number(m[2] ?? "0");
      if (n <= 0) return new Response("bad range", { status: 416 });
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` }
      });
    }
    return streamFile(abs, start, end);
  });

  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 按字节区间流式返回,带正确的 206 / Accept-Ranges 响应头。 */
function streamFile(abs: string, start: number, end: number | undefined): Response {
  const size = statSync(abs).size;
  const stop = end === undefined ? size - 1 : Math.min(end, size - 1);
  const stream = createReadStream(abs, { start, end: stop });
  const body = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    }
  });
  const headers: Record<string, string> = {
    "Content-Type": guessMime(abs),
    "Accept-Ranges": "bytes",
    "Content-Length": String(stop - start + 1)
  };
  if (end !== undefined) headers["Content-Range"] = `bytes ${start}-${stop}/${size}`;
  // 没有 end(即无 Range 的整文件请求)也回 206 不合适,用 200
  return new Response(body, { status: end === undefined ? 200 : 206, headers });
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".m4v": "video/x-m4v",
  ".ts": "video/mp2t",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg"
};

function guessMime(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** ---------- 媒体探测(ffprobe) ---------- */
async function probeMedia(path: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path
    /*
     * windowsHide 必须有。
     * ffprobe 是控制台程序，不设的话每探测一个文件就弹一个黑框、抢一次焦点；
     * 用户一次拖一整个文件夹进来（动辄几十个），就是黑框刷屏。
     * 这和 Hermes 侧 ffmpeg 漏 windowsHide 是同一个病根，两边都得修。
     */
  ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const info = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/");
  const fps = den && Number(den) > 0 ? Number(num) / Number(den) : 0;
  return {
    path,
    durationSec: Number(info.format?.duration ?? 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: Number.isFinite(fps) ? Number(fps.toFixed(3)) : 0,
    videoCodec: video?.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
    sizeBytes: Number(info.format?.size ?? 0)
  };
}

async function listMedia(dir: string): Promise<MediaFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MediaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MEDIA_EXT.has(extname(entry.name).toLowerCase())) continue;
    const full = join(dir, entry.name);
    const st = await stat(full);
    files.push({ path: full, name: entry.name, durationSec: 0, hasVideo: true, hasAudio: true, width: 0, height: 0, fps: 0, videoCodec: "", audioCodec: "", sizeBytes: st.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** ---------- 项目持久化 ---------- */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * 索引条目 -> ProjectSummary。
 *
 * 必须做归一化,因为磁盘上存在两种结构:
 *   新版:{ id, name, sourcePath, ... }
 *   旧版:{ id, name, source: { path, size, mtimeMs }, sourceName, ... }
 * 迁移期写的是旧版。直接原样返回的话 sourcePath 为 undefined,
 * 界面表现为"点开项目说没记录素材路径"。
 */
function normalizeProjectEntry(raw: Record<string, unknown>): ProjectSummary | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const source = (raw.source ?? null) as { path?: string } | null;
  const sourcePath =
    (typeof raw.sourcePath === "string" && raw.sourcePath) ||
    (typeof source?.path === "string" && source.path) ||
    (typeof raw.sourceName === "string" ? raw.sourceName : "");
  const now = new Date().toISOString();
  return {
    id,
    name: (typeof raw.name === "string" && raw.name) || sourcePath.split(/[\\/]/).pop() || "未命名项目",
    sourcePath,
    durationSec: Number(raw.durationSec) || 0,
    hasTranscript: raw.hasTranscript !== false,
    candidateCount: Number(raw.candidateCount) || 0,
    createdAt: (typeof raw.createdAt === "string" && raw.createdAt) || now,
    updatedAt: (typeof raw.updatedAt === "string" && raw.updatedAt) || now,
    lastOpenedAt: (typeof raw.lastOpenedAt === "string" && raw.lastOpenedAt) || now
  };
}

async function listProjects(): Promise<ProjectSummary[]> {
  const index = await readJson<{ projects?: Record<string, unknown>[] }>(join(projectsDir(), "index.json"), {
    projects: []
  });
  const list = (index.projects ?? [])
    .map((p) => normalizeProjectEntry(p))
    .filter((p): p is ProjectSummary => p !== null);
  return list.sort((a, b) => (b.lastOpenedAt || b.updatedAt).localeCompare(a.lastOpenedAt || a.updatedAt));
}

async function writeIndex(projects: ProjectSummary[]): Promise<void> {
  await mkdir(projectsDir(), { recursive: true });
  const tmp = join(projectsDir(), "index.json.tmp");
  await writeFile(tmp, JSON.stringify({ version: 1, projects }, null, 2), "utf8");
  await rename(tmp, join(projectsDir(), "index.json"));
}

let activeProjectId: string | null = null;

async function workspaceGet(): Promise<ProjectWorkspace> {
  return { projects: await listProjects(), activeProjectId };
}

async function projectCreate(checkpoint: SessionCheckpoint): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint }> {
  const now = new Date().toISOString();
  const project: ProjectSummary = {
    id: randomUUID(),
    name: basename(checkpoint.file.path, extname(checkpoint.file.path)),
    sourcePath: checkpoint.file.path,
    durationSec: checkpoint.file.durationSec,
    hasTranscript: checkpoint.transcript !== null,
    candidateCount: checkpoint.candidates?.length ?? 0,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  };
  await mkdir(projectsDir(), { recursive: true });
  await writeFile(join(projectsDir(), `${project.id}.json`), JSON.stringify(checkpoint), "utf8");
  const projects = [project, ...(await listProjects()).filter((p) => p.id !== project.id)];
  await writeIndex(projects);
  activeProjectId = project.id;
  return { project, checkpoint };
}

/**
 * 读检查点。磁盘上有三种形态,全都要认:
 *   ① 新版  <id>.json → 顶层就是 SessionCheckpoint({ file, transcript, candidates, selected })
 *   ② 旧版  <id>.glb  → 顶层是 { version, id, name, source, checkpoint:{ ... } }
 *   ③ 早期  <id>.glb  → 顶层直接是 SessionCheckpoint
 *
 * 不兼容的后果很隐蔽:项目列表能看见(索引里有),点开却说"没有记录素材路径",
 * 或者只有素材没有候选 —— 用户会以为分析结果丢了,其实只是格式不同。
 */
async function readCheckpoint(id: string): Promise<SessionCheckpoint | null> {
  for (const ext of [".json", ".glb"]) {
    const raw = await readJson<Record<string, unknown> | null>(join(projectsDir(), `${id}${ext}`), null);
    if (!raw || typeof raw !== "object") continue;

    // ② 旧版包装:{ version, id, name, source, checkpoint }
    const wrapped = raw.checkpoint as Record<string, unknown> | undefined;
    if (wrapped && typeof wrapped === "object" && wrapped.file) {
      return normalizeCheckpoint(wrapped);
    }

    // ①/③ 直接就是检查点
    if ((raw as unknown as SessionCheckpoint).file) {
      return normalizeCheckpoint(raw);
    }
  }
  return null;
}

/**
 * 旧版检查点补齐新版字段。
 * 旧版 file 里没有 name(旧结构只有 MediaProbe 那套探测字段),
 * 而界面上到处用 file.name 显示 —— 不补的话打开项目会看到"undefined.mp4"。
 */
function normalizeCheckpoint(raw: Record<string, unknown>): SessionCheckpoint {
  const cp = raw as unknown as SessionCheckpoint;
  const file = (cp.file ?? {}) as unknown as MediaFile;
  const path = typeof file.path === "string" ? file.path : "";
  return {
    liveVideoId: null,
    ...cp,
    file: {
      ...file,
      path,
      // 旧版 file 里没有 name(旧结构只有探测字段),界面上到处用 file.name —— 不补会显示 undefined.mp4。
      // 放在 ...file 之后才能保证覆盖旧值。
      name: typeof file.name === "string" && file.name ? file.name : path.split(/[\\/]/).pop() ?? "未命名素材",
      durationSec: Number(file.durationSec) || 0,
      hasVideo: Boolean(file.hasVideo),
      hasAudio: Boolean(file.hasAudio),
      width: Number(file.width) || 0,
      height: Number(file.height) || 0,
      fps: Number(file.fps) || 0,
      videoCodec: String(file.videoCodec ?? ""),
      audioCodec: String(file.audioCodec ?? ""),
      sizeBytes: Number(file.sizeBytes) || 0
    }
  };
}

async function projectOpen(id: string): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint | null } | null> {
  const projects = await listProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) return null;
  const checkpoint = await readCheckpoint(id);
  const next = projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: new Date().toISOString() } : p));
  await writeIndex(next);
  activeProjectId = id;
  return { project: next.find((p) => p.id === id) as ProjectSummary, checkpoint };
}

async function projectSave(id: string, checkpoint: SessionCheckpoint): Promise<boolean> {
  try {
    await mkdir(projectsDir(), { recursive: true });
    await writeFile(join(projectsDir(), `${id}.json`), JSON.stringify(checkpoint), "utf8");
    const projects = (await listProjects()).map((p) =>
      p.id === id
        ? { ...p, updatedAt: checkpoint.savedAt, hasTranscript: checkpoint.transcript !== null, candidateCount: checkpoint.candidates?.length ?? 0 }
        : p
    );
    await writeIndex(projects);
    return true;
  } catch {
    return false;
  }
}

async function projectDelete(id: string): Promise<boolean> {
  try {
    await unlink(join(projectsDir(), `${id}.json`));
    await writeIndex((await listProjects()).filter((p) => p.id !== id));
    if (activeProjectId === id) activeProjectId = null;
    return true;
  } catch {
    return false;
  }
}

async function projectRename(id: string, name: string): Promise<ProjectSummary | null> {
  const projects = await listProjects();
  const target = projects.find((p) => p.id === id);
  if (!target) return null;
  const next = projects.map((p) => (p.id === id ? { ...p, name, updatedAt: new Date().toISOString() } : p));
  await writeIndex(next);
  return next.find((p) => p.id === id) ?? null;
}

/** 素材被移动/改名后重新指向原项目 */
async function projectRelink(id: string, path: string): Promise<{ project: ProjectSummary; checkpoint: SessionCheckpoint } | null> {
  const probe = await probeMedia(path);
  const file: MediaFile = { ...probe, name: basename(path) };
  const old = await readJson<SessionCheckpoint | null>(join(projectsDir(), `${id}.json`), null);
  const checkpoint: SessionCheckpoint = {
    file,
    transcript: old?.transcript ?? null,
    candidates: old?.candidates ?? null,
    selected: old?.selected ?? [],
    savedAt: new Date().toISOString()
  };
  await projectSave(id, checkpoint);
  const project = (await listProjects()).find((p) => p.id === id);
  return project ? { project, checkpoint } : null;
}

/** ---------- Ollama 状态(顶栏状态灯) ---------- */
async function ollamaStatus(): Promise<{ ok: boolean; models: string[] }> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { ok: false, models: [] };
  }
}

/** ---------- 引擎设置(双引擎) ---------- */
// 标注成 EngineSettings 而不是让 TS 推断:否则 defaultEngine 会被锁成字面量 "auto",
// 后面写 defaultEngine === "cloud" 直接报 TS2367。主进程和渲染层共用同一份契约,
// 免得两边各写一份、慢慢漂移。
const DEFAULT_ENGINE: EngineSettings = {
  defaultEngine: "auto",
  local: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b-chat" },
  cloud: { provider: "gemini", apiKey: "", model: "gemini-3.5-flash-lite" },
  // 默认 Google 原生协议。第三方中转走 openai-compatible,
  // 由用户在设置面板里切 —— 两套协议的路径和认证方式都不同,不能替他猜。
  cloudProtocol: "gemini-native",
  cloudBaseUrl: "",
  cloudBudgetPerRun: 8,
  // 空 = 自动（环境变量 > Windows 系统代理）。手填用于覆盖系统设置。
  proxy: ""
};

type EngineSettingsShape = typeof DEFAULT_ENGINE;

async function readEngineSettings(): Promise<EngineSettingsShape> {
  const raw = await readJson<Partial<EngineSettingsShape>>(settingsFile(), {});
  return {
    defaultEngine: raw.defaultEngine ?? DEFAULT_ENGINE.defaultEngine,
    local: { ...DEFAULT_ENGINE.local, ...(raw.local ?? {}) },
    cloud: { ...DEFAULT_ENGINE.cloud, ...(raw.cloud ?? {}) },
    cloudProtocol: raw.cloudProtocol ?? DEFAULT_ENGINE.cloudProtocol,
    cloudBaseUrl: raw.cloudBaseUrl ?? DEFAULT_ENGINE.cloudBaseUrl,
    cloudBudgetPerRun: raw.cloudBudgetPerRun ?? DEFAULT_ENGINE.cloudBudgetPerRun,
    proxy: raw.proxy ?? DEFAULT_ENGINE.proxy
  };
}

/**
 * 分级报错：把 HTTP 失败翻译成"下一步该做什么"。
 *
 * 之前一律报 `HTTP 401`，用户看不出到底是 key 失效、地址写错、协议选错，
 * 还是压根没连上网——这四种的处理办法完全不同。
 */
function describeHttpFailure(status: number, statusText: string, bodyText: string): string {
  const snippet = String(bodyText || "").slice(0, 300);
  if (status === 401 || status === 403) {
    const isKeyWord = /api[\s_-]?key|unauthorized|forbidden|token|鉴权|认证/i.test(snippet);
    return `云端拒绝鉴权（HTTP ${status}）${isKeyWord ? "：key 无效、过期或填错" : ""}。这是 key 的问题，不是网络问题——换个有余额的 key 即可。服务端原话：${snippet}`;
  }
  if (status === 404) {
    return `接口地址不存在（HTTP 404）：${snippet}。多半是地址少写了 /v1，或协议选错了（这个服务是 OpenAI 兼容还是 Gemini 原生要对应）。`;
  }
  if (status === 429) return `被限流或额度用尽（HTTP 429）：${snippet}`;
  if (status >= 500) return `云端服务异常（HTTP ${status}）：${snippet}。可稍后重试。`;
  return `云端返回 HTTP ${status} ${statusText || ""}：${snippet}`;
}

/**
 * 探测代理地址。
 *
 * 为什么要自动探测：这台机器开着 Clash，Windows 系统代理在 127.0.0.1:4780，
 * 而 Electron/Node 都不读那个设置（只认环境变量），于是云端测试必然超时，
 * 看起来像 key 失效。让人手填能用，但每次换端口都要改一遍——
 * 所以这里自动读系统设置，读不到再让用户手填。
 *
 * 优先级与 Hermes 侧 proxy.js 保持一致：手填 > 环境变量 > 系统设置。
 */
function detectProxy(manual: string | undefined): { url: string | null; from: string } {
  const m = manual?.trim();
  if (m) return { url: /^https?:\/\//i.test(m) ? m : `http://${m}`, from: "设置里手填" };

  const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (env?.trim()) return { url: env.trim(), from: "环境变量" };

  if (process.platform === "win32") {
    try {
      // 用 reg query 而不是读注册表文件：打包环境里没有 winreg 依赖，reg.exe 是系统自带的。
      // 必须一条一条查。reg query 的 /v 一次只能给一个值：写成
// '/v ProxyEnable /v ProxyServer' 会被 reg 判成语法错误、返回非 0、输出为空，
// 于是永远探测不到代理 —— 而这正是最需要它工作的场景（Clash 开着、fetch 直连）。
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      const q = (name: string): string => {
        try {
          return execFileSync("reg", ["query", KEY, "/v", name], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 3000
          });
        } catch {
          return "";
        }
      };
      const out = `${q("ProxyEnable")}\n${q("ProxyServer")}`;
      const on = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      const srv = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out);
      if (on?.[1] && Number.parseInt(on[1], 16) !== 0 && srv?.[1]) {
        // 可能是 "http=127.0.0.1:4780;https=127.0.0.1:4780" 这种分协议形式
        const parts = srv[1]
          .trim()
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        const pick = parts.length > 1 ? (parts.find((s) => /^https=/i.test(s)) || parts[0]) : parts[0];
        const host = String(pick).replace(/^https?:\/\//i, "").replace(/\/$/, "").replace(/^https?=/i, "").trim();
        if (/^[\w.\-]+:\d+$/.test(host)) return { url: `http://${host}`, from: "Windows 系统代理" };
      }
    } catch {
      /* 读不到就当没有 */
    }
  }
  return { url: null, from: "无" };
}

/** Hermes 配置文件:整套算法都在这个进程里跑,它的 llm/gemini 配置才是真正生效的那份 */
function hermesConfigFile(): string {
  return join("D:", "GLB", "Hermes", "config", "default.json");
}

/**
 * 把引擎设置同步进 Hermes 配置。
 *
 * 为什么必须同步:设置面板原本只写 GLB 自己的 engine-settings.json,
 * 而 Hermes 只读 config/default.json —— 两边不通。用户在面板里填了 key、
 * 点了保存,界面显示"已保存",分析时 Hermes 依然报"key 缺失"。
 * 这种"存了但没生效"比没有面板更糟。
 *
 * 注意 baseUrl:Hermes 每次请求前都会 replace('/v1',''),所以带不带 /v1 都对,
 * 可以直接把面板的值写过去。
 *
 * 注意 provider 映射:面板说的是 local/cloud/auto,Hermes 说的是
 * ollama/gemini/auto。cloud 必须翻成 gemini,否则 Hermes 会去找一个叫
 * "cloud" 的 provider,然后静默落到本地 —— 正是 auto 之前踩过的那个坑。
 */
async function syncHermesEngineConfig(
  s: EngineSettingsShape
): Promise<{ ok: boolean; error?: string; provider: string }> {
  const file = hermesConfigFile();
  const provider = s.defaultEngine === "cloud" ? "gemini" : s.defaultEngine === "local" ? "ollama" : "auto";
  if (!existsSync(file)) {
    return { ok: false, provider, error: `找不到 Hermes 配置文件：${file}` };
  }
  try {
    const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
    cfg.llm = { ...(cfg.llm ?? {}), provider };
    cfg.ollama = {
      ...(cfg.ollama ?? {}),
      baseUrl: s.local.baseUrl,
      chatModel: s.local.model
    };
    cfg.gemini = {
      ...(cfg.gemini ?? {}),
      apiKey: s.cloud.apiKey,
      model: s.cloud.model,
      cloudBudgetPerRun: s.cloudBudgetPerRun,
      // 协议与地址决定请求打到哪里、用哪种认证。
      // 不传的话 Hermes 只会用 Google 原生那套，接中转必然 401/404。
      protocol: s.cloudProtocol ?? "gemini-native",
      // 空字符串表示"用协议对应的官方地址"，
      // 所以只有用户真的填了才覆盖 —— 写成空会变成 baseUrl 变成 ''，
      // 请求路径就变成 /models/...，全部 404。
      ...(s.cloudBaseUrl && s.cloudBaseUrl.trim() ? { baseUrl: s.cloudBaseUrl.trim() } : {})
    };
    // 代理写进 Hermes 的 llm.proxy。留空则让 proxy.js 按 环境变量 > 系统设置 自动探测。
    cfg.llm = { ...(cfg.llm ?? {}), ...(s.proxy && s.proxy.trim() ? { proxy: s.proxy.trim() } : {}) };
    await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    return { ok: true, provider };
  } catch (err) {
    // 配置写坏会让 Hermes 起不来,这个必须让用户看见,不能吞
    return { ok: false, provider, error: `写入 Hermes 配置失败：${(err as Error).message}` };
  }
}

/** ---------- IPC 注册 ---------- */
function registerIpc(): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };

  /* 素材 */
  handle("media:select", async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "媒体文件", extensions: ["mp4", "mkv", "mov", "flv", "webm", "avi", "mp3", "m4a", "wav", "flac"] }
      ]
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });
  handle("media:probe", (path: string) => probeMedia(path));
  handle("media:list", (dir: string) => listMedia(dir));
  handle("outdir:default", async () => join(app.getPath("videos"), "GLB", "output"));
  handle("outdir:select", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  /** 选 BGM 音频文件 */
  handle("audio:select", async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "选择背景音乐",
      filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] }]
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  /* 项目 */
  handle("project:workspace", () => workspaceGet());
  handle("project:create", (checkpoint: SessionCheckpoint) => projectCreate(checkpoint));
  handle("project:open", (id: string) => projectOpen(id));
  handle("project:close", () => {
    activeProjectId = null;
  });
  handle("project:save", (id: string, checkpoint: SessionCheckpoint) => projectSave(id, checkpoint));
  handle("project:delete", (id: string) => projectDelete(id));
  handle("project:rename", (id: string, name: string) => projectRename(id, name));
  handle("project:relink", (id: string, path: string) => projectRelink(id, path));

  /* 算法(全部经 Hermes) */
  handle("algo:transcribe", (filePath: string) => hermes.transcribe(filePath));
  handle("algo:detect", (request_: Parameters<StudioApi["detect"]>[0]) => hermes.detect(request_));
  // 「取消」必须真的取消。以前这里没有端点，前端按钮调的是 detect() 重跑一遍。
  handle("algo:cancelDetect", (filePath: string) => hermes.cancelDetect(filePath));
  handle("algo:readTranscript", (filePath: string) => hermes.readTranscript(filePath));
  
  handle("algo:rerank", (fileName: string, mode: "short" | "mid" | "long", candidates: Parameters<StudioApi["rerank"]>[2]) =>
    hermes.rerank(fileName, mode, candidates)
  );
  /* 审片：打回/重剪链路已删，只留"确认通过"这一条学习信号 */
  handle(
    "algo:submitReview",
    (projectId: number, payload: Parameters<StudioApi["submitReview"]>[1]) =>
      hermes.submitReview(projectId, payload)
  );

  // 剪辑学习样本 + IP 老师档案（桌面端改标题/剔句子/框选删字后回传）
  handle("algo:recordEditRecords", (payload: Parameters<StudioApi["recordEditRecords"]>[0]) =>
    hermes.recordEditRecords(payload)
  );
  handle("algo:editArchive", (collection: string) => hermes.editArchive(collection));
  handle("algo:listEditArchives", () => hermes.listEditArchives());

  // 热词硬纠正
  handle("algo:listHotwords", (collection: string | null) => hermes.listHotwords(collection));
  handle("algo:addHotword", (payload: { collection?: string | null; from: string; to: string }) =>
    hermes.addHotword(payload)
  );
  handle("algo:removeHotword", (id: number) => hermes.removeHotword(id));

  /* 出片 */
  handle("export:run", async (request_: ExportRequest) => {
    const emit = (progress: ExportProgress): void => {
      mainWindow?.webContents.send("export:progress", progress);
    };
    try {
      emit({ stage: "preparing", clipIndex: 0, clipTotal: request_.clips.length, percent: 0 });
      const result = await hermes.export(request_);
      emit({
        stage: result.ok ? "done" : "error",
        clipIndex: request_.clips.length,
        clipTotal: request_.clips.length,
        percent: 100,
        outputPath: result.outputDir,
        error: result.error
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ stage: "error", clipIndex: 0, clipTotal: request_.clips.length, percent: 0, error: message });
      return { ok: false, outputDir: request_.outDir ?? "", files: [], error: message };
    }
  });

  /* 栈状态 */
  handle("stack:status", async () => hermes.stackStatus(await ollamaStatus()));
  handle("watch:status", () => hermes.watchStatus());

  /* 引擎设置 */
  handle("engine:get", () => readEngineSettings());
  handle("engine:set", async (patch: Partial<EngineSettingsShape>) => {
    const current = await readEngineSettings();
    const next: EngineSettingsShape = {
      ...current,
      ...patch,
      local: { ...current.local, ...(patch.local ?? {}) },
      cloud: { ...current.cloud, ...(patch.cloud ?? {}) }
    };
    await mkdir(userDataDir(), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(next, null, 2), "utf8");
    // 光写自己那份没用,必须同步给真正干活的 Hermes
    const synced = await syncHermesEngineConfig(next);
    if (!synced.ok) console.warn(`[engine:set] ${synced.error}`);
    return { ...next, hermesSynced: synced.ok, hermesSyncError: synced.error ?? null, hermesProvider: synced.provider };
  });
  /** 探活:让面板能验证"填的东西到底能不能用",而不是存完只能靠猜 */
  handle("engine:test", async () => {
    const s = await readEngineSettings();
    const out: {
      local: { ok: boolean; models: string[] };
      cloud: { ok: boolean; error?: string; models?: string[]; modelHint?: string; proxy?: string | null };
      proxy?: string | null;
      proxyDetected?: string | null;
    } = {
      local: { ok: false, models: [] },
      cloud: { ok: false }
    };

    // 探活本身也走代理，而且用的是渲染进程/Electron 的网络栈（不是 Hermes 的）。
    // 两边都要能看到代理走没走通，否则"界面说连上了、实际出片时连不上"。
    const detected = detectProxy(s.proxy);
    out.proxy = s.proxy?.trim() ? s.proxy.trim() : detected.url;
    out.proxyDetected = detected.url;
    out.cloud.proxy = out.proxy;
    if (out.proxy && process.env.NODE_USE_ENV_PROXY !== "1") {
      out.cloud.error = `已识别代理 ${out.proxy}，但 Electron 进程未启用 NODE_USE_ENV_PROXY，云端测试可能失败。重启 GLB Studio 生效。`;
    }
    try {
      const base = s.local.baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${base}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        out.local = { ok: true, models: (data.models ?? []).map((m) => m.name) };
      }
    } catch (err) {
      out.local = { ok: false, models: [] };
    }
    if (s.cloud.apiKey) {
      // 探活必须跟着协议走：官方是 ?key= + /v1beta/models，
      // OpenAI 兼容是 Bearer + <base>/models。用错就是 401/404，
      // 用户会以为 key 填错了，其实只是路径不对。
      try {
        const oai = s.cloudProtocol === "openai-compatible";
        const base = (s.cloudBaseUrl?.trim() || (oai ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta"))
          .replace(/\/$/, "");
        const url = oai ? `${base}/models` : `${base}/models?key=${encodeURIComponent(s.cloud.apiKey)}`;
        const g = await fetch(url, {
          headers: oai ? { Authorization: `Bearer ${s.cloud.apiKey}` } : {},
          signal: AbortSignal.timeout(20000)
        });
        if (g.ok) {
          const data = (await g.json().catch(() => null)) as
            | { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
            | null;
          const models = oai
            ? (data?.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean)
            : (data?.models ?? []).map((m) => String(m?.name ?? "").replace(/^models\//, "")).filter(Boolean);
          out.cloud = {
            ok: true,
            proxy: out.proxy ?? null,
            models,
            // 模型名填错是比 key 失效更常见的原因，而且报错完全看不出是模型名不对
            modelHint:
              models.length > 0 && !models.includes(s.cloud.model)
                ? `连上了，但列表里没有「${s.cloud.model}」。可用：${models.slice(0, 6).join("、")}`
                : undefined
          };
        } else {
          const body = await g.text().catch(() => "");
          out.cloud = { ok: false, error: describeHttpFailure(g.status, g.statusText, body) };
        }
      } catch (err) {
        // 超时和连不上都要指方向:这台机器默认直连是出不去的,
        // 不说清"要不要配代理"的话,用户只会反复换 key。
        const e = err as Error;
        const timedOut = /timeout/i.test(e?.name ?? "") || /timeout|aborted/i.test(String(e?.message ?? ""));
        out.cloud = {
          ok: false,
          error: timedOut
            ? `连不上（20 秒无响应）。${out.proxy ? `已走代理 ${out.proxy}，检查代理软件是否在运行。` : "当前是直连。若这台机器开了 Clash/v2ray，请在上方「代理」里填地址。"}`
            : String(e?.message || e)
        };
      }
    } else {
      out.cloud = { ok: false, error: "未填写 API Key" };
    }
    return out;
  });

  /* 记忆 */
  handle("memory:briefs", () => hermes.memoryBriefs());
  handle("memory:learn", (filePath: string) => hermes.learnMemory(filePath));

  /* 预览播放器取流
   *
   * 不用 file:// 也不用把整段视频读进内存(base64 会撑爆 3 小时直播),
   * 这里注册一个自定义协议,只放行"用户当前打开的那一个文件"。
   * 白名单是必需的:裸注册 glb-media:// 会让渲染层读到磁盘上任意文件。
   */
  const allowedMedia = new Set<string>();
  handle("media:open", (filePath: string) => {
    const abs = resolve(filePath);
    allowedMediaFiles.add(abs);
    // 路径放在 query 而不是 pathname:Windows 盘符与中文目录在 URL 路径里
    // 会被斜杠/百分号编码折腾,query 交给 URLSearchParams 更稳。
    return `glb-media://preview?path=${encodeURIComponent(abs)}`;
  });
  handle("media:close", (filePath: string) => {
    allowedMediaFiles.delete(resolve(filePath));
  });

  /* 系统 */
  handle("shell:openUrl", async (url: string) => {
    await shell.openExternal(url);
  });

  /**
   * 出片产物:在资源管理器里定位 / 用系统默认程序打开。
   *
   * 为什么按扩展名白名单:渲染层把 Hermes 返回的路径原样传进来,
   * 而 shell.openPath 会直接交给系统执行 —— 一旦被篡改成 .exe/.bat/.ps1
   * 就等于给了渲染层一个任意程序执行入口。白名单挡住这一类。
   */
  const RESULT_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".srt", ".vtt", ".txt", ".jpg", ".jpeg", ".png", ".webp"]);
  const assertResultPath = (filePath: string): string | null => {
    const abs = resolve(filePath);
    const ext = extname(abs).toLowerCase();
    if (!RESULT_EXT.has(ext)) return null;
    if (!existsSync(abs)) return null;
    return abs;
  };

  handle("result:reveal", async (filePath: string) => {
    const abs = assertResultPath(filePath);
    if (!abs) return { ok: false, error: "文件不存在或类型不支持" };
    if (process.env.GLB_NO_OPEN === "1") {
      return { ok: true, dryRun: true };
    }
    // showItemInFolder 返回 Promise,不 await 就返回 ok:true,
    // 界面上会以为"定位成功",其实可能什么都没发生。
    await shell.showItemInFolder(abs);
    return { ok: true };
  });
  handle("result:openExternal", async (filePath: string) => {
    const abs = assertResultPath(filePath);
    if (!abs) return { ok: false, error: "文件不存在或类型不支持" };
    // 见 result:openFolder 里的说明:验证脚本不该真的弹播放器
    if (process.env.GLB_NO_OPEN === "1") {
      return { ok: true, dryRun: true };
    }
    // 同上:openPath 是异步的,失败时返回错误字符串,不 await 就永远看不到。
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });
  /**
   * 打开产物所在文件夹 */
  handle("result:openFolder", async (dirPath: string) => {
    const abs = resolve(dirPath);
    // 目录不做扩展名限制,但必须是真存在的目录,不能是文件
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      return { ok: false, error: "目录不存在" };
    }
    // 验证脚本会调用这两个通道来检查白名单,不能让它真的弹播放器:
    // 一来会打开用户机器上的默认播放器(而且很可能是个测试产物),
    // 二来验证行为本身就变得有副作用。GLB_NO_OPEN=1 时只做校验不真打开。
    if (process.env.GLB_NO_OPEN === "1") {
      return { ok: true, dryRun: true };
    }
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /* 爆款记忆库:每个 IP 老师一个独立文件夹,可增删/批量导入/撤回/叠加校准 */
  registerVaultIpc(handle, userDataDir, hermes, () => mainWindow);
registerAssetIpc(handle, userDataDir, () => mainWindow);
}

export type { ExportProgress };
