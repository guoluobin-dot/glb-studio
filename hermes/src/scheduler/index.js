/**
 * Idle Scheduler - 空闲任务调度器
 *
 * Periodically scans upload directories and processes pending videos:
 * 1. Scans upload/hits/ for unanalyzed hit videos → triggers HitAnalyzer
 * 2. Scans upload/live/ for unanalyzed live videos → triggers LiveAnalyzer
 * 3. Checks for analyzed live videos with no clip projects → triggers Clipper
 * 4. Checks for clip projects in 'reviewing' status → triggers ContentGenerator
 * 5. Periodically checks for timed-out user queries
 *
 * Maintains a task queue to avoid concurrent processing conflicts.
 */

import { readdirSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { getGpuState } from './gpu.js';

export class IdleScheduler {
  constructor(orchestrator, config) {
    this.orchestrator = orchestrator;
    this.config = config;
    this.scanIntervalMs = config.scheduler?.scanIntervalMs || 30000;
    this.maxConcurrent = config.scheduler?.maxConcurrentTasks || 2;
    // LLM 分析任务（hit/live）的独立并发闸门。
    // 2026-09-24 修：_effLimit 来自 maxConcurrentIdle（默认 3），那是给纯 CPU 任务（转写/抽帧）算的；
    // 直接套到 LLM 分析上会同时起 3 个 HitAnalyzer，每个还要 vision+text 两轮 Ollama，
    // 3 路 qwen3:8b 抢 8G 显存必然 OOM / fetch failed。RTX 4060 8G 只够一个 8B 模型。
    // 想开大改 config.performance.maxConcurrentLlm，默认 1 = 串行。
    this.llmLimit = Math.max(1, Number(config.performance?.maxConcurrentLlm ?? 1) || 1);
    this.runningTasks = new Set();
    this.timer = null;
    this.isRunning = false;
    // 失败退避：确定性失败（静音/无转写/坏文件）以前每 30s 重跑一次全量流程还永远失败，
    // 11 个坏爆款就能把整轮 tick 堵死。5 次后放弃（重启清零），30 分钟内不重试同文件
    this._failStrikes = new Map();
    // failed 状态冷却表：analyse() 失败时是"置 failed 后正常 return"，不抛异常，
    // 调度器因此走 _noteOk() 把上面的退避清零 —— 结果就是每 30s 完整重跑一次 ffprobe+ASR。
    // 这里单独给 failed 记一次时间戳，6 小时内不再自动捡起来（想立刻重来去点"重新分析"）。
    this._failedAt = new Map();
    // 用户优先集：看板上点了“重新分析/粗剪”的视频路径，下轮优先处理（用户打开哪个先转哪个）
    this._priorityPaths = new Set();
  }

  /** 看板手动触发时调用：该视频下轮第一个处理 */
  prioritize(videoPath) {
    if (!videoPath) return;
    this._priorityPaths.add(String(videoPath).replace(/\\/g, '/').toLowerCase());
  }

  _isPriority(videoPath) {
    return this._priorityPaths.has(String(videoPath || '').replace(/\\/g, '/').toLowerCase());
  }

  _consumePriority(videoPath) {
    this._priorityPaths.delete(String(videoPath || '').replace(/\\/g, '/').toLowerCase());
  }

  _skipBackoff(key) {
    const s = this._failStrikes.get(key);
    if (!s) return false;
    if (s.n >= 5) return true;
    if (Date.now() - s.last < 30 * 60 * 1000) return true;
    return false;
  }

  _noteFail(key) {
    const s = this._failStrikes.get(key) || { n: 0, last: 0 };
    s.n++;
    s.last = Date.now();
    this._failStrikes.set(key, s);
    if (s.n === 5) console.warn(`[Scheduler] ${key} 连败 5 次，本次启动不再重试（重启后会再试；可在看板手动“重新分析”）`);
  }

  _noteOk(key) {
    this._failStrikes.delete(key);
    this._failedAt.delete(key);
  }

  /**
   * 当前档位允许同时跑几个 LLM 任务（0 = 一个都不开，只做纯 CPU 转写）。
   * 自动 tick 和看板"扫一遍"共用这一套判断，避免手动入口绕过忙闲让路。
   */
  _computeLimit(gpu) {
    const perf = this.config.performance || {};
    return gpu.mode === 'idle'
      ? (perf.maxConcurrentIdle ?? this.maxConcurrent ?? 2)
      : (perf.maxConcurrentBusy ?? this.maxConcurrent ?? 2);
  }

  /**
   * LLM 任务的并发闸门：CPU 上限与显存上限取小的那个。
   *
   * 2026-10-05 统一：以前只有 hits / lives 走了这个闸门，
   * deepBackfill / pendingPredictions / readyProjects 三处直接用 _effLimit
   * （配置里是 3）。而它们全都是调本地 Ollama 的任务 ——
   * 文件头注释写得很清楚："3 路 qwen3:8b 抢 8G 显存必然 OOM / fetch failed"。
   *
   * 于是一轮里 1 个 clip + 1 个 predict + 1 个 deep 同时打显存，
   * 实测能把 GPU 顶到 96%，也就是用户报的那台机器"卡死"。
   *
   * 放在一个方法里而不是各写各的：三处口径不一致过一次，
   * 下次再加任务又漏一处的话，同样是静默的资源失控。
   */
  _llmGate() {
    const cpuLimit = Math.max(1, Number(this._effLimit ?? this.maxConcurrent) || 1);
    return Math.max(1, Math.min(cpuLimit, this.llmLimit));
  }

  /**
   * 素材已处于 failed：是否给它一次重跑机会。
   * 冷却 6 小时（默认）内一律跳过；冷却结束后放行一次，再失败则重新计时。
   * 手动"重新分析"不走这条路，随时可用。
   */
  _allowFailedRetry(key) {
    const cooldownMs = this.config.scheduler?.failedRetryAfterMs ?? 6 * 3600e3;
    const t = this._failedAt.get(key);
    if (!t) {
      this._failedAt.set(key, Date.now()); // 首次见到 failed：本次跳过并开始计时
      return false;
    }
    if (Date.now() - t < cooldownMs) return false;
    this._failedAt.delete(key); // 冷却结束，给一次机会；再失败会重新记时间戳
    return true;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Scheduler] Started. Scan interval: ${this.scanIntervalMs}ms, max concurrent: ${this.maxConcurrent}`);

    // Run immediately once
    this._tick();

    // Then schedule periodic scans
    this.timer = setInterval(() => this._tick(), this.scanIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // _tickRunning 必须在这里清掉：暂停时若正好有任务悬挂（Ollama 假死导致 analyze 永不 resolve），
    // 标志位会一直是 true，之后 resume() 每轮都在 _tick() 第一行 return，调度器永久静默且无日志。
    this._tickRunning = false;
    /*
     * 2026-10-05 补清 runningTasks。
     *
     * 它和 _tickRunning 是同一个坑的另一半，而且是更狠的那个：
     * 每个处理器的第一道闸门都是 `runningTasks.size >= 上限`，
     * 而所有闸门都是"有上限就 return"。所以只要有一条 key 是暂停时遗留的，
     * 恢复后每一轮都会在这里 return —— **调度器永久静默，没有任何日志**。
     *
     * 实测场景：暂停/恢复（/api/scheduler/stop|start）时正好有 ffmpeg 切片在跑，
     * 那条 key 就留在集合里，用户点了恢复也再也不会自动分析任何东西。
     * 表现和 _tickRunning 卡死一模一样，但更隐蔽：日志里连一行都没有。
     *
     * 清掉是对的：进程内的这些 key 代表"此刻在跑的任务"，
     * 而 stop() 返回时那些任务要么被杀、要么已不存在，
     * 留着它们等于对后续每一轮撒谎。
     */
    const leftover = this.runningTasks.size;
    if (leftover) {
      console.warn(`[Scheduler] 停机时清掉 ${leftover} 条遗留任务标记（否则恢复后闸门永远关闭）`);
      this.runningTasks.clear();
    }
    console.log('[Scheduler] Stopped');
  }

  async _tick() {
    // 防重叠：上轮没跑完（大文件转写几十分钟）时 setInterval 会再开一轮，同视频双跑
    if (this._tickRunning) return;
    this._tickRunning = true;
    try {
      return await this._tickInner();
    } catch (err) {
      // _tickInner 开头那段（GPU 检测、超时问询）在它自己的 try 之外，
      // 抛出来的话以前会变成 unhandledRejection，本轮的清理/记忆桥/空壳清理全部跳过。
      console.error('[Scheduler] Tick crashed:', err?.message || err);
    } finally {
      this._tickRunning = false;
    }
  }

  async _tickInner() {
    // 忙闲双模：先看显卡。注意排除“自家负载”——Ollama 推理时 GPU 96% 是 Hermes 自己在干活，
    // 此时不应让路；只有“我们没任务、GPU 还很高”才说明用户在用电脑（游戏/剪辑），这才让路。
    const gpu = await getGpuState(this.config);
    this.lastGpu = gpu;
    const perf = this.config.performance || {};
    // 自家负载 = 本调度器在跑的任务 + Ollama 正在推理。
    // 后者多为看板手动触发的分析，不进 runningTasks，只盯 GPU 利用率会把它当成"用户在用电脑"。
    const busyByUs = this.runningTasks.size > 0 || !!gpu.ollamaBusy;
    if (gpu.mode === 'busy' || gpu.ollamaBusy) {
      // 两种忙都不再起新的 LLM 任务（在跑的不停）：用户忙是让路，自家推理是等它跑完，
      // 避免自动任务和手动任务同时抢占 8G 显存、双双 fetch failed。
      // 但转写（Sherpa/ffmpeg 纯 CPU）不受影响：开着剪映也照转，攒好缓存等闲时再分析。
      if (!this._busyLogged || Date.now() - this._busyLogged > 300000) {
        const why = gpu.ollamaBusy
          ? `Ollama 正在推理（看板手动任务在跑），自动任务让路`
          : (busyByUs
            ? `GPU ${gpu.util}%（自家任务在跑），等本轮跑完再起新的`
            : `GPU 忙（${gpu.util}%，用户在用），LLM 任务让路`);
        console.log(`[Scheduler] ${why}，转写继续`);
        this._busyLogged = Date.now();
      }
      this.orchestrator.userQuery?.checkTimeouts();
      if (this.config.scheduler?.transcribeOnBusy !== false) {
        try { await this._transcribeIdle(); } catch (err) {
          console.warn('[Scheduler] Busy-transcribe failed:', err.message);
        }
      }
      return;
    }
    // 原来这里只读 maxConcurrentIdle，config 里的 performance.maxConcurrentBusy 从来没人读，
    // 于是"忙时让路"这条配置一直是废的。0 = normal 档也完全不开新的 LLM 任务。
    const limit = this._computeLimit(gpu);
    if (limit <= 0) {
      if (!this._limitLogged || Date.now() - this._limitLogged > 300000) {
        this._limitLogged = Date.now();
        console.log(`[Scheduler] GPU ${gpu.util}%（${gpu.mode} 档），performance.maxConcurrentBusy=${limit}，本轮不开新的 LLM 任务（转写照常）`);
      }
      this.orchestrator.userQuery?.checkTimeouts();
      return;
    }
    if (this.runningTasks.size >= limit) {
      console.log(`[Scheduler] Max concurrent tasks reached (${this.runningTasks.size}/${limit}, mode=${gpu.mode}), skipping tick`);
      return;
    }
    this._effLimit = limit;

    /*
     * 2026-10-05 修：空闲路径也要预转写，但**不能挡住分析**。
     *
     * 原来这里 `await this._transcribeIdle()`，而 _transcribeIdle 内部是真的在跑
     * 抽音 + Sherpa 推理 —— 一场直播几分钟。await 期间这一轮就卡在这儿，
     * 后面的 _processPendingHits / 深度补全 / 粗剪全都没机会跑。
     * 表现就是"我明明闲着，队列却不动"，而且没有任何日志。
     *
     * 预转写本身是纯 CPU 的（不吃显存），和分析没有资源冲突 ——
     * 不该阻塞，只是顺序问题。所以改成登记成后台任务让它自己跑，
     * 由 runningTasks 记账（并发闸门照常看得见），不占住这一轮。
     */
    if (this.config.scheduler?.transcribeOnIdle !== false) {
      this._startIdleTranscribe();
    }

    try {
      // 1. Process pending hit videos
      await this._processPendingHits();

      // 1b. 存量补预测：已分析完但缺预测的，每轮补一条（自动预测，省显存串行）
      await this._processPendingPredictions();
      // 2026-09-27 恢复自动深解（老板指令六.3）：LLM 已切 DeepSeek，文本深解不再烧本地 GPU；
      // 视觉部分自动回落本地 qwen2.5vl。深解产出（结构/保留丢弃/切点）留作后续接粗剪的素材库。
      await this._processDeepBackfill();

      // 2. Process pending live videos
      await this._processPendingLives();

      // 3. Process clip projects ready for clipping (粗剪到 reviewing 即停，等用户确认；
      // 成片只走手动“生成成片”，调度器/扫一遍永不自动包装)
      await this._processReadyProjects();

      // 5. Check timed-out queries
      this.orchestrator.userQuery?.checkTimeouts();

      // 6. 每小时顺手扫一次临时残留（24h+ 的 temp/半截文件；废弃草稿只手动清理，不自动删）
      // 7. 每小时把记忆桥跑一次（Hermes ⇄ GLB 桌面端/CLI 双向同步）
      try {
        if (!this._lastAutoClean || Date.now() - this._lastAutoClean > 3600e3) {
          this._lastAutoClean = Date.now();
          const rep = await this.orchestrator._cleanupRedundant(false, { includeDrafts: false });
          if (rep.count > 0) {
            console.log(`[Scheduler] Auto-cleaned ${rep.count} temp leftover(s), freed ${(rep.freedBytes / 1048576).toFixed(1)} MB`);
          }
        }
        if (!this._lastBridgeSync || Date.now() - this._lastBridgeSync > 3600e3) {
          this._lastBridgeSync = Date.now();
          const rep = await this.orchestrator.glbBridge.sync();
          console.log(`[Scheduler] Memory bridge synced (${rep.dirs.length} dir(s), +${rep.injected} injected, +${rep.pulledLessons} lessons)`);
        }
        // 7b. 每小时把 WAL 落一次主库。store 构造函数里虽然也落一次，但那是一锤子买卖：
        //     服务一跑几天，WAL 只增不减；更坑的是"按需建的表可能只存在于 WAL 里"，
        //     此时直接 copy hermes.db 会得到缺表的残库（备份恢复踩过）。
        if (!this._lastWalCkpt || Date.now() - this._lastWalCkpt > 3600e3) {
          this._lastWalCkpt = Date.now();
          try { this.orchestrator.store.checkpointWal?.(); } catch { /* ignore */ }
        }
        // 8. 每天自主清一次"空壳记忆"：视频文件已经被手工删掉、库里却还留着的记录
        //    （留着只会让统计变乱、还会带偏爆款预测基线）。只清文件确实不在的，不碰任何正常素材。
        if (!this._lastPurgeOrphans || Date.now() - this._lastPurgeOrphans > 86400e3) {
          this._lastPurgeOrphans = Date.now();
          const r = this.orchestrator.store.purgeOrphanHits();
          if (r.deleted > 0) {
            this.orchestrator._briefCache = null;
            console.log(`[Scheduler] 自主清理：清掉 ${r.deleted} 条空壳记忆（源视频已不在磁盘）`);
          }
        }
      } catch (err) {
        console.warn('[Scheduler] Auto-clean/bridge failed:', err.message);
      }

    } catch (err) {
      console.error('[Scheduler] Tick error:', err.message);
    }
  }

  async _processPendingHits() {
    const hitsDir = this.config.upload?.hitsDir;
    const files = [];
    if (hitsDir && existsSync(hitsDir)) {
      for (const f of readdirSync(hitsDir).filter(f => /\.(mp4|mov|mkv|webm|flv|avi)$/i.test(f))) {
        files.push(join(hitsDir, f).replace(/\\/g, '/'));
      }
    }

    /*
     * 除了扫目录，还要取库里登记为 pending 的路径。
     *
     * 以前只有目录扫描，于是桌面端「继续上传爆款素材」从 E:\直播\ 之类
     * 任意位置选的视频永远进不了队列 —— 登记完就没下文了，
     * 素材既没分析也没进画像，界面看起来"上传成功了"但什么都没学到。
     * 这和 live_videos 一直用 DB 取队列的做法是一致的，hits 这边补上。
     */
    try {
      /*
       * 2026-10-05 修：这里原来还带一个 `AND (asr_path IS NULL OR asr_path = '')`，
       * 条件正好写反了。
       *
       * 分析队列要的是"还没分析完"的素材，而不是"还没转写完"的素材：
       * 转写只要有逐句稿就够了（analyze() 内部自己 getTranscript，命中缓存就是秒过）。
       * 而只要 asr_path 有值 —— 无论是被 _transcribeIdle 回填的，还是进程启动时
       * 从缓存补上的 —— 这些行就被这个条件永久排除出队列了。
       *
       * 后果很具体：一条素材转写成功、LLM 分析途中被打断（重启/取消），就变成
       * status=pending 且 asr_path 非空 —— 既不会被分析队列选中，
       * 也不会被 _transcribeIdle 选中（它只管 asr_path 为空的），于是永远卡住。
       * 实测 15 条案例老师爆款素材在队列里躺了一整天，界面上表现为"上传后什么都不学进去"。
       *
       * 所以这里只按 status 取，转写仍由 analyze() 自己兜底。
       */
      const rows = this.orchestrator.store.db
        .prepare("SELECT video_path AS p FROM hit_videos WHERE analysis_status = 'pending'")
        .all();
      for (const r of rows) if (r.p) files.push(String(r.p).replace(/\\/g, '/'));
    } catch (err) {
      console.warn('[Scheduler] 读取 pending 爆款失败:', err.message);
    }
    // 去重：同一条可能既在目录里又被登记成 pending
    const uniq = [...new Set(files)];

// 用户优先：看板上点过的视频排最前
    if (this.config.scheduler?.priorityFirst !== false && this._priorityPaths.size > 0) {
      uniq.sort((a, b) => (this._isPriority(b) ? 1 : 0) - (this._isPriority(a) ? 1 : 0));
    }

    // 并发闸门：CPU 任务用 file 级上限，LLM 闸门（显存）都要满
    const limit = this._llmGate();
    const queue = [];
    for (const videoPath of uniq) {
      if (this.runningTasks.size + queue.length >= limit) break;
      if (this.runningTasks.has(`hit:${videoPath}`)) continue;

      const existing = this.orchestrator.store.getHitVideo(videoPath);
      if (existing && (existing.analysis_status === 'completed' || existing.analysis_status === 'analyzing' || existing.analysis_status === 'skipped')) {
        continue;
      }
      // failed 必须跳过：无转写的素材被 analyse() 置成 failed 后是正常 return（不抛异常），
      // 走不到 _noteFail()，退避计数每次都被 _noteOk() 清零 → 30s 一轮完整重跑 ffprobe+ASR。
      if (existing?.analysis_status === 'failed' && !this._allowFailedRetry(`hit:${videoPath}`)) continue;
      if (this._skipBackoff(`hit:${videoPath}`)) continue;

      queue.push(videoPath);
    }
    if (!queue.length) return;

    // 真并发：以前是 for 里 await，永远只跑 1 条，maxConcurrentIdle:3 形同虚设；
    // 一个大文件转写能把整轮 tick 独占几十分钟，期间超时问询/清理/记忆桥全部停摆。
    await Promise.all(queue.map(async (videoPath) => {
      // add 必须在 try 内：以前 add 在 try 之外，中间夹着 _consumePriority/console.log，
      // 这两句只要有一句抛（比如 stdout 管道断开），finally 就不会执行 →
      // 这个 key 永久留在 runningTasks 里，size 再也回不到 0，调度器静默停摆。
      const key = `hit:${videoPath}`;
      try {
        this.runningTasks.add(key);
        this._consumePriority(videoPath);
        console.log(`[Scheduler] Starting hit analysis: ${videoPath}`);
        await this.orchestrator.hitAnalyzer.analyze(videoPath);
        this._noteOk(key);
        console.log(`[Scheduler] Hit analysis complete: ${videoPath}`);
      } catch (err) {
        this._noteFail(key);
        console.error(`[Scheduler] Hit analysis failed: ${videoPath}:`, err.message);
      } finally {
        this.runningTasks.delete(key);
      }
    }));
  }

  /** Deep-memory backfill: completed但无深解记录的，每轮补一条（串行省显存）。
   *  新投喂的视频分析完后由这里自动加深，无需改 analyze()。 */
  async _processDeepBackfill() {
    if (this.runningTasks.has('deep:backfill')) return;
    if (this.runningTasks.size >= this._llmGate()) return;
    let row = null;
    try {
      row = this.orchestrator.store.db.prepare(
        "SELECT v.id, v.video_path, v.video_name FROM hit_videos v LEFT JOIN deep_memory d ON d.hit_video_id = v.id " +
        "WHERE v.analysis_status = 'completed' AND (d.hit_video_id IS NULL OR v.analyzed_at > d.updated_at) ORDER BY v.id LIMIT 1"
      ).get();
    } catch { return; }
    if (!row) return;
    if (this._skipBackoff(`deep:${row.id}`)) return;
    this.runningTasks.add('deep:backfill');
    console.log(`[Scheduler] Deep-memory backfill hit ${row.id} (${row.video_name || ''})`);
    try {
      await this.orchestrator.deepAnalyzer.analyze(row.video_path);
      this._noteOk(`deep:${row.id}`);
    } catch (err) {
      this._noteFail(`deep:${row.id}`);
      console.error(`[Scheduler] Deep backfill failed for hit ${row.id}:`, err.message);
    } finally {
      this.runningTasks.delete('deep:backfill');
    }
  }

  async _processPendingPredictions() {
    if (this.runningTasks.has('predict:backfill')) return;
    if (this.runningTasks.size >= this._llmGate()) return;
    let row = null;
    try {
      row = this.orchestrator.store.db.prepare(
        "SELECT v.id, v.video_name FROM hit_videos v LEFT JOIN hit_predictions p ON p.hit_video_id = v.id WHERE v.analysis_status = 'completed' AND p.id IS NULL LIMIT 1"
      ).get();
    } catch {
      return;
    }
    if (!row) return;
    if (this._skipBackoff(`predict:${row.id}`)) return;
    this.runningTasks.add('predict:backfill');
    console.log(`[Scheduler] Auto-predicting hit ${row.id} (${row.video_name})`);
    try {
      await this.orchestrator.predictHitVideo(row.id);
      this._noteOk(`predict:${row.id}`);
      console.log(`[Scheduler] Auto-predict complete for hit ${row.id}`);
    } catch (err) {
      this._noteFail(`predict:${row.id}`);
      console.error(`[Scheduler] Auto-predict failed for hit ${row.id}:`, err.message);
    } finally {
      this.runningTasks.delete('predict:backfill');
    }
  }

  async _processPendingLives() {
    const liveDir = this.config.upload?.liveDir;
    if (!liveDir || !existsSync(liveDir)) return;

    const files = readdirSync(liveDir)
      .filter(f => /\.(mp4|mov|mkv|webm|flv|avi)$/i.test(f))
      .map(f => join(liveDir, f).replace(/\\/g, '/'));

    // 用户优先：看板上点过的视频排最前（打开哪个先转哪个）
    if (this.config.scheduler?.priorityFirst !== false && this._priorityPaths.size > 0) {
      files.sort((a, b) => (this._isPriority(b) ? 1 : 0) - (this._isPriority(a) ? 1 : 0));
    }

    // 同 hit：也要过 LLM 闸门，否则 3 路 8B 抢 8G 显存
    const limit = this._llmGate();
    const queue = [];
    for (const videoPath of files) {
      if (this.runningTasks.size + queue.length >= limit) break;
      if (this.runningTasks.has(`live:${videoPath}`)) continue;

      const existing = this.orchestrator.store.getLiveVideo(videoPath);
      if (existing && (existing.analysis_status === 'completed' || existing.analysis_status === 'analyzing')) {
        continue;
      }
      // 同 hit：failed 不重试会每 30s 重跑，而且 live 每次重跑还会先清空 live_segments，
      // 把已经粗剪依赖的分段删掉，比 hit 更危险。
      if (existing?.analysis_status === 'failed' && !this._allowFailedRetry(`live:${videoPath}`)) continue;
      if (this._skipBackoff(`live:${videoPath}`)) continue;

      queue.push(videoPath);
    }
    if (!queue.length) return;

    await Promise.all(queue.map(async (videoPath) => {
      // 同 hit：add 必须进 try，否则中间抛错会让 key 永久泄漏、调度器停摆
      const key = `live:${videoPath}`;
      try {
        this.runningTasks.add(key);
        this._consumePriority(videoPath);
        console.log(`[Scheduler] Starting live analysis: ${videoPath}`);
        const result = await this.orchestrator.liveAnalyzer.analyze(videoPath);
        this._noteOk(key);
        console.log(`[Scheduler] Live analysis complete: ${videoPath}, ${result.segments?.length || 0} segments`);
      } catch (err) {
        this._noteFail(key);
        console.error(`[Scheduler] Live analysis failed: ${videoPath}:`, err.message);
      } finally {
        this.runningTasks.delete(key);
      }
    }));
  }

  /**
   * 忙时/闲时都可跑的纯 CPU 转写：给还没有转写的视频先把字稿攒出来（Sherpa 本地，不碰显卡），
   * 只回填 asr_path，不改 analysis_status，后续分析直接复用缓存、秒进 LLM。
   * 每轮最多转 1 个，避免 CPU 被长时间占满。
   */
  /**
   * 后台启动空闲预转写，不阻塞本轮处理器。
   *
   * 为什么必须后台：_transcribeIdle 会真跑几分钟（抽音 + Sherpa 推理），
   * await 它就等于这一轮的爆款分析、粗剪全被挡住 —— 表现是"我明明闲着，
   * 队列却不动"，而且日志里一行都没有。
   *
   * 并发保护用固定 key：调度器每 30 秒 tick 一次，不上锁会攒出一堆并行的
   * 转写任务把 CPU 打满 —— 那正是 2026-10-05 报的"上传一批电脑一直卡"。
   */
  _startIdleTranscribe() {
    if (this._idleTranscribeRunning) return;
    this._idleTranscribeRunning = true;
    this.runningTasks.add('asr:idle');
    // 故意不 await：本轮立刻继续做分析，预转写自己在后面跑
    Promise.resolve()
      .then(() => this._transcribeIdle())
      .catch((err) => {
        console.warn('[Scheduler] Idle-transcribe failed:', err?.message || err);
      })
      .finally(() => {
        this._idleTranscribeRunning = false;
        this.runningTasks.delete('asr:idle');
      });
  }

  async _transcribeIdle() {
    const jobs = [];
    // 文件是否还在要在**进循环之前**一次性判完。
    //
    // 原来放在循环里用 `await import('fs')` 现取 —— 那是个 await，
    // 于是"检查 runningTasks"(:455) 和"登记 runningTasks"(:460) 之间让出了事件循环。
    // 而本函数既可能被 tick 调到、也可能被 POST /pipeline/scan 直接调到（那个没有
    // _tickRunning 互斥），两边都能穿过检查，于是同一个文件被转写两次；
    // 第二个任务的 finally 还会把 key 删掉，而第一个还在跑 ——
    // runningTasks.size 于是少报，LLM 显存闸门跟着算错。
    let existsSync;
    try { ({ existsSync } = await import('fs')); } catch { return; }
    try {
      for (const r of this.orchestrator.store.db.prepare(
        "SELECT video_path FROM hit_videos WHERE analysis_status = 'pending' AND (asr_path IS NULL OR asr_path = '') LIMIT 5"
      ).all()) if (existsSync(r.video_path)) jobs.push({ kind: 'hit', path: r.video_path });
      for (const r of this.orchestrator.store.db.prepare(
        "SELECT video_path FROM live_videos WHERE analysis_status = 'pending' AND (asr_path IS NULL OR asr_path = '') LIMIT 5"
      ).all()) if (existsSync(r.video_path)) jobs.push({ kind: 'live', path: r.video_path });
    } catch { return; }
    // 优先转用户点过的
    jobs.sort((a, b) => (this._isPriority(b.path) ? 1 : 0) - (this._isPriority(a.path) ? 1 : 0));
    for (const j of jobs) {
      const key = `asr:${j.path}`;
      // 从这里开始到 runningTasks.add 之间不允许再有 await
      if (this.runningTasks.has(key)) continue;
      if (this._skipBackoff(key)) continue;
      if (!existsSync(j.path)) continue;
      const helper = j.kind === 'hit'
        ? this.orchestrator.hitAnalyzer?.asr
        : this.orchestrator.liveAnalyzer?.asr;
      // 这里必须 continue 到下一条而不是走进 try：
      // 原来 `if (!helper) continue` 写在 try 内部，会先执行 finally 删 key 再继续，
      // 于是"每轮只转 1 个"的约定被打破，一轮里可能把 10 个 job 全试一遍。
      if (!helper) continue;
      this.runningTasks.add(key);
      try {
        console.log(`[Scheduler] Pre-transcribing (${j.kind}): ${j.path}`);
        const r = await helper.getTranscript(j.path);
        if (r.transcript?.length && r.rawPath) {
          if (j.kind === 'hit') this.orchestrator.store.upsertHitVideo(j.path, { asrPath: r.rawPath });
          else this.orchestrator.store.upsertLiveVideo(j.path, { asrPath: r.rawPath });
          console.log(`[Scheduler] Transcript cached (${r.source}, ${r.transcript.length} segs): ${j.path}`);
          this._noteOk(key);
        } else {
          /*
           * 2026-10-05 修：转写不出文本**必须记失败**。
           *
           * 原来这里直接 _noteOk，把失败计数清零 —— 于是 _skipBackoff 永远不生效，
           * 而 asr-helper 只在 segments.length > 0 时才写缓存文件，
           * 所以 asr_path 一直是空、这条记录一直是 pending，
           * 每 30 秒就被重新选中一次：**完整跑一遍抽音 + 一遍 Sherpa 推理**。
           * 队列里有 11 条静音素材时，就是每 30 秒 11 次全量重转写，永不停止。
           * 这正是"上传一批之后电脑一直卡"的 CPU 那一半。
           */
          this._noteFail(key);
          const why = r.silent ? '整段无人声/静音' : (r.reason || r.source || '未知原因');
          console.warn(`[Scheduler] 转写无输出（${why}），已计入失败退避：${j.path}`);
        }
        return; // 每轮只转 1 个
      } catch (err) {
        this._noteFail(key);
        console.warn(`[Scheduler] Pre-transcribe failed: ${j.path}: ${String(err.message).slice(0, 120)}`);
        return;
      } finally {
        this.runningTasks.delete(key);
      }
    }
  }

  async _processReadyProjects() {
    // Find live videos that are completed but have no clip projects
    // segment_count > 0：0 分段的直播建不出项目，跳过以免每轮空转报错
    const completedLives = this.orchestrator.store.db.prepare(
      "SELECT * FROM live_videos WHERE analysis_status = 'completed' AND clip_count = 0 AND segment_count > 0"
    ).all();

    for (const live of completedLives) {
      if (this.runningTasks.has(`clip:${live.id}`)) continue;
      // 失败退避：必须在这里查，而不是只在 catch 里记账 ——
      // 否则记了退避却没人读，连续失败的那些 live 照样每 30 秒重试一次。
      if (this._skipBackoff(`clip:${live.id}`)) continue;
      if (this.runningTasks.size >= this._llmGate()) break;

      // 防重复：该直播已有未完工项目时不再新建（用户可在看板手动粗剪第二版）
      const open = this.orchestrator.store.db.prepare(
        "SELECT id FROM clip_projects WHERE live_video_id = ? AND status IN ('pending','pending_review','clipping','reviewing','generating') LIMIT 1"
      ).get(live.id);
      if (open) {
        console.log(`[Scheduler] Live ${live.id} already has open project ${open.id}, skip auto-clip`);
        continue;
      }

      this.runningTasks.add(`clip:${live.id}`);
      console.log(`[Scheduler] Starting clip project for live video ${live.id}`);

      try {
        // 自动粗剪也带上历史评审意见：否则“钩子不够炸”这类打回永远只对手动重剪生效
        let feedback = [];
        try { feedback = (this.orchestrator.store.getReviewLessons?.() || []).slice(-8).map(l => l.text || l); }
        catch { /* ignore */ }
        const result = await this.orchestrator.clipper.createProject(live.id, { feedback, visionReview: false });
        console.log(`[Scheduler] Clip project created: ${result.projectId}, ${result.segments?.length || 0} segments, ${result.pendingQueries?.length || 0} queries`);

        // If no pending queries, proceed to clipping immediately
        if (result.pendingQueries.length === 0) {
          console.log(`[Scheduler] No pending queries, proceeding to clip`);
          await this.orchestrator.clipper.clip(result.projectId);
        }
      } catch (err) {
        /*
         * 2026-10-05 补失败退避。
         *
         * 五个处理器里只有这里完全没有 _noteFail / _skipBackoff。
         * 而 _processReadyProjects 的"已有 open 工程"守卫是靠 clip_projects 有行来触发的，
         * 一旦 createProject 在插入那行**之前**抛错（比如 LLM 返回畸形 JSON、
         * 显存不足时的 fetch failed），守卫永远不触发 → 同一个 live 每 30 秒重试一次，
         * 每次都是一发全新的 LLM 调用，永不停止。
         *
         * 这就是"上传一批之后机器一直卡"的第三个来源 ——
         * 失败得越快，重试越勤，GPU 越热。
         */
        this._noteFail(`clip:${live.id}`);
        console.error(
          `[Scheduler] Clip project failed for live ${live.id}（已计入退避，`
          + `连续失败 ${this._failStrikes.get(`clip:${live.id}`) || 1} 次）:`,
          err.message
        );
      } finally {
        this.runningTasks.delete(`clip:${live.id}`);
      }
    }
  }

  async _processReviewingProjects() {
    // Find clip projects in 'reviewing' status (clipped, ready for content generation)
    const reviewingProjects = this.orchestrator.store.db.prepare(
      "SELECT * FROM clip_projects WHERE status = 'reviewing'"
    ).all();

    for (const project of reviewingProjects) {
      if (this.runningTasks.has(`gen:${project.id}`)) continue;
      if (this.runningTasks.size >= this._llmGate()) break;

      this.runningTasks.add(`gen:${project.id}`);
      console.log(`[Scheduler] Starting content generation for project ${project.id}`);

      try {
        const result = await this.orchestrator.contentGenerator.generateAll(project.id);
        console.log(`[Scheduler] Content generation complete: ${result.titles?.length || 0} titles, ${result.covers?.length || 0} covers, ${result.finalVideos?.length || 0} final videos`);
      } catch (err) {
        console.error(`[Scheduler] Content generation failed for project ${project.id}:`, err.message);
      } finally {
        this.runningTasks.delete(`gen:${project.id}`);
      }
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      runningTasks: Array.from(this.runningTasks),
      scanIntervalMs: this.scanIntervalMs,
      maxConcurrent: this.maxConcurrent,
      effLimit: this._effLimit ?? this.maxConcurrent,
      gpu: this.lastGpu || null,
    };
  }
}

export default IdleScheduler;
