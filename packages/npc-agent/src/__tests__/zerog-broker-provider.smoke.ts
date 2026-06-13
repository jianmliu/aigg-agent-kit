/**
 * zerog-broker-provider smoke — the verifiable (TeeML) inference flow with a FAKE broker
 * (offline). Proves: auto-picks a TeeML provider, acks the signer once, fetches the
 * provider endpoint with broker headers, and — crucially — when processResponse VERIFIES
 * the TEE signature, the result carries Attestation.signature (TEE-verified); when it
 * does not, signature is absent. Real path: ZeroGBrokerProvider.fromWallet (needs a funded
 * ledger + the SDK).
 *
 * Run: npx tsx src/__tests__/zerog-broker-provider.smoke.ts
 */
import assert from 'node:assert/strict';
import { ZeroGBrokerProvider, type ZeroGBroker } from '../inference/zerog-broker-provider';

function fakeBroker(verify: boolean, calls: string[]): ZeroGBroker {
  return {
    inference: {
      async listService() { calls.push('listService'); return [
        { provider: '0xPlain', verifiability: '', model: 'm0' },
        { provider: '0xTEE', verifiability: 'TeeML', model: 'glm-5' },
      ]; },
      async getServiceMetadata(p) { calls.push('meta:' + p); return { endpoint: 'https://tee.example/v1', model: 'glm-5' }; },
      async acknowledgeProviderSigner(p) { calls.push('ack:' + p); },
      async getRequestHeaders(p) { calls.push('headers:' + p); return { 'x-0g-billing': 'sig123' }; },
      async processResponse(p, id) { calls.push('verify:' + p + ':' + id); return verify; },
    },
  };
}

function fakeFetch(captured: { url?: string; init?: any }): typeof fetch {
  return (async (url: string, init: any) => {
    captured.url = url; captured.init = init;
    return {
      ok: true, status: 200,
      headers: new Map([['ZG-Res-Key', 'chat-abc']]),
      json: async () => ({ id: 'chat-abc', choices: [{ message: { content: '{"action":"hold","amount":0}' } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;
}

async function main() {
  // --- verified case ---
  {
    const calls: string[] = [];
    const cap: { url?: string; init?: any } = {};
    const p = new ZeroGBrokerProvider({ broker: fakeBroker(true, calls), fetchImpl: fakeFetch(cap) });
    const r = await p.complete({ system: 'json only', prompt: 'price 0.12, hold 90 gcc' });

    assert.ok(calls.includes('listService') && calls.includes('meta:0xTEE'), 'auto-picks the TeeML provider');
    assert.ok(calls.includes('ack:0xTEE'), 'acknowledges the provider signer');
    assert.equal(cap.url, 'https://tee.example/v1/chat/completions', 'POSTs to the provider endpoint');
    assert.equal(cap.init.headers['x-0g-billing'], 'sig123', 'sends broker request headers (billing/auth)');
    assert.ok(calls.some((c) => c.startsWith('verify:0xTEE:chat-abc')), 'verifies via processResponse(provider, chatID)');
    assert.equal(r.text, '{"action":"hold","amount":0}', 'parses content');
    assert.ok(r.attestation?.signature === '0g-teeml:verified:chat-abc', 'TEE-VERIFIED → Attestation.signature set');
    console.log('  ✓ verified: TeeML provider picked, broker headers + endpoint, processResponse → Attestation.signature (TEE-verifiable)');
  }
  // --- unverified case → no signature ---
  {
    const calls: string[] = [];
    const cap: { url?: string; init?: any } = {};
    const p = new ZeroGBrokerProvider({ broker: fakeBroker(false, calls), fetchImpl: fakeFetch(cap) });
    const r = await p.complete({ prompt: 'x' });
    assert.equal(r.attestation?.signature, undefined, 'unverified → NO signature (honest: not TEE-attested)');
    assert.ok(r.attestation?.promptHash?.startsWith('0x'), 'still records prompt/response hashes');
    console.log('  ✓ unverified: processResponse=false → no signature (no false TEE claim)');
  }
  // --- prewarm: the on-chain ack happens up front, exactly once, and is NOT
  //     repeated on the first real complete() (boot warm-up, no double-spend) ---
  {
    const calls: string[] = [];
    const cap: { url?: string; init?: any } = {};
    const p = new ZeroGBrokerProvider({ broker: fakeBroker(true, calls), fetchImpl: fakeFetch(cap) });

    await p.prewarm();
    assert.equal(calls.filter((c) => c.startsWith('ack:')).length, 1, 'prewarm acks exactly once');
    assert.ok(calls.includes('ack:0xTEE'), 'prewarm acks the picked TeeML provider');
    assert.ok(!calls.some((c) => c.startsWith('verify:')), 'prewarm runs NO inference (no verify/OG spend)');
    assert.ok(cap.url === undefined, 'prewarm does NOT POST to the provider endpoint (no inference)');

    await p.complete({ prompt: 'first real dialog' });
    assert.equal(calls.filter((c) => c.startsWith('ack:')).length, 1, 'complete() after prewarm does NOT re-acknowledge');
    assert.equal(cap.url, 'https://tee.example/v1/chat/completions', 'complete() still POSTs once warmed');
    console.log('  ✓ prewarm: acks once at boot, no inference; later complete() reuses the ack (no re-acknowledge)');
  }
  // --- prewarm never throws: a broker that fails the ack must not block boot ---
  {
    const broken: ZeroGBroker = {
      inference: {
        async listService() { return [{ provider: '0xTEE', verifiability: 'TeeML', model: 'glm-5' }]; },
        async getServiceMetadata() { return { endpoint: 'https://tee.example/v1', model: 'glm-5' }; },
        async acknowledgeProviderSigner() { throw new Error('0G RPC unreachable'); },
        async getRequestHeaders() { return {}; },
        async processResponse() { return false; },
      },
    };
    const p = new ZeroGBrokerProvider({ broker: broken, fetchImpl: fakeFetch({}) });
    await p.prewarm();  // must resolve, not reject
    console.log('  ✓ prewarm: swallows ack failure (boot proceeds even if 0G is unreachable)');
  }
  console.log('\nZEROG-BROKER-PROVIDER SMOKE PASSED ✅');
}

main().catch((e) => { console.error('ZEROG-BROKER-PROVIDER SMOKE FAILED ❌', e); process.exit(1); });
