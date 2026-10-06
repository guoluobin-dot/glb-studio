/**
 * 二进制与路径解析。
 * 打包后 ffmpeg/ffprobe 位于 asar.unpacked,路径必须改写(asar 内不可执行)。
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const require_ = createRequire(import.meta.url);

/** asar 内路径改写为 asar.unpacked 同级路径;非 asar 环境原样返回。纯函数,便于测试。 */
export function toUnpackedPath(target: string): string {
  return target.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

/** 解析 ffmpeg 可执行文件路径。找不到时抛出可读错误。 */
export function resolveFfmpeg(): string {
  const resolved = require_("ffmpeg-static") as string | null;
  if (!resolved || !existsSync(resolved)) {
    throw new Error("未找到 ffmpeg,请重新安装 GLB Studio");
  }
  return toUnpackedPath(resolved);
}

/** 解析 ffprobe 可执行文件路径。 */
export function resolveFfprobe(): string {
  const mod = require_("@ffprobe-installer/ffprobe") as { path: string };
  if (!mod?.path || !existsSync(mod.path)) {
    throw new Error("未找到 ffprobe,请重新安装 GLB Studio");
  }
  return toUnpackedPath(mod.path);
}

/** 打包体所在根目录(开发态为 out/,生产态为 exe 同级)。 */
export function bundleRoot(appPath: string, isPackaged: boolean): string {
  if (!isPackaged) return join(appPath, "..");
  return dirname(appPath);
}
