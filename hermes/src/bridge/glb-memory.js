/**
 * GLB 记忆桥（Hermes ⇄ GLB 桌面端/CLI/录播监听，三边同享）
 *
 * 原理：GLB 每次“AI 找爆点”都会把本机 review-memory.json（采用/否决样例）
 * 注入提示词。Hermes 直接读写这份原生文件，不改 GLB 一行源码：
 *
 *  灌注（Hermes → GLB）：历史爆款主题 + 你的评审意见（确认通过/打回），
 *    编成 GLB 原生 ReviewRecord，合并写入新旧两版用户目录。
 *    下次你在 GLB.exe 里点“AI 找爆点”，记忆自动生效。
 *  回流（GLB → Hermes）：桌面端新产生的采用/否决，变成 Hermes review lesson，
 *    看板下次粗剪自动遵守。首次同步只定基线，不批量倒灌，避免冲掉已有经验。
 *
 * 安全：只碰 review-memory.json；写前读出 GLB 自己的记录并保留；
 * 原子改名落盘；上限 40 场与上游一致；两边同时写以最后一次为准，
 * 每小时同步一次可自愈。performance-memory.json（含真实播放量）绝不伪造。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BRIDGE_TAG = '(hermes) ';
const MAX_RECORDS = 40; // 与 GLB 上游 recordReview 一致

export class GlbBridge {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  /** 新旧两版 GLB 的用户目录（v0.14 用 GLB，v0.28 用 glb）+ 配置可追加 */
  findUserDataDirs() {
    const found = [];
    const seen = new Set();
    const push = (d) => {
      if (!d || !existsSync(d)) return;
      // Windows/macOS 默认不区分大小写：GLB 与 glb 实为同一目录，必须去重，
      // 否则每次同步写两遍、回流经验也会重复导入
      const key = String(d).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      found.push(d);
    };
    for (const d of this.config?.glb?.userDataDirs || []) push(d);
    if (process.platform === 'win32') {
      const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
      push(join(appdata, 'GLB'));
      push(join(appdata, 'glb'));
    } else if (process.platform === 'darwin') {
      push(join(homedir(), 'Library', 'Application Support', 'glb'));
    } else {
      push(join(homedir(), '.config', 'glb'));
    }
    return found;
  }

  _readRecords(dir) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'review-memory.json'), 'utf-8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (r) => r && typeof r.at === 'string' && Array.isArray(r.kept) && Array.isArray(r.rejected)
      );
    } catch {
      return [];
    }
  }

  _writeRecords(dir, records) {
    const file = join(dir, 'review-memory.json');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(records.slice(-MAX_RECORDS), null, 2), 'utf-8');
    renameSync(tmp, file);
  }

  _toISO(sqliteTs) {
    try {
      const t = Date.parse(String(sqliteTs).replace(' ', 'T') + 'Z');
      if (Number.isFinite(t)) return new Date(t).toISOString();
    } catch {
      /* ignore */
    }
    return new Date().toISOString();
  }

  /** Hermes 侧拼出要灌注的记录（历史爆款主题 + 最近 20 条评审意见） */
  _buildBridgeRecords() {
    const out = [];

    // 1) 历史爆款主题 → 采用样例（同类优先）
    // durationSec 用爆款视频的真实时长（GLB 会把此时长展示给 LLM 做共性总结，
    // 这是让它感知“你家爆款多长”的唯一通道；以前写死的 60s 会把它往 1 分钟里带偏）
    try {
      const themes = (this.store.getAllHitThemes?.(50) || [])
        .filter((t) => t.theme_name)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 6);
      const hitDurs = [];
      try {
        const rows = this.store.db
          .prepare(
            "SELECT duration_ms FROM hit_videos WHERE analysis_status = 'completed' AND duration_ms > 0"
          )
          .all();
        for (const r of rows) hitDurs.push(r.duration_ms / 1000);
      } catch {
        /* ignore */
      }
      hitDurs.sort((a, b) => a - b);
      const medianDur = hitDurs.length > 0 ? hitDurs[Math.floor(hitDurs.length / 2)] : 60;
      // 先钳制再展示：爆款库里若有几条长视频，中位数会被拉大到几分钟，
      // 标题与 durationSec 必须一致，否则 LLM 无所适从。短视频取 3 分钟封顶。
      const idealDur = Math.max(15, Math.min(180, Math.round(medianDur)));
      const clampDur = (s) => Math.max(15, Math.min(180, Math.round(s || idealDur)));
      if (themes.length > 0) {
        out.push({
          at: new Date().toISOString(),
          video: `${BRIDGE_TAG}历史爆款主题`,
          kept: themes.map((t) => {
            let kw = [];
            try {
              const parsed = JSON.parse(t.keywords || '[]');
              if (Array.isArray(parsed)) kw = parsed.slice(0, 6);
            } catch {
              /* ignore */
            }
            return {
              title: String(t.theme_name).slice(0, 60),
              hook: kw.join('、'),
              score: Math.round((t.confidence || 0.7) * 100),
              durationSec: clampDur(medianDur),
              keywords: kw,
            };
          }),
          rejected: [],
        });
        // 2) 成片时长偏好：把“你家爆款平均多长”单独讲一遍，LLM 才会当回事
        const mm = Math.floor(idealDur / 60);
        const ss = Math.round(idealDur % 60);
        out.push({
          at: new Date().toISOString(),
          video: `${BRIDGE_TAG}成片时长偏好`,
          kept: [
            {
              title: `理想成片时长约${mm > 0 ? `${mm}分` : ''}${ss}秒`,
              hook: `历史爆款中位数时长，别切太碎（8~30秒的碎片不要）`,
              score: 90,
              durationSec: idealDur,
              keywords: ['时长偏好'],
            },
          ],
          rejected: [],
        });
      }
    } catch {
      /* ignore */
    }

    // 3) 评审反馈 → 确认通过进采用，打回进否决（精确到主题）
    try {
      const rows = this.store.db
        .prepare('SELECT * FROM review_feedback ORDER BY id DESC LIMIT 20')
        .all()
        .reverse();
      for (const f of rows) {
        const names = [];
        try {
          const ids = JSON.parse(f.segment_ids || '[]');
          if (Array.isArray(ids)) {
            for (const sid of ids.slice(0, 3)) {
              const seg = this.store.db
                .prepare('SELECT theme_name FROM live_segments WHERE id = ?')
                .get(sid);
              if (seg?.theme_name) names.push(seg.theme_name);
            }
          }
        } catch {
          /* ignore */
        }
        const live = f.live_video_id ? this.store.getLiveVideoById?.(f.live_video_id) : null;
        const vname = String(live?.video_name || '直播切片').replace(/\.[a-z0-9]+$/i, '');
        const comment = String(f.comment || '').slice(0, 80);
        const kept = f.decision === 'approve';
        const topics = names.length > 0 ? names : [`${vname}精选`];
        out.push({
          at: this._toISO(f.created_at),
          video: `${BRIDGE_TAG}${vname}`,
          kept: kept
            ? topics.map((t) => ({
                title: String(t).slice(0, 60),
                hook: comment || '用户确认通过',
                score: 85,
                durationSec: 60,
                keywords: [],
              }))
            : [],
          rejected: !kept
            ? topics.map((t) => ({
                title: String(t).slice(0, 60),
                hook: comment || '用户打回',
                score: 30,
                durationSec: 60,
                keywords: [],
              }))
            : [],
        });
      }
    } catch {
      /* ignore */
    }

    return out;
  }

  /**
   * 双向同步一次。
   * @returns {Promise<{dirs: string[], injected: number, pulledLessons: number}>}
   */
  async sync(opts = {}) {
    const { inject = true, pull = true } = opts;
    const dirs = this.findUserDataDirs();
    const bridge = inject ? this._buildBridgeRecords() : [];
    let profile = {};
    try {
      profile = this.store.getStyleProfile?.() || {};
    } catch {
      /* ignore */
    }
    const cursor = profile.glb_bridge_cursor || {};
    let injected = 0;
    let pulledLessons = 0;

    for (const dir of dirs) {
      const all = this._readRecords(dir);
      const own = all.filter((r) => !String(r.video || '').startsWith(BRIDGE_TAG));

      if (inject && bridge.length > 0) {
        // 给桥接记录预留配额：以前 [...own, ...bridge].slice(-40) 会挤掉用户最老的手动采用/否决
        const keepOwn = Math.max(0, MAX_RECORDS - bridge.length);
        this._writeRecords(dir, [...own.slice(-keepOwn), ...bridge]);
        injected += bridge.length;
      }

      if (pull) {
        const last = cursor[dir] || '';
        if (!last) {
          // 首次同步只定基线：不把存量老记录倒灌成经验，避免冲掉 Hermes 已有 lesson
          const latest = own.length > 0 ? own[own.length - 1].at : '';
          if (latest) cursor[dir] = latest;
          continue;
        }
        const fresh = own.filter((r) => r.at > last).slice(-10);
        for (const r of fresh) {
          for (const c of (r.kept || []).slice(0, 2)) {
            if (c?.title) {
              this.store.addReviewLesson?.(
                `GLB桌面端采用了《${c.title}》${c.hook ? `（钩子：${c.hook}）` : ''}`
              );
              pulledLessons++;
            }
          }
          for (const c of (r.rejected || []).slice(0, 2)) {
            if (c?.title) {
              this.store.addReviewLesson?.(`GLB桌面端否决了《${c.title}》，同类少选`);
              pulledLessons++;
            }
          }
        }
        if (fresh.length > 0) cursor[dir] = fresh[fresh.length - 1].at;
      }
    }

    if (pull) {
      try {
        this.store.setStyleProfile?.('glb_bridge_cursor', cursor);
      } catch {
        /* ignore */
      }
    }
    return { dirs, injected, pulledLessons };
  }
}

export default GlbBridge;
