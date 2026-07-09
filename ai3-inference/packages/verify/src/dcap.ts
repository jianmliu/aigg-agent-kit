/**
 * DCAP quote verifiers (extraction plan T6) — real TDX hardware-root checks
 * behind the existing `QuoteVerifier` seam. Two adapters, one interface:
 *
 * (a) dcapQvlQuoteVerifier — PREFERRED, isomorphic. Wraps Phala's dcap-qvl
 *     verification library compiled to wasm (npm: `@phala/dcap-qvl-node` for
 *     node, `@phala/dcap-qvl-web` for browsers). The wasm module is INJECTED,
 *     not imported: this package stays dependency-light and browser-safe, and
 *     the host picks the right wasm build for its runtime:
 *
 *       import * as qvl from '@phala/dcap-qvl-node';       // node
 *       // or: import init, * as qvl from '@phala/dcap-qvl-web'; await init(); // browser
 *       const quoteVerifier = dcapQvlQuoteVerifier({
 *         qvl,
 *         collateral: (quote) => qvl.js_get_collateral(PCCS_URL, quote),
 *       });
 *
 * (b) httpQuoteVerifier — FALLBACK for server-side hosts: POSTs the raw quote
 *     to a verification service (aigg-src ships one in
 *     backend/internal/service/attest, route `POST /attest/verify-quote`)
 *     and trusts its `{ok}` verdict. Use when shipping wasm is impractical;
 *     note it re-introduces trust in the service operator, so point it at
 *     infrastructure you (the verifying client) control.
 *
 * Both return `QuoteVerifier` = (quote) => Promise<boolean> and NEVER throw:
 * any error (bad quote, unreachable collateral/service, policy miss) is
 * `false`, which `verifyQuoteOnce` turns into a hard verification failure.
 */
import type { QuoteVerifier } from './autoinf-attestation.js';

/** dcap-qvl's QuoteCollateral JSON shape (serde field names). */
export interface DcapCollateral {
  pck_crl_issuer_chain: string;
  root_ca_crl: string;
  pck_crl: string;
  tcb_info_issuer_chain: string;
  tcb_info: string;
  tcb_info_signature: string;
  qe_identity_issuer_chain: string;
  qe_identity: string;
  qe_identity_signature: string;
}

/** The wasm surface this adapter needs — matches @phala/dcap-qvl-node/-web. */
export interface DcapQvlModule {
  /** throws on any verification failure; returns the verification report. */
  js_verify(rawQuote: Uint8Array, collateral: unknown, now: bigint): DcapVerificationReport;
  /** fetches collateral from a PCCS for the quote's PCK cert (optional here). */
  js_get_collateral?(pccsUrl: string, rawQuote: Uint8Array): Promise<DcapCollateral>;
}

/** What js_verify returns on success (subset we act on). */
export interface DcapVerificationReport {
  /** TCB status, e.g. "UpToDate", "SWHardeningNeeded", "OutOfDate", … */
  status: string;
  advisory_ids: string[];
  report?: unknown;
}

export interface DcapQvlVerifierOptions {
  /** the loaded wasm module (node or web build, already init()ed). */
  qvl: DcapQvlModule;
  /** recorded collateral, or a fetcher (e.g. quote => js_get_collateral(PCCS, quote)). */
  collateral: DcapCollateral | ((quote: Uint8Array) => Promise<DcapCollateral>);
  /** verification time in unix SECONDS; default: wall clock. Pin it in tests
   *  so recorded collateral stays inside its validity window. */
  now?: () => bigint;
  /** TCB statuses accepted as verified. Default STRICT: ['UpToDate'].
   *  Deployments willing to accept hardening advisories can widen this
   *  (e.g. ['UpToDate','SWHardeningNeeded']) as an explicit policy choice. */
  acceptStatuses?: readonly string[];
  /** observer for diagnostics — receives the report or the thrown error. */
  onResult?: (outcome: { ok: boolean; report?: DcapVerificationReport; error?: unknown }) => void;
}

/** (a) the wasm-backed verifier — see module doc. */
export function dcapQvlQuoteVerifier(opts: DcapQvlVerifierOptions): QuoteVerifier {
  const accept = opts.acceptStatuses ?? ['UpToDate'];
  const now = opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  return async (quote: Uint8Array): Promise<boolean> => {
    try {
      const collateral =
        typeof opts.collateral === 'function' ? await opts.collateral(quote) : opts.collateral;
      const report = opts.qvl.js_verify(quote, collateral, now());
      const ok = accept.includes(report.status);
      opts.onResult?.({ ok, report });
      return ok;
    } catch (error) {
      opts.onResult?.({ ok: false, error });
      return false;
    }
  };
}

export interface HttpQuoteVerifierOptions {
  fetchImpl?: typeof fetch;
  /** extra headers (auth etc.). */
  headers?: Record<string, string>;
  /** observer for diagnostics. */
  onResult?: (outcome: { ok: boolean; status?: number; error?: unknown }) => void;
}

/**
 * (b) the HTTP-service-backed verifier — see module doc. Contract:
 * `POST <endpoint>` with the raw quote as `application/octet-stream`;
 * the service answers 200 `{"ok":true}` or `{"ok":false,"error":"…"}`.
 * Anything else (non-200, malformed body, network error) is false.
 */
export function httpQuoteVerifier(endpoint: string, opts: HttpQuoteVerifierOptions = {}): QuoteVerifier {
  const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!f) throw new Error('[httpQuoteVerifier] no fetch implementation available');
  return async (quote: Uint8Array): Promise<boolean> => {
    try {
      const res = await f(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...(opts.headers ?? {}) },
        // cast: fetch's BodyInit typing predates ArrayBufferLike-generic Uint8Array
        body: quote as unknown as RequestInit['body'],
      });
      if (!res.ok) {
        opts.onResult?.({ ok: false, status: res.status });
        return false;
      }
      const body = (await res.json()) as { ok?: unknown };
      const ok = body?.ok === true;
      opts.onResult?.({ ok, status: res.status });
      return ok;
    } catch (error) {
      opts.onResult?.({ ok: false, error });
      return false;
    }
  };
}
