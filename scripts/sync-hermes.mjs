#!/usr/bin/env node
/**
 * 把本机在跑的 Hermes 同步进仓库的 hermes/ 目录。
 *
 * 为什么要这个脚本（2026-10-06）：
 * 仓库里 hermes/ 是**快照**，不是运行时那份。改完 D:\GLB\Hermes 的代码
 * 直接推不会更新仓库，两边会悄悄分叉 —— 到出事时已经晚了。
 *
 * 同步时做的三件事：
 *   1. 拷贝源码，排除本机状态（node_modules / data / upload / .git / logs）
 *   2. **脱敏**：把本机绝对路径、姓名换成占位符 —— 否则公开仓库会暴露你的目录结构
 *   3. 绝不碰密钥：config/secrets.local.json 一律不带过去
 *
 * 用法：node scripts/sync-hermes.mjs [--check]
 *        --check 只看有没有差异，不写入
 */
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = 'D:/GLB/Hermes';
const DST = 'D:/GLB-NEW/hermes';
const CHECK_ONLY = process.argv.includes('--check');

/*
 * 必须排除的：体积大 / 含密钥 / 含业务数据
 *
 * 'scripts' 的理由和上面几项不同，单独说：
 * 它不是体积或密钥问题，是"诊断脚本不属于引擎"。那 11 个文件全是
 * 那 11 个文件全是 diag-、probe-、reanalyze-、test-zen 这类一次性排查工具，
 * 依赖本机环境（路径写死 D:/GLB/Hermes、.py/.ps1/.cmd 混着），
 * 引擎跑起来一个都用不到。同步是"先 rmSync 清空 DST 再拷贝"的镜像同步，
 * 所以加了这一项，下次同步 hermes/scripts/ 会自动从快照里消失，
 * 不会每跑一次同步又把带本机路径的脚本带回来。
 */
const SKIP_DIRS = new Set(['node_modules', 'data', 'upload', '.git', 'logs', 'dist', 'out', 'scripts']);

/*
 * 但 data/ 里混着两种东西，不能整个排除也不能整个带走：
 *
 *  - 用户自己的配置（跟源码走，别人 clone 下来也得能跑）：
 *      clip-rules.json         粗剪剔除词、开场寒暄模式
 *      clip-standard.json      粗剪基准
 *      copywriting-presets.json 文案预设
 *      theme-taxonomy.json     主题受控词表
 *  - 运行状态和业务数据（绝不能进仓库）：
 *      hermes.db / *.bak / *.db-wal  数据库和备份
 *      active-collection.json        当前选中的 IP，是状态还会带真实姓名
 *      *.log / .hermes-secret        日志和密钥
 *      .tmp-* / e2e-tmp / frames      临时目录
 *
 * 早先整个 data/ 被排除，导致 clip-rules.json 缺席，
 * 回归测试直接红（测试断言的就是这个文件存在），仓库变成"clone 下来跑不起来"。
 */
const DATA_KEEP = new Set([
  'clip-rules.json',
  'clip-standard.json',
  'copywriting-presets.json',
  'theme-taxonomy.json',
]);

// data/ 下走白名单，其余一律不带
const isDataKeep = (rel) => rel.startsWith('data/') && DATA_KEEP.has(rel.slice(5));

/*
 * 哪些文件要过脱敏。
 *
 * 早先这里写死 /\.js|mjs|cjs|json|md|yml$/ —— 白名单式扩展名列表必然漏：
 * 2026-10-06 扫仓库时抓到 重新分析老素材.cmd 里带着真实用户名，
 * 正因为 .cmd 不在列表里，从来没被脱敏过。漏一个扩展名就是一个泄露口。
 *
 * 改成反过来：**默认全脱敏**，只把明显的二进制排除掉。
 * 新增任何脚本类型都不用记得改这个函数。
 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc',
  '.md', '.yml', '.yaml', '.txt', '.cmd', '.bat', '.ps1', '.sh',
  '.py', '.toml', '.ini', '.env', '.html', '.css', '.sql',
]);

// 扩展名不可靠（LICENSE、Makefile 之类），且内容确定是文本的，直接放行
const TEXT_BASENAME = new Set([
  'LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'README', 'CHANGELOG',
  'Makefile', 'Dockerfile', '.gitignore', '.gitattributes', '.npmrc',
]);

const isSanitizable = (rel) => {
  const base = rel.split('/').pop();
  if (TEXT_BASENAME.has(base)) return true;
  if (base.startsWith('.env')) return true;
  if (base.startsWith('.')) return false;         // .db / .exe / .secret 等
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;                      // 没扩展名的当二进制
  return TEXT_EXT.has(base.slice(dot).toLowerCase());
};

// 脱敏规则：只改副本，绝不碰本机运行目录
//
// 为什么不用正则（2026-10-06 修正）：
// 原来这里写的是 /C:\Users\<用户名>\/.../g 这种正则，字面量里的
// \U \G \2 都不是合法转义（\B 还会被当成单词边界），于是 replace 静默不匹配，
// 真实路径就原样进了仓库。这里改成**纯字符串替换**，没有转义歧义。
//
// 顺序敏感：长的写在前面。短的先替换会把长路径切成两半，替换不回来。
//
// 只有「仓库自己的结构」能写死在这里：仓库根目录名对外可见，
// 但本机用户名和盘符布局同样属于个人信息，所以也走本地映射表。
const PATH_SUBS = [
  ['D:\\GLB-NEW', '<REPO_ROOT>'],
  ['D:\\GLB\\', '<GLB_ROOT>/'],
];

/*
 * 姓名映射为什么必须放在 gitignore 的本地文件里（2026-10-06 修正）：
 *
 * 早先这里把真实称呼直接写在替换表里，后来改成 \u 转义。两次都不合格 ——
 * 这个脚本自己要进公开仓库，所以它是泄露源本身：
 *   - 明文：仓库里直接能读出真名；
 *   - 转义：\u795d 谁都能还原，等于没脱敏。
 * 扫业务文件全绿、脚本自己漏，这种泄露最难发现。
 *
 * 现在真名只存在于 scripts/sanitize-names.local.json，该文件被 .gitignore 排除，
 * 仓库里一个真名字形都没有。换机器时自己建一份即可。
 */
const NAMES_FILE = new URL('./sanitize-names.local.json', import.meta.url);

const loadLocalSubs = () => {
  if (!existsSync(NAMES_FILE)) {
    console.warn(
      '警告：找不到 ' + fileURLToPath(NAMES_FILE) + '\n' +
      '      本机脱敏规则（姓名 / 用户目录 / 素材目录）缺失，本次同步不会替换它们。\n' +
      '      在该文件里写成 [{ "from": "真实值", "to": "<占位符>" }] 即可，长的写前面。'
    );
    return [];
  }
  let j;
  try { j = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); }
  catch (e) { throw new Error('脱敏表不是合法 JSON: ' + e.message); }
  if (!Array.isArray(j)) throw new Error('脱敏表必须是数组: [{"from":"...","to":"..."}]');
  return j.map((r, i) => {
    if (!r || typeof r.from !== 'string' || !r.from || typeof r.to !== 'string') {
      throw new Error(`脱敏表第 ${i + 1} 条不对，需要 from/to 都是非空字符串`);
    }
    return [r.from, r.to];
  });
};

// 本机规则排在仓库规则之后：占位符互不干扰，但长串必须先于短串
const SUBS = [...PATH_SUBS, ...loadLocalSubs()];

// 源码里同一路径可能写成反斜杠也可能写成正斜杠，两种形态都要替掉
const SUBS2 = SUBS.flatMap(([from, to]) => [
  [from, to],
  [from.replace(/\\/g, '/'), to],
]);

const sanitize = (s) => {
  for (const [from, to] of SUBS2) s = s.split(from).join(to);
  return s;
};

const walk = (dir, acc = [], root = dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // 顺序要紧：data/ 的白名单必须先判。SKIP_DIRS 里含 'data'，
      // 先判它的话 data/ 整个被跳过，下面的白名单分支永远走不到
      // —— 结果是文件被拷进来了，但脱敏循环和差异检查都看不见它，
      //    真实 IP 名就这么原样进了仓库。
      if (e.name === 'data') {
        for (const f of DATA_KEEP) {
          const fp = join(dir, e.name, f);
          if (existsSync(fp)) acc.push(fp);
        }
        continue;
      }
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, acc, root);
    } else acc.push(p);
  }
  return acc;
};

if (!existsSync(SRC)) { console.error('找不到源目录: ' + SRC); process.exit(1); }

if (!CHECK_ONLY) {
  rmSync(DST, { recursive: true, force: true });
  mkdirSync(DST, { recursive: true });
  cpSync(SRC, DST, {
    recursive: true,
    filter: (s) => {
      const rel = relative(SRC, s);
      if (!rel) return true;
      const norm = rel.replace(/\\/g, '/');
      // data/ 要放行目录本身，否则白名单文件没机会被拷
      if (norm === 'data') return true;
      // 注意：data/ 的白名单必须先判。SKIP_DIRS 里含 'data'，
      // 先判它的话下面这行永远走不到，data/ 会一直是空的。
      if (norm.startsWith('data/')) return isDataKeep(norm);
      if (SKIP_DIRS.has(norm.split('/')[0])) return false;
      if (norm === 'config/secrets.local.json') return false;  // 密钥
      return true;
    },
  });
  let n = 0;
  for (const f of walk(DST)) {
    // 基准必须是 DST：walk(DST) 返回的是目标路径，
    // 拿 SRC 去算相对路径会得到 ../../..，于是每个文件都被当成无扩展名的二进制跳过
    if (!isSanitizable(relative(DST, f))) continue;
    let s; try { s = readFileSync(f, 'utf8'); } catch { continue }
    const o = s;
    s = sanitize(s);
    if (s !== o) { writeFileSync(f, s, 'utf8'); n++; }
  }
  console.log('已同步 ' + n + ' 个文件（已脱敏）');
}

// 差异检查
let diff = 0;
for (const f of walk(SRC)) {
  const rel0 = relative(SRC, f).replace(/\\/g, '/');
  if (!isSanitizable(rel0)) continue;
  const rel = rel0;
  if (rel === 'config/secrets.local.json') continue;  const t = join(DST, rel);
  if (!existsSync(t)) { console.log('  缺: ' + rel); diff++; continue; }
  let a = readFileSync(f, 'utf8'), b = readFileSync(t, 'utf8');
  a = sanitize(a);
  if (a !== b) { console.log('  改: ' + rel); diff++; }
}
console.log(diff ? '共 ' + diff + ' 处差异' + (CHECK_ONLY ? '（跑一次同步即可）' : '')
                 : '仓库里的 hermes/ 与本机一致');
