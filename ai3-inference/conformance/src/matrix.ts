/**
 * The conformance matrix (extraction plan T7) — grades an endpoint+registry
 * pair pass/fail over the invariant groups:
 *
 *   registry-lifecycle   register (exact bond) / no-double / update / paging /
 *                        deactivate refunds the bond          [needs a funded key]
 *   quote-binding        DSN blob hashes to attestationRef; report_data binds
 *                        the live response signer; wrong blob / wrong key fail
 *   response-signature   broker complete() yields dstack:verified:<id>; the
 *                        client-side tamper matrix all fails
 *   cost-nonzero         usage cost from registry prices is never 0
 *   streaming-trailer    SSE body + HTTP trailers verify over the exact
 *                        streamed bytes; a flipped byte fails
 *   tier-label-guard     listed verifiability is within the image allowlist
 *                        ceiling; lying/free-form labels fail (fusion §2.1)
 *   voucher-settlement   Phase B (plan T9): deposit → transferTo → 402 gate →
 *                        paid calls batch-settle on-chain → replay / expired
 *                        rejected at the gate; fee>maxFee / nonce replay /
 *                        expiry rejected by the CONTRACT; refund-window
 *                        semantics (settleable during, min(requested,
 *                        remaining) after)     [needs the ledger config]
 *   dcap                 the real DCAP verifier passes the known-good fixture
 *                        quote and rejects a tampered one (T6 column)
 *
 * Every group returns granular checks; the run is green only if ALL checks in
 * ALL non-skipped groups pass.
 */
import { request as httpRequest } from 'node:http';
import { keccak256, getAddress, hexToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AutoInfBrokerProvider,
  ViemRegistryReader,
  HttpQuoteFetcher,
  type RegistryService,
} from '@ai3-inference/broker';
import {
  AutoInfAttestationVerifier,
  verifyResponseSignature,
  recoverResponsePublicKey,
  parseAttestationHeaders,
  extractImageMeasurement,
  assertTierAllowedForImage,
  UNSAFE_acceptAnyQuote,
  ATTEST_HEADERS,
  dcapQvlQuoteVerifier,
  type QuoteVerifier,
  type ResponseAttestation,
  type HeaderLike,
  type DcapCollateral,
} from '@ai3-inference/verify';
import { signVoucher, encodeVoucher, VOUCHER_HEADERS, type Voucher } from '@ai3-inference/voucher';
import { chainFor } from './harness/deploy.js';
import { RegistryWriter } from './harness/registry.js';
import { LedgerClient, increaseChainTime } from './harness/ledger.js';
import { makeSyntheticQuote, realFixtureQuote, realFixtureCollateral, REAL_FIXTURE_NOW } from './harness/mock-dstack.js';

export interface ConformanceConfig {
  rpcUrl: string;
  registryAddress: string;
  dsnBaseUrl: string;
  /** grade this listing (default: cheapest active service). */
  providerAddress?: string;
  /** override the endpoint instead of using the listing's (plan CLI flag). */
  endpointOverride?: string;
  /** funded key for the on-chain lifecycle group; omitted → group skipped. */
  lifecycleKey?: Hex;
  /** TDX verifier for the live loop (hermetic runs pass UNSAFE explicitly —
   *  synthetic quotes have no Intel signature; real DCAP is graded by the
   *  `dcap` fixture group). */
  quoteVerifier?: QuoteVerifier;
  /** dcap column mode; default 'fixture'. */
  dcap?: 'fixture' | 'off';
  model?: string;
  /** Phase-B group config (plan T9); omitted → group skipped. */
  ledger?: {
    /** InferenceLedger contract. */
    address: string;
    /** the voucher-gated gateway endpoint to grade. */
    endpoint: string;
    /** the voucher-gated service's provider EOA (vouchers name it). */
    providerAddress: string;
    /** funded payer key — deposits, escrows, and signs vouchers. */
    userKey: Hex;
    /** the provider's key — enables the direct on-chain rejection checks
     *  (fee>maxFee / replay / expiry) and the during-window settle. */
    providerKey?: Hex;
    /** dev chain only: fast-forward the 24h refund window. */
    timeTravel?: boolean;
  };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GroupResult {
  group: string;
  ok: boolean;
  skipped?: string;
  checks: CheckResult[];
}

export interface MatrixResult {
  ok: boolean;
  groups: GroupResult[];
}

class Group {
  readonly checks: CheckResult[] = [];
  async check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      this.checks.push({ name, ok: true });
    } catch (e) {
      this.checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  async expectThrow(name: string, fn: () => Promise<unknown> | unknown, match?: RegExp): Promise<void> {
    await this.check(name, async () => {
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (match && !match.test(msg)) throw new Error(`threw, but not ${match}: ${msg}`);
        return;
      }
      throw new Error('expected failure, but it passed');
    });
  }
  result(group: string, skipped?: string): GroupResult {
    return { group, ok: this.checks.every((c) => c.ok), ...(skipped ? { skipped } : {}), checks: this.checks };
  }
}

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

// ── shared setup ──────────────────────────────────────────────────────────────

interface Resolved {
  svc: RegistryService;
  endpoint: string;
  quoteBlob: Uint8Array;
  quoteVerifier: QuoteVerifier;
}

async function resolveService(cfg: ConformanceConfig): Promise<Resolved> {
  const reader = new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress);
  const services = (await reader.list()).filter((s) => s.active);
  assert(services.length > 0, 'registry has no active services');
  let svc: RegistryService;
  if (cfg.providerAddress) {
    const want = getAddress(cfg.providerAddress);
    const hit = services.find((s) => getAddress(s.provider) === want);
    assert(hit, `provider ${want} not listed/active`);
    svc = hit!;
  } else {
    svc = services.reduce((best, s) => (s.inputPriceWei < best.inputPriceWei ? s : best), services[0]!);
  }
  const quoteBlob = await new HttpQuoteFetcher(cfg.dsnBaseUrl).fetch(svc.attestationRef);
  return {
    svc,
    endpoint: cfg.endpointOverride ?? svc.endpoint,
    quoteBlob,
    quoteVerifier: cfg.quoteVerifier ?? UNSAFE_acceptAnyQuote,
  };
}

/** one buffered call to the endpoint; returns the client-computed attestation. */
async function bufferedCall(endpoint: string, model: string): Promise<{ att: ResponseAttestation; body: string }> {
  const reqBody = JSON.stringify({ model, messages: [{ role: 'user', content: 'conformance ping' }] });
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: reqBody,
  });
  const text = await res.text();
  assert(res.ok, `endpoint HTTP ${res.status}: ${text.slice(0, 120)}`);
  const att = parseAttestationHeaders(res.headers, keccak256(utf8(reqBody)), keccak256(utf8(text)));
  assert(att, 'response carries no attestation headers');
  return { att: att!, body: text };
}

// ── groups ────────────────────────────────────────────────────────────────────

async function registryLifecycle(cfg: ConformanceConfig): Promise<GroupResult> {
  const g = new Group();
  if (!cfg.lifecycleKey) return g.result('registry-lifecycle', 'no lifecycle key provided (read-only run)');

  const chain = await chainFor(cfg.rpcUrl);
  const w = new RegistryWriter(cfg.rpcUrl, chain, cfg.registryAddress, cfg.lifecycleKey);
  const bond = await w.bondWei();
  const signer = privateKeyToAccount(cfg.lifecycleKey);
  const fields = {
    endpoint: 'https://conformance.invalid',
    models: ['conformance-lifecycle'],
    inputPriceWei: 10_000n, // expensive: never the cheapest pick
    outputPriceWei: 20_000n,
    attestationRef: keccak256(makeSyntheticQuote({ signerPubkey: hexToBytes(signer.publicKey).slice(1) })),
    attestedSigner: signer.address,
    verifiability: 'dstack-cvm-relay',
  };

  await g.expectThrow('register with wrong bond reverts', () => w.register(fields, bond + 1n));
  await g.check('register with exact bond lists the service', async () => {
    await w.register(fields, bond);
    const s = await w.getService(w.providerAddress);
    assert(s.active, 'service not active after register');
  });
  await g.expectThrow('double register reverts', () => w.register(fields, bond));
  await g.check('update rewrites listing fields', async () => {
    await w.update({ ...fields, endpoint: 'https://conformance-updated.invalid' });
    const s = await w.getService(w.providerAddress);
    assert(s.endpoint === 'https://conformance-updated.invalid', `endpoint not updated: ${s.endpoint}`);
  });
  await g.check('list() pages consistently', async () => {
    const reader = new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress, 1); // page size 1
    const paged = await reader.list();
    const whole = await new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress).list();
    assert(paged.length === whole.length, `paged ${paged.length} != whole ${whole.length}`);
    assert(
      paged.every((s, i) => getAddress(s.provider) === getAddress(whole[i]!.provider)),
      'paged order differs from whole listing',
    );
  });
  await g.check('deactivate refunds the bond exactly', async () => {
    const before = await w.balance();
    const { gasCostWei } = await w.deactivate();
    const after = await w.balance();
    assert(after === before + bond - gasCostWei, `refund math: before=${before} after=${after} bond=${bond} gas=${gasCostWei}`);
    const s = await w.getService(w.providerAddress);
    assert(!s.active, 'service still active after deactivate');
  });
  return g.result('registry-lifecycle');
}

async function quoteBinding(cfg: ConformanceConfig, r: Resolved): Promise<GroupResult> {
  const g = new Group();
  await g.check('DSN blob hashes to attestationRef', () => {
    assert(keccak256(r.quoteBlob).toLowerCase() === r.svc.attestationRef.toLowerCase(), 'keccak(blob) != attestationRef');
  });

  const { att } = await bufferedCall(r.endpoint, cfg.model ?? r.svc.models[0] ?? '');
  const pubkey = await recoverResponsePublicKey(att);

  await g.check('quote binds the live response signer (verifyQuoteOnce)', async () => {
    const v = new AutoInfAttestationVerifier({
      attestedSigner: r.svc.attestedSigner,
      attestationRef: r.svc.attestationRef,
      quoteVerifier: r.quoteVerifier,
      verifiability: r.svc.verifiability,
    });
    await v.verifyQuoteOnce(r.quoteBlob, pubkey);
  });
  await g.expectThrow('tampered blob fails the ref check', async () => {
    const bad = new Uint8Array(r.quoteBlob);
    bad[0]! ^= 0xff;
    const v = new AutoInfAttestationVerifier({
      attestedSigner: r.svc.attestedSigner,
      attestationRef: r.svc.attestationRef,
      quoteVerifier: r.quoteVerifier,
    });
    await v.verifyQuoteOnce(bad, pubkey);
  }, /attestationRef/);
  await g.expectThrow('quote bound to a different key fails report_data', async () => {
    const stranger = privateKeyToAccount(('0x' + '22'.repeat(32)) as Hex);
    const alien = makeSyntheticQuote({ signerPubkey: hexToBytes(stranger.publicKey).slice(1) });
    const v = new AutoInfAttestationVerifier({
      attestedSigner: r.svc.attestedSigner,
      attestationRef: keccak256(alien),
      quoteVerifier: r.quoteVerifier,
    });
    await v.verifyQuoteOnce(alien, pubkey);
  }, /report_data/);
  return g.result('quote-binding');
}

async function responseSignature(cfg: ConformanceConfig, r: Resolved): Promise<GroupResult> {
  const g = new Group();
  await g.check('broker complete() yields dstack:verified:<id>', async () => {
    const broker = new AutoInfBrokerProvider({
      registry: new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress),
      quotes: new HttpQuoteFetcher(cfg.dsnBaseUrl),
      quoteVerifier: r.quoteVerifier,
      providerAddress: r.svc.provider,
      requireVerified: true,
    });
    const res = await broker.complete({ prompt: 'conformance: verified completion' });
    assert(res.attestation?.signature?.startsWith('dstack:verified:'), `unexpected verdict: ${res.attestation?.signature}`);
    assert(res.text.length > 0, 'empty completion text');
  });

  const { att } = await bufferedCall(r.endpoint, cfg.model ?? r.svc.models[0] ?? '');
  const signer = r.svc.attestedSigner;
  await g.check('honest attestation verifies', async () => {
    assert((await verifyResponseSignature(att, signer)).verified, 'baseline attestation did not verify');
  });
  const flip = (h: Hex): Hex => (h.slice(0, 3) + (h[3] === '0' ? '1' : '0') + h.slice(4)) as Hex;
  const tampers: Array<[string, ResponseAttestation]> = [
    ['flipped response byte', { ...att, responseHash: flip(att.responseHash) }],
    ['swapped model', { ...att, model: att.model + '-tampered' }],
    ['altered input tokens', { ...att, inputTokens: Number(att.inputTokens) + 1 }],
    ['altered output tokens', { ...att, outputTokens: Number(att.outputTokens) + 1 }],
    ['garbage signature', { ...att, signature: ('0x' + 'ab'.repeat(65)) as Hex }],
  ];
  for (const [name, mutated] of tampers) {
    await g.check(`tamper: ${name} fails`, async () => {
      assert(!(await verifyResponseSignature(mutated, signer)).verified, 'tampered attestation verified');
    });
  }
  return g.result('response-signature');
}

async function costNonzero(cfg: ConformanceConfig, r: Resolved): Promise<GroupResult> {
  const g = new Group();
  if (r.svc.inputPriceWei === 0n && r.svc.outputPriceWei === 0n) {
    return g.result('cost-nonzero', 'listing prices are zero — nothing to meter');
  }
  await g.check('usage cost is filled from registry prices (never 0)', async () => {
    const broker = new AutoInfBrokerProvider({
      registry: new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress),
      quotes: new HttpQuoteFetcher(cfg.dsnBaseUrl),
      quoteVerifier: r.quoteVerifier,
      providerAddress: r.svc.provider,
    });
    const res = await broker.complete({ prompt: 'conformance: cost check' });
    const usage = res.usage;
    assert(usage, 'no usage on the result');
    assert(usage!.inputTokens > 0 && usage!.outputTokens > 0, 'token counts are zero');
    assert(usage!.gccCost > 0, `gccCost is ${usage!.gccCost}`);
  });
  return g.result('cost-nonzero');
}

/** raw node:http streaming call — fetch cannot surface HTTP trailers. */
function streamCall(
  endpoint: string,
  bodyStr: string,
): Promise<{ headers: Record<string, string>; trailers: Record<string, string>; bodyBytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/chat/completions`);
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const norm = (h: NodeJS.Dict<string | string[]>): Record<string, string> =>
            Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0]! : (v ?? '')]));
          resolve({ headers: norm(res.headers), trailers: norm(res.trailers), bodyBytes: new Uint8Array(Buffer.concat(chunks)) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(bodyStr);
  });
}

async function streamingTrailer(cfg: ConformanceConfig, r: Resolved): Promise<GroupResult> {
  const g = new Group();
  const reqBody = JSON.stringify({
    model: cfg.model ?? r.svc.models[0] ?? '',
    messages: [{ role: 'user', content: 'conformance stream' }],
    stream: true,
  });
  const { headers, trailers, bodyBytes } = await streamCall(r.endpoint, reqBody);
  const merged: HeaderLike = { get: (n) => trailers[n.toLowerCase()] ?? headers[n.toLowerCase()] ?? null };

  await g.check('signature arrives as an HTTP trailer after the body', () => {
    assert(trailers[ATTEST_HEADERS.signature], 'no signature trailer');
  });
  await g.check('leading signer header matches the registry attestedSigner', () => {
    const lead = headers[ATTEST_HEADERS.signer];
    assert(lead && getAddress(lead) === getAddress(r.svc.attestedSigner), `signer header ${lead}`);
  });
  const att = parseAttestationHeaders(merged, keccak256(utf8(reqBody)), keccak256(bodyBytes));
  await g.check('trailer attestation verifies over the exact streamed bytes', async () => {
    assert(att, 'attestation not parseable from headers+trailers');
    assert((await verifyResponseSignature(att!, r.svc.attestedSigner)).verified, 'stream attestation did not verify');
  });
  await g.check('tamper: one flipped streamed byte fails', async () => {
    const bad = new Uint8Array(bodyBytes);
    bad[5]! ^= 0x01;
    const att2 = parseAttestationHeaders(merged, keccak256(utf8(reqBody)), keccak256(bad));
    assert(att2 && !(await verifyResponseSignature(att2, r.svc.attestedSigner)).verified, 'tampered stream verified');
  });
  return g.result('streaming-trailer');
}

async function tierLabelGuard(_cfg: ConformanceConfig, r: Resolved): Promise<GroupResult> {
  const g = new Group();
  const measurement = extractImageMeasurement(r.quoteBlob);
  await g.check(`listed label '${r.svc.verifiability}' is within the image ceiling`, () => {
    assertTierAllowedForImage(r.svc.verifiability, measurement);
  });
  await g.expectThrow('unknown image claiming dstack-cvm-inference fails closed', () =>
    assertTierAllowedForImage('dstack-cvm-inference', '0x' + 'cd'.repeat(48)), /tier/);
  await g.expectThrow('free-form label fails (closed enum)', () =>
    assertTierAllowedForImage('tee-verified-inference', measurement), /tier/);
  return g.result('tier-label-guard');
}

async function voucherSettlement(cfg: ConformanceConfig): Promise<GroupResult> {
  const g = new Group();
  const lc = cfg.ledger;
  if (!lc) return g.result('voucher-settlement', 'no ledger config (Phase-A run)');

  const chain = await chainFor(cfg.rpcUrl);
  const user = new LedgerClient(cfg.rpcUrl, chain, lc.address, lc.userKey);
  const providerAddr = getAddress(lc.providerAddress);
  const domain = { chainId: BigInt(chain.id), verifyingContract: getAddress(lc.address) };
  const userAccount = privateKeyToAccount(lc.userKey);

  // the graded listing — metering must match its advertised prices.
  const reader = new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress);
  const listing = (await reader.list()).find((s) => getAddress(s.provider) === providerAddr && s.active);
  assert(listing, `voucher provider ${providerAddr} not listed/active`);

  const chainNow = await user.chainNow();
  const maxFee = 10n ** 15n; // comfortably above the gate's pre-flight estimate
  const mkVoucher = (nonce: bigint, over: Partial<Voucher> = {}): Voucher => ({
    user: userAccount.address,
    provider: providerAddr,
    nonce,
    maxFee,
    expiry: chainNow + 7n * 24n * 3600n, // survives the refund-window time travel
    ...over,
  });
  const sign = (v: Voucher) => signVoucher(userAccount, v, domain);

  const call = async (voucher?: Voucher, signature?: Hex) => {
    const body = JSON.stringify({
      model: listing!.models[0] ?? '',
      messages: [{ role: 'user', content: 'conformance: paid call' }],
    });
    const res = await fetch(`${lc.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(voucher ? { [VOUCHER_HEADERS.voucher]: encodeVoucher(voucher) } : {}),
        ...(signature ? { [VOUCHER_HEADERS.signature]: signature } : {}),
      },
      body,
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), reqBody: body };
  };

  // 1. fund the escrow: deposit → transferTo
  const escrow = 4n * 10n ** 17n; // 0.4 AI3
  await g.check('deposit → transferTo funds the (user,provider) sub-account', async () => {
    await user.deposit(5n * 10n ** 17n);
    await user.transferTo(providerAddr, escrow);
    assert((await user.balanceOf(userAccount.address, providerAddr)) === escrow, 'escrow balance mismatch');
  });

  // 2. the 402 gate
  await g.check('no voucher → HTTP 402', async () => {
    const r = await call();
    assert(r.status === 402, `got ${r.status}`);
    assert(/voucher/i.test(r.json?.error ?? ''), `error: ${r.text}`);
  });
  await g.check('maxFee below the estimate → 402 with estimateWei', async () => {
    const v = mkVoucher(1000n, { maxFee: 1000n });
    const r = await call(v, await sign(v));
    assert(r.status === 402, `got ${r.status}`);
    assert(typeof r.json?.estimateWei === 'string' && BigInt(r.json.estimateWei) > 1000n, `body: ${r.text}`);
  });

  // 3. two paid calls → one on-chain settle batch
  const v0 = mkVoucher(0n);
  const v1 = mkVoucher(1n);
  const sig0 = await sign(v0);
  let feeTotal = 0n;
  await g.check('paid calls succeed and batch-settle on-chain (funds move, nonces burn)', async () => {
    const balBefore = await user.balanceOf(userAccount.address, providerAddr);
    const accruedBefore = await user.accrued(providerAddr);
    for (const [v, s] of [[v0, sig0], [v1, await sign(v1)]] as Array<[Voucher, Hex]>) {
      const r = await call(v, s);
      assert(r.status === 200, `paid call got ${r.status}: ${r.text}`);
      const usage = r.json?.usage;
      assert(usage?.prompt_tokens > 0 && usage?.completion_tokens > 0, 'no usage in response');
      feeTotal += BigInt(usage.prompt_tokens) * listing!.inputPriceWei + BigInt(usage.completion_tokens) * listing!.outputPriceWei;
    }
    assert(feeTotal > 0n && feeTotal <= 2n * maxFee, `metered total ${feeTotal}`);
    assert((await user.balanceOf(userAccount.address, providerAddr)) === balBefore - feeTotal, 'escrow did not decrease by the metered fees');
    assert((await user.accrued(providerAddr)) === accruedBefore + feeTotal, 'provider accrual mismatch');
    assert(await user.nonceUsed(userAccount.address, providerAddr, 0n), 'nonce 0 not burned');
    assert(await user.nonceUsed(userAccount.address, providerAddr, 1n), 'nonce 1 not burned');
  });

  // 4. gate-level rejections after settlement
  await g.check('replayed nonce → 402', async () => {
    const r = await call(v0, sig0);
    assert(r.status === 402 && /nonce/i.test(r.json?.error ?? ''), `got ${r.status}: ${r.text}`);
  });
  await g.check('expired voucher → 402', async () => {
    const v = mkVoucher(2n, { expiry: chainNow - 10n });
    const r = await call(v, await sign(v));
    assert(r.status === 402 && /expir/i.test(r.json?.error ?? ''), `got ${r.status}: ${r.text}`);
  });

  // 5. contract-level rejections (the ledger is the last line of defense)
  if (lc.providerKey) {
    const provider = new LedgerClient(cfg.rpcUrl, chain, lc.address, lc.providerKey);
    await g.expectThrow('contract: fee > maxFee → FeeAboveMax', async () => {
      const v = mkVoucher(5n);
      await provider.settle([{ voucher: v, signature: await sign(v), fee: maxFee + 1n }]);
    }, /FeeAboveMax/);
    await g.expectThrow('contract: settled nonce replay → NonceUsed', async () => {
      await provider.settle([{ voucher: v0, signature: sig0, fee: 1n }]);
    }, /NonceUsed/);
    await g.expectThrow('contract: expired voucher → VoucherExpired', async () => {
      const v = mkVoucher(6n, { expiry: chainNow - 10n });
      await provider.settle([{ voucher: v, signature: await sign(v), fee: 1n }]);
    }, /VoucherExpired/);

    // 6. refund-window semantics
    await g.check('refund: locked during the window, still settleable, pays min(requested, remaining) after', async () => {
      const remaining = await user.balanceOf(userAccount.address, providerAddr);
      assert(remaining > 0n, 'nothing left to refund');
      await user.requestRefund(providerAddr, remaining);
      // locked: immediate withdraw reverts
      await assertRejects(() => user.withdrawRefund(providerAddr), /RefundLocked/);
      // still settleable during the window — provider protection
      const v9 = mkVoucher(9n);
      const duringFee = 10n ** 12n;
      await provider.settle([{ voucher: v9, signature: await sign(v9), fee: duringFee }]);
      if (lc.timeTravel) {
        const unlock = await user.refundUnlock();
        await increaseChainTime(cfg.rpcUrl, unlock + 5n);
        const walletBefore = await user.walletBalance();
        const { gasCostWei } = await user.withdrawRefund(providerAddr);
        const paid = remaining - duringFee; // min(requested, remaining after the settle)
        assert(
          (await user.walletBalance()) === walletBefore + paid - gasCostWei,
          'refund payout != min(requested, remaining) − gas',
        );
        assert((await user.balanceOf(userAccount.address, providerAddr)) === 0n, 'escrow not emptied');
      }
    });
  }

  return g.result('voucher-settlement');
}

async function assertRejects(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!match.test(msg)) throw new Error(`rejected, but not with ${match}: ${msg}`);
    return;
  }
  throw new Error(`expected rejection ${match}, but it passed`);
}

async function dcapColumn(cfg: ConformanceConfig): Promise<GroupResult> {
  const g = new Group();
  if (cfg.dcap === 'off') return g.result('dcap', 'disabled (--dcap off)');
  const qvl = await import('@phala/dcap-qvl-node');
  const collateral = realFixtureCollateral() as DcapCollateral;
  const good = realFixtureQuote();
  const verifier = dcapQvlQuoteVerifier({ qvl, collateral, now: () => REAL_FIXTURE_NOW });
  await g.check('known-good TDX quote passes real DCAP', async () => {
    assert(await verifier(good), 'fixture quote rejected');
  });
  await g.check('tampered TDX quote fails real DCAP', async () => {
    const bad = new Uint8Array(good);
    bad[200]! ^= 0x01;
    assert(!(await verifier(bad)), 'tampered fixture quote accepted');
  });
  await g.check('stale collateral fails real DCAP', async () => {
    const staleVerifier = dcapQvlQuoteVerifier({ qvl, collateral, now: () => REAL_FIXTURE_NOW + 10_000_000n });
    assert(!(await staleVerifier(good)), 'expired collateral accepted');
  });
  return g.result('dcap');
}

// ── runner ────────────────────────────────────────────────────────────────────

export async function runMatrix(cfg: ConformanceConfig): Promise<MatrixResult> {
  const r = await resolveService(cfg);
  const groups: GroupResult[] = [];
  groups.push(await quoteBinding(cfg, r));
  groups.push(await responseSignature(cfg, r));
  groups.push(await costNonzero(cfg, r));
  groups.push(await streamingTrailer(cfg, r));
  groups.push(await tierLabelGuard(cfg, r));
  groups.push(await voucherSettlement(cfg)); // Phase B (T9)
  groups.push(await dcapColumn(cfg));
  groups.push(await registryLifecycle(cfg)); // last: it adds/removes a listing
  return { ok: groups.every((g) => g.ok), groups };
}

export function renderMatrix(m: MatrixResult): string {
  const lines: string[] = [];
  for (const g of m.groups) {
    const mark = g.skipped ? '◌' : g.ok ? '✓' : '✗';
    lines.push(`${mark} ${g.group}${g.skipped ? `  (skipped: ${g.skipped})` : ''}`);
    for (const c of g.checks) {
      lines.push(`   ${c.ok ? '✓' : '✗'} ${c.name}${c.ok || !c.detail ? '' : ` — ${c.detail}`}`);
    }
  }
  lines.push('', m.ok ? 'CONFORMANCE: PASS' : 'CONFORMANCE: FAIL');
  return lines.join('\n');
}
