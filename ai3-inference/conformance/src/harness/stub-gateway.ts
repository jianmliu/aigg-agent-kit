/**
 * stub-gateway (extraction plan T7) — a minimal provider gateway that signs
 * every response with a test enclave key, Phase-A style, over exactly the
 * bytes it sends:
 *
 *   digest = keccak(reqHash ‖ respHash ‖ model ‖ be64(inTok) ‖ be64(outTok))
 *   signature = EIP-191(digest) by the enclave key
 *
 * Two response paths, mirroring the real gateway (aigg-src):
 *   • buffered JSON (POST /chat/completions): attestation as LEADING headers
 *     (a Content-Length response would drop trailers — the gateway's known
 *     non-streamed limitation, avoided here the same way);
 *   • SSE (body {"stream":true}): chunked event stream; signer + response-id
 *     lead, signature + metered fields arrive as HTTP TRAILERS after the
 *     body — the transport the Go gateway uses for streamed responses.
 *
 * Token counts are deterministic functions of the request/response sizes so a
 * grader can replay a call and get identical metering.
 *
 * Phase B (extraction plan T9): an optional VOUCHER GATE — the middleware the
 * real gateway (aigg-src) will be graded against. When configured, every
 * request must carry X-AIGG-Voucher + X-AIGG-Voucher-Sig; the gate rejects
 * with HTTP 402 (+ machine-readable reason, + estimateWei when the cap is
 * too small) on: missing/malformed voucher, bad signature, wrong provider,
 * expired (CHAIN clock), reused nonce, maxFee below the estimate, or escrow
 * balance below maxFee. Served requests are metered (tokens × listing
 * prices) and their vouchers auto-settle on-chain in batches of
 * `settleEvery` (legacy type-0), so a grader observes real Settled effects.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { keccak256, hexToBytes, getAddress, recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { computeResponseDigest } from '@ai3-inference/core';
import { ATTEST_HEADERS } from '@ai3-inference/verify';
import { VOUCHER_HEADERS, decodeVoucher, hashVoucher, type Voucher } from '@ai3-inference/voucher';
import { LedgerClient } from './ledger.js';
import type { Chain } from 'viem';

export interface VoucherGateOptions {
  rpcUrl: string;
  chain: Chain;
  ledgerAddress: string;
  /** the provider EOA vouchers must name AND the key that settles them. */
  providerKey: Hex;
  /** listing prices — metering must match what the registry advertises. */
  inputPriceWei: bigint;
  outputPriceWei: bigint;
  /** pre-flight token bound used for the 402 estimate (spec §4 gate). */
  estimateTokens?: { input: number; output: number };
  /** settle on-chain after this many served vouchers (default 2 — proves batching). */
  settleEvery?: number;
}

export interface StubGateway {
  endpoint: string; // base URL; serves POST /chat/completions
  enclaveAddress: Address;
  /** uncompressed pubkey minus the 0x04 prefix — what report_data binds. */
  enclavePubkey: Uint8Array;
  /** voucher-gate mode only: the provider EOA that settles. */
  providerAddress?: Address;
  /** voucher-gate mode only: settle any pending vouchers now. */
  settleNow?: () => Promise<void>;
  stop(): Promise<void>;
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

/** deterministic metering: ~4 bytes per token, never zero. */
export const meterTokens = (byteLen: number) => Math.floor(byteLen / 4) + 1;

async function signFields(
  account: PrivateKeyAccount,
  fields: { requestHash: Hex; responseHash: Hex; model: string; inputTokens: number; outputTokens: number },
): Promise<Hex> {
  return account.signMessage({ message: { raw: computeResponseDigest(fields) } });
}

export async function startStubGateway(opts: { enclaveKey: Hex; voucherGate?: VoucherGateOptions }): Promise<StubGateway> {
  const account = privateKeyToAccount(opts.enclaveKey);
  const enclavePubkey = hexToBytes(account.publicKey).slice(1);

  // ── voucher gate state (Phase B) ────────────────────────────────────────────
  const gate = opts.voucherGate;
  const ledger = gate ? new LedgerClient(gate.rpcUrl, gate.chain, gate.ledgerAddress, gate.providerKey) : undefined;
  const providerAddress = ledger?.account.address;
  const usedNonces = new Set<string>(); // local replay guard (contract re-checks at settle)
  const pending: Array<{ voucher: Voucher; signature: Hex; fee: bigint }> = [];
  const settleEvery = gate?.settleEvery ?? 2;

  const settleNow = async (): Promise<void> => {
    if (!ledger || pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    await ledger.settle(batch);
  };

  const reject402 = (res: import('node:http').ServerResponse, error: string, extra: Record<string, string> = {}) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error, ledger: gate?.ledgerAddress, provider: providerAddress, ...extra }));
  };

  /** the 402 gate — returns the accepted voucher, or null after rejecting. */
  const checkVoucher = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<{ voucher: Voucher; signature: Hex } | null> => {
    const rawVoucher = req.headers[VOUCHER_HEADERS.voucher];
    const rawSig = req.headers[VOUCHER_HEADERS.signature];
    if (typeof rawVoucher !== 'string' || typeof rawSig !== 'string') {
      reject402(res, 'voucher required: send X-AIGG-Voucher + X-AIGG-Voucher-Sig');
      return null;
    }
    let voucher: Voucher;
    try {
      voucher = decodeVoucher(rawVoucher);
    } catch (e) {
      reject402(res, `malformed voucher: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    const signature = rawSig as Hex;
    if (getAddress(voucher.provider) !== providerAddress) {
      reject402(res, 'voucher names a different provider');
      return null;
    }
    let signer: Address;
    try {
      signer = await recoverAddress({
        hash: hashVoucher(voucher, { chainId: gate!.chain.id, verifyingContract: getAddress(gate!.ledgerAddress) }),
        signature,
      });
    } catch {
      reject402(res, 'invalid voucher signature');
      return null;
    }
    if (getAddress(signer) !== getAddress(voucher.user)) {
      reject402(res, 'voucher signature does not recover to voucher.user');
      return null;
    }
    // expiry against the CHAIN clock — that is what settle() enforces.
    if (voucher.expiry <= (await ledger!.chainNow())) {
      reject402(res, 'voucher expired');
      return null;
    }
    const nonceKey = `${getAddress(voucher.user)}:${voucher.nonce}`;
    if (usedNonces.has(nonceKey) || (await ledger!.nonceUsed(voucher.user, providerAddress!, voucher.nonce))) {
      reject402(res, 'voucher nonce already used');
      return null;
    }
    const est = gate!.estimateTokens ?? { input: 64, output: 64 };
    const estimateWei = BigInt(est.input) * gate!.inputPriceWei + BigInt(est.output) * gate!.outputPriceWei;
    if (voucher.maxFee < estimateWei) {
      reject402(res, 'maxFee below the pre-flight estimate — re-sign a bigger voucher', {
        estimateWei: estimateWei.toString(),
      });
      return null;
    }
    if ((await ledger!.balanceOf(voucher.user, providerAddress!)) < voucher.maxFee) {
      reject402(res, 'escrow balance below maxFee — deposit + transferTo first');
      return null;
    }
    return { voucher, signature };
  };

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        // Phase-B gate first: no voucher, no inference.
        let accepted: { voucher: Voucher; signature: Hex } | null = null;
        if (gate) {
          accepted = await checkVoucher(req, res);
          if (!accepted) return;
        }
        const rawReq = Buffer.concat(chunks);
        const requestHash = keccak256(new Uint8Array(rawReq));
        let body: any = {};
        try {
          body = JSON.parse(rawReq.toString('utf8'));
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        const model: string = body.model ?? 'conformance-model';
        const lastUser = Array.isArray(body.messages)
          ? [...body.messages].reverse().find((m: any) => m?.role === 'user')?.content ?? ''
          : '';
        const content = `stub-gateway echo: ${String(lastUser).slice(0, 64)}`;
        const inputTokens = meterTokens(rawReq.length);
        const outputTokens = meterTokens(content.length);
        const responseId = randomUUID();

        // Phase-B metering: fee = tokens × listing prices, capped by the
        // user-signed maxFee at settle time; batch-settle deterministically
        // BEFORE responding so a grader can assert on-chain effects at once.
        if (gate && accepted) {
          const fee = BigInt(inputTokens) * gate.inputPriceWei + BigInt(outputTokens) * gate.outputPriceWei;
          usedNonces.add(`${getAddress(accepted.voucher.user)}:${accepted.voucher.nonce}`);
          pending.push({ voucher: accepted.voucher, signature: accepted.signature, fee });
          if (pending.length >= settleEvery) await settleNow();
        }

        if (body.stream === true) {
          // ── SSE + HTTP trailers ────────────────────────────────────────────
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Trailer: [
              ATTEST_HEADERS.signature,
              ATTEST_HEADERS.payloadHash,
              ATTEST_HEADERS.model,
              ATTEST_HEADERS.inputTokens,
              ATTEST_HEADERS.outputTokens,
              ATTEST_HEADERS.verification,
            ].join(', '),
            [ATTEST_HEADERS.signer]: account.address,
            [ATTEST_HEADERS.responseId]: responseId,
          });
          const bodyParts: Uint8Array[] = [];
          const send = (s: string) => {
            const b = utf8(s);
            bodyParts.push(b);
            res.write(b);
          };
          for (const piece of [content.slice(0, 10), content.slice(10)]) {
            send(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          send(`data: ${JSON.stringify({ usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}\n\n`);
          send('data: [DONE]\n\n');
          const streamed = new Uint8Array(Buffer.concat(bodyParts.map((b) => Buffer.from(b))));
          const responseHash = keccak256(streamed);
          const signature = await signFields(account, { requestHash, responseHash, model, inputTokens, outputTokens });
          res.addTrailers({
            [ATTEST_HEADERS.signature]: signature,
            [ATTEST_HEADERS.payloadHash]: responseHash,
            [ATTEST_HEADERS.model]: model,
            [ATTEST_HEADERS.inputTokens]: String(inputTokens),
            [ATTEST_HEADERS.outputTokens]: String(outputTokens),
            [ATTEST_HEADERS.verification]: `dstack:verified:${responseId}`,
          });
          res.end();
          return;
        }

        // ── buffered JSON + leading headers ──────────────────────────────────
        const respBody = JSON.stringify({
          id: responseId,
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
        });
        const responseHash = keccak256(utf8(respBody));
        const signature = await signFields(account, { requestHash, responseHash, model, inputTokens, outputTokens });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          [ATTEST_HEADERS.signer]: account.address,
          [ATTEST_HEADERS.responseId]: responseId,
          [ATTEST_HEADERS.signature]: signature,
          [ATTEST_HEADERS.payloadHash]: responseHash,
          [ATTEST_HEADERS.model]: model,
          [ATTEST_HEADERS.inputTokens]: String(inputTokens),
          [ATTEST_HEADERS.outputTokens]: String(outputTokens),
          [ATTEST_HEADERS.verification]: `dstack:verified:${responseId}`,
        });
        res.end(respBody);
      })().catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub-gateway: no address');
  return {
    endpoint: `http://127.0.0.1:${addr.port}`,
    enclaveAddress: account.address,
    enclavePubkey,
    ...(gate ? { providerAddress, settleNow } : {}),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
