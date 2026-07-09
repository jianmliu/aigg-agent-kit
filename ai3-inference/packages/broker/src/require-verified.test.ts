/**
 * requireVerified hard-fail (extraction plan T5) — `requireVerified: true`
 * promises the caller that every response is verified against a hardware
 * root. Constructing the broker with that promise but NO quote verifier is a
 * contradiction and must fail LOUDLY at construction time, not degrade to a
 * warning. Explicitly passing UNSAFE_acceptAnyQuote is a conscious opt-out
 * and is allowed (tests/bring-up).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoInfBrokerProvider, autoInfBrokerFromRpc } from './index.js';
import { UNSAFE_acceptAnyQuote } from '@ai3-inference/verify';

const stubRegistry = { list: async () => [] };
const stubQuotes = { fetch: async () => new Uint8Array() };
const noFetch = (async () => {
  throw new Error('unreachable');
}) as unknown as typeof fetch;

test('requireVerified:true without a quoteVerifier → constructor throws', () => {
  assert.throws(
    () =>
      new AutoInfBrokerProvider({
        registry: stubRegistry,
        quotes: stubQuotes,
        requireVerified: true,
        fetchImpl: noFetch,
      }),
    /requireVerified/,
  );
});

test('requireVerified:true with an explicit verifier (even UNSAFE) → constructs', () => {
  const p = new AutoInfBrokerProvider({
    registry: stubRegistry,
    quotes: stubQuotes,
    requireVerified: true,
    quoteVerifier: UNSAFE_acceptAnyQuote,
    fetchImpl: noFetch,
  });
  assert.equal(p.id, 'autoinf-broker');
});

test('requireVerified unset without a verifier → constructs (degraded, warned)', () => {
  const p = new AutoInfBrokerProvider({
    registry: stubRegistry,
    quotes: stubQuotes,
    fetchImpl: noFetch,
  });
  assert.equal(p.id, 'autoinf-broker');
});

test('fromRpc enforces the same invariant', () => {
  assert.throws(
    () =>
      autoInfBrokerFromRpc({
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        dsnBaseUrl: 'http://127.0.0.1:1',
        requireVerified: true,
        fetchImpl: noFetch,
      }),
    /requireVerified/,
  );
});
