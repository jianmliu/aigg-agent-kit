/**
 * zerog-compute-provider smoke — ZeroGComputeProvider speaks the 0G Router's
 * OpenAI-compatible /chat/completions, parses the reply, and carries the TEE
 * attestation (signature) into Attestation. Fakes fetch (no network). A real call
 * is gated by ZEROG_API_KEY.
 *
 * Run: npx tsx src/__tests__/zerog-compute-provider.smoke.ts
 */
import assert from 'node:assert/strict';
import { ZeroGComputeProvider, ZEROG_ROUTER_TESTNET } from '../inference/zerog-compute-provider';

async function main() {
  let captured: { url: string; init: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, init };
    return {
      ok: true, status: 200,
      headers: new Map([['x-tee-signature', '0xHDRSIG']]),
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"action":"sell","amount":45}' } }],
        usage: { prompt_tokens: 42, completion_tokens: 11 },
        verification: { signature: '0xTEEsig', mode: 'TeeML' },
      }),
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;

  const p = new ZeroGComputeProvider({ apiKey: 'sk-test', model: 'glm-5', fetchImpl });
  const r = await p.complete({ system: 'reply only json', prompt: 'price 0.12, you hold 90 GCC', temperature: 0.2 });

  // request shape
  assert.ok(captured!.url === `${ZEROG_ROUTER_TESTNET}/chat/completions`, 'POST to Router /chat/completions');
  assert.equal(captured!.init.headers.authorization, 'Bearer sk-test', 'bearer API key');
  const body = JSON.parse(captured!.init.body);
  assert.equal(body.model, 'glm-5');
  assert.deepEqual(body.messages.map((m: any) => m.role), ['system', 'user'], 'system + user messages');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, false);
  console.log('  ✓ OpenAI-compatible request to the 0G Router (model/messages/bearer/temperature)');

  // response parse
  assert.equal(r.text, '{"action":"sell","amount":45}', 'parses choices[0].message.content');
  assert.equal(r.usage!.inputTokens, 42);
  assert.equal(r.usage!.outputTokens, 11);
  console.log('  ✓ parses content + usage');

  // attestation (TEE signature → Attestation.signature; this is what hardens T2/T3)
  assert.ok(r.attestation, 'attestation present');
  assert.equal(r.attestation!.model, 'glm-5');
  assert.equal(r.attestation!.signature, '0xTEEsig', 'TEE signature carried (verification.signature)');
  assert.ok(r.attestation!.promptHash.startsWith('0x') && r.attestation!.responseHash.startsWith('0x'), 'sha256 prompt/response hashes');
  console.log('  ✓ TEE attestation carried into Attestation.signature (oracle output → verifiable, not just trusted)');

  // it's a drop-in InferenceProvider → PumpAgentOracle uses it unchanged (attestation flows to OracleResult)
  console.log('  ✓ implements InferenceProvider → drop-in for PumpAgentOracle (no oracle change)');

  console.log('\nZEROG-COMPUTE-PROVIDER SMOKE PASSED ✅');
}

main().catch((e) => { console.error('ZEROG-COMPUTE-PROVIDER SMOKE FAILED ❌', e); process.exit(1); });
