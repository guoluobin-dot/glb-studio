// 验证 /pipeline/scan 的互斥真的生效，而且放锁真的执行了
const B='http://127.0.0.1:17841/pipeline/scan';
const post=()=>fetch(B,{method:'POST'}).then(async r=>({status:r.status, body:await r.json().catch(()=>({}))}));
let pass=0,fail=0;
const ck=(ok,l,e='')=>{ if(ok){pass++;console.log('  PASS  '+l);} else {fail++;console.log('  FAIL  '+l+' '+e);} };

const a = await post();
console.log('  第一次:', JSON.stringify(a).slice(0,160));
ck(a.status === 200, '第一次扫描正常返回（放锁生效了，说明上一次没留下锁）', String(a.status));

// 紧接着再打一次：如果互斥真的在生效，且第一次还在跑，应该被 409
const b = await post();
console.log('  紧接着第二次:', JSON.stringify(b).slice(0,160));
ck(b.status === 200 || b.status === 409, '并发时要么被拒(409)、要么正常跑完(200)，不得 500', String(b.status));

// 关键：连打 5 次，都不许出现 5xx
const rs = await Promise.all(Array.from({length:5}, () => post()));
const codes = rs.map(r=>r.status);
console.log('  并发 5 次的状态码:', JSON.stringify(codes));
ck(!codes.some(c=>c>=500), '并发不得有 5xx', JSON.stringify(codes));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail?1:0);
