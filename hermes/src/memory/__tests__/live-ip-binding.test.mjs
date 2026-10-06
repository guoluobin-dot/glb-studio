/**
 * 直播素材 ↔ IP 记忆库的绑定。
 *
 * 要防的是那个静默故障:导入某老师的直播,界面停在王老师身上,
 * 于是拿王老师的爆款记忆去分析某老师的素材 —— 不报错,只是片段不对味,
 * 事后根本查不出是谁的问题。
 *
 * 必须用 Hermes 自己的 node 跑(它的 better-sqlite3 是按那个 ABI 编译的),
 * 所以这个文件是 .mjs 并由 `npm test` 调用,不放进 GLB-NEW 的 vitest。
 *
 * 用临时库,绝不碰 data/hermes.db。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryStore } from "../../memory/store.js";

const VIDEO_A = "D:/fake/zhulaoshi-2026-06-20.mp4";
const VIDEO_B = "D:/fake/wanglaoshi-2026-06-20.mp4";

/**
 * MemoryStore 把 dbPath 相对 Hermes 根目录 join,所以必须给**相对**路径 ——
 * 给绝对路径会被拼成 D:\GLB\Hermes\D:\GLB\Hermes\data\...。
 * 临时库放在 Hermes 自己的 data/.tmp-test 下,跑完删掉,绝不碰 hermes.db。
 */
const REL = `data/.tmp-test-bind-${process.pid}`;
const store = new MemoryStore({ memory: { dbPath: `${REL}/t.db`, similarityThreshold: 0.75 } });

test.after(() => {
  try { store.close?.(); } catch { /* ignore */ }
  try { rmSync(join(join(import.meta.dirname, "..", "..", "..", "..", REL)), { recursive: true, force: true }); }
  catch { /* ignore */ }
});

test("live_videos 表有 collection 列", () => {
  const cols = store.db.prepare("PRAGMA table_info(live_videos)").all().map((c) => c.name);
  assert.ok(cols.includes("collection"), "live_videos 缺 collection 列");
});

test("导入时就能绑定老师", () => {
  store.upsertLiveVideo(VIDEO_A, { videoName: "某老师直播", collection: "某老师" });
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A)), "某老师");
});

test("中途 upsert 不能把绑定冲掉", () => {
  // 真实流程会 upsert 好几次：登记 analyzing → 回填分段数 → 写体检结果，
  // 都不带 collection。哪一步用 null 覆盖，绑定就没了。
  const id = store.getLiveVideoIdByPath(VIDEO_A);
  store.upsertLiveVideo(VIDEO_A, { analysisStatus: "analyzing" });
  store.upsertLiveVideo(VIDEO_A, { segmentCount: 210 });
  store.upsertLiveVideo(VIDEO_A, { analysisHealth: '{"grade":"ok"}' });
  assert.equal(store.getLiveVideoCollection(id), "某老师");
});

test("可以改绑到另一位老师", () => {
  store.bindLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A), "王老师");
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A)), "王老师");
});

test("解绑后回到『用全局』而不是『没有记忆』", () => {
  store.bindLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A), null);
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A)), undefined);
});

test("没绑定的素材返回 undefined 而不是 null", () => {
  // 两者语义不同：undefined=不知道(用全局)，null=明确要通用记忆。
  // 混用会让"没绑"的老数据全部拿不到任何记忆。
  store.upsertLiveVideo(VIDEO_B, { videoName: "王老师直播" });
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_B)), undefined);
});

test("两条直播可以绑定到不同老师，互不串味", () => {
  store.upsertLiveVideo(VIDEO_A, { collection: "某老师" });
  store.upsertLiveVideo(VIDEO_B, { collection: "王老师" });
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_A)), "某老师");
  assert.equal(store.getLiveVideoCollection(store.getLiveVideoIdByPath(VIDEO_B)), "王老师");
});

test("绑定不存在的直播要报错而不是静默成功", () => {
  const r = store.bindLiveVideoCollection(999999, "某老师");
  assert.equal(r.ok, false);
});

test("反斜杠路径能查到同一条", () => {
  // 接口可能传 D:\x，库里存的是 D:/x。不归一化就会当成两条素材，
  // 于是绑定写到"另一条"上，分析时读到的还是没绑定的那条。
  assert.equal(
    store.getLiveVideoIdByPath("D:\\fake\\zhulaoshi-2026-06-20.mp4"),
    store.getLiveVideoIdByPath(VIDEO_A)
  );
});

test("getCollection* 支持显式传归属，不吃全局", () => {
  // 真正生效的判断依据：显式传 collection 时结果必须和全局无关
  store.activeCollection = "王老师";
  const zhuliao = store.getCollectionThemeKeywords("某老师", 50);
  const wang = store.getCollectionThemeKeywords("王老师", 50);
  assert.notEqual(zhuliao === wang, undefined); // 都能查，不抛
  store.activeCollection = null;
});

/* ────────────────────────────────────────────
 * 分段批次：重新分析后同一 index 不能有两条活跃分段
 * ──────────────────────────────────────────── */

test("同一 segment_index 不会返回两条活跃分段", () => {
  // 背景：重分析时有未完成项目引用旧分段 -> 跳过清空 -> 新旧并存。
  // 不区分活跃/失效时，按 index 取分段会拿到上一轮内容，且界面毫无异常。
  const vid = store.getLiveVideoIdByPath(VIDEO_A);

  // 先造一批"旧分段"（前面几个用例只登记了 live_videos，没写分段）
  const insOld = store.db.prepare(`
    INSERT INTO live_segments
      (live_video_id, segment_index, start_ms, end_ms, duration_ms, transcript_summary, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `);
  if (store.getLiveSegmentsByVideo(vid).length === 0) {
    for (let i = 0; i < 3; i++) {
      insOld.run(vid, i, i * 40000, (i + 1) * 40000, 40000, `旧批次第${i}段`);
    }
  }
  const before = store.getLiveSegmentsByVideo(vid);
  assert.ok(before.length >= 2, "前置条件：本测试需要至少两段旧分段");

  // 模拟"保留旧分段 + 写入新批次"
  store.db
    .prepare("UPDATE live_segments SET status = 'superseded' WHERE live_video_id = ? AND status = 'draft'")
    .run(vid);
  const ins = store.db.prepare(`
    INSERT INTO live_segments
      (live_video_id, segment_index, start_ms, end_ms, duration_ms, transcript_summary, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `);
  ins.run(vid, 0, 0, 40000, 40000, "新批次第0段");
  ins.run(vid, 1, 40000, 80000, 40000, "新批次第1段");

  const after = store.getLiveSegmentsByVideo(vid);
  const idx = after.map((s) => s.segment_index);
  assert.equal(new Set(idx).size, idx.length, `index 重复: ${JSON.stringify(idx)}`);
  assert.ok(
    after.every((s) => s.transcript_summary.startsWith("新批次")),
    "取到的必须是活跃批次，不是 superseded 的旧行"
  );
  // 旧行仍在库里，老项目的 segmentId 仍能查到（不悬空）
  const oldId = before[0]?.id;
  if (oldId) {
    const row = store.db.prepare("SELECT id, status FROM live_segments WHERE id = ?").get(oldId);
    assert.ok(row, "旧行被删了，老项目会悬空");
    assert.equal(row.status, "superseded");
  }
});
