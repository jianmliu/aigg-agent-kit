/**
 * @ai3-inference/conformance — hermetic harness + grading CLI (plan T7).
 *
 * Harness: local chain bootstrap (anvil → hardhat-node fallback), legacy
 * type-0 contract deploy from artifacts, fake-dsn (content-addressed HTTP
 * blob store), mock-dstack (fixture quotes: synthetic layout-faithful +
 * the real T6 DCAP fixture), stub-gateway (test-key Phase-A signing over
 * exact bytes; buffered-headers AND SSE+trailers paths).
 *
 * Matrix (see ./matrix.ts): registry lifecycle, quote binding, per-response
 * signature (+ tamper), cost non-zero, streaming trailer path, tier-label
 * guard, dcap column. `runHermetic()` is the milestone-V1 gate; the CLI
 * (`ai3-conformance`) grades any live endpoint+registry pair with the same
 * matrix. T9 adds the Phase-B voucher group.
 */
export const AI3_CONFORMANCE_VERSION = '0.0.1';

export * from './matrix.js';
export * from './hermetic.js';
export * from './harness/local-chain.js';
export * from './harness/deploy.js';
export * from './harness/fake-dsn.js';
export * from './harness/mock-dstack.js';
export * from './harness/stub-gateway.js';
export * from './harness/registry.js';
