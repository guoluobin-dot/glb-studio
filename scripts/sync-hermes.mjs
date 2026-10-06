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
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const SRC = 'D:/GLB/Hermes';
const DST = 'D:/GLB-NEW/hermes';
const CHECK_ONLY = process.argv.includes('--check');

// 必须排除的：体积大 / 含密钥 / 含业务数据
const SKIP_DIRS = new Set(['node_modules', 'data', 'upload', '.git', 'logs', 'dist', 'out']);

/*
 * 但 data/ 里混着两种东西，不能整个排除也不能整个带走：
 *
 *  - 用户自己的配置（跟源码走，别人 clone 下来也得能跑）：
 *      clip-rules.json         粗剪剔除词、开场寒暄模式
 *      clip-standard.json      粗剪基准
 *      copywriting-presets.json 文案预设
 *  - 运行状态和业务数据（绝不能进仓库）：
 *      hermes.db / *.bak / *.db-wal  数据库和备份
 *      active-collection.json        当前选中的 IP，是状态还会带真实姓名
 *      *.log / .hermes-secret        日志和密钥
 *      .tmp-* / e2e-tmp / frames      临时目录
 *
 * 早先整个 data/ 被排除，导致 clip-rules.json 缺席，
 * 回归测试直接红（测试断言的就是这个文件存在），仓库变成"clone 下来跑不起来"。
 */
const DATA_KEEP = new Set(['clip-rules.json', 'clip-standard.json', 'copywriting-presets.json']);

// data/ 下走白名单，其余一律不带
const isDataKeep = (rel) => rel.startsWith('data/') && DATA_KEEP.has(rel.slice(5));

// 脱敏规则：只改副本，绝不碰 D:\GLB\Hermes
//
// 为什么不用正则（2026-10-06 修正）：
// 原来这里写的是 /<USER_HOME>\/.../g 这种正则，字面量里的
// \U \G \2 都不是合法转义（\B 还会被当成单词边界），于是 replace 静默不匹配，
// 真实路径就原样进了仓库。这里改成**纯字符串替换**，没有转义歧义。
//
// 顺序敏感：长的写在前面。短的先替换会把长路径切成两半，替换不回来。
const SUBS = [
  ['C:\\Users\\Administrator\\Videos\\GLB', '<USER_VIDEOS>/GLB'],
  ['C:\\Users\\Administrator', '<USER_HOME>'],
  ['D:\\GLB\\GLBUserData', '<GLB_USERDATA>'],
  ['D:\\GLB\\output', '<GLB_OUTPUT>'],
  ['D:\\GLB-NEW', '<REPO_ROOT>'],
  ['E:\\某\\2', '<素材目录>'],
  ['D:\\GLB\\', '<GLB_ROOT>/'],
  ['案例老师', '案例老师'],
];

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
      if (SKIP_DIRS.has(e.name)) continue;
      // data/ 本身要进，但只走白名单文件（与 cpSync 的 filter 保持一致）
      if (e.name === 'data') {
        for (const f of DATA_KEEP) {
          const fp = join(dir, e.name, f);
          if (existsSync(fp)) acc.push(fp);
        }
        continue;
      }
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
    if (!/\.(js|mjs|cjs|json|md|yml)$/.test(f)) continue;
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
  if (!/\.(js|mjs|cjs|json|md|yml)$/.test(f)) continue;
  const rel = relative(SRC, f).replace(/\\/g, '/');
  if (rel === 'config/secrets.local.json') continue;  const t = join(DST, rel);
  if (!existsSync(t)) { console.log('  缺: ' + rel); diff++; continue; }
  let a = readFileSync(f, 'utf8'), b = readFileSync(t, 'utf8');
  a = sanitize(a);
  if (a !== b) { console.log('  改: ' + rel); diff++; }
}
console.log(diff ? '共 ' + diff + ' 处差异' + (CHECK_ONLY ? '（跑一次同步即可）' : '')
                 : '仓库里的 hermes/ 与本机一致');
