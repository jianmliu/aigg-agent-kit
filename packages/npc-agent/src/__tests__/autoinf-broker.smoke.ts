/**
 * autoinf-broker smoke — AutoInfBrokerProvider end-to-end against a SIMULATED
 * gateway. A fake fetch plays the enclave: it computes the same digest the
 * client will (keccak(reqBody) ‖ keccak(respBody) ‖ model ‖ tokens), signs it
 * with a test key, and returns the attestation as response headers. A fake
 * registry lists that key as attestedSigner; a fake DSN returns a TDX-shaped
 * quote blob binding the key's pubkey. The provider must:
 *   pick the service by model/price → verify the quote once → verify the
 *   response signature → stamp dstack:verified:<id> → price the usage.
 *
 * Run: tsx src/__tests__/autoinf-broker.smoke.ts
 */
import assert from 'node:assert/strict';
import { keccak256, stringToBytes, hexToBytes, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AutoInfBrokerProvider,
  computeResponseDigest,
  ATTEST_HEADERS,
  TDX_REPORT_DATA_OFFSET,
  insecureAcceptAnyQuote,
  type RegistryService,
  type RegistryReader,
  type QuoteFetcher,
} from '../index';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex; // hardhat #1
const account = privateKeyToAccount(PK);
const SIGNER = account.address as Address;

// pubkey (uncompressed 64) → report_data = keccak256(pubkey); embed in a quote.
const PUBKEY = hexToBytes(account.publicKey).slice(1); // strip 0x04 → 64
const REPORT_DATA = keccak256(PUBKEY); // 0x..32
const QUOTE = (() => {
  const q = new Uint8Array(TDX_REPORT_DATA_OFFSET + 64);
  for (let i = 0; i < TDX_REPORT_DATA_OFFSET; i++) q[i] = (i * 13) & 0xff;
  q.set(hexToBytes(REPORT_DATA), TDX_REPORT_DATA_OFFSET);
  return q;
})();
const ATTESTATION_REF = keccak256(QUOTE);

function svc(over: Partial<RegistryService> = {}): RegistryService {
  return {
    provider: '0x00000000000000000000000000000000000000A1' as Address,
    endpoint: 'https://gw.autoinf.example/v1',
    models: ['claude-opus-4-8'],
    inputPriceWei: 1000n,
    outputPriceWei: 2000n,
    attestationRef: ATTESTATION_REF,
    attestedSigner: SIGNER,
    verifiability: 'dstack-cvm-relay',
    active: true,
    ...over,
  };
}

const registry: RegistryReader = { list: async () => [svc()] };
const quotes: QuoteFetcher = { fetch: async () => QUOTE };

// A fake gateway fetch: signs the client-computed digest and returns headers.
function gatewayFetch(opts: { tamperBody?: boolean; omitSig?: boolean } = {}): typeof fetch {
  return (async (_url: string, init: any) => {
    const reqBody: string = init.body;
    const requestHash = keccak256(stringToBytes(reqBody));
    const parsed = JSON.parse(reqBody);
    const model: string = parsed.model;

    const responseObj = {
      id: 'chatcmpl-xyz',
      choices: [{ message: { role: 'assistant', content: '茶棚今日无恙。' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    };
    let rawText = JSON.stringify(responseObj);
    const responseHash = keccak256(stringToBytes(rawText));

    const responseId = 'resp_gw_1';
    const digest = computeResponseDigest({
      requestHash,
      responseHash,
      model,
      inputTokens: 12,
      outputTokens: 7,
    });
    const signature = await account.signMessage({ message: { raw: digest } });

    const headers = new Map<string, string>();
    headers.set(ATTEST_HEADERS.signer, SIGNER);
    headers.set(ATTEST_HEADERS.responseId, responseId);
    headers.set(ATTEST_HEADERS.model, model);
    headers.set(ATTEST_HEADERS.inputTokens, '12');
    headers.set(ATTEST_HEADERS.outputTokens, '7');
    if (!opts.omitSig) headers.set(ATTEST_HEADERS.signature, signature);

    if (opts.tamperBody) {
      // gateway signed the untampered body, but a MITM alters it in flight.
      rawText = JSON.stringify({ ...responseObj, choices: [{ message: { content: 'TAMPERED' } }] });
    }

    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => rawText,
    } as any;
  }) as unknown as typeof fetch;
}

async function main() {
  // 1. happy path: verified verdict + priced usage.
  {
    const p = new AutoInfBrokerProvider({
      registry,
      quotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'claude-opus-4-8',
      fetchImpl: gatewayFetch(),
    });
    const r = await p.complete({ prompt: '茶棚如何？' });
    assert.equal(r.text, '茶棚今日无恙。', 'response text');
    assert.ok(r.attestation?.signature, 'attestation signed');
    assert.equal(r.attestation!.signature, 'dstack:verified:resp_gw_1', 'honest verdict token');
    assert.equal(p.providerAddress, svc().provider, 'service resolved');
    // usage priced from registry: 12*1000 + 7*2000 = 26000 wei.
    assert.equal(r.usage?.inputTokens, 12);
    assert.equal(r.usage?.outputTokens, 7);
    assert.equal(r.usage?.gccCost, 26000 / 1e18, 'AI3 cost from registry prices (never 0)');
  }

  // 2. tampered response body → signature no longer matches → no token.
  {
    const p = new AutoInfBrokerProvider({
      registry,
      quotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'claude-opus-4-8',
      fetchImpl: gatewayFetch({ tamperBody: true }),
    });
    const r = await p.complete({ prompt: 'x' });
    assert.equal(r.attestation?.signature, undefined, 'tampered body must not verify');
  }

  // 3. requireVerified + missing signature header → throws.
  {
    const p = new AutoInfBrokerProvider({
      registry,
      quotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'claude-opus-4-8',
      requireVerified: true,
      fetchImpl: gatewayFetch({ omitSig: true }),
    });
    let threw = false;
    try {
      await p.complete({ prompt: 'x' });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'requireVerified must throw when unverifiable');
  }

  // 4. quote ref mismatch → verify fails (no token), but response still returns.
  {
    const badQuotes: QuoteFetcher = { fetch: async () => new Uint8Array(TDX_REPORT_DATA_OFFSET + 64) };
    const p = new AutoInfBrokerProvider({
      registry,
      quotes: badQuotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'claude-opus-4-8',
      fetchImpl: gatewayFetch(),
    });
    const r = await p.complete({ prompt: 'x' });
    assert.equal(r.attestation?.signature, undefined, 'wrong quote blob → unverified');
    assert.equal(r.text, '茶棚今日无恙。', 'response still delivered (graceful degrade)');
  }

  // 5. price-pick: cheaper active service wins among several offering the model.
  {
    const cheap = svc({ provider: '0x00000000000000000000000000000000000000B2' as Address, inputPriceWei: 10n });
    const multi: RegistryReader = { list: async () => [svc(), cheap] };
    const p = new AutoInfBrokerProvider({
      registry: multi,
      quotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'claude-opus-4-8',
      fetchImpl: gatewayFetch(),
    });
    await p.complete({ prompt: 'x' });
    assert.equal(p.providerAddress, cheap.provider, 'cheapest service chosen');
  }

  // 6. model not offered → ensureService throws.
  {
    const p = new AutoInfBrokerProvider({
      registry,
      quotes,
      quoteVerifier: insecureAcceptAnyQuote,
      model: 'no-such-model',
      fetchImpl: gatewayFetch(),
    });
    let threw = false;
    try {
      await p.complete({ prompt: 'x' });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'unavailable model must throw');
  }

  // ── 7. rename back-compat: deprecated AutoPal aliases are the same bindings ──
  {
    const legacy = await import('../inference/autopal-broker-provider');
    assert.equal(legacy.AutoPalBrokerProvider, AutoInfBrokerProvider);
    assert.equal(legacy.autoPalBrokerFromRpc, legacy.autoInfBrokerFromRpc);
  }

  console.log('autoinf-broker smoke: OK (7 groups — verify-only provider e2e + alias back-compat)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
