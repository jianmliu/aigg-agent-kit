/**
 * @ai3-inference/conformance — hermetic harness + grading CLI.
 *
 * Scaffold (extraction plan T1). T7 builds: anvil bootstrap, fake-dsn
 * (HTTP content-addressed blob store), mock-dstack (fixture quotes),
 * stub-gateway (test-key signing, headers AND trailers/SSE), and the CLI
 * `ai3-conformance --rpc … --registry … --dsn … --endpoint …` producing a
 * pass/fail matrix over: registry lifecycle, quote binding, per-response
 * signature (+ tamper), cost non-zero, streaming trailer path, tier-label
 * guard. T9 adds the Phase-B voucher group.
 */
export const AI3_CONFORMANCE_VERSION = '0.0.1';
