/**
 * CloudASR 的转写协议与拼装逻辑（不花钱，不起真服务）。
 *
 * 用本地 http server 冒充 OpenAI 兼容 /audio/transcriptions，
 * 这样测到的是**真实的 FormData 上传路径**（multipart、字段、文件名），
 * 而不是"假定 fetch 会怎么调"。
 *
 * 注意切片目录必须用 asr.chunkDir(videoPath) 算 —— 它带路径哈希，
 * 猜名字会让切片目录对不上，测的就成了另一回事。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudASR, normalizeOpenAiTranscript, parseGeminiTranscript } from '../cloud-asr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const REL = 'data/.tmp-cloud-asr-test';
const TMP = join(ROOT, REL);
const VIDEO = join(TMP, 'f.mp4');

/** 收到的请求（用于断言"发了哪一片、发了多大"）*/
const inFlight = [];
let server;
let baseUrl;
let handler = null;

before(async () => {
  server = createServer((req, res) => {
    if (handler) return handler(req, res);
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bufs);
      const text = raw.toString('latin1');
      const m = /name="file"; filename="([^"]+)"/.exec(text);
      inFlight.push({ index: Number((String(m?.[1]).match(/chunk_(\d+)/) || [])[1] ?? -1), size: raw.length, filename: m?.[1] || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 每片固定返回 2 句，时间戳从 10s 起 —— 拼装断言要靠它
      res.end(JSON.stringify({
        text: '测试',
        segments: [
          { start: 10.0, end: 11.5, text: '第一句' },
          { start: 12.0, end: 13.25, text: '第二句' },
        ],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  mkdirSync(TMP, { recursive: true });
});

after(() => {
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

function makeAsr(extra = {}) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.analyzer = cfg.analyzer || {};
  cfg.analyzer.cloudAsr = {
    enabled: true,
    baseUrl,
    apiKey: 'test-key',
    model: 'whisper-1',
    language: 'zh',
    chunkSeconds: 600,
    concurrency: 1,
    tempDir: REL,
    ...extra,
  };
  return new CloudASR(cfg);
}

/** 造 N 个假分片（不需要 ffmpeg） */
function fakeChunks(asr, n, videoPath = VIDEO) {
  const dir = asr.chunkDir(videoPath);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `c_${String(i).padStart(4, '0')}.ogg`), Buffer.alloc(1024, i));
  }
  return dir;
}

test('拼装结果不带内部字段（_k 不能漏进 transcript）', () => {
  // 内部排序列漏出去会跟着 JSON.stringify 写进 asr_path 缓存和数据库
  const asr = makeAsr({ chunkSeconds: 300 });
  fakeChunks(asr, 1);
  return asr.transcribe(VIDEO, {}).then((r) => {
    assert.ok(r.ok, r.reason);
    for (const s of r.transcript) {
      for (const k of Object.keys(s)) {
        assert.ok(!k.startsWith('_'), `不该出现内部字段 ${k}`);
      }
      // 下游要的两个键都必须在
      assert.ok('start' in s && 'end' in s && 'text' in s);
      assert.ok('start_ms' in s && 'end_ms' in s, 'start_ms/end_ms 也必须给，下游两种写法都有人用');
    }
  });
});

test('listChunks 用 seg.csv 的真实起止时间，不按 index*chunkSeconds 估算', () => {
  const asr = makeAsr({ chunkSeconds: 300 });
  const dir = asr.chunkDir(VIDEO);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'c_0000.ogg'), 'a');
  writeFileSync(join(dir, 'c_0001.ogg'), 'b');
  writeFileSync(join(dir, 'c_0002.ogg'), 'c');
  writeFileSync(join(dir, 'c_0003.ogg'), 'd');
  writeFileSync(join(dir, 'seg.csv'), [
    'c_0000.ogg,0.000000,300.000563',
    'c_0001.ogg,300.000563,600.001188',
    'c_0002.ogg,600.001188,900.001750',
    'c_0003.ogg,900.001750,1200.002313',
  ].join('\n') + '\n');

  const chunks = asr.listChunks(dir);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].startMs, 0);
  assert.equal(chunks[0].endMs, 300001);
  assert.equal(chunks[1].startMs, 300001, '第 1 片必须从 300s 起，不是按 index*300 猜');
  assert.equal(chunks[2].startMs, 600001);
  assert.equal(chunks[3].startMs, 900002);
  for (const c of chunks) assert.equal(c.exact, true);
});

test('真实片长忽长忽短时，拼出来的时间戳仍然单调', async () => {
  /*
   * 2026-10-13 实测踩的坑的回归：
   * ffmpeg 的 -segment_time 只是目标时长，实际切点受输入流影响。
   * 226 分钟的直播切出了 5 秒 / 309 秒 / 460 秒的片。
   * 拿 index*chunkSeconds 去拼 → 整条时间轴系统性错位几百秒。
   */
  const asr = makeAsr({ chunkSeconds: 300 });
  const dir = asr.chunkDir(VIDEO);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'c_0000.ogg'), 'a');
  writeFileSync(join(dir, 'c_0001.ogg'), 'b');
  writeFileSync(join(dir, 'c_0002.ogg'), 'c');
  writeFileSync(join(dir, 'seg.csv'),
    'c_0000.ogg,0.000000,460.000000\nc_0001.ogg,460.000000,921.000000\nc_0002.ogg,921.000000,926.000000\n');

  const r = await asr.transcribe(VIDEO, {});
  assert.ok(r.ok, r.reason);
  assert.equal(r.transcript.length, 6);
  assert.equal(r.transcript[0].start, 10000);
  assert.equal(r.transcript[2].start, 460000 + 10000);
  // 第 2 片只有 5 秒（921→926s），装不下模型报的 10s/12s，
  // 所以会被钳到本片末尾附近。这个钳制是对的：宁可贴边也不能越界去侵占下一片。
  assert.equal(r.transcript[4].start, 921000 + 4900, '越界段应被钳回本片窗口');
  for (let i = 1; i < r.transcript.length; i++) {
    assert.ok(r.transcript[i].start >= r.transcript[i - 1].start,
      `第 ${i} 段倒退：${r.transcript[i - 1].start} → ${r.transcript[i].start}`);
  }
});

test('模型把时间戳报出本片边界时，钳回本片窗口而不是跟下一片重叠', async () => {
  const asr = makeAsr({ chunkSeconds: 60 });
  const dir = asr.chunkDir(VIDEO);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'c_0000.ogg'), 'a');
  writeFileSync(join(dir, 'c_0001.ogg'), 'b');
  writeFileSync(join(dir, 'seg.csv'), 'c_0000.ogg,0.000000,60.000000\nc_0001.ogg,60.000000,120.000000\n');

  const prev = handler;
  handler = (req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      const isFirst = Buffer.concat(bufs).toString('latin1').includes('chunk_0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        segments: isFirst
          ? [{ start: 10, end: 20, text: '越界一' }, { start: 80, end: 90, text: '越界二' }]
          : [{ start: 10, end: 20, text: '正常' }],
      }));
    });
  };
  const r = await asr.transcribe(VIDEO, {});
  handler = prev;
  assert.ok(r.ok, r.reason);
  const outOfRange = r.transcript.filter((s) => s.start >= 60000 && s.start < 61000);
  assert.equal(outOfRange.length, 0, '不该有句子掉进下一片的区间');
  for (let i = 1; i < r.transcript.length; i++) {
    assert.ok(r.transcript[i].start >= r.transcript[i - 1].start, '钳制后仍须单调');
  }
});

test('Gemini 把原始 JSON 吐进 text 字段时要清掉', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: JSON.stringify([
    { start: 0, end: 2, text: '开始请罪吧' },
    { start: 5, end: 11, text: ', "end": 2, "text": "第二首我们唱这首歌，好不好？"}' },
    { start: 12, end: 16, text: '{"start":16,' },
    { start: 20, end: 25, text: '正常的一句' },
  ]) }] } }] });
  const texts = r.map((x) => x.text);
  assert.equal(texts[0], '开始请罪吧');
  assert.equal(texts[1], '第二首我们唱这首歌，好不好？', '应从碎片里抽出真正的文本');
  assert.ok(!texts.some((t) => /"\s*end\s*"\s*:/.test(t)), '不该残留 JSON 键值');
  assert.ok(texts.includes('正常的一句'), '正常句子不能被误删');
});

test('正常文本不会被 sanitize 误伤', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: JSON.stringify([
    { start: 0, end: 2, text: '他说："这里的引号要留着"' },
    { start: 2, end: 4, text: 'JSON 这个词本身没特殊' },
    { start: 4, end: 6, text: '[括号] 开头也算正常文本' },
  ]) }] } }] });
  assert.equal(r.length, 3, '三句都该保留');
  assert.equal(r[0].text, '他说："这里的引号要留着"');
});

test('normalizeOpenAiTranscript：秒→毫秒、丢空句、补齐 start_ms/end_ms', () => {
  const r = normalizeOpenAiTranscript({
    segments: [
      { start: 1.5, end: 2.5, text: '有字' },
      { start: 3.0, end: 3.0, text: '零长度' },   // end<=start → 丢
      { start: 4.0, end: 5.0, text: '   ' },       // 空文本 → 丢
      { start: 6.0, end: 7.0, text: '另一句' },
    ],
  });
  assert.equal(r.length, 2);
  assert.equal(r[0].start, 1500);
  assert.equal(r[0].end, 2500);
  assert.equal(r[0].start_ms, 1500, 'start_ms 必须一起给，否则下游读到 undefined');
  assert.equal(r[0].end_ms, 2500);
});

test('normalizeOpenAiTranscript：裸数组也要认（Gemini 那一路传的是数组）', () => {
  const r = normalizeOpenAiTranscript([{ start: 1, end: 2, text: '甲' }]);
  assert.equal(r.length, 1, '只认 {segments} 会静默返回空数组 —— 表现为"识别成功但一个字都没有"');
  assert.equal(r[0].start, 1000);
});

test('normalizeOpenAiTranscript：非有限时间戳直接丢（不能让 NaN 进库）', () => {
  const r = normalizeOpenAiTranscript({ segments: [{ start: NaN, end: Infinity, text: 'bad' }] });
  assert.equal(r.length, 0);
});

test('parseGeminiTranscript 认得标准 JSON', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: '[{"start":1,"end":2,"text":"甲"}]' }] } }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].start, 1000);
});

test('parseGeminiTranscript 认得 {segments:[...]} 形态', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: '{"segments":[{"start":1,"end":2,"text":"甲"}]}' }] } }] });
  assert.equal(r.length, 1);
});

test('parseGeminiTranscript 兜住 ```json 代码块', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: '```json\n[{"start":1,"end":2,"text":"甲"}]\n```' }] } }] });
  assert.equal(r.length, 1);
});

test('parseGeminiTranscript 模型跑题时按行兜底', () => {
  const r = parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: '3.0-4.5 这是第一句\n5.0-6.0 第二句' }] } }] });
  assert.equal(r.length, 2);
  assert.equal(r[0].start, 3000);
  assert.equal(r[1].end, 6000);
});

test('parseGeminiTranscript 空响应不成崩', () => {
  assert.deepEqual(parseGeminiTranscript({}), []);
  assert.deepEqual(parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: '' }] } }] }), []);
});

test('多片拼接：时间戳按 i*chunkSeconds 偏移', async () => {
  const asr = makeAsr();
  fakeChunks(asr, 3);
  const r = await asr.transcribe(VIDEO, {});
  assert.ok(r.ok, r.reason);
  assert.equal(r.transcript.length, 6, '3 片 × 2 句');
  // 第 0 片 10s；第 1 片整体 +600s；第 2 片 +1200s
  assert.equal(r.transcript[0].start, 10000);
  assert.equal(r.transcript[2].start, 10000 + 600000);
  assert.equal(r.transcript[4].start, 10000 + 1200000);
  // 必须单调递增，否则打轴全乱
  for (let i = 1; i < r.transcript.length; i++) {
    assert.ok(r.transcript[i].start >= r.transcript[i - 1].start, '时间戳必须单调');
  }
  assert.equal(r.chunkCount, 3);
  assert.ok(r.elapsedMs >= 0);
});

test('上传文件名带片序号（服务端才能定位出错片）', async () => {
  const asr = makeAsr();
  fakeChunks(asr, 1);
  inFlight.length = 0;
  await asr.transcribe(VIDEO, {});
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0].filename, 'chunk_0.ogg');
});

test('续传：已有缓存的片不再上传（不重复计费）', async () => {
  const asr = makeAsr();
  const dir = fakeChunks(asr, 3);
  inFlight.length = 0;
  await asr.transcribe(VIDEO, {});
  assert.equal(inFlight.length, 3, '第一次应传 3 片');

  inFlight.length = 0;
  const r2 = await asr.transcribe(VIDEO, {});
  assert.ok(r2.ok, r2.reason);
  assert.equal(inFlight.length, 0, '第二次一片都不该传（缓存命中）');

  // 删掉中间一片的缓存 → 只补那一片
  rmSync(join(dir, 'chunk_0001.json'), { force: true });
  inFlight.length = 0;
  const r3 = await asr.transcribe(VIDEO, {});
  assert.ok(r3.ok, r3.reason);
  assert.equal(inFlight.length, 1, '只该补缺的那一片');
  assert.equal(inFlight[0].index, 1);
});

test('fatal 错误立刻停手：不再把剩下的片全发一遍（烧钱）', async () => {
  const asr = makeAsr({ concurrency: 1 });
  fakeChunks(asr, 5);
  inFlight.length = 0;
  const prev = handler;
  handler = (req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      inFlight.push({ index: 0, size: 1 });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid API key' } }));
    });
  };
  const r = await asr.transcribe(VIDEO, {});
  handler = prev;
  assert.ok(!r.ok, '401 应该整体失败');
  assert.match(r.reason, /key 无效|401/i, '报错要能看出是 key 的问题');
  assert.equal(inFlight.length, 1, '只该发一片就停（401 是配置问题，重发只是烧钱）');
});

test('429 限流会退避重试，不当作配置错误', async () => {
  const asr = makeAsr({ retries: 2, concurrency: 1 });
  fakeChunks(asr, 1);
  inFlight.length = 0;
  const prev = handler;
  let calls = 0;
  handler = (req, res) => {
    calls++;
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      inFlight.push({ index: 0, size: 1 });
      if (calls < 2) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end('{"error":"rate limited"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'ok' }] }));
    });
  };
  const r = await asr.transcribe(VIDEO, {});
  handler = prev;
  assert.ok(r.ok, r.reason);
  assert.equal(calls, 2, '第一次 429，第二次应成功');
});

test('maxMinutesPerRun 超限时直接拒绝，不上传', async () => {
  const asr = makeAsr({ maxMinutesPerRun: 10 });
  fakeChunks(asr, 3); // 3 × 600s = 30 分钟
  inFlight.length = 0;
  const r = await asr.transcribe(VIDEO, {});
  assert.ok(!r.ok);
  assert.match(r.reason, /上限/);
  assert.equal(inFlight.length, 0, '超限就不该发任何一片');
});

test('单片超体积直接拒绝并提示调小 chunkSeconds', async () => {
  const asr = makeAsr({ maxFileMB: 24 });
  const dir = asr.chunkDir(VIDEO);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'c_0000.ogg'), Buffer.alloc(30 * 1024 * 1024, 1));
  inFlight.length = 0;
  const r = await asr.transcribe(VIDEO, {});
  assert.ok(!r.ok);
  assert.match(r.reason, /chunkSeconds/);
  assert.equal(inFlight.length, 0);
});

test('configError 把缺什么说清楚', () => {
  assert.match(makeAsr({ enabled: false }).configError, /未启用/);
  // 这两个要关掉 inherit：否则会从 gemini 那份配置里兜底拿到值，
  // "显式配的优先、没配才继承"是设计本身，不能当 bug 测。
  assert.match(makeAsr({ apiKey: '', inherit: false }).configError, /key/);
  assert.match(makeAsr({ baseUrl: '', inherit: false }).configError, /baseUrl/);
});

test('model 永远有值：空的也会兜底成 whisper-1（不测空模型状态）', () => {
  // model 那一路是 `x || gemini.model || 'whisper-1'`，永远非空 ——
  // 所以 configError 不可能因为"没配模型"而报错。这点单独锁住，
  // 免得以后有人以为该报错、回去改实现把这条兜底删了。
  const asr = makeAsr({ model: '', inherit: false });
  assert.equal(asr.model, 'whisper-1');
  assert.ok(!/模型/.test(asr.configError || ''));
});

test('继承：baseUrl/model 缺省时复用 gemini 那份配置', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.gemini = { ...(cfg.gemini || {}), baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-shared', model: 'shared-model' };
  cfg.analyzer = cfg.analyzer || {};
  cfg.analyzer.cloudAsr = { enabled: true, tempDir: REL }; // 什么都没配
  const asr = new CloudASR(cfg);
  assert.equal(asr.baseUrl, 'https://relay.example.com/v1');
  assert.equal(asr.apiKey, 'sk-shared');
  assert.equal(asr.model, 'shared-model');
  assert.equal(asr.configError, null, '继承到就不该报缺配置');
});

test('显式配置优先于继承', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.gemini = { ...(cfg.gemini || {}), baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-shared', model: 'shared-model' };
  cfg.analyzer = cfg.analyzer || {};
  cfg.analyzer.cloudAsr = {
    enabled: true, tempDir: REL,
    baseUrl: 'https://audio.example.com/v1',
    apiKey: 'sk-audio',
    model: 'whisper-audio',
  };
  const asr = new CloudASR(cfg);
  assert.equal(asr.baseUrl, 'https://audio.example.com/v1');
  assert.equal(asr.apiKey, 'sk-audio');
  assert.equal(asr.model, 'whisper-audio');
});

test('probe 用真实 1 段音频走完整链路', async () => {
  const asr = makeAsr();
  const r = await asr.probe();
  assert.ok(r.ok, r.error);
  assert.equal(r.supported, true);
});

test('cancel 能中断（不继续上传扣费）', async () => {
  const asr = makeAsr({ concurrency: 1, timeoutMs: 5000 });
  fakeChunks(asr, 3);
  const ac = new AbortController();
  const prev = handler;
  handler = (req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      inFlight.push({ index: 0, size: 1 });
      // 永远不响应 → 只能靠取消退出
      ac.abort();
    });
  };
  const r = await asr.transcribe(VIDEO, { signal: ac.signal });
  handler = prev;
  assert.ok(!r.ok);
  assert.match(r.reason, /取消/);
});

test('回归：配置项缺失/脏值时不能变成 NaN（否则循环一片都不跑）', async () => {
  /*
   * 真实踩过的坑：retries 用 `Number(c.retries) ?? 2` 取，
   * 而 Number(undefined) 是 NaN —— NaN 不是 nullish，?? 不兜底
   * → this.retries = NaN → `for (attempt=0; attempt <= NaN; ...)` 一次都不进
   * → 直接返回"未知失败"，一片都不发、也不报任何原因。
   *
   * 所以这里专门用"完全不传这些字段"的配置跑一次真实转写。
   */
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'default.json'), 'utf-8'));
  cfg.analyzer = cfg.analyzer || {};
  cfg.analyzer.cloudAsr = {
    enabled: true,
    baseUrl,
    apiKey: 'test-key',
    model: 'whisper-1',
    tempDir: REL,
    // 故意不写：retries / chunkSeconds / concurrency / timeoutMs / maxFileMB
  };
  const asr = new CloudASR(cfg);
  for (const [k, v] of Object.entries({
    retries: asr.retries, chunkSeconds: asr.chunkSeconds, concurrency: asr.concurrency,
    timeoutMs: asr.timeoutMs, maxFileMB: asr.maxFileMB, maxMinutesPerRun: asr.maxMinutesPerRun,
    bitrateKbps: asr.bitrateKbps,
  })) {
    assert.ok(Number.isFinite(v), `${k} 不能是 NaN，实际=${v}`);
  }
  assert.ok(asr.retries >= 1, `retries 至少为 1，实际=${asr.retries}`);

  fakeChunks(asr, 1);
  inFlight.length = 0;
  const r = await asr.transcribe(VIDEO, {});
  assert.ok(r.ok, r.reason);
  assert.equal(inFlight.length, 1, '缺省配置下也必须真的把片发出去');
});

test('clear 清掉切片与缓存', () => {
  const asr = makeAsr();
  const dir = fakeChunks(asr, 2);
  assert.equal(asr.clear(VIDEO), 2);
  assert.ok(!existsSync(dir), '目录应被删掉');
});

test('cachedCount 反映断点进度', async () => {
  const asr = makeAsr();
  fakeChunks(asr, 4);
  await asr.transcribe(VIDEO, {});
  const c = asr.cachedCount(VIDEO);
  assert.equal(c.chunks, 4);
  assert.equal(c.cached, 4);
});
