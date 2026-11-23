import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityAssistant } from './assistant.mjs';
import { definitions } from './dsh-plugin.mjs';

// Fixed operation allowlist; no shell, arbitrary module path or device-write operation.
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8000) throw new Error('请求过长。');
  }
  const body = JSON.parse(input);
  if (!body || Object.keys(body).some(k => !['tool', 'args'].includes(k))) throw new Error('请求格式无效。');
  const assistant = new CommunityAssistant({ stateDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'state') });
  const tool = definitions(assistant).find(x => x.name === body.tool);
  if (!tool) throw new Error('不允许的操作。');
  console.log(JSON.stringify({ ok: true, result: await tool.execute(body.args) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) }));
  process.exitCode = 1;
}
