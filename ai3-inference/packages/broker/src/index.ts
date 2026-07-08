/**
 * @ai3-inference/broker — registry-driven consumer broker (moved from
 * aigg-agent-kit npc-agent per extraction plan T4). Deps: viem + fetch only;
 * renamed autopal → autoinf 2026-07-08 (inference infra, not a PAL app
 * concept); the kit re-exports deprecated AutoPal aliases so old import
 * paths and submodule pointers keep working.
 */
export const AI3_BROKER_VERSION = '0.0.1';

export * from './autoinf-broker-provider.js';
