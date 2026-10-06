/**
 * GLB Studio 应用外壳
 * © 2026 郭洛斌
 *
 * 启动:连桥接 → 探本地栈 → 读工作区恢复会话。
 * 分派:有素材进工作台,没素材停在导入页。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LuBrain, LuCheck, LuCircleAlert, LuCpu, LuFilm, LuRefreshCw, LuSettings } from "react-icons/lu";
import { bridge, call, hasBridge } from "./lib/bridge";
import { useSession } from "./stores/session-store";
import type { EngineSettings, EngineTestResult, LocalStackStatus } from "@shared/api-types";
import { ImportStage } from "./components/ImportStage";
import { Workbench } from "./components/Workbench";
import { Dot, Modal, cx } from "./components/ui";
import "./styles.css";

const BRIDGE_HINT = [
  "主进程日志会打印其中一条:",
  "  [bridge] 预加载桥已就绪 window.studio OK",
  "  [bridge] 预加载桥未注入!",
  "  [bridge] preload 加载出错: <路径>",
  "",
  "最常见原因:预加载路径配成 index.mjs,",
  "但 electron-vite 实际产出是 index.js,",
  "不报错、不崩,只是桥静默缺失。",
  "用 GLB_STUDIO_DEBUG=1 启动可看到完整主进程日志。"
].join("\n");

function StatusLamp({
  ok,
  loading,
  icon,
  label,
  detail
}: {
  ok: boolean | null;
  loading: boolean;
  icon: React.ReactNode;
  label: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <span
      title={detail ?? (loading ? "探测中" : ok ? "正常" : "未运行")}
      className={cx(
        "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
        loading
          ? "border-line text-mut"
          : ok
            ? "border-ok/30 bg-ok/8 text-ok"
            : "border-bad/30 bg-bad/8 text-bad/90"
      )}
    >
      <Dot tone={loading ? "busy" : ok ? "ok" : "bad"} />
      {icon}
      {label}
    </span>
  );
}

/** 引擎设置面板 */
function EnginePanel({ settings, onClose }: { settings: EngineSettings; onClose: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [engineTest, setEngineTest] = useState<EngineTestResult | null>(null);

  const save = async (): Promise<void> => {
    setNote(null);
    // 选了云端却没 key:先说清楚,否则存下去会"永远走本地",用户还以为云端已开
    if (draft.defaultEngine === "cloud" && !draft.cloud.apiKey.trim()) {
      setNote({ tone: "warn", text: "选了「只用云端」但没填 API Key。分析会自动回落到本地,等于没生效。" });
      return;
    }
    try {
      const r = await call((api) => api.setEngineSettings(draft));
      setDraft(r);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      // Hermes 只在启动时读一次配置,不提示的话用户会以为设置没起作用
      setNote(
        r.hermesSynced
          ? { tone: "ok", text: `已保存并同步到 Hermes(provider=${r.hermesProvider})。重启 Hermes 后生效。` }
          : { tone: "warn", text: `已保存到本机,但没同步到 Hermes:${r.hermesSyncError}` }
      );
    } catch (err) {
      setNote({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setNote(null);
    try {
      const r = await call((api) => api.testEngines());
      setEngineTest(r);
      // 三种失败要分开说：key 无效、地址/协议错、根本没连上网。
      // 混成一句"不可用"时，用户只能反复换 key，而问题根本不在 key。
      if (r.local.ok && r.cloud.ok) {
        setNote({
          tone: "ok",
          text: r.cloud.modelHint
            ? `本地与云端都连上了。${r.cloud.modelHint}`
            : "本地与云端都可用。"
        });
      } else if (r.cloud.error?.includes("key")) {
        setNote({ tone: "warn", text: r.cloud.error });
      } else if (r.local.ok) {
        setNote({ tone: "warn", text: `本地可用,云端不可用:${r.cloud.error ?? "未知原因"}` });
      } else {
        setNote({ tone: "warn", text: "本地引擎连不上,请确认 Ollama 已启动。" });
      }
    } catch (err) {
      setNote({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      title="分析引擎"
      subtitle="引擎按素材形态自动分派:短片段(带货/卖课)用本地模型,长直播(2-5 小时)用长上下文读完整场。"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          {note && (
            <span className={`mr-auto max-w-md text-[11.5px] leading-snug ${note.tone === "ok" ? "text-ok" : "text-warn"}`}>
              {note.text}
            </span>
          )}
          {!note && saved && <span className="mr-auto flex items-center gap-1.5 text-[11.5px] text-ok"><Dot tone="ok" />已保存</span>}
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut hover:text-fg disabled:opacity-40"
          >
            {testing ? "检测中" : "检测连通"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut hover:text-fg"
          >
            关闭
          </button>
          <button type="button" onClick={() => void save()} className="btn-flame rounded-lg px-5 py-2 text-[12.5px] font-bold text-white">
            保存
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* ---------- 引擎分派 ---------- */}
        {/* 这个选择器以前是缺的:面板文案一直说"按素材形态自动分派",
            但 defaultEngine 从来不能改 —— 用户只能被动接受自动。
            而它直接决定写给 Hermes 的 llm.provider(只用本地/只用云端都要能选)。 */}
        <div className="rounded-xl border border-line bg-panel-2/40 p-3.5">
          <div className="mb-2 text-[12.5px] font-bold text-fg">引擎分派</div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { key: "auto", label: "自动", hint: "短片段本地 · 长直播云端" },
                { key: "local", label: "只用本地", hint: "不花钱 · 长直播可能不准" },
                { key: "cloud", label: "只用云端", hint: "全局视角好 · 要 API Key" }
              ] as const
            ).map((o) => {
              const on = draft.defaultEngine === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setDraft({ ...draft, defaultEngine: o.key })}
                  className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    on ? "border-ember/45 bg-ember/8" : "border-line hover:bg-panel-2/60"
                  }`}
                >
                  <div className="text-[12px] font-bold text-fg">{o.label}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-mut-2">{o.hint}</div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="rounded-xl border border-ok/25 bg-ok/6 p-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-bold text-ok">
            <Dot tone="ok" />
            本地引擎(默认,免费无限)
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">
            单条带货/卖课片段只有几十到几百字,本地模型上下文完全够用,不上传也不花钱。
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">模型</span>
              <input
                value={draft.local.model}
                onChange={(e) => setDraft({ ...draft, local: { ...draft.local, model: e.target.value } })}
                className="tabular rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] outline-none focus:border-ember/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">接口地址</span>
              <input
                value={draft.local.baseUrl}
                onChange={(e) => setDraft({ ...draft, local: { ...draft.local, baseUrl: e.target.value } })}
                className="tabular rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] outline-none focus:border-ember/60"
              />
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-accent/25 bg-accent/6 p-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-bold text-accent">
            <Dot tone={draft.cloud.apiKey ? "ok" : "idle"} />
            长上下文引擎(长直播增强)
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">
            一场 2-5 小时直播的逐句稿是 3-6 万字,超出本地窗口。切成块逐块判断会丢掉全局视角——
            这就是"选出来总不对"的根因。长上下文引擎能一次看完整场,理解整体节奏。
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">模型</span>
              <input
                value={draft.cloud.model}
                onChange={(e) => setDraft({ ...draft, cloud: { ...draft.cloud, model: e.target.value } })}
                className="tabular rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">API Key</span>
              <input
                type="password"
                value={draft.cloud.apiKey}
                placeholder="留空则只走本地"
                onChange={(e) => setDraft({ ...draft, cloud: { ...draft.cloud, apiKey: e.target.value } })}
                className="rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] outline-none focus:border-accent/60"
              />
            </label>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">接口协议</span>
              <select
                value={draft.cloudProtocol ?? "gemini-native"}
                onChange={(e) =>
                  setDraft({ ...draft, cloudProtocol: e.target.value as "gemini-native" | "openai-compatible" })
                }
                className="rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] outline-none focus:border-accent/60"
              >
                <option value="gemini-native">Google 官方（?key= 认证）</option>
                <option value="openai-compatible">第三方中转（Bearer 认证）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold text-mut-2">接口地址（留空=官方地址）</span>
              <input
                value={draft.cloudBaseUrl ?? ""}
                onChange={(e) => setDraft({ ...draft, cloudBaseUrl: e.target.value })}
                placeholder={
                  draft.cloudProtocol === "openai-compatible"
                    ? "https://api.apimart.ai/v1"
                    : "https://generativelanguage.googleapis.com/v1beta"
                }
                className="tabular rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[11.5px] outline-none focus:border-accent/60"
              />
            </label>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-mut-2">
            协议选错会一直 401/404：官方用 <code className="font-mono">?key=</code> 加{" "}
            <code className="font-mono">:generateContent</code>，第三方中转用{" "}
            <code className="font-mono">Bearer</code> 加 <code className="font-mono">/chat/completions</code>，两者不通。
          </p>
          <label className="mt-2.5 flex flex-col gap-1">
            <span className="text-[10.5px] font-bold text-mut-2">单次分析云端调用上限(防额度失控)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.cloudBudgetPerRun}
              onChange={(e) => setDraft({ ...draft, cloudBudgetPerRun: Math.max(1, Number(e.target.value) || 1) })}
              className="tabular w-28 rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent/60"
            />
          </label>

          {/* 代理：这一项决定了"API 用不了"到底是不是网络问题 */}
          <div className="mt-4 rounded-lg border border-line bg-panel-2/40 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="text-[10.5px] font-bold text-mut-2">出网代理</span>
              {engineTest?.proxy && (
                <span className="tabular rounded bg-panel px-1.5 py-0.5 font-mono text-[9.5px] text-mut-2">
                  实际走 {engineTest.proxy}
                </span>
              )}
            </div>
            <input
              value={draft.proxy}
              onChange={(e) => setDraft({ ...draft, proxy: e.target.value })}
              placeholder="留空自动：环境变量 &gt; Windows 系统代理"
              className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent/60"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-mut-2">
              开着 Clash/v2ray 时必须能走代理，否则连不上云端 —— 而表现和「key 失效」一模一样。
              形如 <code className="font-mono">http://127.0.0.1:4780</code>，端口看代理软件。
            </p>
            {engineTest?.proxyDetected && !draft.proxy.trim() && (
              <p className="mt-1 text-[10px] text-mut-2">
                已自动识别到系统代理 <code className="font-mono">{engineTest.proxyDetected}</code>
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 本地栈状态是否等价。用于避免 15s 轮询把整棵树重渲染(界面会闪)。 */
function sameStack(a: LocalStackStatus | null, b: LocalStackStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.hermes.ok !== b.hermes.ok) return false;
  if (a.ollama.ok !== b.ollama.ok) return false;
  if (a.ollama.models.length !== b.ollama.models.length) return false;
  return a.ollama.models.every((m, i) => m === b.ollama.models[i]);
}

export default function App(): React.JSX.Element {
  const session = useSession();
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);
  const [stack, setStack] = useState<{ status: LocalStackStatus | null; loading: boolean }>({ status: null, loading: true });
  const [engine, setEngine] = useState<EngineSettings | null>(null);
  const [showEngine, setShowEngine] = useState(false);

  /**
   * 当前选中的 IP 老师（爆款库里勾的那个）。
   *
   * 用自定义事件而不是 ref 直传：选 IP 的动作发生在 Workbench 里，
   * 而要用它的是这里的"打开项目"effect，两者是兄弟组件。
   * 事件是这里唯一干净的跨组件通道。
   *
   * 监听必须放在 useEffect 里 ——
   * 写在渲染函数体内会**每次渲染都挂一个新监听**，
   * 内存一直涨，而且回调闭包读到的是旧值。
   */
  const memoryIpIdRef = useRef<string | null>(null);
  useEffect(() => {
    const onPicked = (e: Event): void => {
      memoryIpIdRef.current = (e as CustomEvent<string | null>).detail ?? null;
    };
    window.addEventListener("glb:ip-picked", onPicked);
    return () => window.removeEventListener("glb:ip-picked", onPicked);
  }, []);

  useEffect(() => {
    setBridgeOk(hasBridge());
  }, []);

  // 探本地栈
  //
  // 2026-09-30 修"界面一直在闪"：原来每 15s 无条件 setStack(新对象)，
  // 而 setStack 挂在 App 上，会让整棵子树重新渲染 —— 正在播放的
  // <video>、选中的候选卡、滚动位置全部被重建，视觉上就是整页抖动。
  // 现在只在状态真的变化时才更新。
  useEffect(() => {
    if (!bridgeOk) return;
    let alive = true;
    const probe = async (): Promise<void> => {
      try {
        const status = await call((api) => api.localStackStatus());
        if (!alive) return;
        setStack((prev) => {
          if (!prev.loading && sameStack(prev.status, status)) return prev;
          return { status, loading: false };
        });
      } catch {
        if (!alive) return;
        setStack((prev) => (prev.status === null && !prev.loading ? prev : { status: null, loading: false }));
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bridgeOk]);

  // 恢复会话 + 读引擎设置
  useEffect(() => {
    if (!bridgeOk) return;
    let alive = true;
    void (async () => {
      try {
        const [workspace, outDir, settings] = await Promise.all([
          call((api) => api.projectWorkspaceGet()),
          call((api) => api.defaultOutDir()),
          call((api) => api.engineSettings())
        ]);
        if (!alive) return;
        session.setProjects(workspace.projects);
        session.setActiveProjectId(workspace.activeProjectId);
        session.setOutDir(outDir);
        setEngine(settings);
        if (workspace.activeProjectId) {
          const id = workspace.activeProjectId;
          const opened = await call((api) => api.projectOpen(id));
          if (alive && opened?.checkpoint) {
          /*
           * 打开老项目时也要套热词。
           *
           * 项目 JSON 里存的是**当时的**逐句稿副本。加了新热词规则之后，
           * 不套一遍的话用户重新打开项目看到的还是错字 ——
           * 而他刚在爆款库里明明加了规则，这就会被当成"没生效"。
           *
           * 归属用当前选中的 IP：那是界面上的显式选择，
           * 也是老项目能拿到的唯一归属线索。
           */
          let cp = opened.checkpoint;
          try {
            const rules = await call((api) => api.listHotwords(memoryIpIdRef.current ?? null));
            if (rules.length && cp.transcript) {
              cp = {
                ...cp,
                transcript: bridge().applyHotwordsToTranscript(cp.transcript, rules)
              };
            }
          } catch { /* 热词读不到就按原文显示，别卡住打开项目 */ }
          if (alive) session.restore(cp);
        }
        }
      } catch {
        /* 首次启动无工作区属正常 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridgeOk]);

  const refreshEngine = useCallback(async (): Promise<void> => {
    setEngine(await call((api) => api.engineSettings()));
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header
        className="z-10 flex h-12 shrink-0 items-center gap-3 border-b border-line/70 bg-panel/55 px-4 backdrop-blur-xl"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex shrink-0 items-center gap-2">
          <span className="flame-gradient flex h-6 w-6 items-center justify-center rounded-lg text-[13px] font-black text-white">
            G
          </span>
          <span className="text-[13px] font-extrabold tracking-tight">GLB Studio</span>
        </div>

        {/* 管线灯:一眼看到四步走到哪 */}
        {session.file && (
          <nav className="flex shrink-0 items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <span
              className={cx(
                "flex h-6.5 items-center gap-1.5 rounded-lg border px-2.5 text-[11px]",
                session.transcript ? "border-ok/30 bg-ok/8 text-ok" : session.transcribing ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut"
              )}
            >
              {session.transcript ? <LuCheck className="h-3 w-3" strokeWidth={3} /> : <Dot tone={session.transcribing ? "busy" : "idle"} />}
              转写
            </span>
            <span
              className={cx(
                "flex h-6.5 items-center gap-1.5 rounded-lg border px-2.5 text-[11px]",
                session.candidates ? "border-ok/30 bg-ok/8 text-ok" : session.detecting ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut"
              )}
            >
              {session.candidates ? <LuCheck className="h-3 w-3" strokeWidth={3} /> : <Dot tone={session.detecting ? "busy" : "idle"} />}
              爆点
              {session.candidates && <span className="tabular font-mono text-[10px] opacity-80">{session.candidates.length}</span>}
            </span>
            <span
              className={cx(
                "flex h-6.5 items-center gap-1.5 rounded-lg border px-2.5 text-[11px]",
                session.stage === "exporting" ? "border-ember/50 bg-ember/10 text-ember" : session.selected.size > 0 ? "border-line text-fg/80" : "border-line text-mut"
              )}
            >
              <Dot tone={session.stage === "exporting" ? "busy" : session.selected.size > 0 ? "ok" : "idle"} />
              出片
            </span>
          </nav>
        )}

        <div className="flex-1" />

        <StatusLamp
          ok={bridgeOk === null ? null : bridgeOk}
          loading={bridgeOk === null}
          icon={<LuCpu className="h-3.5 w-3.5" />}
          label="主进程"
        />
        <StatusLamp
          ok={stack.status?.ollama.ok ?? null}
          loading={stack.loading}
          icon={<LuFilm className="h-3.5 w-3.5" />}
          label="Ollama"
          detail={stack.status?.ollama.models.join(" · ")}
        />
        <StatusLamp
          ok={stack.status?.hermes.ok ?? null}
          loading={stack.loading}
          icon={<LuBrain className="h-3.5 w-3.5" />}
          label="Hermes"
        />
        <button
          type="button"
          onClick={() => void refreshEngine().then(() => setShowEngine(true))}
          title="引擎设置"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
        >
          <LuSettings className="h-3.5 w-3.5" />
          引擎
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          title="重新探测本地栈"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:border-mut hover:text-fg"
        >
          <LuRefreshCw className={cx("h-3.5 w-3.5", stack.loading && "spin-slow")} />
        </button>
      </header>

      {/* 主区 */}
      {bridgeOk === false ? (
        <main className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="pop-in flex max-w-xl flex-col items-center gap-4 rounded-2xl border border-bad/30 bg-bad/8 p-8 text-center">
            <LuCircleAlert className="h-9 w-9 text-bad" />
            <div>
              <h2 className="text-[15px] font-extrabold">未连接到主进程</h2>
              <p className="mt-2 text-[12.5px] leading-relaxed text-mut">
                预加载桥没有注入成功,界面无法调用本地能力(转写、爆点检测、出片)。
              </p>
            </div>
            <details className="w-full text-left">
              <summary className="cursor-pointer text-[11.5px] font-semibold text-mut-2 hover:text-mut">
                技术细节
              </summary>
              <pre className="scroll-thin mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel-2 p-3 text-[10.5px] leading-relaxed text-mut">
                {BRIDGE_HINT}
              </pre>
            </details>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setBridgeOk(hasBridge());
                }}
                className="btn-flame rounded-lg px-5 py-2 text-[12.5px] font-bold text-white"
              >
                重新检测
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-line px-5 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:text-fg"
              >
                重新加载界面
              </button>
            </div>
          </div>
        </main>
      ) : session.file ? (
        <Workbench engine={engine} onOpenSettings={() => void refreshEngine().then(() => setShowEngine(true))} />
      ) : (
        <>
          {!stack.status?.hermes.ok && !stack.loading && (
            <div className="flex shrink-0 items-center gap-3 border-b border-warn/25 bg-warn/8 px-4 py-2.5">
              <Dot tone="warn" />
              <span className="text-[12px] text-warn/90">
                <b>Hermes 算法服务未运行。</b>转写、爆点检测与成片都由它承担,
                请先双击 <code className="rounded bg-black/30 px-1">启动GLB.cmd</code> 启动全家桶。
              </span>
            </div>
          )}
          <ImportStage />
        </>
      )}

      {showEngine && engine && <EnginePanel settings={engine} onClose={() => setShowEngine(false)} />}
    </div>
  );
}
