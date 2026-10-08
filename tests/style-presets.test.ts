/**
 * 样式预设的存取。
 *
 * 重点不是"存取能用"，而是**脏数据不许把界面搞崩**。
 * localStorage 里的内容用户可以手改，也可能来自旧版本，
 * 而这份数据最终会被丢给渲染层；一个坏预设不该让出片选项整个打不开。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_NAME_LEN,
  MAX_PRESETS,
  isValidPreset,
  loadPresets,
  makePreset,
  normalizeName,
  savePresets,
  type StylePreset
} from "../src/renderer/src/lib/style-presets";
import type { CaptionStyle, TitleStyle } from "@shared/api-types";

/** 最小可用的 localStorage 替身，能模拟"配额满/隐私模式"两种抛错。 */
function makeStorage(opts: { throwOnWrite?: boolean } = {}): {
  data: Map<string, string>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (opts.throwOnWrite) throw new Error("QuotaExceededError");
      data.set(k, v);
    }
  };
}

const KEY = "glb.stylePresets.v1";

function install(storage: ReturnType<typeof makeStorage>): void {
  vi.stubGlobal("window", { localStorage: storage });
}

describe("样式预设：存取往返", () => {
  beforeEach(() => {
    install(makeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("存进去再读出来，字段一致", () => {
    const caption: CaptionStyle = { font: "思源黑体", color: "#FFD700", size: 34, marginV: 120, outline: 2, bold: true };
    const title: TitleStyle = { font: "思源宋体", color: "#FFFFFF", size: 48, position: "top", offsetY: -30 };
    const made = makePreset("直播带货", caption, title);
    expect(made).not.toBeNull();

    expect(savePresets([made!])).toBe(true);
    const back = loadPresets();
    expect(back).toHaveLength(1);
    expect(back[0]?.name).toBe("直播带货");
    expect(back[0]?.caption).toEqual(caption);
    expect(back[0]?.title).toEqual(title);
    expect(back[0]?.id).toBe(made!.id);
  });

  it("全默认不给存 —— 标题栏本来就有「恢复默认」，再存一份是重复", () => {
    // 之前这条测试写反了：一边让 makePreset 拒绝空样式，一边断言能存。
    // 结论取"拒绝"：点了这种预设不会有任何变化，而恢复默认按钮就在旁边。
    expect(makePreset("全默认", {}, {})).toBeNull();
    expect(isValidPreset({ id: "a", name: "全默认", caption: {}, title: {} })).toBe(false);
  });

  it("同名不覆盖，两条并存", () => {
    const a = makePreset("同名", { size: 20 }, { size: 20 });
    const b = makePreset("同名", { size: 30 }, { size: 30 });
    expect(a!.id).not.toBe(b!.id);
    savePresets([a!, b!]);
    expect(loadPresets()).toHaveLength(2);
  });
});

describe("样式预设：不该接受的东西", () => {
  beforeEach(() => {
    install(makeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("空名字 / 纯空格不给存", () => {
    expect(makePreset("", { size: 20 }, {})).toBeNull();
    expect(makePreset("   ", { size: 20 }, {})).toBeNull();
  });

  it("名字超长会被截断，不会撑爆存储", () => {
    const long = "x".repeat(200);
    const made = makePreset(long, { size: 20 }, {});
    expect(made!.name.length).toBe(MAX_NAME_LEN);
  });

  it("两边都等于系统默认时不存 —— 存了也没用还占位", () => {
    expect(makePreset("空的", {}, {})).toBeNull();
  });

  it("未知字段会被丢掉，不会带进渲染层", () => {
    const evil = {
      id: "x1",
      name: "脏数据",
      savedAt: 1,
      caption: { size: 20, __proto__: { polluted: true }, 恶意字段: "boom" },
      title: { size: 30, 另一个: 1 }
    };
    savePresets([evil as unknown as StylePreset]);
    const back = loadPresets();
    expect(back).toHaveLength(1);
    // 白名单之外的一律不该出现
    expect(Object.keys(back[0]?.caption ?? {})).toEqual(["size"]);
    expect(Object.keys(back[0]?.title ?? {})).toEqual(["size"]);
    expect(JSON.stringify(back)).not.toContain("恶意字段");
  });
});

describe("样式预设：脏数据不许把界面搞崩", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("JSON 坏了 -> 当成没有预设，不抛", () => {
    const s = makeStorage();
    s.data.set(KEY, "{这不是 JSON");
    install(s);
    expect(() => loadPresets()).not.toThrow();
    expect(loadPresets()).toEqual([]);
  });

  it("根节点不是数组 -> 当成没有预设", () => {
    const s = makeStorage();
    s.data.set(KEY, '{"id":"x"}');
    install(s);
    expect(loadPresets()).toEqual([]);
  });

  it("数组里混着非对象/null/缺字段 -> 逐条丢弃，保留合法的", () => {
    const s = makeStorage();
    s.data.set(
      KEY,
      JSON.stringify([
        null,
        "字符串",
        { name: "缺 id" },
        { id: "a", name: "   " },
        { id: "b", name: "正常", caption: { size: 22 } }
      ])
    );
    install(s);
    const back = loadPresets();
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe("b");
  });

  it("一条预设两边的样式都没有 -> 丢弃（点了也不会有任何变化）", () => {
    expect(isValidPreset({ id: "a", name: "x" })).toBe(false);
    expect(isValidPreset({ id: "a", name: "x", caption: {} })).toBe(false);
    expect(isValidPreset({ id: "a", name: "x", caption: { size: 1 } })).toBe(true);
  });

  it("localStorage 不让读（隐私模式）-> 当成没有预设，不抛", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      }
    });
    expect(() => loadPresets()).not.toThrow();
    expect(loadPresets()).toEqual([]);
  });

  it("localStorage 不让写 -> savePresets 返回 false，界面据此提示而不是静默丢", () => {
    install(makeStorage({ throwOnWrite: true }));
    const made = makePreset("x", { size: 20 }, {});
    expect(savePresets([made!])).toBe(false);
  });

  it("超过上限的旧数据被截断，不会一次性全塞进内存", () => {
    const s = makeStorage();
    const many = Array.from({ length: MAX_PRESETS + 10 }, (_, i) => ({
      id: `id${i}`,
      name: `预设${i}`,
      savedAt: i,
      caption: { size: 20 + i }
    }));
    s.data.set(KEY, JSON.stringify(many));
    install(s);
    expect(loadPresets()).toHaveLength(MAX_PRESETS);
  });
});

describe("样式预设：名字规范化", () => {
  it("去掉首尾空格、拒绝空串", () => {
    expect(normalizeName("  直播  ")).toBe("直播");
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeName("")).toBeNull();
  });
});