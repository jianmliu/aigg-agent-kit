/**
 * Headless smoke for the wallet-svc bridge: AiggWalletClient + RemoteAgentWallet.
 * A fake HTTP server stands in for the Go wallet-svc (the real signature is
 * verified on the Go side; here we assert the WIRE + that RemoteAgentWallet drops
 * into the same AgentWallet seam used by X402GccEip3009Settlement).
 * Run: pnpm --filter @onchainpal/onchain test:remote
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GccLedger, InMemoryStore, type InferenceUsage } from '@onchainpal/npc-agent';
import { AiggWalletClient } from '../aigg-wallet-client';
import { RemoteAgentWallet } from '../remote-agent-wallet';
import { RemoteEip3009Settlement } from '../remote-eip3009-settlement';
import { X402GccEip3009Settlement } from '../x402-gcc-eip3009';
import { AiggFacilitatorClient } from '../aigg-facilitator-client';

const ADDR = '0x0Bd887A8F108F61320AEa46dA534f9d16844D111';
const SIG = ('0x' + 'ab'.repeat(65)) as `0x${string}`;
const TOKEN = 'devtoken';
const GCC = '0x628626de13dd4b5b1cb80d468c261c15df00d717' as const;
const SELLER = '0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26' as const;

async function main() {
  const calls: Array<{ path: string; auth: string; body: any }> = [];
  const svc = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ path: req.url || '', auth, body: parsed });
      if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/address') return res.end(JSON.stringify({ address: ADDR, derivationPath: "m/44'/8453'/123'" }));
      if (req.url === '/sign') return res.end(JSON.stringify({ address: ADDR, signature: SIG, digest: '0xdead' }));
      if (req.url === '/sign/eip3009') return res.end(JSON.stringify({
        address: ADDR, signature: SIG, digest: '0xdead',
        payload: { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:84532', amount: parsed.value, asset: GCC, payTo: SELLER },
          payload: { signature: SIG, authorization: { from: ADDR, to: SELLER, value: parsed.value, validAfter: '0', validBefore: '1900000000', nonce: '0x' + '11'.repeat(32) } } },
        requirements: { scheme: 'exact', network: 'eip155:84532', asset: GCC, amount: parsed.value, maxTimeoutSeconds: 300, payTo: SELLER, extra: { name: 'Guaranteed Capacity Credit', version: '1', verifyingContract: GCC } }
      }));
      res.end('{}');
    });
  });
  await new Promise<void>((r) => svc.listen(0, () => r()));
  const port = (svc.address() as any).port;
  const client = new AiggWalletClient({ baseUrl: `http://localhost:${port}`, authToken: TOKEN });

  // RemoteAgentWallet fetches its address from /address (legacy string selector)
  const wallet = await RemoteAgentWallet.create({ client, selector: 'npc:jiu-jianxian' });
  assert.equal(wallet.address, ADDR, 'address fetched from wallet-svc /address');
  assert.equal(await wallet.balanceGcc(), null, 'agent EOA holds no funds (scoped model)');

  // signTypedData delegates to /sign with Bearer + the subject + the payload
  const sig = await wallet.signTypedData({ domain: {}, types: { Foo: [{ name: 'a', type: 'uint256' }] }, primaryType: 'Foo', message: { a: 1n } } as any);
  assert.equal(sig, SIG, 'signature returned from wallet-svc /sign');
  const signCall = calls.find((c) => c.path === '/sign')!;
  assert.equal(signCall.auth, `Bearer ${TOKEN}`, 'Bearer sent');
  assert.equal(signCall.body.subject, 'npc:jiu-jianxian', 'string selector forwarded as { subject }');

  // Structured selector { owner, agent } forwards verbatim (one-owner-many-agents)
  const structured = await RemoteAgentWallet.create({ client, selector: { owner: 42, agent: 7 } });
  assert.equal(structured.address, ADDR, 'structured address fetched');
  const addrCall = calls.filter((c) => c.path === '/address').at(-1)!;
  assert.equal(addrCall.body.owner, 42, 'structured owner forwarded');
  assert.equal(addrCall.body.agent, 7, 'structured agent forwarded');
  assert.equal(addrCall.body.subject, undefined, 'no subject for structured selector');
  assert.ok(signCall.body.typedData?.primaryType === 'Foo', 'typedData forwarded');

  // it drops into the existing x402 settlement as the walletFor signer
  const facCalls: any[] = [];
  const fac = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { facCalls.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ isValid: true, payer: ADDR })); });
  });
  await new Promise<void>((r) => fac.listen(0, () => r()));
  const facPort = (fac.address() as any).port;
  const facilitator = new AiggFacilitatorClient({ baseUrl: `http://localhost:${facPort}`, authToken: 'ftok' });

  const ledger = new GccLedger(new InMemoryStore(), () => 1);
  const settlement = new X402GccEip3009Settlement({
    config: { gccToken: GCC, gccName: 'Guaranteed Capacity Credit', chainId: 84532, network: 'eip155:84532', payTo: SELLER, decimals: 18 },
    walletFor: () => wallet,           // ← RemoteAgentWallet signs via wallet-svc
    facilitator, ledger, verifyOnly: true, now: () => 1_000_000
  });
  const usage: InferenceUsage = { model: 'aigg', inputTokens: 600, outputTokens: 80, gccCost: 0.0003 };
  const res = await settlement.settle('npc:jiu-jianxian', usage);
  assert.equal(res.mode, 'x402');
  assert.equal(facCalls[0].paymentPayload.payload.signature, SIG, 'facilitator received the wallet-svc signature');
  assert.equal(facCalls[0].paymentPayload.payload.authorization.from, ADDR, 'payer = remote agent EOA');

  // === scoped production path: RemoteEip3009Settlement (svc builds+signs, TS relays) ===
  facCalls.length = 0;
  const scoped = new RemoteEip3009Settlement({ wallet: client, facilitator, verifyOnly: true });
  const r2 = await scoped.settle('npc:azhu', { model: 'aigg', inputTokens: 100, outputTokens: 20, gccCost: 0.0005 });
  assert.equal(r2.mode, 'x402');
  assert.ok(r2.receiptId?.startsWith('verify:'), 'scoped settle verified');
  const sc = calls.find((c) => c.path === '/sign/eip3009')!;
  assert.equal(sc.body.subject, 'npc:azhu', 'scoped: subject forwarded');
  assert.equal(sc.body.value, (5n * 10n ** 14n).toString(), 'scoped: gccCost→atoms as decimal string');
  assert.equal(facCalls[0].paymentPayload.payload.authorization.to, SELLER, 'scoped: recipient locked to payTo (from svc)');
  assert.equal(facCalls[0].paymentRequirements.asset, GCC, 'scoped: requirements from svc');

  svc.close(); fac.close();
  console.log('✓ RemoteAgentWallet: address via /address + sign via /sign (Bearer) + plugs into x402 settlement');
  console.log('✓ RemoteEip3009Settlement: svc builds+signs scoped payload, TS relays to facilitator (recipient locked)');
  console.log('\nREMOTE-WALLET SMOKE PASSED ✅');
}

main().catch((err) => { console.error('REMOTE-WALLET SMOKE FAILED ❌', err); process.exit(1); });
