/**
 * Functional smoke for the inference proxy: spin a fake upstream, start the proxy
 * pointed at it, and exercise auth + forward + usage/gccCost + per-NPC ledger.
 * Run: node smoke.mjs   (or: pnpm --filter @onchainpal/inference-proxy smoke)
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// fake upstream (stands in for sub2api / ai.gg /v1/messages)
const upstream = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/messages') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: '哈哈，好酒！' }], usage: { input_tokens: 600, output_tokens: 80 } }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => upstream.listen(0, r));
const upPort = upstream.address().port;

const PORT = 8099;
process.env.PORT = String(PORT);
process.env.UPSTREAM_URL = `http://localhost:${upPort}`;
process.env.UPSTREAM_TOKEN = 'test-token';
process.env.PROXY_SECRET = 's3cr3t';
process.env.GCC_PRICING = JSON.stringify({ 'claude-opus-4-8': { in: 5, out: 25 } });

await import('./server.mjs');
await new Promise((r) => setTimeout(r, 200));

const base = `http://localhost:${PORT}`;

// missing secret → 401
let r = await fetch(`${base}/api/npc-infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
assert.equal(r.status, 401, 'missing secret rejected');

// happy path
r = await fetch(`${base}/api/npc-infer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-proxy-secret': 's3cr3t' },
  body: JSON.stringify({ npcId: 'npc:jiu-jianxian', system: 'sys', prompt: '老伯请喝酒', model: 'claude-opus-4-8' })
});
assert.equal(r.status, 200, 'authorized request ok');
const j = await r.json();
assert.equal(j.text, '哈哈，好酒！', 'forwarded text');
assert.equal(j.usage.inputTokens, 600);
assert.equal(j.usage.outputTokens, 80);
assert.ok(Math.abs(j.usage.gccCost - 0.005) < 1e-9, 'gccCost = 600/1e6*5 + 80/1e6*25 = 0.005');

// per-NPC ledger
const led = await (await fetch(`${base}/api/ledger`)).json();
assert.equal(led['npc:jiu-jianxian'].calls, 1, 'ledger recorded the call');
assert.ok(Math.abs(led['npc:jiu-jianxian'].gccSpent - 0.005) < 1e-9, 'ledger gccSpent');

// healthz
assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true);

console.log('✓ proxy: 401 on bad secret + forward + usage/gccCost + per-NPC ledger + healthz');
console.log('\nINFERENCE-PROXY SMOKE PASSED ✅');
process.exit(0);
