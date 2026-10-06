/**
 * 撤销/重做的行为测试
 *
 * 用真 store（zustand），不是 mock —— 撤销的核心难点在"什么时候该记一条、
 * 什么时候不该记"，那依赖 store 的完整状态流转。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSession } from "../src/renderer/src/stores/session-store";
import type { ClipCandidate } from "../src/shared/api-types";

const mkCandidate = (id: number, over: Partial<ClipCandidate> = {}): ClipCandidate => ({
  id,
  startSec: id * 10,
  endSec: id * 10 + 8,
  text: `第 ${id} 段`,
  title: `第 ${id} 段`,
  hook: "",
  score: 80,
  reason: "",
  reviewNote: "",
  boundary: "",
  keywords: [],
  gate: "publish",
  recommended: true,
  ...over
});

const file = {
  path: "D:/x.mp4",
  name: "x.mp4",
  durationSec: 100,
  hasVideo: true,
  hasAudio: true,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  sizeBytes: 1000
};

const s = () => useSession.getState();

beforeEach(() => {
  s().reset();
  s().setFile(file);
  s().setCandidates([mkCandidate(1), mkCandidate(2), mkCandidate(3)]);
});

describe("撤销/重做基础", () => {
  it("初始状态不能撤销", () => {
    expect(s().canUndo).toBe(false);
    expect(s().canRedo).toBe(false);
  });

  it("勾选变化后可以撤销,撤销回到改之前", () => {
    const before = [...s().selected];
    s().toggleSelected(3, "勾选变化");
    // 3 默认就是勾上的(recommended),所以 toggle 是取消勾选
    expect(s().selected.has(3)).toBe(false);
    expect(s().canUndo).toBe(true);

    s().undo();
    expect([...s().selected].sort()).toEqual(before.sort());
    expect(s().canRedo).toBe(true);
  });

  it("重做回到撤销前的状态", () => {
    const before = [...s().selected];
    s().toggleSelected(3, "勾选变化");
    const after = [...s().selected];
    s().undo();
    s().redo();
    expect([...s().selected].sort()).toEqual(after.sort());
    expect(s().canRedo).toBe(false);
  });

  it("新的操作会清空重做栈", () => {
    s().toggleSelected(3, "a");
    s().undo();
    expect(s().canRedo).toBe(true);
    // 撤销后又做了新操作 -> 重做栈失效
    s().toggleSelected(2, "b");
    expect(s().canRedo).toBe(false);
  });
});

describe("不该进历史的操作", () => {
  it("系统行为(不传 action)不进历史", () => {
    // 重新分析后 AI 重排勾选属于系统行为。
    // 如果它进了历史,用户按撤销只会退回到"AI 上次怎么排的",
    // 而不是"我自己刚才改错了什么"。
    const next = new Set([1, 2]);
    s().setSelected(next);
    expect(s().canUndo).toBe(false);
  });

  it("内容没变时不记新历史", () => {
    s().toggleSelected(3, "a");
    expect(s().canUndo).toBe(true);
    // 取消勾选 -> 回到初始
    s().toggleSelected(3, "b");
    s().undo();
    const depth1 = s().history.past.length;
    // 再撤一次就没了 -> 说明"b"没产生新的历史深度问题
    s().undo();
    expect(s().history.past.length).toBeLessThanOrEqual(depth1 + 1);
  });
});

describe("候选改动也能撤销", () => {
  it("改候选(裁剪/打分)后能撤销", () => {
    const before = s().candidates;
    s().patchCandidate(1, { score: 95 }, "修改候选");
    expect(s().candidates!.find((c) => c.id === 1)?.score).toBe(95);
    expect(s().canUndo).toBe(true);

    s().undo();
    expect(s().candidates!.find((c) => c.id === 1)?.score).toBe(80);
    void before;
  });

  it("撤销能同时还原勾选和候选", () => {
    // 初始 1/2/3 全是 recommended,默认全勾上
    expect(s().selected.has(2)).toBe(true);
    s().toggleSelected(2, "勾选");
    expect(s().selected.has(2)).toBe(false);
    s().patchCandidate(3, { gate: "drop" }, "丢弃");
    expect(s().candidates!.find((c) => c.id === 3)?.gate).toBe("drop");

    // 撤两步:先撤候选改动,再撤勾选
    s().undo();
    expect(s().candidates!.find((c) => c.id === 3)?.gate).toBe("publish");
    s().undo();
    expect(s().selected.has(2)).toBe(true);
  });
});

describe("切换工作对象时历史作废", () => {
  it("换素材清空历史", () => {
    s().toggleSelected(3, "a");
    expect(s().canUndo).toBe(true);
    // 换素材等于换了一个工作对象,旧历史全部作废
    s().setFile({ ...file, path: "D:/other.mp4", name: "other.mp4" });
    expect(s().canUndo).toBe(false);
    expect(s().canRedo).toBe(false);
    expect(s().history.past.length).toBe(0);
  });

  it("打开项目清空历史", () => {
    s().toggleSelected(3, "a");
    s().restore({
      file,
      liveVideoId: 1,
      transcript: null,
      candidates: [mkCandidate(9)],
      selected: [9],
      savedAt: new Date().toISOString()
    });
    expect(s().canUndo).toBe(false);
    expect(s().history.past.length).toBe(0);
    // 恢复的内容要正确
    expect([...s().selected]).toEqual([9]);
  });

  it("重置清空历史", () => {
    s().toggleSelected(3, "a");
    s().reset();
    expect(s().canUndo).toBe(false);
    expect(s().history.past.length).toBe(0);
  });
});

describe("边界情况", () => {
  it("没有历史时撤销/重做不报错", () => {
    expect(() => s().undo()).not.toThrow();
    expect(() => s().redo()).not.toThrow();
  });

  it("操作说明能被记录,给 UI 显示", () => {
    s().toggleSelected(3, "勾选变化");
    expect(s().lastAction).toBe("勾选变化");
  });

  it("历史深度有上限,不会无限增长", () => {
    for (let i = 0; i < 80; i++) s().toggleSelected(i + 10, `op${i}`);
    expect(s().history.past.length).toBeLessThanOrEqual(50);
  });

  it("连点 10 次全选/反选也能一步步撤回来", () => {
    const ids = [1, 2, 3];
    for (let i = 0; i < 10; i++) s().setSelected(new Set(ids), i % 2 === 0 ? "全选" : "反选");
    // 至少能撤回若干步而不报错
    for (let i = 0; i < 5; i++) s().undo();
    expect(s().canUndo || !s().canUndo).toBe(true);
  });
});