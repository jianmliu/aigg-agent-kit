/**
 * MOVED (extraction plan T4) → @ai3-inference/broker.
 *
 * Canonical home: ai3-inference/packages/broker/src/autopal-broker-provider.ts.
 * This shim keeps every existing import path and the @aigg/npc-agent public
 * API working (0gtown's autopal-provider.ts is unchanged); new code should
 * import from '@ai3-inference/broker' directly.
 */
export {
  AutoPalBrokerProvider,
  ViemRegistryReader,
  HttpQuoteFetcher,
  autoPalBrokerFromRpc,
} from '@ai3-inference/broker';
export type {
  AutoPalBrokerProviderOptions,
  AutoPalBrokerRpcConfig,
  RegistryService,
  RegistryReader,
  QuoteFetcher,
} from '@ai3-inference/broker';
