import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = src/analyzer/__tests__ → 仓库根要往上三层，不是两层
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'normalize-hit-themes.mjs');
const TMP = join(ROOT, 'data', '.tmp-theme-normalize-test.db');

/*
 * 历史主题归一脚本的安全约束
 *
 * 这个脚本直接 UPDATE 生产库。写它的时候我把 `if (!APPLY)` 守卫删掉过，
 * dry-run 一路跑到 prepare() 才崩 —— 崩在事务之前所以数据没被改，
 * 纯属运气，不是设计。这种事光靠 review 拦不住，所以在这里
 * 用一次性数据库把脚本真跑一遍，钉死"dry-run 不写库"。
 */

/** 造一个只有 hit_themes 的最小库，返回原始主题名 */
const seedDb = (rows) => {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
  const db = new Database(TMP);
  // 列要和脚本的 SELECT 一致，否则测的是"表结构不对"而不是"脚本行为"
  db.exec(`CREATE TABLE hit_themes (
    id INTEGER PRIMARY KEY,
    hit_video_id INTEGER,
    theme_name TEXT,
    confidence REAL,
    keywords TEXT,
    related_segments TEXT
  )`);
  const ins = db.prepare('INSERT INTO hit_themes (id, hit_video_id, theme_name, confidence, keywords, related_segments) VALUES (?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(i + 1, i + 1, r.name, 0.9, JSON.stringify(r.kws ?? []), '[]'));
  db.close();
  return rows.map((r) => r.name);
};

const readThemes = () => {
  const db = new Database(TMP, { readonly: true });
  const out = db.prepare('SELECT theme_name FROM hit_themes ORDER BY id').all().map((r) => r.theme_name);
  db.close();
  return out;
};

const run = (args = []) => execFileSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DB_PATH_OVERRIDE: TMP },
});

const cleanup = () => {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
};

test.after(cleanup);

test('脚本存在', () => {
  assert.ok(existsSync(SCRIPT), `找不到 ${SCRIPT}`);
});

test('dry-run 一个字都不能改（真跑一遍验证，不是看日志）', () => {
  const before = seedDb([
    { name: '高音技巧教学', kws: ['高音', '鼻孔发力'] },
    { name: '气息训练', kws: ['气息', '腹部发力'] },
  ]);
  const out = run();
  assert.match(out, /dry-run，库没有改动/, '必须明确声明没有改动');
  assert.deepEqual(readThemes(), before, 'dry-run 之后主题名必须原封不动');
  cleanup();
});

test('dry-run 也不能留下备份文件（备份只属于写入）', () => {
  seedDb([{ name: '高音技巧教学', kws: ['高音'] }]);
  const before = readdirCount();
  run();
  assert.equal(readdirCount(), before, 'dry-run 不该产生 .bak 文件');
  cleanup();
});

test('--apply 才写库，而且写完主题确实变了', () => {
  const before = seedDb([
    { name: '高音技巧教学', kws: ['高音', '鼻孔发力'] },
    { name: '气息训练', kws: ['气息', '腹部发力'] },
  ]);
  const out = run(['--apply']);
  assert.match(out, /已备份到/, '写入前必须先备份');
  assert.match(out, /写入完成/, '写入后必须回报结果');

  const after = readThemes();
  assert.notDeepEqual(after, before, '--apply 必须真的改了库');
  assert.ok(after.includes('高音突破'), '「高音技巧教学」应归到「高音突破」');
  assert.ok(after.includes('气息与腹式呼吸'), '「气息训练」应归到「气息与腹式呼吸」');
  cleanup();
});

test('--apply 之后重复跑是幂等的，不会乱改', () => {
  seedDb([
    { name: '高音技巧教学', kws: ['高音', '鼻孔发力'] },
    { name: '气息训练', kws: ['气息', '腹部发力'] },
  ]);
  run(['--apply']);
  const once = readThemes();
  const out = run(['--apply']);
  assert.deepEqual(readThemes(), once, '已经是标准分类名的不能再被改');
  assert.match(out, /没有需要归一的主题/);
  cleanup();
});

test('分不清的主题原样保留，不能被硬塞进某个分类', () => {
  // 吸气 vs 腔体 各打平：这条素材真的两可
  const before = seedDb([{ name: '唱歌技巧教学', kws: ['吸气', '腔体', '保持', '发力'] }]);
  run(['--apply']);
  assert.deepEqual(readThemes(), before, '打平的主题必须原样保留');
  cleanup();
});

test('keywords 是坏 JSON 也不能中断整批迁移', () => {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) rmSync(f, { force: true });
  const db = new Database(TMP);
  db.exec(`CREATE TABLE hit_themes (
    id INTEGER PRIMARY KEY,
    hit_video_id INTEGER,
    theme_name TEXT,
    confidence REAL,
    keywords TEXT,
    related_segments TEXT
  )`);
  const ins = db.prepare('INSERT INTO hit_themes (id, hit_video_id, theme_name, confidence, keywords, related_segments) VALUES (?,?,?,?,?,?)');
  // 第 1 行 keywords 是坏 JSON —— 它必须只影响自己，不能带崩整批
  ins.run(1, 1, '歌唱技巧教学', 0.9, '这不是 JSON', '[]');
  ins.run(2, 2, '气息训练', 0.9, JSON.stringify(['气息', '腹部发力']), '[]');
  ins.run(3, 3, '高音技巧教学', 0.9, '[[[', '[]');
  db.close();

  run(['--apply']);   // 抛异常就会直接 fail

  const after = readThemes();
  assert.ok(after.includes('气息与腹式呼吸'),
    '坏行之后的正常行必须照样归一 —— 说明脚本没被坏数据打断');
  assert.ok(after.includes('高音突破'),
    'keywords 坏了但主题名够用时，仍应归一');
  assert.ok(after.includes('歌唱技巧教学'),
    '主题名和 keywords 都给不出证据时，必须原样保留而不是瞎归');
  cleanup();
});

test('脚本源码里必须留着 --apply 守卫和备份', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /if \(!APPLY\)/,
    '守卫被删过一次，dry-run 直接冲进写入路径');
  assert.match(src, /bak-before-theme-normalize/, '写入前必须自动备份');
});

/** 数一下 data/ 目录里的 .bak 数量，用来验证 dry-run 不产生备份 */
function readdirCount() {
  return readdirSync(join(ROOT, 'data'))
    .filter((f) => f.includes('bak-before-theme-normalize')).length;
}