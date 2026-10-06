/**
 * 出片素材库 IPC:封面图 + 结尾藏带货视频。
 *
 * 与爆款库(hit:*)分开注册 —— 两者的生命周期不同:
 * 爆款库是"每个 IP 一份记忆",素材库是"全局共用的出片素材",
 * 混在一起会让切换 IP 时的清理逻辑互相干扰。
 */
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { deleteAssets, importAssets, listAssets, pickAsset, restoreAssets } from "./asset-store";
import type { AssetKind } from "./asset-store";

/** 图片/视频的可选扩展名。必须和 asset-store 里的白名单一致 */
const COVER_EXT_LIST = ["jpg", "jpeg", "png", "webp", "bmp"];
const TAIL_EXT_LIST = ["mp4", "mov", "mkv", "webm"];

export function registerAssetIpc(
  handle: <T>(channel: string, fn: (...args: never[]) => Promise<T> | T) => void,
  userData: () => string,
  getWindow: () => BrowserWindow | null
): void {
  const list = (kind: string) => listAssets(userData(), kind as AssetKind);

  handle("asset:list", (kind: string) => list(kind));

  /** 批量导入。copy=true 会把文件复制进素材库 —— 原图可能随时被移动或改名 */
  handle("asset:import", async (kind: string, copy?: boolean) => {
    const win = getWindow();
    const isCover = kind === "covers";
    const exts = isCover ? COVER_EXT_LIST : TAIL_EXT_LIST;
    const opts = {
      title: isCover ? "选择封面图（可多选）" : "选择结尾藏带货视频（可多选）",
      properties: ["openFile", "multiSelections"] as const,
      filters: [{ name: isCover ? "图片" : "视频", extensions: exts }]
    };
    // 没有窗口时也能弹(部分平台支持),但拿不到结果就返回空,不能让这里抛出去
    const res = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : { canceled: true, filePaths: [] as string[] };
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: true, imported: [], skipped: 0, errors: [] };
    }
    return importAssets(userData(), kind as AssetKind, res.filePaths, copy !== false);
  });

  handle("asset:delete", (kind: string, ids: string[]) =>
    deleteAssets(userData(), kind as AssetKind, ids ?? [])
  );
  handle("asset:restore", (kind: string) => restoreAssets(userData(), kind as AssetKind));

  /**
   * 出片时真正用哪一条。放在主进程做,而不是渲染层随机 ——
   * 只有主进程知道最终选了谁,才能把"这次用了哪张封面"回显给用户。
   * 渲染层自己随机会导致用户看到的和实际烧进片子的是两张图。
   */
  handle("asset:pick", (kind: string, usePath: string | undefined, pick: string | undefined) =>
    pickAsset(userData(), kind as AssetKind, usePath, pick as "first" | "last" | "random" | undefined)
  );
}
