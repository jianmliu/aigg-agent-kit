/**
 * MOVED (extraction plan T4) → @ai3-inference/broker, and RENAMED
 * autopal → autoinf (2026-07-08): the broker is inference infra, so the
 * PAL-flavored app name is gone. Canonical home:
 * ai3-inference/packages/broker/src/autoinf-broker-provider.ts.
 *
 * This shim keeps every existing import path working and keeps the OLD
 * AutoPal* names as deprecated aliases; new code imports the AutoInf* names
 * from '@ai3-inference/broker' directly.
 */
export {
  AutoInfBrokerProvider,
  ViemRegistryReader,
  HttpQuoteFetcher,
  autoInfBrokerFromRpc,
  // deprecated aliases (pre-rename API)
  AutoInfBrokerProvider as AutoPalBrokerProvider,
  autoInfBrokerFromRpc as autoPalBrokerFromRpc,
} from '@ai3-inference/broker';
export type {
  AutoInfBrokerProviderOptions,
  AutoInfBrokerRpcConfig,
  RegistryService,
  RegistryReader,
  QuoteFetcher,
  // deprecated aliases (pre-rename API)
  AutoInfBrokerProviderOptions as AutoPalBrokerProviderOptions,
  AutoInfBrokerRpcConfig as AutoPalBrokerRpcConfig,
} from '@ai3-inference/broker';
