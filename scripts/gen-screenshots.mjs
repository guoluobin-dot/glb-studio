#!/usr/bin/env node
/**
 * 生成界面示意图（不抓真实窗口）
 *
 * 为什么不用屏幕截图：
 *   1. 抓屏会连带抓到桌面上别的窗口 —— 实测抓到过浏览器窗口，
 *      书签栏里全是别的项目的敏感信息（token 站、AI 工具站）。
 *   2. 真实界面里有用户的真实数据（IP 老师名、素材文件名），
 *      仓库是公开的，抓屏必然泄露。
 *   3. 焦点会跳。坐标点击在多窗口环境下不可靠，点到了别的应用上。
 *
 * 所以这里的做法：用真实的样式和文案，画一张**不含任何用户数据**的示意图。
 * 图上出现的每个字段都是写死的示例值。
 *
 * 好处：任何人 clone 下来都能重新生成，不需要跑起整个应用。
 * 坏处：不是运行时的真实截图。所以图上标了"示意图"。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");

// 与 src/renderer/src/styles.css 的深色主题对齐
const C = {
  bg: "#0b0d12",
  panel: "#141821",
  panel2: "#1b2029",
  border: "#252b36",
  text: "#e8ecf3",
  dim: "#8b95a7",
  faint: "#5c6577",
  accent: "#ff6a1f",
  accentDim: "#8a3d14",
  green: "#3ddc84",
  blue: "#4a9eff",
  yellow: "#ffcc4d",
};

const S = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="'Segoe UI','Microsoft YaHei',sans-serif">
  <rect width="${w}" height="${h}" fill="${C.bg}"/>
${body}
</svg>`;

const text = (x, y, t, { size = 14, fill = C.text, weight = 400, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${t}</text>`;

const box = (x, y, w, h, { fill = C.panel, stroke = C.border, r = 8, sw = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

/** 顶栏：应用名 + 服务状态灯 */
const header = (w) => {
  let s = box(0, 0, w, 52, { fill: C.panel2, stroke: "none", r: 0 });
  s += `<circle cx="26" cy="26" r="9" fill="${C.accent}"/>`;
  s += text(26, 31, "G", { size: 12, fill: "#fff", weight: 700, anchor: "middle" });
  s += text(44, 31, "GLB Studio", { size: 16, weight: 600 });
  // 三个状态灯
  const lamps = [
    { x: w - 300, label: "主进程", color: C.green },
    { x: w - 205, label: "Ollama", color: C.green },
    { x: w - 118, label: "Hermes", color: C.green },
  ];
  for (const l of lamps) {
    s += box(l.x, 15, 82, 22, { fill: "#0f1a14", stroke: C.green, r: 11, sw: 1 });
    s += `<circle cx="${l.x + 14}" cy="26" r="3.5" fill="${l.color}"/>`;
    s += text(l.x + 26, 30, l.label, { size: 11, fill: C.green });
  }
  return s;
};

/* ── 图 1：上传页 ── */
function shotUpload() {
  const W = 1200, H = 760;
  let s = header(W);
  s += text(W / 2, 120, "把直播录像拖进来", { size: 28, weight: 700, anchor: "middle" });
  s += text(W / 2, 150, "转写、找爆点、切片成片都在本地完成。短片段用本地模型，", {
    size: 14, fill: C.dim, anchor: "middle",
  });
  s += text(W / 2, 172, "长直播自动切到长上下文引擎。", { size: 14, fill: C.dim, anchor: "middle" });

  // IP 选择行
  s += box(300, 200, 600, 74);
  s += text(322, 230, "这段直播是哪位老师的？", { size: 13 });
  s += text(322, 252, "分析会用她的爆款记忆和避雷词", { size: 12, fill: C.faint });
  s += box(322, 258, 120, 28, { fill: C.panel2, r: 6 });
  s += text(334, 277, "不指定（通用）", { size: 12, fill: C.dim });
  s += box(452, 258, 130, 28, { fill: C.accentDim, stroke: C.accent, r: 6 });
  s += text(464, 277, "示例老师", { size: 12, fill: C.accent });
  s += text(556, 277, "·", { size: 12, fill: C.faint });

  // 拖放区
  const dx = 300, dy = 300, dw = 600, dh = 250;
  s += box(dx, dy, dw, dh, { stroke: C.faint, r: 12, sw: 2 });
  // 虚线效果：内框
  s += `<rect x="${dx + 8}" y="${dy + 8}" width="${dw - 16}" height="${dh - 16}" rx="8" fill="none" stroke="${C.border}" stroke-width="1" stroke-dasharray="6 5"/>`;
  s += box(dx + dw / 2 - 28, dy + 60, 56, 56, { fill: C.accentDim, stroke: C.accent, r: 14 });
  s += text(dx + dw / 2, dy + 96, "▶", { size: 22, fill: C.accent, anchor: "middle" });
  s += box(dx + dw / 2 - 90, dy + 140, 180, 44, { fill: C.accent, stroke: "none", r: 8 });
  s += text(dx + dw / 2, dy + 168, "选择视频文件", { size: 15, fill: "#fff", weight: 600, anchor: "middle" });
  s += text(dx + dw / 2, dy + 206, "或直接拖拽到此处 · 可以一次拖一整个文件夹", {
    size: 12, fill: C.faint, anchor: "middle",
  });
  // 格式标签
  const tags = ["MP4", "MKV", "MOV", "FLV", "MP3", "M4A"];
  let tw = 0;
  for (const t of tags) tw += t.length * 9 + 24;
  let tx = dx + dw / 2 - tw / 2;
  for (const t of tags) {
    const w0 = t.length * 9 + 24;
    s += box(tx, dy + 220 - 44 + 44, w0, 24, { fill: C.panel2, r: 5 });
    s += text(tx + w0 / 2, dy + 240 - 12, t, { size: 11, fill: C.dim, anchor: "middle" });
    tx += w0 + 6;
  }
  s += text(dx + dw / 2, dy + dh - 22, "✓ 全程本地处理，不上传云端", {
    size: 12, fill: C.green, anchor: "middle",
  });

  // 底部信息条
  s += box(300, 576, 600, 40);
  s += text(322, 601, "📁 出片目录  D:/output", { size: 12, fill: C.dim });
  s += text(322 + 230, 601, "⚡ 引擎自动按内容形态分流", { size: 12, fill: C.blue });

  // 示意图声明
  s += text(W / 2, H - 22, "示意图 · 所有字段为示例数据，不含任何真实用户信息", {
    size: 11, fill: C.faint, anchor: "middle",
  });
  return S(W, H, s);
}

/* ── 图 2：审片台（逐句改 + 框选删字） ── */
function shotReview() {
  const W = 1240, H = 780;
  let s = header(W);

  // 左侧素材栏
  s += box(0, 52, 190, H - 52, { fill: C.panel, stroke: "none", r: 0 });
  s += text(16, 78, "素材", { size: 12, fill: C.faint, weight: 600 });
  const items = ["① 开场提问", "② 知识点 A", "③ 案例讲解", "④ 互动寒暄", "⑤ 收尾"];
  items.forEach((t, i) => {
    const y = 92 + i * 30;
    const on = i === 2;
    s += box(8, y, 174, 26, { fill: on ? C.accentDim : "none", stroke: on ? C.accent : "none", r: 5 });
    // 已剪掉的段落画删除线
    const cut = i === 3;
    s += text(18, y + 18, t, {
      size: 12, fill: cut ? C.faint : on ? C.accent : C.dim,
    });
    if (cut) s += `<line x1="18" y1="${y + 13}" x2="${18 + t.length * 12}" y2="${y + 13}" stroke="${C.faint}" stroke-width="1"/>`;
  });

  // 视频预览
  s += box(204, 66, 300, 400, { fill: "#000", r: 6 });
  s += text(354, 240, "视频预览", { size: 13, fill: C.faint, anchor: "middle" });
  // 播放进度条
  s += box(204, 478, 300, 6, { fill: C.border, r: 3 });
  s += box(204, 478, 190, 6, { fill: C.accent, r: 3 });
  s += text(214, 500, "12:04 / 38:22", { size: 11, fill: C.faint });

  // 逐句稿面板
  s += box(518, 66, 700, 460, { fill: C.panel, r: 8 });
  s += text(538, 92, "逐句稿", { size: 13, weight: 600 });
  s += text(598, 92, "· 点字跳播 · 框选删字 · 撤销", { size: 11, fill: C.faint });

  const lines = [
    { t: "我们在讲唱歌提喉的时候", keep: true },
    { t: "第一个要点是舌根要放松", keep: true },
    { t: "点点关注收藏一下", keep: false },
    { t: "对 就是这个位置", keep: true },
    { t: "啊 啊 啊（长音示范）", keep: true },
    { t: "加微信可以领资料", keep: false },
  ];
  let ly = 118;
  for (const ln of lines) {
    if (!ln.keep) {
      // 删掉的整句：灰色 + 删除线
      s += text(538, ly, ln.t, { size: 13, fill: C.faint });
      s += `<line x1="538" y1="${ly - 5}" x2="${538 + ln.t.length * 13}" y2="${ly - 5}" stroke="${C.accent}" stroke-width="1.5"/>`;
      s += text(1000, ly, "已剪", { size: 11, fill: C.accent });
    } else {
      s += text(538, ly, ln.t, { size: 13 });
      if (ln.t.includes("啊 啊 啊")) {
        s += text(538 + ln.t.length * 13 + 8, ly, "← 元音长音（练声内容，保留）", {
          size: 11, fill: C.green,
        });
      }
    }
    ly += 26;
  }

  // 框选删除的可视化
  s += `<rect x="536" y="${ly - 66}" width="150" height="24" fill="none" stroke="${C.accent}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  s += text(694, ${ly - 50}, "← 框选这几个字", { size: 11, fill: C.accent });

  // 底部工具条
  s += box(204, 520, 1014, 56, { fill: C.panel2, r: 8 });
  s += text(224, 544, "爆点命中", { size: 11, fill: C.faint });
  s += text(224, 564, "翻车对比 · 知识点开场", { size: 12, fill: C.yellow });
  s += text(520, 544, "粗剪区间", { size: 11, fill: C.faint });
  s += text(520, 564, "4 段 · 保留 38 秒", { size: 12 });
  s += box(950, 532, 120, 34, { fill: C.accent, stroke: "none", r: 7 });
  s += text(1010, 554, "重新出片", { size: 13, fill: "#fff", weight: 600, anchor: "middle" });

  s += text(W / 2, H - 22, "示意图 · 所有字段为示例数据，不含任何真实用户信息", {
    size: 11, fill: C.faint, anchor: "middle",
  });
  return S(W, H, s);
}

/* ── 图 3：引擎分流决策 ── */
function shotRouting() {
  const W = 1080, H = 560;
  let s = header(W);
  s += text(W / 2, 108, "引擎自动按内容形态分流", { size: 22, weight: 700, anchor: "middle" });
  s += text(W / 2, 134, "8GB 显存装不下长直播的上下文，硬塞会静默截断 —— 所以必须分流", {
    size: 13, fill: C.dim, anchor: "middle",
  });

  // 决策框
  s += box(400, 160, 280, 56, { fill: C.panel2, r: 8 });
  s += text(540, 194, "这段有多少字？多长？", { size: 14, weight: 600, anchor: "middle" });

  // 左分支
  s += `<line x1="470" y1="216" x2="250" y2="270" stroke="${C.green}" stroke-width="2"/>`;
  s += `<line x1="610" y1="216" x2="830" y2="270" stroke="${C.blue}" stroke-width="2"/>`;
  s += text(340, 240, "≤ 9,216 字", { size: 12, fill: C.green, weight: 600 });
  s += text(760, 240, "> 9,216 字", { size: 12, fill: C.blue, weight: 600 });

  s += box(100, 270, 300, 130, { stroke: C.green });
  s += text(250, 300, "本机 Ollama", { size: 16, weight: 700, fill: C.green, anchor: "middle" });
  s += text(250, 326, "qwen3:8b-chat", { size: 12, fill: C.dim, anchor: "middle" });
  s += text(250, 348, "免费 · 无限 · 不外发", { size: 12, fill: C.dim, anchor: "middle" });
  s += text(250, 372, "显存占用 5.76 GB", { size: 12, fill: C.faint, anchor: "middle" });

  s += box(680, 270, 300, 130, { stroke: C.blue });
  s += text(830, 300, "云端 Gemini", { size: 16, weight: 700, fill: C.blue, anchor: "middle" });
  s += text(830, 326, "gemini-3.5-flash-lite", { size: 12, fill: C.dim, anchor: "middle" });
  s += text(830, 348, "百万级上下文", { size: 12, fill: C.dim, anchor: "middle" });
  s += text(830, 372, "有单次调用预算上限", { size: 12, fill: C.faint, anchor: "middle" });

  // 边界说明
  s += box(100, 428, 880, 70, { fill: C.panel, r: 8 });
  s += text(122, 454, "为什么 16,384 不行", { size: 13, weight: 600, fill: C.yellow });
  s += text(122, 478, "8GB 显存下 16k 上下文会把 Qwen 推到 7.28 GB，和视觉模型叠加必然爆显存。", { size: 12, fill: C.dim });
  s += text(122, 494, "所以本地上限定在 8,192 —— 这是物理限制，调配置只会让它崩。", { size: 12, fill: C.dim });

  s += text(W / 2, H - 22, "示意图 · 所有字段为示例数据，不含任何真实用户信息", {
    size: 11, fill: C.faint, anchor: "middle",
  });
  return S(W, H, s);
}

/* ── 生成 ── */
mkdirSync(OUT, { recursive: true });
const shots = [
  ["01-上传与分流.svg", shotUpload()],
  ["02-审片台逐句改.svg", shotReview()],
  ["03-引擎分流与显存边界.svg", shotRouting()],
];
for (const [name, svg] of shots) {
  const p = join(OUT, name);
  writeFileSync(p, svg, "utf8");
  console.log(`已生成 ${name}  (${(svg.length / 1024).toFixed(1)} KB)`);
}
console.log(`\n共 ${shots.length} 张，全部为矢量 SVG（可直接缩放，不含任何真实数据）`);
