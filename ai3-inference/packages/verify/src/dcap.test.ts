/**
 * DCAP verifier tests (extraction plan T6) — known-good / known-bad quote
 * fixtures drive both adapters behind the QuoteVerifier seam:
 *
 *   • wasm (dcap-qvl): the real Phala sample TDX quote + recorded collateral
 *     verifies at a pinned timestamp; a tampered TD report byte fails; a
 *     timestamp past the collateral window fails; the status policy gates.
 *   • http: contract-level tests against a stubbed fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as qvl from '@phala/dcap-qvl-node';
import {
  dcapQvlQuoteVerifier,
  httpQuoteVerifier,
  extractReportData,
  extractImageMeasurement,
  type DcapCollateral,
} from './index.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/dcap/${name}`, import.meta.url));

const QUOTE = new Uint8Array(readFileSync(fixture('tdx_quote.bin')));
const COLLATERAL = JSON.parse(readFileSync(fixture('tdx_quote_collateral.json'), 'utf8')) as DcapCollateral;

/** pinned inside the recorded collateral's TCB validity window (see fixtures README). */
export const DCAP_FIXTURE_NOW = 1750809600n; // 2025-06-25T00:00:00Z

const goodVerifier = (extra: Partial<Parameters<typeof dcapQvlQuoteVerifier>[0]> = {}) =>
  dcapQvlQuoteVerifier({ qvl, collateral: COLLATERAL, now: () => DCAP_FIXTURE_NOW, ...extra });

test('dcap-qvl wasm: known-good quote + collateral at pinned now → verified', async () => {
  let seen: string | undefined;
  const v = goodVerifier({ onResult: (o) => (seen = o.report?.status) });
  assert.equal(await v(QUOTE), true);
  assert.equal(seen, 'UpToDate');
});

test('dcap-qvl wasm: tampered TD report byte → fails', async () => {
  const bad = new Uint8Array(QUOTE);
  bad[200] ^= 0x01; // inside the TD report body → quote signature breaks
  assert.equal(await goodVerifier()(bad), false);
});

test('dcap-qvl wasm: tampered report_data → fails', async () => {
  const bad = new Uint8Array(QUOTE);
  bad[568 + 3] ^= 0x01;
  assert.equal(await goodVerifier()(bad), false);
});

test('dcap-qvl wasm: now past the collateral window → fails (freshness enforced)', async () => {
  const v = goodVerifier({ now: () => 1760000000n });
  assert.equal(await v(QUOTE), false);
});

test('dcap-qvl wasm: status policy gates the verdict', async () => {
  const strict = goodVerifier({ acceptStatuses: ['SomeOtherStatus'] });
  assert.equal(await strict(QUOTE), false);
  const explicit = goodVerifier({ acceptStatuses: ['UpToDate'] });
  assert.equal(await explicit(QUOTE), true);
});

test('dcap-qvl wasm: collateral fetcher form is supported', async () => {
  let fetched = 0;
  const v = dcapQvlQuoteVerifier({
    qvl,
    collateral: async () => {
      fetched++;
      return COLLATERAL;
    },
    now: () => DCAP_FIXTURE_NOW,
  });
  assert.equal(await v(QUOTE), true);
  assert.equal(fetched, 1);
});

test('fixture sanity: the real quote matches our layout constants', () => {
  // report_data lives at 568 and RTMR3 at 520 in a real v4 TDX quote too.
  assert.equal(extractReportData(QUOTE).length, 64);
  assert.match(extractImageMeasurement(QUOTE), /^0x[0-9a-f]{96}$/);
});

// ── http fallback adapter ────────────────────────────────────────────────────

function stubFetch(handler: (body: Uint8Array) => { status: number; json?: unknown }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const out = handler(new Uint8Array(init!.body as Uint8Array));
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.json,
    } as Response;
  }) as typeof fetch;
}

test('http verifier: {ok:true} → true, and the exact quote bytes are POSTed', async () => {
  let posted: Uint8Array | undefined;
  const v = httpQuoteVerifier('http://verify.local/attest/verify-quote', {
    fetchImpl: stubFetch((body) => {
      posted = body;
      return { status: 200, json: { ok: true } };
    }),
  });
  assert.equal(await v(QUOTE), true);
  assert.deepEqual(posted, QUOTE);
});

test('http verifier: {ok:false} / non-200 / network error / bad json → false', async () => {
  const cases: Array<typeof fetch> = [
    stubFetch(() => ({ status: 200, json: { ok: false, error: 'bad quote' } })),
    stubFetch(() => ({ status: 503, json: { ok: true } })),
    (async () => {
      throw new Error('connrefused');
    }) as unknown as typeof fetch,
    stubFetch(() => ({ status: 200, json: 'not-an-object' })),
  ];
  for (const fetchImpl of cases) {
    const v = httpQuoteVerifier('http://verify.local/attest/verify-quote', { fetchImpl });
    assert.equal(await v(QUOTE), false);
  }
});
