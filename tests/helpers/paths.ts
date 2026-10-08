/**
 * 测试里读源码时用的路径解析。
 *
 * 要解决的问题：这些断言原来把路径写死成 D:/GLB/Hermes/... 和 D:/GLB-NEW/...。
 * 后果有两个，都很实际：
 *  1) 换台机器 clone 下来跑测试直接 ENOENT —— 整套契约测试全红，
 *     但红的原因跟代码对不对毫无关系，是文件不在。
 *  2) 验证的是"本机运行版"，而仓库里发布的是 hermes/ 快照。
 *     两者一旦漂移，测试照样全绿 —— 也就是说它守的东西其实是空的。
 *
 * 所以默认改成读仓库里那份快照（任何机器都有，且就是对外发布的那份），
 * 想验证真正在跑的运行版就设环境变量：
 *
 *   GLB_HERMES_ROOT=D:\GLB\Hermes npm test      对着运行版跑
 *   GLB_HERMES_ROOT=D:\GLB\Hermes npx vitest run tests/contract.test.ts
 *
 * 部署脚本（启动器、守卫）不在仓库里，属于本机文件，所以另设一个开关：
 *   GLB_DEPLOY_DIR=D:\GLB npm test
 * 不给就不跑那组断言 —— 因为文件不在仓库，任何人都无法验证，
 * 硬跑只会让所有人的测试都红。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根（tests/helpers/ 往上一级） */
export const REPO_ROOT = join(HERE, "..", "..");

/**
 * Hermes 源码根。
 * 默认用仓库里的快照；GLB_HERMES_ROOT 可以指到运行版。
 * 用 realpath 之外的普通 join 就好，不追求符号链接统一。
 */
export const HERMES_ROOT: string = process.env.GLB_HERMES_ROOT ?? join(REPO_ROOT, "hermes");

/** 读 hermes 源码里的某个文件：hermesFile("src/generator/index.js") */
export const hermesFile = (rel: string): string => join(HERMES_ROOT, rel);

/** 仓库内文件：repoFile("src/renderer/src/lib/text-layout.ts") */
export const repoFile = (rel: string): string => join(REPO_ROOT, rel);

/** 本机部署目录（start-glb.cmd / hermes-guard.js 所在处），默认没有 */
export const DEPLOY_DIR: string = process.env.GLB_DEPLOY_DIR ?? "";

/** 部署脚本是否可用。不给 GLB_DEPLOY_DIR 就是不可用。 */
export const hasDeployFiles: boolean = DEPLOY_DIR !== "" && existsSync(join(DEPLOY_DIR, "start-glb.cmd"));

/** 部署脚本路径；未配置时返回一个不存在的路径，让误用立刻暴露而不是静默读到别的文件 */
export const deployFile = (name: string): string => join(DEPLOY_DIR, name);