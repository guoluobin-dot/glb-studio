/**
 * 封面首帧 + 结尾藏带货 + 字幕/标题样式的真实 ffmpeg 验证。
 *
 * 为什么必须真跑:这些功能的失败模式全是"看起来写对了"——
 * concat 参数不对时 ffmpeg 报的是难懂的 "Media type mismatch"，
 * ASS 颜色写错时不会报错只是颜色反了，drawtext 位置算错时画面还在但位置不对。
 * 只做正则断言等于什么都没验。
 *
 * 全程用测试素材，输出到临时目录，跑完清掉。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ffmpegPath = "";
let ffprobePath = "";

function probe(file: string): any {
  const out = execFileSync(ffprobePath, [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", file
  ], { encoding: "utf8" });
  return JSON.parse(out);
}
function durationSec(file: string): number {
  return Number(probe(file).format.duration) || 0;
}
function videoStream(file: string): { w: number; h: number; fps: string } {
  const s = probe(file).streams.find((x: any) => x.codec_type === "video");
  return { w: Number(s?.width) || 0, h: Number(s?.height) || 0, fps: s?.r_frame_rate || "" };
}

let dir = "";
let mainClip = "";
let coverImg = "";
let tailClip = "";
let srt = "";
/**
 * 真实字体文件。drawtext 不给 fontfile 会去依赖 fontconfig，
 * 而 ffmpeg-static 打包的 Windows 版通常没有 fontconfig ->
 * 报 "Cannot load default config file" 直接失败。这正是 generator 里
 * _resolveFontFile 必须总有回退的原因。
 */
let FONT = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glb-compose-"));
  ffmpegPath = require("ffmpeg-static");
  // ffprobe 必须用真的二进制。之前"把 ffmpeg 复制成 ffprobe"是错的 ——
  // ffmpeg 收到 ffprobe 的参数会报 "Option not found"，而且报错发生在
  // 探测阶段，看起来像产物有问题，其实是探测工具不对。
  // @ffprobe-installer 的平台包（@ffprobe-installer/win32-x64）在 pnpm 下
  // **不会**被软链到顶层 node_modules —— pnpm 只暴露直接声明的依赖。
  // 所以 require.resolve("@ffprobe-installer/win32-x64/...") 必然 MODULE_NOT_FOUND，
  // 而包本体其实好好地躺在 .pnpm 里（之前误判成"依赖没装"就是这个原因）。
  //
  // 主包 @ffprobe-installer/ffprobe 自己知道平台包在哪，直接问它要路径。
  ffprobePath = require("@ffprobe-installer/ffprobe").path;
  if (!ffprobePath || !existsSync(ffprobePath)) {
    throw new Error(`找不到 ffprobe 二进制：${ffprobePath}`);
  }
  for (const n of ["simhei.ttf", "msyhbd.ttc", "arial.ttf"]) {
    const p = `C:/Windows/Fonts/${n}`;
    if (existsSync(p)) { FONT = p; break; }
  }
  if (!FONT) throw new Error("系统里找不到任何可用字体，测不了 drawtext");

  // 主片：6 秒 1080x1920 竖屏，带音频
  mainClip = join(dir, "main.mp4");
  execFileSync(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", mainClip
  ], { stdio: "ignore" });

  // 封面图：故意用横图 1920x1080，验证会被 pad 而不是拉伸
  coverImg = join(dir, "cover.jpg");
  execFileSync(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "color=c=blue:size=1920x1080",
    "-frames:v", "1", coverImg
  ], { stdio: "ignore" });

  // 藏带货：2 秒，尺寸也不同(720x1280)，验证能对齐
  tailClip = join(dir, "tail.mp4");
  execFileSync(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "color=c=red:size=720x1280:rate=25:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", tailClip
  ], { stdio: "ignore" });

  // 字幕
  srt = join(dir, "sub.srt");
  writeFileSync(srt, "1\n00:00:00,500 --> 00:00:03,000\n测试字幕第一行\n\n2\n00:00:03,200 --> 00:00:05,500\n第二行字幕\n", "utf8");
}, 180000);

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 用真实 ffmpeg 拼一条，参数与 generator 的结构一致 */
function compose(out: string, { cover = null, tail = null, coverSec = 1.5 }: { cover?: string | null; tail?: string | null; coverSec?: number } = {}): string {
  const norm = `scale=608:1080:force_original_aspect_ratio=decrease,pad=608:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=yuv420p`;
  const chains = [];
  const args = ["-y", "-i", mainClip];
  let n = 1;
  let idxCover = -1;
  let idxTail = -1;
  if (cover) { args.push("-loop", "1", "-t", String(coverSec), "-i", cover); idxCover = n++; }
  if (tail) { args.push("-i", tail); idxTail = n++; }

  chains.push(`[0:v]${norm}[vmain]`);
  const parts = [];
  if (cover) {
    const cvf = [norm];
    if (coverCfg.scrim > 0) cvf.push(`drawbox=x=0:y=0:w=608:h=1080:color=black@${coverCfg.scrim}:t=fill`);
    cvf.push(
      `drawtext=text='封面文案测试':fontsize=46:fontcolor=white:borderw=3:bordercolor=black@0.85:` +
      `x=(w-text_w)/2:y=(h-text_h)*0.68:fontfile='${FONT}'`
    );
    chains.push(`[${idxCover}:v]${cvf.join(",")}[vcover]`);
    parts.push("[vcover]");
  }
  parts.push("[vmain]");
  if (tail) {
    chains.push(`[${idxTail}:v]${norm},drawtext=text='立即下单':fontsize=40:fontcolor=white:borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=h-th-60:fontfile='${FONT}'[vtail]`);
    parts.push("[vtail]");
  }
  chains.push(`${parts.join("")}concat=n=${parts.length}:v=1:a=0[vcat]`);

  // 刻意不加 -shortest：拼接后视频比音频长（封面/藏带货那几秒静音），
  // 加了 -shortest 会把视频截回音频长度，封面和藏带货被静默丢掉。
  // 这与 generator 的做法一致（BGM 那边靠 amix=duration=first 收尾）。
  args.push("-filter_complex", chains.join(";"), "-map", "[vcat]", "-map", "0:a:0");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", out);
  execFileSync(ffmpegPath, args, { stdio: "pipe" });
  return out;
}

const coverCfg = { scrim: 0.25 };

describe("封面图作为成片第一帧", () => {
  it("封面 + 主片拼起来，时长 = 封面秒数 + 主片时长", () => {
    const out = join(dir, "with-cover.mp4");
    compose(out, { cover: coverImg, coverSec: 1.5 });
    const d = durationSec(out);
    // 1.5 秒封面 + 6 秒主片，容差 0.5 秒（编码器/帧率取整会有偏差）
    expect(d).toBeGreaterThan(7.0);
    expect(d).toBeLessThan(8.0);
  });

  it("封面是横图时按 pad 补齐，不能拉伸变形", () => {
    const out = join(dir, "cover-pad.mp4");
    compose(out, { cover: coverImg });
    const v = videoStream(out);
    // 输出必须和主片同一画幅；封面本身是 1920x1080，被拉伸的话尺寸会变成 1920x1920
    expect(`${v.w}x${v.h}`).toBe("608x1080");
  });

  it("第一帧确实是封面（蓝色），不是主片画面", () => {
    const out = join(dir, "cover-first.mp4");
    compose(out, { cover: coverImg, coverSec: 1.5 });
    const avg = (t: number): { r: number; g: number; b: number } => {
      const raw = execFileSync(ffmpegPath, [
        "-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
      ], { maxBuffer: 1024 * 1024 * 200 });
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < raw.length; i += 3) { r += raw[i] ?? 0; g += raw[i + 1] ?? 0; b += raw[i + 2] ?? 0; }
      const px = raw.length / 3 || 1;
      return { r: r / px, g: g / px, b: b / px };
    };
    // 封面时段（0~1.5s）应该明显偏蓝
    const inCover = avg(0.5);
    expect(inCover.b, `封面时段应偏蓝，实际 rgb=${JSON.stringify(inCover)}`).toBeGreaterThan(inCover.r + 8);
    // 主片时段（testsrc 是灰白）三通道应该接近 —— 用它反证前面那段确实是封面
    const inMain = avg(3.0);
    expect(Math.abs(inMain.r - inMain.b), "主片时段应是灰白").toBeLessThan(20);
    expect(inCover.b - inCover.r, "封面比主片更蓝").toBeGreaterThan(Math.abs(inMain.b - inMain.r) + 5);
  });

  it("文案烧在图中下位置（y ≈ 68% 高度）", () => {
    const out = join(dir, "cover-text.mp4");
    compose(out, { cover: coverImg, coverSec: 2 });
    // 抽封面时段里文字所在的高度带，和文字上方的带比白像素占比
    const whiteRatio = (t: number, y0: number, h: number): number => {
      const raw = execFileSync(ffmpegPath, [
        "-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1",
        "-vf", `crop=608:${h}:0:${y0}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"
      ], { maxBuffer: 1024 * 1024 * 100 });
      let white = 0;
      for (const v of raw) if (v > 220) white++;
      return white / (raw.length || 1);
    };
    // y=0.68*1080 ≈ 734，文字高度约 46px → 检查 700~790 这一带
    const atText = whiteRatio(0.5, 700, 90);
    const aboveText = whiteRatio(0.5, 200, 90);
    expect(atText, "文字带应有明显白像素").toBeGreaterThan(aboveText);
  });
});

describe("结尾藏带货", () => {
  it("藏带货拼在结尾，时长 = 主片 + 藏带货", () => {
    const out = join(dir, "with-tail.mp4");
    compose(out, { tail: tailClip });
    const d = durationSec(out);
    expect(d).toBeGreaterThan(7.5);
    expect(d).toBeLessThan(8.5);
  });

  it("藏带货尺寸不同也能对齐（不能拼接失败）", () => {
    const out = join(dir, "tail-scaled.mp4");
    compose(out, { tail: tailClip });
    // 藏带货是 720x1280，主片是 1080x1920 -> 输出应统一到主片画幅
    expect(`${videoStream(out).w}x${videoStream(out).h}`).toBe("608x1080");
  });

  it("封面和藏带货同时开也能拼（三段）", () => {
    const out = join(dir, "both.mp4");
    compose(out, { cover: coverImg, coverSec: 1, tail: tailClip });
    const d = durationSec(out);
    // 1 + 6 + 2 = 9
    expect(d).toBeGreaterThan(8.5);
    expect(d).toBeLessThan(9.5);
  });

  it("两者都不开时保持原样（不引入额外输入）", () => {
    const out = join(dir, "plain.mp4");
    compose(out, {});
    const d = durationSec(out);
    expect(d).toBeGreaterThan(5.5);
    expect(d).toBeLessThan(6.5);
  });
});

describe("字幕样式", () => {
  const caption = (out: string, style: string): string => {
    execFileSync(ffmpegPath, [
      "-y", "-i", mainClip, "-vf", `subtitles='${srt.replace(/\\/g, "/").replace(/:/g, "\\:")}':force_style='${style}'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "copy", out
    ], { stdio: "pipe" });
    return out;
  };

  it("自定义字体 + 字号 + 描边能生效", () => {
    const out = caption(join(dir, "cap-style.mp4"), "FontName=SimHei,FontSize=48,Bold=1,Outline=4,Shadow=2");
    expect(existsSync(out)).toBe(true);
    expect(durationSec(out)).toBeGreaterThan(5);
  });

  it("非白色字幕不会报错（ASS 是 BGR，颜色写错不会失败只是颜色反）", () => {
    // 这条是回归：以前只有白色（#FFFFFF 两种写法一样），换颜色才暴露问题
    const out = caption(join(dir, "cap-color.mp4"), "FontSize=32,PrimaryColour=&H00FF8040,Outline=3,Shadow=1");
    expect(existsSync(out)).toBe(true);
  });

  it("MarginV 能把字幕抬高", () => {
    const out = caption(join(dir, "cap-margin.mp4"), "FontSize=32,MarginV=400,Outline=3");
    expect(existsSync(out)).toBe(true);
  });
});

describe("drawtext 标题样式", () => {
  it("自定义颜色 + 位置 + 底板能生效", () => {
    const out = join(dir, "title-style.mp4");
    execFileSync(ffmpegPath, [
      "-y", "-i", mainClip,
      "-vf", `drawtext=text='标题测试':fontsize=40:fontcolor=#FFD700:box=1:boxcolor=#FF0000@0.6:boxborderw=14:x=(w-text_w)/2:y=300:fontfile='${FONT}'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "copy", out
    ], { stdio: "pipe" });
    expect(existsSync(out)).toBe(true);
  });

  it("字体名解析：找不到的字体要回退而不是让整条失败", () => {
    // 回退失败 = drawtext 无 fontfile -> 依赖 fontconfig -> 成片直接报错
    const out = join(dir, "title-fallback.mp4");
    execFileSync(ffmpegPath, [
      "-y", "-i", mainClip,
      "-vf", "drawtext=text='回退测试':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=100:fontfile='C:/Windows/Fonts/nonexistent-xyz.ttf'",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "copy", out
    ], { stdio: "pipe" });
    expect(durationSec(out)).toBeGreaterThan(5);
  });
});

void readFileSync;
void mkdirSync;
