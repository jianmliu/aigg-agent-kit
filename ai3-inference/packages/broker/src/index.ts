/**
 * @ai3-inference/broker — registry-driven consumer broker.
 *
 * Scaffold (extraction plan T1). T4 moves `autoPalBrokerFromRpc` here from
 * aigg-agent-kit packages/npc-agent/src/inference/autopal-broker-provider.ts
 * (ViemRegistryReader / HttpQuoteFetcher / QuoteVerifier seams; deps: viem +
 * fetch only). The kit re-exports for compatibility — 0gtown's AUTOPAL_* env
 * and import paths keep working.
 */
export const AI3_BROKER_VERSION = '0.0.1';
