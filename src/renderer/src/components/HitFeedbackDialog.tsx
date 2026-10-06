/**
 * 爆款预测更正弹窗
 *
 * 两个设计上的取舍，都跟"别让用户误判"有关：
 *
 * 1. **截图是主路径，手填是兜底。**
 *    用户手上通常就有那张数据截图，直接 OCR 比手敲五个数字快得多。
 *    但 OCR 可能读错，所以识别结果会**回填到输入框里让用户核对** ——
 *    不能悄悄用 OCR 的结果当事实写进库。
 *
 * 2. **发之前必须压图。**
 *    Hermes 的 express.json 上限 15mb，base64 还要再放大 4/3，
 *    所以手机直出截图（几 MB 到十几 MB）必然超。
 *    这里压到 1200px / jpeg 0.82，压完还超就明确报错，
 *    不做静默截断（截断出来的图 OCR 出来是错的，比失败更糟）。
 *
 * @author 郭洛斌
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LuImageUp, LuLoader, LuRefreshCw, LuX } from "react-icons/lu";
import { call } from "../lib/bridge";
import { Modal, cx } from "./ui";
import type { HitEntry } from "@shared/api-types";

interface Props {
  entry: HitEntry;
  /** 传进来是为了按 IP 定位 Hermes 侧的 collection */
  ipName: string;
  onClose: () => void;
  onDone: (msg: { tone: "ok" | "warn"; text: string }) => void;
}

/** Hermes 的 express.json 上限 15mb，base64 放大 4/3 之后要留足余量 */
const MAX_BYTES = 6 * 1024 * 1024;

function formatCount(n?: number | null): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(Math.round(v));
}

async function fileToCompressedDataUrl(file: File): Promise<{ dataUrl: string; note: string }> {
  /*
   * 用 createImageBitmap + OffscreenCanvas 压图。
   * 不走 <img> + canvas 那条路：它在 file:// 下有时会因为
   * canvas 被污染而抛 SecurityError（图片是本地 blob 也一样）。
   */
  const bmp = await createImageBitmap(file);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到画布，压图失败");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
  if (bytes > MAX_BYTES) {
    throw new Error(`压到 ${w}×${h} 仍有 ${(bytes / 1024 / 1024).toFixed(1)}MB，超出上限；请换一张小一点的截图`);
  }
  const note = bmp.width !== w || bmp.height !== h ? `已压到 ${w}×${h}` : "";
  return { dataUrl, note };
}

export function HitFeedbackDialog({ entry, ipName, onClose, onDone }: Props): React.JSX.Element {
  const [views, setViews] = useState("");
  const [likes, setLikes] = useState("");
  const [comments, setComments] = useState("");
  const [shares, setShares] = useState("");
  const [platform, setPlatform] = useState("");
  const [note, setNote] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [shotName, setShotName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<"ocr" | "send" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const p = entry.prediction;
  useEffect(() => {
    // 用真实回流数据预填（比预测更可信），没有才留空
    setViews(entry.metrics.views ? String(entry.metrics.views) : "");
    setLikes(entry.metrics.likes ? String(entry.metrics.likes) : "");
    setComments(entry.metrics.comments ? String(entry.metrics.comments) : "");
    setShares(entry.metrics.shares ? String(entry.metrics.shares) : "");
    setPlatform("");
    setNote("");
    setShot(null);
    setShotName(null);
    setMsg(null);
  }, [entry.id]);

  /** Hermes 侧的 id：按源文件路径查，查不到就是还没同步 */
  const resolveHitId = useCallback(async (): Promise<number | null> => {
    const id = await call((api) => api.hitResolveHermesId(ipName, entry.sourcePath));
    if (id == null) {
      setMsg({ tone: "warn", text: "这条素材还没同步到 Hermes，先点「从历史爆款库同步」再更正。" });
    }
    return id;
  }, [entry.sourcePath, ipName]);

  const pickShot = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy("ocr");
    setMsg(null);
    try {
      const { dataUrl, note: sizeNote } = await fileToCompressedDataUrl(file);
      setShot(dataUrl);
      setShotName(`${file.name}${sizeNote ? `（${sizeNote}）` : ""}`);
      setMsg({ tone: "ok", text: `截图已就绪${sizeNote ? `，${sizeNote}` : ""}。点「识别」让 Hermes 读数，读完记得核对。` });

      // 直接送去 OCR：省得用户再点一次
      const hitId = await resolveHitId();
      if (hitId == null) return;
      const r = await call((api) => api.hitFeedback({ hitId, screenshot: dataUrl, note: "" }));
      if (!r.ok) {
        setMsg({ tone: "warn", text: `截图已附上，但识别失败：${r.error ?? "原因不明"}。可以手填数字。` });
        return;
      }
      // OCR 结果只回填输入框，不直接当事实写库
      const o = (r.ocr ?? {}) as Record<string, unknown>;
      const fill = (v: unknown): string => (Number.isFinite(Number(v)) && Number(v) > 0 ? String(Math.round(Number(v))) : "");
      setViews((cur) => cur || fill(o.views));
      setLikes((cur) => cur || fill(o.likes));
      setComments((cur) => cur || fill(o.comments));
      setShares((cur) => cur || fill(o.shares));
      if (r.platform) setPlatform(r.platform);
      const read = [o.views, o.likes, o.comments, o.shares].filter((x) => Number(x) > 0).length;
      setMsg({
        tone: read > 0 ? "ok" : "warn",
        text: read > 0
          ? `识别到 ${read} 项数字，已填进下面，请核对后再提交。`
          : "没能从截图里读出数字。可以手填，或换一张更清晰的截图。"
      });
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const submit = async (): Promise<void> => {
    const num = (s: string): number | null => (s.trim() === "" ? null : Math.max(0, Math.round(Number(s) || 0)));
    if (!shot && !views.trim() && !likes.trim() && !comments.trim() && !shares.trim()) {
      setMsg({ tone: "warn", text: "至少给一个数字，或者附一张截图。" });
      return;
    }
    setBusy("send");
    try {
      const hitId = await resolveHitId();
      if (hitId == null) {
        setBusy(null);
        return;
      }
      const r = await call((api) => api.hitFeedback({
        hitId,
        views: num(views),
        likes: num(likes),
        comments: num(comments),
        shares: num(shares),
        platform,
        note,
        screenshot: shot ?? ""
      }));
      if (!r.ok) {
        setMsg({ tone: "warn", text: `提交失败：${r.error ?? "原因不明"}` });
        return;
      }
      const pred = (r.prediction ?? {}) as { viewsLow?: number; viewsHigh?: number; confidence?: string };
      const lo = Number(pred.viewsLow);
      const hi = Number(pred.viewsHigh);
      const range = Number.isFinite(lo) && Number.isFinite(hi) && hi > 0 ? `${formatCount(lo)}~${formatCount(hi)}` : "—";
      onDone({
        tone: "ok",
        text: `已记入真实数据，预测更新为 ${range} 播放（把握${pred.confidence || "低"}）。`
      });
      onClose();
    } catch (err) {
      setMsg({ tone: "warn", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const numInput = (label: string, val: string, set: (s: string) => void, ph: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold text-mut">{label}</span>
      <input
        value={val}
        onChange={(e) => set(e.target.value)}
        inputMode="numeric"
        placeholder={ph}
        className="rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] outline-none focus:border-ember/60"
      />
    </label>
  );

  return (
    <Modal
      title={`更正爆款数据 · ${entry.title.slice(0, 24)}`}
      subtitle="真实数据会用来校准这位老师的爆款感，并重算这条的预测"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy !== null}
            className="btn-flame flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
          >
            {busy === "send" ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuRefreshCw className="h-3.5 w-3.5" />}
            提交并重算预测
          </button>
        </>
      }
    >
      {/* 当前预测：让用户对着"猜的"和"真的"做比较 */}
      {p?.viewsLow != null && (
        <div className="mb-3 rounded-lg border border-line/70 bg-panel-2/40 px-2.5 py-2">
          <div className="flex items-center gap-2 text-[10px] font-bold text-mut-2">
            当前预测
            <span className="tabular font-mono text-[12px] text-fg">
              {formatCount(p.viewsLow)}~{formatCount(p.viewsHigh)} 播放
            </span>
            <span className="font-semibold text-mut">把握{p.confidence || "低"}</span>
          </div>
          {p.rationale && <p className="mt-1 text-[10.5px] leading-relaxed text-mut-2">{p.rationale}</p>}
        </div>
      )}

      {/* 截图主路径 */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-bold text-fg">数据截图</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickShot(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold text-mut transition-colors hover:border-ember/45 hover:text-fg disabled:opacity-50"
          >
            {busy === "ocr" ? <LuLoader className="h-3 w-3 animate-spin" /> : <LuImageUp className="h-3 w-3" />}
            {shot ? "换一张" : "选择截图"}
          </button>
        </div>
        {shotName ? (
          <div className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/8 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{shotName}</span>
            <button
              type="button"
              onClick={() => {
                setShot(null);
                setShotName(null);
              }}
              title="移除截图"
              className="shrink-0 text-mut-2 hover:text-fg"
            >
              <LuX className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line/70 px-2.5 py-3 text-[10.5px] leading-relaxed text-mut-2">
            截图会自动识别播放/点赞/评论/转发和平台，识别结果会填进下面的输入框让你核对。
            大图会先压到 1200px 再发，避免超��大小限制导致失败。
          </p>
        )}
      </div>

      {/* 手填兜底 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {numInput("播放", views, setViews, "如 120000")}
        {numInput("点赞", likes, setLikes, "如 3200")}
        {numInput("评论", comments, setComments, "如 180")}
        {numInput("转发/收藏", shares, setShares, "如 90")}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-mut">平台</span>
          <input
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="视频号/抖音/小红书/快手/B站"
            className="rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] outline-none focus:border-ember/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-mut">备注</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="选填，比如这条是投流推的"
            className="rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] outline-none focus:border-ember/60"
          />
        </label>
      </div>

      {msg && (
        <p
          className={cx(
            "mt-2.5 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed",
            msg.tone === "ok" ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
          )}
        >
          {msg.text}
        </p>
      )}
    </Modal>
  );
}