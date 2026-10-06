#!/usr/bin/env node
/**
 * Zen 连通性最小测试（不烧太多额度）
 * 用法：
 *   $env:OPENCODE_ZEN_API_KEY="你的key"; node scripts/test-zen.js
 *   HERMES_LLM=zen node scripts/test-zen.js   # 同上，强制走 zen
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'default.json'), 'utf-8'));
// 测试时强制走 zen，不改配置文件
config.llm = { provider: 'zen' };

const { createLlmClient } = await import('../src/llm/router.js');
const llm = createLlmClient(config);

console.log('provider: zen');
console.log('model:', config.zen?.model);
console.log('key:', process.env.OPENCODE_ZEN_API_KEY ? `已设置(${process.env.OPENCODE_ZEN_API_KEY.length}位)` : '❌ 未设置 OPENCODE_ZEN_API_KEY');

const health = await llm.health();
console.log('health:', JSON.stringify(health));
if (!health.ok) {
  console.log('\nhealth 未通过：检查 Key / 额度 / 网络后再试。不退出，继续试一次 chat 以便看到具体报错。');
}

try {
  const out = await llm.generate(
    '你是 Hermes 测试助手。只输出 JSON，不要解释。',
    '输出 {"ok":true,"msg":"zen连通成功"}，不要加多余字段。',
    { parseJson: true, maxTokens: 256, tier: 'light', timeout: 120000 }
  );
  console.log('generate(parseJson) 返回:', JSON.stringify(out));
  console.log('\n✅ Zen 连通成功，可以把 config/default.json 里 llm.provider 改成 "zen" 正式用。');
} catch (err) {
  console.error('\n❌ chat/generate 失败:', err.message);
  console.error('排查：1) Key 是否为 https://opencode.ai/auth 的 Zen Key  2) 免费额度是否用完  3) 公司网是否墙了 opencode.ai');
  process.exit(1);
}
