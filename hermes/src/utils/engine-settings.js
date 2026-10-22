/**
 * 桌面端「分析引擎」设置的读取器。
 *
 * 2026-10-12 加。修的是一个静默到极点的配置断链。
 *
 * 背景：桌面端（GLB Studio，app.asar 里）保存设置时做两件事：
 *   1) 写自己的 %APPDATA%\glb-studio\engine-settings.json —— 这步永远成功
 *   2) 再把同样的内容同步进 Hermes 的 config/default.json —— 靠一个**写死**的路径
 *      hermesConfigFile() = D:\GLB\Hermes\config\default.json
 *
 * 全家桶从 D: 挪到 E: 之后，第 2 步必然失败（existsSync 直接 false），
 * 而界面照样显示"已保存"——用户看到的是"我明明保存了 key，分析时还是说 key 缺失"。
 * 整个过程没有任何报错能传回来（同步失败的提示被吞在 Electron 控制台里）。
 *
 * 这已经是这套系统在"挪盘"上栽的第四个跟头（语音模型、package.json 测试脚本、
 * config 里的 D:/GLB 路径、现在这个）。而 app.asar 在 Electron 里是打包签名的，
 * 去改它要么重打包要么打补丁，风险和收益不成比例。
 *
 * 所以换个方向：**让 Hermes 反过来读桌面端那份设置**。
 * 桌面端才是用户填 key 的地方，它写的那份文件天然就是配置的第一来源；
 * 同步到 config/default.json 只是老代码的遗留通道，留着无害（两者一致时无差别）。
 *
 * 好处不止是"修好"：以后用户换 key、改协议、改中转地址，
 * 桌面端保存 → Hermes 20 秒热重载里读到，全程不用重启服务、不用手改 JSON。
 */
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { readJsonFile } from './read-config.js';

/** 桌面端设置文件的候选路径（环境变量优先，方便非标准部署） */
export function engineSettingsPaths() {
  const paths = [];
  const push = (p) => { if (p && !paths.includes(p)) paths.push(p); };
  push(process.env.GLB_ENGINE_SETTINGS);
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  push(join(appData, 'glb-studio', 'engine-settings.json'));
  push(join(appData, 'GLB Studio', 'engine-settings.json'));
  // 开发/便携部署：全家桶内的 GLBUserData（app.getPath('userData') 被改过时）
  push(join(process.cwd(), '..', 'GLBUserData', 'engine-settings.json'));
  return paths;
}

/** 桌面端文件实际在哪（排查用；没有则 null） */
export function findEngineSettingsFile() {
  for (const p of engineSettingsPaths()) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 桌面端把 provider 叫 local/cloud/auto，Hermes 叫 ollama/gemini/auto
 */
function mapProvider(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'cloud' || s === 'gemini') return 'gemini';
  if (s === 'local' || s === 'ollama') return 'ollama';
  if (s === 'auto') return 'auto';
  return null;
}

/**
 * secrets.local.json 的路径（与 src/hermes.js loadLocalSecrets 同一份）。
 * 抽出来是为了让"谁的 key 更新"这件事有据可查。
 *
 * 位置：<Hermes>/config/secrets.local.json。
 * 本文件在 src/utils/ 下，所以根是往上两级。
 */
export function secretsFilePath() {
  // ESM 里没有 __dirname，要从 import.meta.url 反推
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config', 'secrets.local.json');
}

/** 文件 mtime，取不到返回 0 */
function mtimeOf(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * 判断"桌面面板的 key 该不该盖掉配置里的 key"。
 *
 * 2026-10-12。这里原本是**无条件覆盖**：
 *   if (s.cloud.apiKey && s.cloud.apiKey.trim()) cfg.gemini.apiKey = s.cloud.apiKey;
 *
 * 造成的坑：config/default.json 里写的是 {env:GEMINI_API_KEY} 占位符
 * （setup-cloud.mjs gemini <key> / secrets.local.json 的合法用法），
 * 而面板里躺着用户几个月前填的一把 key。两者冲突时面板永远赢，
 * 于是命令行明明配了新 key，服务依旧用旧的 —— 界面上看不出任何区别，
 * 排查时只会看到"新 key 也不通"。
 *
 * 改用时间戳判定：**最近改的那份生效**。
 *   - 人在面板里填 key → 面板文件变新 → 面板赢（符合直觉）
 *   - 跑 setup-cloud.mjs 写 secrets/secrets.local.json → 那份文件变新 → 它赢
 *
 * 注意只对密钥做这件事。模型名、协议、地址这类设置面板仍然是唯一来源，
 * 因为它们不在 secrets 文件里，不存在"两份都对"的歧义。
 */
export function panelKeyWins(panelFile) {
  // 面板文件本身都不存在，谈不上谁赢
  if (!panelFile) return true;
  const secretsMtime = mtimeOf(secretsFilePath());
  if (!secretsMtime) return true;               // 没有 secrets 文件 → 面板是唯一来源
  const panelMtime = mtimeOf(panelFile);
  // 面板比 secrets 新（或同时改）→ 面板赢；secrets 更新 → 让位
  return panelMtime >= secretsMtime;
}

/**
 * 把桌面端设置合并进 Hermes 配置（原地改）。
 * @returns {{applied: boolean, file: string|null, reason?: string}}
 */
export function applyDesktopEngineSettings(cfg, file = findEngineSettingsFile()) {
  if (!cfg) return { applied: false, file: null, reason: '配置对象为空' };
  if (!file) return { applied: false, file: null, reason: '桌面端设置文件不存在' };
  let s;
  try {
    s = readJsonFile(file);
  } catch (err) {
    return { applied: false, file, reason: err.message };
  }
  if (!s || typeof s !== 'object') return { applied: false, file, reason: '设置文件内容不是对象' };

  const provider = mapProvider(s.defaultEngine);
  if (provider) cfg.llm = { ...(cfg.llm || {}), provider };

  if (s.local && typeof s.local === 'object') {
    if (s.local.baseUrl) cfg.ollama = { ...(cfg.ollama || {}), baseUrl: String(s.local.baseUrl) };
    if (s.local.model) cfg.ollama = { ...(cfg.ollama || {}), chatModel: String(s.local.model) };
  }
  if (s.cloud && typeof s.cloud === 'object') {
    // 空 key 不覆盖：桌面端只在用户清空时才会给空串，那时应该真的清掉，
    // 但旧版可能不返回该字段，undefined 不能当成"清空"。
    //
    // 另外要按时间戳决定谁赢（见 panelKeyWins 的注释）：面板的 key 会盖掉
    // default.json 里的 {env:...} 占位符，那会让 setup-cloud.mjs 配的新 key
    // 永远不生效。只有面板这份文件比 secrets.local.json 更新时才覆盖。
    if (typeof s.cloud.apiKey === 'string' && s.cloud.apiKey.trim() && panelKeyWins(file)) {
      cfg.gemini = { ...(cfg.gemini || {}), apiKey: s.cloud.apiKey.trim() };
    }
    if (s.cloud.model) cfg.gemini = { ...(cfg.gemini || {}), model: String(s.cloud.model) };
  }
  if (s.cloudProtocol) cfg.gemini = { ...(cfg.gemini || {}), protocol: String(s.cloudProtocol) };
  // 空地址 = "用官方地址"，不覆盖 config 里的 baseUrl
  if (s.cloudBaseUrl && String(s.cloudBaseUrl).trim()) {
    cfg.gemini = { ...(cfg.gemini || {}), baseUrl: String(s.cloudBaseUrl).trim() };
  }
  if (Number.isFinite(Number(s.cloudBudgetPerRun))) {
    cfg.gemini = { ...(cfg.gemini || {}), cloudBudgetPerRun: Number(s.cloudBudgetPerRun) };
  }
  // 代理留空 = 自动（环境变量 > Windows 系统代理），不能把空串写进去把自动探测关掉
  if (s.proxy && String(s.proxy).trim()) cfg.llm = { ...(cfg.llm || {}), proxy: String(s.proxy).trim() };

  return { applied: true, file };
}

/** 设置文件的 mtime（ms）。0 = 文件不存在 */
export function engineSettingsMtime(file = findEngineSettingsFile()) {
  if (!file) return 0;
  try { return statSync(file).mtimeMs; } catch { return 0; }
}