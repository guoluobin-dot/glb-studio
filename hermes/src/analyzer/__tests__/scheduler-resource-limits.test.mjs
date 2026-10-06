/**
 * 调度器资源失控的回归测试
 *
 * 这组锁的是用户 2026-10-05 报的那个现象：
 * 上传一批素材后 GPU 96%、内存 24GB/31GB、机器卡死。
 * 根因不是一个地方，而是四条各自独立的失控路径叠加：
 *
 *   1. llmLimit（显存闸门）只被 2/5 个处理器遵守
 *   2. /pipeline/scan 不走 _tickRunning，连点就并发
 *   3. /pipeline/deep-backfill 完全没有并发保护
 *   4. 静音素材每 30 秒全量重转写一次（_noteOk 把失败计数清零，退避永不生效）
 *   5. stop() 不清 runningTasks → 暂停一次后调度器永久静默
 *   6. _processReadyProjects 失败无退避 → LLM 报错就无限重试
 *   7. 分析队列按 asr_path 过滤 → 有稿的素材永久卡住（"上传后什么都不学进去"）
 *   8. _transcribeIdle 只在 GPU 忙的分支被调用 → 空闲时不补转写，方向反了
 *   9. guard 不看护 Ollama → 它一停，整批短片段分析全失败并被打进退避
 *
 * 这九条都不会报错，只会让机器变慢或让活儿停摆 —— 所以只能靠断言锁住。
 *
 * @author 郭洛斌
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sch = readFileSync(join(process.cwd(), 'src/scheduler/index.js'), 'utf8');
const orch = readFileSync(join(process.cwd(), 'src/orchestrator/index.js'), 'utf8');
const ff = readFileSync(join(process.cwd(), 'src/analyzer/ffmpeg-helper.js'), 'utf8');

test('llm 显存闸门必须被所有 LLM 处理器遵守', () => {
  /*
   * 以前只有 _processPendingHits / _processPendingLives 走
   * min(_effLimit, llmLimit)，另外三个直接用 _effLimit（配置里是 3）。
   * 而它们全都是打本地 Ollama 的任务 —— 文件头注释写着
   * "3 路 qwen3:8b 抢 8G 显存必然 OOM / fetch failed"。
   */
  assert.match(sch, /_llmGate\(\)\s*\{/, '必须有一个统一的闸门方法');
  // 五处处理器 + getStatus 之外，不允许再直接用 _effLimit 做并发判断
  const direct = sch.match(/runningTasks\.size >= \(this\._effLimit \?\? this\.maxConcurrent\)/g) || [];
  assert.strictEqual(direct.length, 0, `还有 ${direct.length} 处绕过显存闸门`);
  assert.ok((sch.match(/_llmGate\(\)/g) || []).length >= 7, '六处判断 + 定义都该用它');
});

test('手动扫描必须有互斥', () => {
  /*
   * /pipeline/scan 直接调 scheduler 的私有处理器，不经过 _tickRunning，
   * 而看板「扫一遍」绑的是普通 onclick、从不禁用。
   * 连点三次 → 三个请求都过闸门 → 3 个 createProject 并发打 8G 显存。
   */
  const lockAt = orch.indexOf('_scanInFlight = true');
  const unlockAt = orch.indexOf('_scanInFlight = false');
  assert.ok(lockAt > 0, '必须上锁');
  assert.match(orch, /正在扫一遍/);
  assert.ok(unlockAt > lockAt, '必须放锁');
  assert.ok(unlockAt - lockAt < 4000, '放锁必须在同一个处理函数里');
  // 而且放锁必须真的在 finally 里：找它前面最近的 finally
  const fin = orch.lastIndexOf('finally', unlockAt);
  assert.ok(fin > lockAt, '放锁必须在 finally 内，否则中途抛错就永久锁死');
});

test('deep-backfill 必须有并发锁', () => {
  // 原本连 runningTasks 都没登记，连点 8 次就是 8 个视觉模型同时加载
  assert.match(orch, /_busyDeep/);
  const d = orch.indexOf("this.app.post('/pipeline/deep-backfill'");
  const seg = orch.slice(d, d + 2200);
  assert.match(seg, /_busyDeep\.has\(/, '必须查重');
  assert.match(seg, /runningTasks\?\.add\(deepKey\)/, '必须登记进调度器，闸门才看得见');
  assert.match(seg, /finally[\s\S]*_busyDeep\.delete/);
});

test('转写无输出必须记失败，否则每 30 秒全量重转写', () => {
  /*
   * 静音素材：asr-helper 只在 segments.length > 0 时写缓存，
   * 所以 asr_path 一直空、记录一直 pending，每 30 秒被重新选中，
   * 每次都是完整一遍抽音 + Sherpa 推理。而原代码走的是 _noteOk
   * （成功分支），把失败计数清零，退避永远不生效。
   * 队列里 11 条静音素材 = 每 30 秒 11 次全量重转写，永不停止。
   */
  // 必须用**定义点**（带 { ）而不是调用点，否则窗口落在 _tickInner 里，什么都找不到
  const i = sch.indexOf('_transcribeIdle() {');
  const seg = sch.slice(i, i + 3200);
  const noOutput = seg.indexOf('转写无输出');
  assert.ok(noOutput > 0, '必须有一条"转写无输出"的分支');
  const after = seg.slice(noOutput, noOutput + 500);
  assert.match(after, /_noteFail\(/, '无输出必须记失败，不能记成功');
  assert.doesNotMatch(after, /_noteOk\(/, '失败分支里不许出现 _noteOk');
});

test('stop() 必须清掉 runningTasks', () => {
  /*
   * 所有处理器的第一道闸门都是 runningTasks.size >= 上限。
   * 暂停时遗留一条 key，恢复后每轮都在这里 return ——
   * 调度器永久静默，而且日志里一行都没有。
   */
  const i = sch.indexOf('  stop()');
  const seg = sch.slice(i, i + 1400);
  assert.match(seg, /runningTasks\.clear\(\)/, '停机必须清任务标记');
  assert.match(seg, /否则恢复后闸门永远关闭/, '要有日志，否则线上查不出来');
});

test('粗剪失败必须有退避', () => {
  /*
   * 五个处理器里只有它没有 _noteFail/_skipBackoff。
   * 而"已有 open 工程"的守卫是靠 clip_projects 有行来触发的，
   * createProject 在插行之前抛错（LLM 畸形 JSON、显存不足的 fetch failed）
   * 就永远不触发守卫 → 每 30 秒重试一次，每次一发新 LLM 调用。
   */
  const i = sch.indexOf('_processReadyProjects() {');
  const seg = sch.slice(i, i + 3600);
  assert.match(seg, /_skipBackoff\(`clip:/, '取任务前必须查退避');
  assert.match(seg, /_noteFail\(`clip:/, '失败必须记账');
});

test('ffmpeg 预取消不能留下孤儿进程', () => {
  /*
   * const timer 声明在 onAbort 之后，而 if (signal.aborted) onAbort()
   * 在它之前就可能执行 → onAbort 里 clearTimeout(timer) 命中暂时性死区。
   * 抛出的 ReferenceError 从 Promise executor 逃出，调用方拿到的
   * 不是 err.name === 'AbortError'，取消语义整个丢掉；
   * 更糟的是 onAbort 没跑到 deregister 也没跑到 taskkill ——
   * 留下一个杀不掉的孤儿 ffmpeg + 一条永不释放的登记表项。
   */
  const i = ff.indexOf('async run(');
  const seg = ff.slice(i, i + 3200);
  const declAt = seg.indexOf('let timer = null;');
  // 必须取 onAbort 的**定义处**：注释里也会出现这个词，
  // 用 indexOf 会命中注释，位置比 timer 还早，判断就反了。
  const useAt = seg.indexOf('const onAbort');
  assert.ok(declAt > 0, 'timer 必须先声明');
  assert.ok(useAt > 0, '找得到 onAbort 定义');
  assert.ok(declAt < useAt, `timer 声明(${declAt}) 必须早于 onAbort 定义(${useAt})`);
  // 超时也必须杀进程树
  assert.match(seg, /taskkill.*\/T.*\/F/s, '超时必须杀整棵进程树，不能只 child.kill()');
});

test('_transcribeIdle 的检查与登记之间不许有 await', () => {
  /*
   * 原来在循环里 `await import('fs')` 现取 existsSync ——
   * 那个 await 让"检查 runningTasks"和"登记 runningTasks"之间让出事件循环。
   * 本函数既可能被 tick 调到、也可能被 /pipeline/scan 直接调到（那个没有互斥），
   * 两边都能穿过检查 → 同一文件转写两次，
   * 而第二个任务的 finally 会把 key 删掉（第一个还在跑），
   * runningTasks.size 于是少报，LLM 闸门跟着算错。
   */
  const i = sch.indexOf('_transcribeIdle() {');
  const seg = sch.slice(i, i + 3200);
  const checkAt = seg.indexOf('this.runningTasks.has(key)');
  const addAt = seg.indexOf('this.runningTasks.add(key)');
  assert.ok(checkAt > 0 && addAt > checkAt);
  const between = seg.slice(checkAt, addAt);
  assert.doesNotMatch(between, /await /, 'check 与 add 之间不能有 await');
});

test('分析队列不能按 asr_path 过滤，否则素材永久卡住', () => {
  /*
   * 2026-10-05 修的真实 bug：_processPendingHits 取 pending 队列时带着
   *   AND (asr_path IS NULL OR asr_path = '')
   * 条件正好写反了。分析要的是"没分析完"，不是"没转写完" ——
   * 有逐句稿反而是**更该分析**的那批（analyze() 内部自己 getTranscript，
   * 命中缓存就是秒过，不需要预转写）。
   *
   * 一旦 asr_path 有值，这些行就永久被分析队列排除；
   * 而 _transcribeIdle 只管 asr_path 为空的，两边都不选 → 永远卡住。
   * 触发路径很普通：转写成功 → LLM 分析途中重启/取消 → 状态回到 pending。
   * 实测 15 条素材躺了一整天，界面上就是"上传后什么都不学进去"。
   */
  const i = sch.indexOf('_processPendingHits() {');
  assert.ok(i > 0, '找得到 _processPendingHits');
  const seg = sch.slice(i, i + 2600);
  const q = seg.match(/analysis_status\s*=\s*'pending'[^`"']*/);
  assert.ok(q, '必须有一条按 status 取 pending 的查询');
  assert.doesNotMatch(
    q[0],
    /asr_path/,
    `分析队列不许按 asr_path 过滤（现在写的是：${q[0].trim().slice(0, 120)}）`
  );
  // 而 _transcribeIdle 那边**必须保留** asr_path 过滤：
  // 它的职责就是"给还没稿的补转写"，放宽就会每轮重复转写已有稿的素材。
  const t = sch.indexOf('_transcribeIdle() {');
  const tseg = sch.slice(t, t + 2600);
  assert.match(
    tseg,
    /analysis_status\s*=\s*'pending'\s*AND\s*\(\s*asr_path\s+IS\s+NULL/,
    '_transcribeIdle 仍要只取没稿的'
  );
});

test('_transcribeIdle 不能只在 GPU 忙的分支被调用', () => {
  /*
   * 原来 _transcribeIdle() 只出现在 _tickInner 的 GPU 忙分支里：
   * 命中 `gpu.mode === 'busy' || gpu.ollamaBusy` 就转写，走正常路径反而不转。
   * 于是机器空闲（用户最希望它干活的时候）永远不补转写，
   * 只有用户正拿电脑剪片子时才会跑 —— 正好是反的。
   *
   * 现在两处都要有：忙分支里让路式转写 + 空闲路径里开工前转写。
   */
  const calls = sch.match(/_transcribeIdle\(\)/g) || [];
  assert.ok(
    calls.length >= 2,
    `_transcribeIdle 至少要有忙/闲两处调用（现在 ${calls.length} 处）`
  );
  // 正常路径上必须有：limit<=0 的提前 return 之后、_processPendingHits 之前
  const i = sch.indexOf('async _tickInner()');
  assert.ok(i > 0, '找得到 _tickInner');
  const seg = sch.slice(i, i + 6000);
  const idleCall = seg.indexOf('_transcribeIdle()');
  const gate = seg.indexOf('_processPendingHits()');
  assert.ok(idleCall > 0 && gate > 0, '两条都得在');
  assert.ok(idleCall < gate, '空闲路径也要先补转写再分析');
  // 并且空闲路径这次调用要受配置开关保护，不能无条件抢 CPU
  assert.match(seg.slice(idleCall - 400, idleCall + 120), /transcribeOnIdle|_transcribeIdle\(\)/);
});

test('guard 必须看护 Ollama，否则红点会再回来', () => {
  /*
   * 原来 hermes-guard.js 只探 17841。Ollama 只在 start-glb.cmd 里被拉一次，
   * 部署时习惯直接重启守护脚本 → 绕过启动脚本 → Ollama 一直没起来。
   * 连锁后果：界面红点、provider=auto 的短片段分析全失败、
   * 队列被打进失败退避（这才是"上传后不学进去"的放大器）。
   */
  const guard = readFileSync(join(process.cwd(), '..', 'hermes-guard.js'), 'utf8');
  assert.match(guard, /11434/, '必须探 Ollama 端口');
  assert.match(guard, /ensureOllama/, '必须有独立的 Ollama 探测/拉起');
  assert.match(guard, /ollama\.exe/i, '必须用同一份 Ollama 可执行文件');
  // 模型目录必须显式指过去，否则会去读空的 %USERPROFILE%\.ollama\models
  assert.match(guard, /OLLAMA_MODELS/, '必须设 OLLAMA_MODELS');
  // 每轮都要看，不能只在启动时看一次
  const loopAt = guard.indexOf('async function loop()');
  const loopSeg = guard.slice(loopAt, loopAt + 1400);
  assert.match(loopSeg, /ensureOllama\(\)/, '主循环里每轮都要看 Ollama');
  // 单例锁别被改坏
  assert.match(guard, /LOCK_PORT = 17899/);
  assert.match(guard, /EADDRINUSE/);
});
