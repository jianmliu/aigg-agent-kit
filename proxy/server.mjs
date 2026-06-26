/**
 * inference-proxy — the server-side hop so the BROWSER can drive GCC-consuming NPC
 * inference without ever holding the ai.gg / sub2api credential.
 *
 *   browser  ──POST /api/npc-infer──▶  this proxy (holds UPSTREAM_TOKEN)
 *                                       └─▶ UPSTREAM /v1/messages (sub2api / ai.gg) ─▶ Claude, burns GCC
 *
 * Zero deps, zero build: runs on `node server.mjs` (Node 18+ for global fetch).
 * Tailored for node1 staging (old Docker 18.09, low mem): deploy as one small
 * container in /opt/sub2api-staging's compose, UPSTREAM_URL = the local sub2api
 * (http://sub2api:8080) so inference never leaves the box's network.
 *
 * Holds: the upstream token, the per-NPC GCC ledger, rate limiting. The browser
 * only gets a session/shared secret. (Mirrors @aigg/npc-agent GccLedger.)
 */
import { createServer } from 'node:http';
import { DonationsIndexer } from './donations.mjs';

const PORT = Number(process.env.PORT || 8090);
// Production AI.GG gateway by default — that's where GCC actually burns.
// Use http://sub2api:8080 (node1's local sub2api) only for dev/dry-runs (it's a
// TEST gateway, not the production-billed one).
const UPSTREAM_URL = (process.env.UPSTREAM_URL || 'https://www.ai.gg').replace(/\/+$/, '');
const UPSTREAM_TOKEN = process.env.UPSTREAM_TOKEN || ''; // ai.gg / sub2api Bearer — SERVER-SIDE ONLY
const PROXY_SECRET = process.env.PROXY_SECRET || ''; // shared secret the browser presents
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'claude-opus-4-8';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1024);
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 60);
// GCC per 1M tokens, per model: {"claude-opus-4-8":{"in":5,"out":25},"default":{"in":1,"out":2}}
let PRICING = {};
try { PRICING = JSON.parse(process.env.GCC_PRICING || '{}'); } catch { PRICING = {}; }

// Donations indexer (B4) — reads per-NPC ERC-6551 TBA balance + inbound GCC
// Transfer logs. Off unless DONATIONS_NFT is set.
//   DONATIONS_NFT, DONATIONS_GCC, DONATIONS_RPC, DONATIONS_CHAIN, DONATIONS_FROM_BLOCK
//   DONATIONS_NPC_TOKENS = {"npc:azhu":1,"npc:li-daniang":2,"npc:jiu-jianxian":3}
let DONATIONS = null;
try {
  if (process.env.DONATIONS_NFT) {
    DONATIONS = new DonationsIndexer({
      nftAddress: process.env.DONATIONS_NFT,
      gccToken: process.env.DONATIONS_GCC || '0x628626de13dd4b5b1cb80d468c261c15df00d717',
      rpcUrl: process.env.DONATIONS_RPC || 'https://sepolia.base.org',
      chainId: Number(process.env.DONATIONS_CHAIN || 84532),
      fromBlock: process.env.DONATIONS_FROM_BLOCK || '0x0',
      npcTokens: JSON.parse(process.env.DONATIONS_NPC_TOKENS || '{"npc:azhu":1,"npc:li-daniang":2,"npc:jiu-jianxian":3}')
    });
  }
} catch (err) { console.warn('[inference-proxy] donations config error:', String(err)); }

const ledger = new Map(); // npcId -> { gccSpent, calls, inputTokens, outputTokens, lastAt }
const hits = new Map(); // ip -> { n, windowStart }

function gccCost(model, inTok, outTok) {
  const p = PRICING[model] || PRICING.default || { in: 0, out: 0 };
  return (inTok / 1e6) * (p.in || 0) + (outTok / 1e6) * (p.out || 0);
}
function rateOk(ip) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.windowStart > 60_000) { hits.set(ip, { n: 1, windowStart: now }); return true; }
  e.n += 1;
  return e.n <= RATE_PER_MIN;
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': CORS_ORIGIN });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': CORS_ORIGIN,
      'access-control-allow-headers': 'content-type,x-proxy-secret',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, upstream: UPSTREAM_URL, donations: !!DONATIONS });
  if (req.method === 'GET' && req.url === '/api/ledger') return send(res, 200, Object.fromEntries(ledger));

  // GET /api/donations/:npcId — per-NPC TBA balance + donor aggregation
  if (req.method === 'GET' && req.url.startsWith('/api/donations/')) {
    if (!DONATIONS || !DONATIONS.configured()) return send(res, 501, { error: 'donations_not_configured' });
    const npcId = decodeURIComponent(req.url.slice('/api/donations/'.length).split('?')[0]);
    try {
      return send(res, 200, await DONATIONS.view(npcId));
    } catch (err) {
      return send(res, 502, { error: 'rpc_error', detail: String(err).slice(0, 200) });
    }
  }

  if (req.method === 'POST' && req.url === '/api/npc-infer') {
    if (PROXY_SECRET && req.headers['x-proxy-secret'] !== PROXY_SECRET) return send(res, 401, { error: 'unauthorized' });
    const ip = req.socket.remoteAddress || '?';
    if (!rateOk(ip)) return send(res, 429, { error: 'rate_limited' });

    let body = '';
    for await (const chunk of req) body += chunk;
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
    const { npcId, system, prompt, model = MODEL_DEFAULT, maxTokens = MAX_TOKENS, thinking, output_config } = p;
    if (!prompt || typeof prompt !== 'string') return send(res, 400, { error: 'prompt_required' });

    let up;
    try {
      up = await fetch(`${UPSTREAM_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(UPSTREAM_TOKEN ? { authorization: `Bearer ${UPSTREAM_TOKEN}` } : {})
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          ...(thinking ? { thinking } : {}),
          ...(output_config ? { output_config } : {}),
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch (err) {
      return send(res, 502, { error: 'upstream_unreachable', detail: String(err).slice(0, 200) });
    }
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      return send(res, 502, { error: 'upstream_error', status: up.status, detail: t.slice(0, 300) });
    }
    const msg = await up.json();
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = msg.usage || {};
    const inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outputTokens = u.output_tokens || 0;
    const cost = gccCost(model, inputTokens, outputTokens);
    if (npcId) {
      const e = ledger.get(npcId) || { gccSpent: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
      ledger.set(npcId, {
        gccSpent: e.gccSpent + cost,
        calls: e.calls + 1,
        inputTokens: e.inputTokens + inputTokens,
        outputTokens: e.outputTokens + outputTokens,
        lastAt: Date.now()
      });
    }
    return send(res, 200, { text, usage: { model, inputTokens, outputTokens, gccCost: cost } });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => console.log(`[inference-proxy] listening :${PORT} → ${UPSTREAM_URL}`));
