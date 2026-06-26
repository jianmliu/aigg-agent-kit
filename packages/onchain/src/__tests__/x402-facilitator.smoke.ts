/**
 * Headless smoke for the AIGG facilitator wire — asserts the EXACT shape the
 * facilitator main.go expects (paymentPayload + paymentRequirements pair), with
 * a fake facilitator HTTP server standing in for node2. Real EIP-3009 signature
 * is produced by the per-NPC EOA and verified to recover that EOA's address.
 *
 * Run: pnpm --filter @onchainpal/game-engine test:facilitator
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifyTypedData } from 'viem';
import { GccLedger, InMemoryStore, type InferenceUsage } from '@aigg/npc-agent';
import { EoaAgentWallet } from '../agent-eoa';
import { AiggFacilitatorClient } from '../aigg-facilitator-client';
import { X402GccEip3009Settlement } from '../x402-gcc-eip3009';

const MNEMONIC = 'test test test test test test test test test test test junk';
const JX = 'npc:jiu-jianxian';
const GCC = '0x000000000000000000000000000000000000c0c0' as const;
const SELLER = '0x00000000000000000000000000000000000005e1' as const;
const TOKEN = 'tok-fake';

const usage = (gcc: number): InferenceUsage => ({ model: 'aigg', inputTokens: 600, outputTokens: 80, gccCost: gcc });

async function main() {
  // capture every incoming request so we can assert the wire shape exactly
  const calls: Array<{ path: string; auth: string; body: any }> = [];
  const fac = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      let parsed: any = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      calls.push({ path: req.url || '', auth, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/supported') {
        return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], signers: { 'eip155:*': [SELLER] } }));
      }
      if (req.url === '/verify') return res.end(JSON.stringify({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from }));
      if (req.url === '/settle') return res.end(JSON.stringify({ success: true, transaction: '0xfeedfeedfeed', network: 'eip155:8453' }));
      res.end('{}');
    });
  });
  await new Promise<void>((r) => fac.listen(0, () => r()));
  const port = (fac.address() as any).port;
  const client = new AiggFacilitatorClient({ baseUrl: `http://localhost:${port}`, authToken: TOKEN });

  // /supported is public + reflects facilitator capabilities
  const cap = await client.supported();
  assert.equal(cap.kinds[0].scheme, 'exact');
  assert.equal(cap.kinds[0].network, 'eip155:8453');

  const wallet = new EoaAgentWallet(MNEMONIC, JX);
  const ledger = new GccLedger(new InMemoryStore(), () => 1);
  const settlement = new X402GccEip3009Settlement({
    config: {
      gccToken: GCC, gccName: 'Guaranteed Capacity Credit', chainId: 8453,
      network: 'eip155:8453', payTo: SELLER, decimals: 18, maxTimeoutSeconds: 300
    },
    walletFor: () => wallet,
    facilitator: client,
    ledger,
    verifyOnly: true,
    now: () => 1_000_000
  });

  // === verify-only path ===
  const r1 = await settlement.settle(JX, usage(0.0003));
  assert.equal(r1.mode, 'x402');
  assert.ok(r1.receiptId?.startsWith('verify:'), 'verify-only returns a verify receipt');

  const verifyCall = calls.find((c) => c.path === '/verify');
  assert.ok(verifyCall, '/verify was called');
  assert.equal(verifyCall!.auth, `Bearer ${TOKEN}`, 'Bearer auth header sent');

  // exact x402 wire shape (both keys present, scheme = exact)
  const pp = verifyCall!.body.paymentPayload;
  const pr = verifyCall!.body.paymentRequirements;
  assert.ok(pp && pr, 'body has both paymentPayload and paymentRequirements');
  assert.equal(pp.x402Version, 2);
  // v2: scheme/network/amount/asset/payTo live in `accepted`, NOT top-level
  assert.equal(pp.accepted.scheme, 'exact');
  assert.equal(pp.accepted.network, 'eip155:8453');
  assert.equal(pp.accepted.asset, GCC);
  assert.equal(pp.accepted.payTo, SELLER);
  assert.equal(pp.accepted.amount, (3n * 10n ** 14n).toString());
  assert.equal(pp.payload.authorization.from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(pp.payload.authorization.to, SELLER);
  assert.equal(pp.payload.authorization.value, (3n * 10n ** 14n).toString(), 'value = gccCost * 1e18');
  assert.match(pp.payload.authorization.nonce, /^0x[0-9a-f]{64}$/i, 'bytes32 nonce');

  assert.equal(pr.scheme, 'exact');
  assert.equal(pr.network, 'eip155:8453');
  assert.equal(pr.asset, GCC);
  assert.equal(pr.payTo, SELLER);
  assert.equal(pr.amount, (3n * 10n ** 14n).toString());
  assert.equal(pr.extra.verifyingContract, GCC);
  assert.equal(pr.extra.name, 'Guaranteed Capacity Credit');
  assert.equal(pr.extra.version, '1');

  // real signature verifies against the NPC EOA
  const td = settlement.buildAuthorizationTypedData(
    wallet.address, 3n * 10n ** 14n,
    Number(pp.payload.authorization.validAfter),
    Number(pp.payload.authorization.validBefore),
    pp.payload.authorization.nonce
  );
  const ok = await verifyTypedData({ address: wallet.address as `0x${string}`, ...(td as any), signature: pp.payload.signature });
  assert.ok(ok, 'EIP-3009 TransferWithAuthorization signature recovers to the NPC EOA');

  // ledger reflects consumption
  assert.equal((await ledger.get(JX)).calls, 1);

  // === real settle path (verifyOnly: false) ===
  const realSettlement = new X402GccEip3009Settlement({
    ...(settlement as any).opts,
    verifyOnly: false
  });
  const r2 = await realSettlement.settle(JX, usage(0.0001));
  assert.equal(r2.mode, 'x402');
  assert.equal(r2.receiptId, '0xfeedfeedfeed', 'settle returns the on-chain tx hash');
  const settleCall = calls.find((c) => c.path === '/settle');
  assert.ok(settleCall, '/settle was called');

  fac.close();
  console.log('✓ exact x402 wire shape + EIP-3009 sig verifies to NPC EOA + verify→settle round-trip');
  console.log('\nALL X402-FACILITATOR SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('X402-FACILITATOR SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
