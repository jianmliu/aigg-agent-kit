/**
 * @ai3-inference/broker — registry-driven consumer broker (moved from
 * aigg-agent-kit npc-agent per extraction plan T4). Deps: viem + fetch only;
 * the kit re-exports for compatibility, so 0gtown's AUTOPAL_* env and import
 * paths keep working unchanged.
 */
export const AI3_BROKER_VERSION = '0.0.1';

export * from './autopal-broker-provider.js';
