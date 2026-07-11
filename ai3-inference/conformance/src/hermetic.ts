/**
 * Hermetic stack bootstrap (extraction plan T7 / milestone V1) — from a clean
 * clone with no sibling repos:
 *
 *   local chain → deploy ServiceRegistry+InferenceLedger (legacy type-0) →
 *   fake DSN → mock dstack quote (binds the stub enclave key) → stub gateway
 *   → register the listing on-chain → the SAME matrix any live pair is
 *   graded with.
 *
 * The loop's QuoteVerifier is UNSAFE_acceptAnyQuote — a synthetic quote has
 * no Intel signature; real DCAP is graded by the matrix's `dcap` group over
 * the real fixture quote. Everything else (ref integrity, report_data
 * binding, tier ceiling, response signatures, trailers, bond math) is real.
 */
import { keccak256, parseEther, type Hex } from 'viem';
import { UNSAFE_acceptAnyQuote } from '@ai3-inference/verify';
import { startLocalChain, DEV_KEYS, type LocalChain } from './harness/local-chain.js';
import { deployMarket, type Deployment } from './harness/deploy.js';
import { startFakeDsn, type FakeDsn } from './harness/fake-dsn.js';
import { makeSyntheticQuote } from './harness/mock-dstack.js';
import { startStubGateway, type StubGateway } from './harness/stub-gateway.js';
import { RegistryWriter } from './harness/registry.js';
import { runMatrix, type ConformanceConfig, type MatrixResult } from './matrix.js';

/** the stub gateway's enclave signing key (dev account #3 of the test mnemonic). */
export const HERMETIC_ENCLAVE_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
/** the voucher-gated gateway's enclave key (dev account #5) — a second service,
 *  so the Phase-A groups keep grading the ungated listing. */
export const HERMETIC_VOUCHER_ENCLAVE_KEY: Hex = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

/** Phase-B listing prices (wei-of-AI3 per token) — shared by the registry
 *  entry and the gateway's metering so conformance can cross-check fees. */
const VOUCHER_INPUT_PRICE = 10n ** 12n;
const VOUCHER_OUTPUT_PRICE = 2n * 10n ** 12n;

export interface HermeticStack {
  chain: LocalChain;
  deployment: Deployment;
  dsn: FakeDsn;
  gateway: StubGateway;
  config: ConformanceConfig;
  stop(): Promise<void>;
}

export async function startHermeticStack(): Promise<HermeticStack> {
  const chain = await startLocalChain();
  const teardown: Array<() => Promise<void>> = [() => chain.stop()];
  try {
    const deployment = await deployMarket(chain.rpcUrl, DEV_KEYS.deployer as Hex, '0.1');
    const dsn = await startFakeDsn();
    teardown.push(() => dsn.stop());
    const gateway = await startStubGateway({ enclaveKey: HERMETIC_ENCLAVE_KEY });
    teardown.push(() => gateway.stop());

    // mock dstack quote binding the stub enclave pubkey → DSN → registry.
    const quote = makeSyntheticQuote({ signerPubkey: gateway.enclavePubkey });
    const attestationRef = dsn.put(quote);
    if (attestationRef !== keccak256(quote)) throw new Error('fake-dsn ref mismatch');

    const provider = new RegistryWriter(chain.rpcUrl, deployment.chain, deployment.serviceRegistry, DEV_KEYS.provider as Hex);
    await provider.register(
      {
        endpoint: gateway.endpoint,
        models: ['conformance-model'],
        inputPriceWei: parseEther('0.000001'),
        outputPriceWei: parseEther('0.000002'),
        attestationRef,
        attestedSigner: gateway.enclaveAddress,
        verifiability: 'dstack-cvm-relay',
      },
      deployment.bondWei,
    );

    // ── Phase B (T9): a second, voucher-gated service ────────────────────────
    const voucherGateway = await startStubGateway({
      enclaveKey: HERMETIC_VOUCHER_ENCLAVE_KEY,
      voucherGate: {
        rpcUrl: chain.rpcUrl,
        chain: deployment.chain,
        ledgerAddress: deployment.inferenceLedger,
        providerKey: DEV_KEYS.voucherProvider as Hex,
        inputPriceWei: VOUCHER_INPUT_PRICE,
        outputPriceWei: VOUCHER_OUTPUT_PRICE,
        settleEvery: 2, // two paid calls → ONE settle tx: proves batching
      },
    });
    teardown.push(() => voucherGateway.stop());
    const voucherQuote = makeSyntheticQuote({ signerPubkey: voucherGateway.enclavePubkey, seed: 21 });
    const voucherProvider = new RegistryWriter(
      chain.rpcUrl, deployment.chain, deployment.serviceRegistry, DEV_KEYS.voucherProvider as Hex,
    );
    await voucherProvider.register(
      {
        endpoint: voucherGateway.endpoint,
        models: ['conformance-paid-model'],
        inputPriceWei: VOUCHER_INPUT_PRICE,
        outputPriceWei: VOUCHER_OUTPUT_PRICE,
        attestationRef: dsn.put(voucherQuote),
        attestedSigner: voucherGateway.enclaveAddress,
        verifiability: 'dstack-cvm-relay',
      },
      deployment.bondWei,
    );

    const config: ConformanceConfig = {
      rpcUrl: chain.rpcUrl,
      registryAddress: deployment.serviceRegistry,
      dsnBaseUrl: dsn.baseUrl,
      providerAddress: provider.providerAddress,
      lifecycleKey: DEV_KEYS.provider2 as Hex,
      quoteVerifier: UNSAFE_acceptAnyQuote,
      model: 'conformance-model',
      ledger: {
        address: deployment.inferenceLedger,
        endpoint: voucherGateway.endpoint,
        providerAddress: voucherProvider.providerAddress,
        userKey: DEV_KEYS.user as Hex,
        providerKey: DEV_KEYS.voucherProvider as Hex,
        timeTravel: true,
      },
    };
    return {
      chain,
      deployment,
      dsn,
      gateway,
      config,
      stop: async () => {
        for (const t of teardown.reverse()) await t().catch(() => {});
      },
    };
  } catch (e) {
    for (const t of teardown.reverse()) await t().catch(() => {});
    throw e;
  }
}

/** boot, grade, tear down — the V1 gate in one call. */
export async function runHermetic(): Promise<MatrixResult> {
  const stack = await startHermeticStack();
  try {
    return await runMatrix(stack.config);
  } finally {
    await stack.stop();
  }
}
