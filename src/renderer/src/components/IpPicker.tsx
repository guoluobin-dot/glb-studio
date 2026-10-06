import { useCallback, useEffect, useState } from "react";
import { LuBrain, LuCheck, LuFolderPlus, LuUsers } from "react-icons/lu";
import { call } from "../lib/bridge";
import { cx } from "./ui";
import type { HitCollection } from "@shared/api-types";

/**
 * 上传直播时选 IP 老师。
 *
 * 放在拖拽区正上方，顺序是有意的：先说清"这段素材归谁的记忆"，再让人拖文件。
 * 反过来的话用户已经把素材拖进来了，才发现分析用的是别人的爆款库 ——
 * 而那个错不会报错，只会让选出来的片段"不对味"，事后极难归因。
 *
 * 选中之后：
 *  - 立刻激活这个文件夹（爆款库面板、评审经验都跟着它走）
 *  - 传给 analyze 的 collection 会绑到这条素材自己身上，
 *    之后不管界面切到谁，重开这条素材仍然用同一份记忆
 */
export function IpPicker({
  value,
  onChange,
  /** 素材导入后会显示在这里，让用户知道刚才那批素材绑给了谁 */
  boundName,
  /** 双击某个 IP = 打开 ta 的爆款记忆素材库 */
  onOpenVault
}: {
  value: string | null;
  onChange: (name: string | null) => void;
  boundName?: string | null;
  onOpenVault?: (ip: HitCollection) => void;
}): React.JSX.Element {
  const [ips, setIps] = useState<HitCollection[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await call((api) => api.hitListIps());
      setIps(list);
      // 只有一个老师时直接选上：绝大多数用户就一位老师，
      // 每次都手选一遍纯属多余步骤
      if (list.length === 1) onChange(list[0]?.name ?? null);
    } catch (err) {
      setIps([]);
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = async (name: string | null): Promise<void> => {
    onChange(name);
    setMsg(null);
    if (!name) return;
    // 同步给 Hermes：不开这个的话评审经验/避雷词仍会串到别的老师
    try {
      const ip = ips?.find((x) => x.name === name);
      if (ip) await call((api) => api.hitActivateIp(ip.id));
      else setMsg(`已选中「${name}」，但没在列表里找到它，暂时只作为本次分析的归属。`);
    } catch (err) {
      setMsg(`已选中，但同步给算法层失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /*
   * 双击 = 打开这位老师的爆款记忆素材库（查看/继续上传/删除）。
   *
   * 单击只做"选中"—— 它决定这段素材用谁的记忆去分析，
   * 是个高频的轻量动作；打开记忆库是"我要看看/管理 ta 的素材"，
   * 属于另一个意图。以前只有单击，于是用户只能从左边导航栏
   * 进爆款库再自己找是哪一位 —— 明明名字就在眼前。
   *
   * 先选中再打开：进库后当前 IP 已经在正确的上下文里，
   * 不用再点一次。
   */
  const openVaultFor = async (ip: HitCollection): Promise<void> => {
    await pick(ip.name);
    onOpenVault?.(ip);
  };

  const create = async (): Promise<void> => {
    const name = draft.trim();
    if (!name) return;
    try {
      const created = await call((api) => api.hitCreateIp(name, ""));
      if (!created?.name) {
        setMsg("新建后没拿到档案信息，请刷新后再试。");
        return;
      }
      setDraft("");
      setCreating(false);
      await load();
      await pick(created.name);
      /*
       * 建完之后别立刻把提示清掉：Hermes 侧记忆库没建成功时，
       * 这个 IP 的学习样本会存不下（界面看着一切正常，记忆却是空的）。
       * 紧接着又调 pick()，成功提示会被冲掉，所以放在最后说。
       */
      if (created.hermesSynced === false) {
        setMsg(`「${created.name}」的记忆库没建成功(${created.hermesError ?? "原因不明"})，样本暂时存不下。`);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  if (ips === null) {
    return (
      <div className="mb-4 h-[68px] w-full max-w-2xl rounded-2xl border border-line bg-panel-2/30 skeleton" />
    );
  }

  return (
    <div className="rise-in mb-1 w-full max-w-2xl">
      <div className="rounded-2xl border border-line bg-panel-2/40 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <LuUsers className="h-3.5 w-3.5 shrink-0 text-mut-2" />
          <span className="text-[11.5px] font-bold text-mut">这段直播是哪位老师的？</span>
          <span className="truncate text-[10.5px] text-mut-2">
            分析会用ta的爆款记忆和避雷词
          </span>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-mut-2 transition-colors hover:text-ember"
          >
            <LuFolderPlus className="h-3 w-3" />
            新建
          </button>
        </div>

        {creating && (
          <div className="mt-2 flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="IP 名字（例：王老师）"
              className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ember/60"
            />
            <button
              type="button"
              onClick={() => void create()}
              disabled={!draft.trim()}
              className="rounded bg-ember px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
            >
              建
            </button>
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void pick(null)}
            className={cx(
              "rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
              value === null ? "border-ember/45 bg-ember/8 text-fg" : "border-line text-mut hover:bg-panel-2/60"
            )}
          >
            不指定（通用）
          </button>
          {ips.map((ip) => {
            const on = value === ip.name;
            return (
              <button
                key={ip.id}
                type="button"
                onClick={() => void pick(ip.name)}
                onDoubleClick={() => void openVaultFor(ip)}
                // 说明双击能做什么：不然用户只会以为是"选中"，
                // 永远不知道名字旁边就能进去看素材
                title={`${ip.entryCount} 条爆款记忆 · 双击打开 ta 的爆款素材库`}
                className={cx(
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
                  on ? "border-ember/45 bg-ember/8 text-fg" : "border-line text-mut hover:bg-panel-2/60"
                )}
              >
                <LuBrain className="h-3 w-3 shrink-0 opacity-70" />
                <span className="truncate">{ip.name}</span>
                <span className="tabular font-mono text-[9.5px] opacity-60">{ip.entryCount}</span>
                {on && <LuCheck className="h-3 w-3 shrink-0 text-ember" strokeWidth={3} />}
              </button>
            );
          })}
          {ips.length === 0 && !creating && (
            <span className="py-1.5 text-[11.5px] text-mut-2">
              还没有 IP 档案 —— 先新建一个，之后导入爆款素材可以叠进ta的记忆里
            </span>
          )}
        </div>

        {(msg || boundName) && (
          <div className="mt-2 text-[10.5px] leading-relaxed text-mut-2">
            {boundName
              ? `本批素材已绑定「${boundName}」：重开这条项目仍然用ta的记忆，不会因为之后切换了IP而变味。`
              : msg}
          </div>
        )}
      </div>
    </div>
  );
}
