/**
 * 路径归一化反查的回归测试
 *
 * 这条守的是一个**静默串档**的 bug：
 * 桌面端发 Windows 原生路径，库里存规范化路径，精确匹配查不到 →
 * liveId 为 null → collection 退化成"通用" →
 * A 老师的剪辑样本被记成对所有人生效。
 *
 * 症状：功能看着正常（样本入库了），归属全错，不报错。
 * 没有任何 UI 提示，只有靠这条测试才拦得住。
 *
 * @author 郭洛斌
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';

function expect(actual) {
  return {
    toBe: (v) => assert.strictEqual(actual, v),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeTruthy: () => assert.ok(actual),
    toBeGreaterThan: (v) => assert.ok(actual > v)
  };
}

describe('按路径反查直播 · 必须忽略分隔符与大小写', () => {
  let store;

  before(async () => {
    const { MemoryStore } = await import('../../memory/store.js');
    const dbPath = 'data/hermes-test-pathfind.db';
    const json = JSON.parse(readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf8'));
    json.memory = { ...json.memory, dbPath };
    store = new MemoryStore(json);
    // 库里存的是规范化路径（正斜杠），模拟真实数据
    const now = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO live_videos (video_path, video_name, analysis_status, created_at, collection)
      VALUES ('E:/直播/compressO-2026-06-17_103203.mp4', 'a.mp4', 'analyzed', ?, '某老师')
    `).run(now);
  });

  after(() => {
    try { store?.db?.close(); } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) {
      try { rmSync(join(process.cwd(), 'data', `hermes-test-pathfind.db${s}`), { force: true }); } catch { /* ignore */ }
    }
  });

  it('桌面端的反斜杠路径要能查到（这是串档的根因）', () => {
    const r = store._findLiveByPath('E:\\直播\\compressO-2026-06-17_103203.mp4');
    expect(r).toBeTruthy();
    expect(r.collection).toBe('某老师');
  });

  it('正斜杠（库里的原样）也能查到', () => {
    expect(store._findLiveByPath('E:/直播/compressO-2026-06-17_103203.mp4')).toBeTruthy();
  });

  it('大小写不同也能查到', () => {
    expect(store._findLiveByPath('e:/直播/Compresso-2026-06-17_103203.MP4')).toBeTruthy();
  });

  it('末尾多一个反斜杠也能查到', () => {
    expect(store._findLiveByPath('E:\\直播\\compressO-2026-06-17_103203.mp4\\')).toBeTruthy();
  });

  it('确实不存在的路径要返回 null（不能瞎猜一条）', () => {
    expect(store._findLiveByPath('E:/直播/别的视频.mp4')).toBeNull();
  });

  it('空路径返回 null', () => {
    expect(store._findLiveByPath('')).toBe(null);
    expect(store._findLiveByPath(null)).toBe(null);
  });

  it('collection 传 null 要存成真 NULL，不能是字符串 "null"', () => {
    /*
     * 回归：String(null) === 'null'，多包一层 String 就把 null 变成字符串了。
     * 后果是这条规则"添加成功、读不回来、也不生效"——
     * 查询条件 collection = NULL 永远匹配不上字符串 'null'。
     * 属于典型的"看着成功了，其实在哪都看不见"。
     */
    const r = store.addHotword(null, '猪老师', '朱老师');
    expect(r.ok).toBe(true);
    const raw = store.db.prepare('SELECT collection AS c, typeof(collection) AS t FROM hotwords WHERE id = ?').get(r.id);
    /*
     * 注意这里不能写 raw?.c ?? 'x'：
     * 值正确地等于 null 时，?? 会把它当成"空"再替换成 'x'，
     * 于是正确的实现反而报失败 —— 断言自己把正确答案判成了错。
     */
    assert.ok(raw, `id=${r.id} 的行必须查得到`);
    assert.strictEqual(raw.c, null, '必须是真 NULL');
    assert.strictEqual(raw.t, 'null', 'SQLite 里就是 NULL 类型');
    // 而且必须能被通用查询读回来
    expect(store.getHotwords(null).some((h) => h.from === '猪老师')).toBe(true);
  });
    it('精确匹配查不到时也不能退化成"通用归属"', () => {
    // 复现原 bug 的判据：桌面端路径必须能定位到那条直播，
    // 否则端点会拿不到 collection，样本被记成对所有人生效。
    const viaExact = store.db.prepare('SELECT id FROM live_videos WHERE video_path = ?')
      .get('E:\\直播\\compressO-2026-06-17_103203.mp4');
    const viaNorm = store._findLiveByPath('E:\\直播\\compressO-2026-06-17_103203.mp4');
    expect(viaExact ?? null).toBe(null);   // 精确匹配确实查不到 —— 这就是 bug 的成因
    expect(viaNorm).toBeTruthy();      // 归一化能查到 —— 修复生效
  });
});