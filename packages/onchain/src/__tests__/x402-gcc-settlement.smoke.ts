/**
 * Headless smoke test for X402GccSettlement — verifies the onchainpal-side real
 * settlement (GCC EIP-2612 permit signed by the per-NPC EOA + facilitator submit)
 * WITHOUT a live chain: nonceProvider + facilitator are fakes; signing is real.
 * Run: pnpm --filter @onchainpal/game-engine test:settlement
 */
import assert from 'node:assert/strict';
import { verifyTypedData } from 'viem';
import { GccLedger, InMemoryStore, type InferenceUsage } from '@onchainpal/npc-agent';
import { EoaAgentWallet } from '../agent-eoa';
import { X402GccSettlement, type FacilitatorClient, type GccPermitPayment, type NonceProvider } from '../x402-gcc-settlement';

const MNEMONIC = 'test test test test test test test test test test test junk';
const JX = 'npc:jiu-jianxian';
const GCC = '0x000000000000000000000000000000000000c0c0' as const; // fake GCC addr
const SELLER = '0x00000000000000000000000000000000000005e1' as const;

const usage = (gcc: number): InferenceUsage => ({ model: 'aigg', inputTokens: 600, outputTokens: 80, gccCost: gcc });

async function main() {
  const wallet = new EoaAgentWallet(MNEMONIC, JX);
  const ledger = new GccLedger(new InMemoryStore(), () => 1);

  const captured: GccPermitPayment[] = [];
  const facilitator: FacilitatorClient = {
    async submit(p) {
      captured.push(p);
      return { receiptId: `rcpt-${captured.length}` };
    }
  };
  const nonceProvider: NonceProvider = { async nonce() { return 7n; } };

  const settlement = new X402GccSettlement({
    config: { gccToken: GCC, gccName: 'Guaranteed Capacity Credit', sellerAddress: SELLER, chainId: 8453, decimals: 18, timeoutSeconds: 300 },
    walletFor: () => wallet,
    nonceProvider,
    facilitator,
    ledger,
    now: () => 1_000_000
  });

  const res = await settlement.settle(JX, usage(0.0003));

  assert.equal(res.mode, 'x402', 'mode is on-chain x402');
  assert.equal(res.receiptId, 'rcpt-1', 'facilitator receipt returned');
  assert.equal(captured.length, 1, 'facilitator received exactly one payment');

  const p = captured[0];
  assert.equal(p.scheme, 'eip2612');
  assert.equal(p.owner.toLowerCase(), wallet.address.toLowerCase(), 'owner = NPC EOA');
  assert.equal(p.spender, SELLER, 'spender = AIGG seller');
  assert.equal(p.token, GCC);
  assert.equal(p.nonce, '7', 'nonce from provider');
  assert.equal(p.deadline, 1_000_300, 'deadline = now + timeout');
  // 0.0003 * 1e18 = 3e14
  assert.equal(p.value, (3n * 10n ** 14n).toString(), 'gccCost scaled to atomic units');

  // the signature is a REAL EIP-2612 Permit sig that verifies to the NPC EOA.
  // Reuse the exact typed-data the settlement built (also asserts the shape).
  const td = settlement.buildPermitTypedData(wallet.address, 3n * 10n ** 14n, 7n, 1_000_300);
  assert.equal(td.primaryType, 'Permit');
  assert.equal((td.domain as any).verifyingContract, GCC, 'domain.verifyingContract = GCC');
  const ok = await verifyTypedData({
    address: wallet.address as `0x${string}`,
    ...(td as any),
    signature: p.signature
  });
  assert.ok(ok, 'EIP-2612 Permit signature verifies to the NPC EOA');

  // ledger also updated
  assert.equal((await ledger.get(JX)).calls, 1, 'consumption also recorded to ledger');

  console.log('✓ X402: per-NPC EOA signs GCC EIP-2612 Permit (verifies) → facilitator submit + ledger');
  console.log('\nALL X402-GCC-SETTLEMENT SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('X402-GCC-SETTLEMENT SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
