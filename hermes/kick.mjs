/**
 * 手动触发 15 条 pending 爆款素材的分析。
 *
 * 为什么要手动触发：调度器在 Hermes 重启后没有自动捞起 pending 队列
 * （guard 今天重启了 4 次）。这里直接调 /pipeline/scan 把它踢起来。
 *
 * 认证：requireWriteAuth 对"回环地址 + 同源"放行（防 CSRF 靠 Origin 墙），
 * 所以带一个本机 Origin 就行，不需要密钥。
 */
const BASE = 'http://127.0.0.1:17841';
const H = {
  'content-type': 'application/json',
  origin: BASE,               // 同源放行
  host: '127.0.0.1:17841',
};

const r = await fetch(`${BASE}/pipeline/scan`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({}),
});
const t = await r.text();
console.log(`POST /pipeline/scan → ${r.status}`);
console.log(t.slice(0, 600));

// 再看看状态有没有变化
await new Promise((r2) => setTimeout(r2, 4000));
const st = await fetch(`${BASE}/api/deep-status`, { headers: H }).then((x) => x.json());
console.log('\ndeep-status:', JSON.stringify(st));
