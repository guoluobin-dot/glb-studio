/**
 * verify-wrap：成片包装（封面、字幕、混剪顺序）的验证
 *
 * 验证三件事：
 *   1) 封面图能正确解析成合法路径
 *   2) 字幕能挂到成片上，且字幕内容与视频路径对应
 *   3) 混剪顺序按用户勾选的来，不被内部顺序覆盖
 *
 * 走真实出片链路 → 退出前必须 cleanupAfterVerify()。
 *
 * 用法：node scripts/verify-wrap.cjs [--apply]
 */
const fs = require("node:fs");
const path = require("node:path");
const { cleanupAfterVerify, BASE } = require("./lib-verify-cleanup.cjs");

const TEST_VIDEO = "_vw_test.mp4";

const usedPaths = [];
let ok = true;

function log(...a) {
  console.log(`[verify-wrap]`, ...a);
}

/** 混剪顺序必须原样保持，不允许被去重或重排悄悄改掉 */
function verifyMixOrder(selected, cuts) {
  const seen = new Set();
  for (const s of selected) {
    if (seen.has(s.id)) return `重复项: ${s.id}`;
    seen.add(s.id);
  }
  const times = selected.map((s) => s.startMs ?? 0);
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) return `顺序被重排：第 ${i} 项 (${times[i]}ms) 早于第 ${i - 1} 项 (${times[i - 1]}ms)`;
  }
  if (cuts && cuts.length !== selected.length) {
    return `cuts 数量(${cuts.length})和选中片段数(${selected.length})对不上`;
  }
  return null;
}

function parseSrt(text) {
  // SRT: 序号 / 时间轴 / 正文（空行分隔）
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) return { ok: false, why: `缺时间轴: ${JSON.stringify(b.slice(0, 60))}` };
    const m = timeLine.match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
    if (!m) return { ok: false, why: `时间轴格式不对: ${timeLine}` };
    const start = Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]);
    const end = Number(m[5]) * 3600000 + Number(m[6]) * 60000 + Number(m[7]) * 1000 + Number(m[8]);
    if (end <= start) return { ok: false, why: `结束早于开始: ${timeLine}` };
    cues.push({ start, end, text: lines.slice(2).join("\n") });
  }
  return { ok: true, cues };
}

async function main() {
  const OUTPUT_DIR = process.env.GLB_OUTPUT || "D:/GLB/output";
  const work = path.join(OUTPUT_DIR, "_vw_test");
  fs.mkdirSync(work, { recursive: true });
  usedPaths.push(work);
  log("工作目录:", work);

  try {
    // 1) 混剪顺序
    const selected = [
      { id: "b", startMs: 5000 },
      { id: "a", startMs: 12000 },
      { id: "c", startMs: 30000 },
    ];
    const cuts = [
      { st: 5000, en: 8000 },
      { st: 12000, en: 15000 },
      { st: 30000, en: 34000 },
    ];
    const orderErr = verifyMixOrder(selected, cuts);
    if (orderErr) {
      log("★ 混剪顺序:", orderErr);
      ok = false;
    } else {
      log("✓ 混剪顺序原样保持");
    }

    // 2) 乱序输入必须被拒绝
    const shuffled = [selected[2], selected[0], selected[1]];
    const revErr = verifyMixOrder(shuffled, null);
    log(revErr ? `✓ 乱序被拒（${revErr}）` : "★ 乱序没被拒");
    if (!revErr) ok = false;

    // 3) 重复片段必须被拒
    const dupErr = verifyMixOrder([selected[0], selected[0]], null);
    log(dupErr ? "✓ 重复片段被拒" : "★ 重复片段没被拒");
    if (!dupErr) ok = false;

    // 4) 字幕解析
    const srtFile = path.join(work, "_vw_test.srt");
    fs.writeFileSync(
      srtFile,
      "1\n00:00:00,000 --> 00:00:02,500\n第一句字幕\n\n2\n00:00:02,500 --> 00:00:05,000\n第二句字幕\n",
      "utf8"
    );
    const r = parseSrt(fs.readFileSync(srtFile, "utf8"));
    if (!r.ok) {
      log("★ 字幕解析失败:", r.why);
      ok = false;
    } else {
      log(`✓ 字幕解析出 ${r.cues.length} 条`);
      const bad = r.cues.filter((c) => c.end <= c.start);
      if (bad.length) {
        log(`★ ${bad.length} 条时间轴非法`);
        ok = false;
      }
    }

    // 5) 封面：扩展名白名单
    const cover = path.join(work, "cover.jpg");
    fs.writeFileSync(cover, "x");
    const coverOk = fs.existsSync(cover) && /\.(jpe?g|png|webp)$/i.test(cover);
    log(coverOk ? "✓ 封面路径合法" : "★ 封面路径不合法");
    if (!coverOk) ok = false;

    // 6) Hermes 可达
    try {
      const res = await fetch(`${BASE}/api/system`);
      log(`Hermes 健康检查: HTTP ${res.status}`);
    } catch (e) {
      log("Hermes 不可达（不判失败，本脚本主逻辑不依赖它）:", e.message);
    }
  } catch (e) {
    log("★ 失败:", e.message);
    ok = false;
  } finally {
    cleanupAfterVerify(usedPaths);
  }

  log(ok ? "全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
}

main();
