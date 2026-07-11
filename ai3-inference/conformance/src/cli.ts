#!/usr/bin/env node
/**
 * ai3-conformance (extraction plan T7) — grade an endpoint+registry pair
 * pass/fail over the invariant matrix.
 *
 *   # hermetic self-test (milestone V1 gate): boots chain+DSN+gateway itself
 *   ai3-conformance --hermetic
 *
 *   # grade a live pair
 *   ai3-conformance --rpc <url> --registry <0x…> --dsn <url> \
 *       [--endpoint <url>] [--provider <0x…>] [--model <id>] \
 *       [--lifecycle-key <0x…>] [--dcap fixture|off] [--unsafe-quotes] \
 *       [--ledger <0x…> --ledger-endpoint <url> --ledger-provider <0x…> \
 *        --user-key <0x…> [--settle-key <0x…>] [--time-travel]]   # Phase-B group (T9)
 *
 * Exit codes: 0 = matrix green, 1 = failures, 2 = usage error.
 *
 * Live-run notes: by default the loop's quote check uses a real DCAP
 * verifier (dcap-qvl wasm + PCCS collateral; --pccs overrides the URL) —
 * pass --unsafe-quotes to explicitly downgrade (bring-up only).
 * --lifecycle-key must be a FUNDED throwaway key with NO existing listing;
 * the run registers and deactivates a temporary service with it.
 */
import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { dcapQvlQuoteVerifier, UNSAFE_acceptAnyQuote, type QuoteVerifier } from '@ai3-inference/verify';
import { runMatrix, renderMatrix, type ConformanceConfig } from './matrix.js';
import { runHermetic } from './hermetic.js';

const { values } = parseArgs({
  options: {
    hermetic: { type: 'boolean', default: false },
    rpc: { type: 'string' },
    registry: { type: 'string' },
    dsn: { type: 'string' },
    endpoint: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'lifecycle-key': { type: 'string' },
    dcap: { type: 'string', default: 'fixture' },
    'unsafe-quotes': { type: 'boolean', default: false },
    pccs: { type: 'string' },
    ledger: { type: 'string' },
    'ledger-endpoint': { type: 'string' },
    'ledger-provider': { type: 'string' },
    'user-key': { type: 'string' },
    'settle-key': { type: 'string' },
    'time-travel': { type: 'boolean', default: false },
  },
});

async function main(): Promise<number> {
  if (values.hermetic) {
    const result = await runHermetic();
    console.log(renderMatrix(result));
    return result.ok ? 0 : 1;
  }

  if (!values.rpc || !values.registry || !values.dsn) {
    console.error('usage: ai3-conformance --hermetic | --rpc <url> --registry <0x…> --dsn <url> [--endpoint <url>] …');
    return 2;
  }

  let quoteVerifier: QuoteVerifier;
  if (values['unsafe-quotes']) {
    console.error('⚠ --unsafe-quotes: the TDX hardware root is NOT checked on the live loop');
    quoteVerifier = UNSAFE_acceptAnyQuote;
  } else {
    const qvl = await import('@phala/dcap-qvl-node');
    const pccs = values.pccs ?? 'https://pccs.phala.network/tdx/certification/v4';
    quoteVerifier = dcapQvlQuoteVerifier({
      qvl,
      collateral: (quote) => qvl.js_get_collateral(pccs, quote),
    });
  }

  const cfg: ConformanceConfig = {
    rpcUrl: values.rpc,
    registryAddress: values.registry,
    dsnBaseUrl: values.dsn,
    endpointOverride: values.endpoint,
    providerAddress: values.provider,
    model: values.model,
    lifecycleKey: values['lifecycle-key'] as Hex | undefined,
    quoteVerifier,
    dcap: values.dcap === 'off' ? 'off' : 'fixture',
    ...(values.ledger && values['ledger-endpoint'] && values['ledger-provider'] && values['user-key']
      ? {
          ledger: {
            address: values.ledger,
            endpoint: values['ledger-endpoint'],
            providerAddress: values['ledger-provider'],
            userKey: values['user-key'] as Hex,
            providerKey: values['settle-key'] as Hex | undefined,
            timeTravel: values['time-travel'],
          },
        }
      : {}),
  };
  const result = await runMatrix(cfg);
  console.log(renderMatrix(result));
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('ai3-conformance: fatal:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
