/** @onchainpal/cognition — agent social cognition over the aigg-memory service.
 *  A MemoryKernel port (Aigg/Fake adapters) + per-peer trust + warning diffusion +
 *  a recall/learn/warn orchestrator. Model-free core; reflection is optional. */
export * from './types';
export { corpusId, corpusPath } from './id';
export type { MemoryKernel, KV } from './kernel/port';
export { InMemoryKV } from './kernel/kv';
export { FakeKernel } from './kernel/fake';
export { AiggMemoryKernel } from './kernel/aigg';
export type { AiggMemoryKernelOpts } from './kernel/aigg';
export { TrustLedger, TRUST_DELTAS } from './social/trust';
export { diffuseWarning } from './social/warn';
export { shouldRefuse } from './gate';
export { Cognition } from './cognition';
export { Polity } from './governance/polity';
export type { Choice, Proposal, TallyResult, Enactor, PolityOpts } from './governance/polity';
export { voteBeliefGated, runSanctionVote } from './governance/voting';
export { RapSheet } from './society/rapsheet';
export type { RapEntry } from './society/rapsheet';
export { LoanBook, LOAN_RATE, LOAN_TERM } from './society/lending';
export type { Loan, Settlement } from './society/lending';
export { misconductTopic, recordMisconduct, runRapSanction } from './society/misconduct';
