/** 诊断 LLM 结构化调用:为什么 chunkFailed=2 */
import { readFileSync } from 'node:fs';
import { createLlmClient } from '../src/llm/router.js';

const cfg = JSON.parse(readFileSync('./config/default.json', 'utf8'));
const llm = createLlmClient(cfg);
console.log('client:', llm.constructor.name);
console.log('provider:', cfg.llm?.provider, '| model:', cfg.llm?.model || cfg.ollama?.model);

const sys = 'You output strict JSON only. No prose.';
const user = [
  '把这句转写切成 1 个片段，输出严格 JSON：',
  '{"segments":[{"start_seconds":0,"end_seconds":18,"theme_name":"X","transcript_summary":"...","hook_quality":0.5,"confidence":0.5}]}',
  '',
  '转写：今天我们来聊一聊发声练习，先把嘴张开。'
].join('\n');

const t0 = Date.now();
try {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(llm));
  console.log('可用方法:', methods.filter((m) => m !== 'constructor').join(', '));
  // chat(messages[]) —— Ollama 原生 API 要求 messages 是数组
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ];
  const t1 = Date.now();
  const r = await llm.chat(messages, { maxTokens: 400, temperature: 0.2 });
  console.log('chat 返回长度:', typeof r === 'string' ? r.length : '(null)');
  console.log('内容:', String(r).slice(0, 400));
  console.log('单次耗时', ((Date.now() - t1) / 1000).toFixed(1) + 's');
} catch (e) {
  console.log('ERR:', e.message.slice(0, 300));
}
console.log('耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
