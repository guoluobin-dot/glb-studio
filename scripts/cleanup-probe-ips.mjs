/**
 * 清理桌面端 vault 里的探针 IP
 * 用法：node cleanup-probe-ips.mjs <wsUrl>
 */
const wsUrl = process.argv[2];
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result?.result?.value); pending.delete(m.id); }
};
const ev = (x) => new Promise((r) => {
  const i = ++id; pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: x, returnByValue: true, awaitPromise: true } }));
  setTimeout(() => r(undefined), 15000);
});
await new Promise((r) => { ws.onopen = () => r(); });

const before = JSON.parse(String(await ev('(async()=>JSON.stringify((await window.studio.hitListIps()).map(i=>({id:i.id,name:i.name}))))()')));
console.log('清理前:', JSON.stringify(before));

for (const ip of before.filter((i) => /探针/.test(i.name))) {
  const r = await ev(`(async()=>JSON.stringify(await window.studio.hitDeleteIp(${JSON.stringify(ip.id)})))()`);
  console.log(`  删除 ${ip.name} -> ${r}`);
}

console.log('清理后:', String(await ev('(async()=>JSON.stringify((await window.studio.hitListIps()).map(i=>i.name)))()')));
ws.close();
process.exit(0);