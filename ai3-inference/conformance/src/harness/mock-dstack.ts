/**
 * mock-dstack (extraction plan T7) — emits fixture TDX quotes for the
 * hermetic run, standing in for the dstack guest agent socket.
 *
 * Two quote sources:
 *   • makeSyntheticQuote — layout-faithful bytes (report_data at 568, RTMR3 at
 *     520) binding an arbitrary signer pubkey. Passes every structural check
 *     (ref integrity, report_data binding, tier extraction); only a real DCAP
 *     verifier rejects it — hermetic runs inject UNSAFE_acceptAnyQuote for the
 *     loop and grade real DCAP separately (the `dcap` group uses the REAL
 *     fixture quote shipped with @ai3-inference/verify).
 *   • serve() — an HTTP stub over a unix socket answering dstack's
 *     `/GetQuote?report_data=…` shape, for graders pointed at gateway-side
 *     code that expects a socket. Optional; the TS loop uses the factory.
 */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { keccak256, hexToBytes, bytesToHex } from 'viem';
import { TDX_REPORT_DATA_OFFSET, TDX_RTMR3_OFFSET } from '@ai3-inference/verify';

/** deterministic filler so fixture quotes are stable across runs. */
function filler(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 31 + seed * 7 + 3) & 0xff;
  return out;
}

export interface SyntheticQuoteOptions {
  /** 64-byte uncompressed pubkey (X‖Y) the quote's report_data binds. */
  signerPubkey: Uint8Array;
  /** 48-byte image measurement written to RTMR3 (allowlist key). */
  rtmr3?: Uint8Array;
  seed?: number;
}

/** a TDX-v4-shaped quote: report_data = keccak256(pubkey) ‖ 0^32. */
export function makeSyntheticQuote(opts: SyntheticQuoteOptions): Uint8Array {
  const quote = filler(TDX_REPORT_DATA_OFFSET + 64, opts.seed ?? 7);
  quote.set(opts.rtmr3 ?? filler(48, (opts.seed ?? 7) + 1), TDX_RTMR3_OFFSET);
  quote.set(hexToBytes(keccak256(opts.signerPubkey)), TDX_REPORT_DATA_OFFSET);
  quote.fill(0, TDX_REPORT_DATA_OFFSET + 32, TDX_REPORT_DATA_OFFSET + 64);
  return quote;
}

/** the REAL known-good TDX quote shipped with @ai3-inference/verify (T6). */
export function realFixtureQuote(): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(readFileSync(require.resolve('@ai3-inference/verify/fixtures/dcap/tdx_quote.bin')));
}

/** its recorded collateral + the pinned verification time (see fixtures README). */
export function realFixtureCollateral(): unknown {
  const require = createRequire(import.meta.url);
  return JSON.parse(
    readFileSync(require.resolve('@ai3-inference/verify/fixtures/dcap/tdx_quote_collateral.json'), 'utf8'),
  );
}
export const REAL_FIXTURE_NOW = 1750809600n; // 2025-06-25T00:00:00Z

export interface MockDstack {
  socketPath: string;
  stop(): Promise<void>;
}

/**
 * serve — dstack-guest-agent-shaped stub on a unix socket:
 * GET/POST /GetQuote?report_data=0x… → {"quote":"0x…"} with the caller's
 * report_data embedded at the standard offset (zero-padded to 64 bytes).
 */
export async function serveMockDstack(socketPath: string): Promise<MockDstack> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://unix');
    if (!url.pathname.endsWith('/GetQuote')) {
      res.writeHead(404).end();
      return;
    }
    const rdHex = (url.searchParams.get('report_data') ?? '').replace(/^0x/i, '');
    const rd = new Uint8Array(64);
    rd.set(hexToBytes(`0x${rdHex}`).slice(0, 64));
    const quote = filler(TDX_REPORT_DATA_OFFSET + 64, 11);
    quote.set(rd, TDX_REPORT_DATA_OFFSET);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quote: bytesToHex(quote) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
