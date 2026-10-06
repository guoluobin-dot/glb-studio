/**
 * 预览播放器
 * © 2026 郭洛斌
 *
 * 为什么必须自研而不是用现成控件:要跟时间轴、逐句稿、候选卡三处共用同一个
 * currentTime,任何一处跳转都要同步另外两处。现成播放器控件拿不到播放头,
 * 自己拿 <video> 元素反而更直接。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LuMaximize,
  LuPause,
  LuPlay,
  LuSkipBack,
  LuSkipForward,
  LuVolume2,
  LuVolumeX
} from "react-icons/lu";
import { call } from "../lib/bridge";
import { cx } from "./ui";
import { formatClock } from "../lib/format";

/** 播放头订阅:时间轴与逐句稿都靠它跟着画面走 */
export interface PlaybackApi {
  currentTime: number;
  duration: number;
  playing: boolean;
  seek: (sec: number) => void;
  toggle: () => void;
  /**
   * 暂停。
   *
   * 必须单独提供而不是靠 toggle：正在播时 toggle 是暂停（对），
   * 但已经暂停时再 toggle 就变成播放了。
   * 框选文案时要求"按下就停"，如果那时恰好已暂停，
   * 用 toggle 反而把视频放了起来 —— 正好和意图相反。
   */
  pause: () => void;
}

interface Props {
  filePath: string;
  /** 外部(如点候选卡/点逐句稿)要求跳转到的秒数 */
  seekTo?: number | null;
  /** 段落区间,用于在画面上标出当前选中的范围 */
  markers?: Array<{ id: number; startSec: number; endSec: number; selected: boolean }>;
  focusedId?: number | null;
  onTime?: (sec: number) => void;
  onDuration?: (sec: number) => void;
  registerApi?: (api: PlaybackApi | null) => void;
  /** 打开就播。预览成片时用,工作台里不自动播(避免抢声音) */
  autoPlay?: boolean;
  /** 外层高度。预览成片时要固定高度,不能让它撑满整列 */
  heightClass?: string;
}

export function PreviewPlayer({
  filePath,
  seekTo = null,
  markers = [],
  focusedId = null,
  onTime,
  onDuration,
  registerApi,
  autoPlay = false,
  heightClass = "min-h-0 flex-1"
}: Props): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 记录最后一次主动跳转,避免 timeupdate 回写把位置又拽回去 */
  const seekTarget = useRef<number | null>(null);

  // 取流:切换素材时重新向主进程要 URL
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setLoadError(null);
    setCurrentTime(0);
    setDuration(0);
    // 切素材必须重置倍速与音量状态,否则上一条的设置会串到下一条
    setRate(1);
    setVolume(1);
    setMuted(false);
    void (async () => {
      try {
        const url = await call((api) => api.mediaOpen(filePath));
        if (alive) setSrc(url);
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
      void call((api) => api.mediaClose(filePath)).catch(() => undefined);
    };
  }, [filePath]);

  const seek = useCallback((sec: number): void => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(sec, v.duration || sec));
    v.currentTime = clamped;
    seekTarget.current = clamped;
    setCurrentTime(clamped);
    onTime?.(clamped);
  }, [onTime]);

  // 打开就播(仅预览成片时开)。等元数据到了再 play,
  // 否则 autoplay 会被浏览器策略挡掉,表现为"点了没反应"。
  useEffect(() => {
    if (!autoPlay) return;
    const v = videoRef.current;
    if (!v || v.readyState < 1) return;
    void v.play().catch(() => undefined);
  }, [autoPlay, src, loadError]);

  // 外部请求跳转
  useEffect(() => {
    if (seekTo === null || !Number.isFinite(seekTo)) return;
    seek(seekTo);
  }, [seekTo, seek]);

  // 把播放控制能力交给上层(时间轴播放按钮/快捷键用)。
  // 没有传 registerApi 的场合(比如预览成片)直接跳过,别去污染别人的 api。
  useEffect(() => {
    if (!registerApi) return;
    registerApi({
      currentTime,
      duration,
      playing,
      seek,
      toggle: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play();
        else v.pause();
      },
      // 幂等暂停：已经停了再调一次不会有副作用（toggle 不行）
      pause: () => {
        videoRef.current?.pause();
      }
    });
    return () => registerApi(null);
  }, [currentTime, duration, playing, registerApi, seek]);

  // 聚焦候选时,若播放头不在该段内,自动跳到段首
  useEffect(() => {
    if (focusedId === null) return;
    const m = markers.find((x) => x.id === focusedId);
    if (!m) return;
    setCurrentTime((t) => (t >= m.startSec && t <= m.endSec ? t : m.startSec));
  }, [focusedId, markers]);

  return (
    <div className={cx("flex flex-col gap-0 overflow-hidden rounded-xl border border-line bg-black/45", heightClass)}>
      <div className="relative min-h-0 flex-1 bg-black">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              setDuration(d);
              onDuration?.(d);
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              // 主动跳转后的第一帧不算"用户在看",跳过避免抖动
              if (seekTarget.current !== null && Math.abs(t - seekTarget.current) < 0.35) {
                seekTarget.current = null;
                setCurrentTime(t);
                onTime?.(t);
                return;
              }
              setCurrentTime(t);
              onTime?.(t);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setLoadError("无法播放该素材(编码不受支持或文件被占用)")}
            onClick={() => {
              const v = videoRef.current;
              if (v) {
                if (v.paused) void v.play();
                else v.pause();
              }
            }}
          />
        ) : loadError ? (
          <div className="flex h-full items-center justify-center p-4 text-center">
            <p className="max-w-sm text-[11.5px] leading-relaxed text-bad/90">{loadError}</p>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[11.5px] text-mut-2">正在打开素材…</p>
          </div>
        )}
      </div>

      {/* 控制条 */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-line/70 bg-panel-2/80 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (v) {
              if (v.paused) void v.play();
              else v.pause();
            }
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-ember/60 hover:text-ember"
          title={playing ? "暂停(空格)" : "播放(空格)"}
        >
          {playing ? <LuPause className="h-3.5 w-3.5" /> : <LuPlay className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => seek(currentTime - 5)}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-ember/60 hover:text-ember"
          title="后退 5 秒"
        >
          <LuSkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => seek(currentTime + 5)}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-ember/60 hover:text-ember"
          title="前进 5 秒"
        >
          <LuSkipForward className="h-3.5 w-3.5" />
        </button>

        <span className="tabular ml-1 font-mono text-[11px] text-mut">
          {formatClock(currentTime)} / {formatClock(duration)}
        </span>

        {/* 倍速:审片时 2× 快过、0.5× 慢看细节,是高频需求。
            只靠 ±5 秒不够,看不清嘴型/手势时必须能慢放。 */}
        <button
          type="button"
          onClick={() => {
            const rates = [1, 1.5, 2, 0.5, 0.25];
            const cur = rates.indexOf(rate);
            const idx = cur < 0 ? 0 : (cur + 1) % rates.length;
            const next = rates[idx] ?? 1;
            setRate(next);
            const v = videoRef.current;
            if (v) v.playbackRate = next;
          }}
          title="切换倍速（审片常用慢放/快过）"
          className="tabular rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-mut transition-colors hover:border-ember/60 hover:text-ember"
        >
          {rate}×
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            // 静音与音量分开:静音是临时开关,音量条才是真实值。
            // 只留静音按钮时,想调音量就得取消静音再猜原来多少。
            v.muted = !v.muted;
            setMuted(v.muted);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-ember/60 hover:text-ember"
          title={muted ? "取消静音" : "静音"}
        >
          {muted || volume === 0 ? <LuVolumeX className="h-3.5 w-3.5" /> : <LuVolume2 className="h-3.5 w-3.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            setMuted(v === 0);
            const el = videoRef.current;
            if (el) {
              el.volume = v;
              el.muted = v === 0;
            }
          }}
          title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%`}
          className="w-16 accent-[var(--color-flame)]"
        />
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (v?.requestFullscreen) void v.requestFullscreen();
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-ember/60 hover:text-ember"
          title="全屏"
        >
          <LuMaximize className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
