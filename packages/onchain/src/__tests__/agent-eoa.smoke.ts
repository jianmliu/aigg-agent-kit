/**
 * Headless smoke test for per-NPC agent EOA derivation. No network/funds.
 * Run: pnpm --filter @onchainpal/game-engine test:eoa
 */
import assert from 'node:assert/strict';
import { verifyTypedData, isAddress } from 'viem';
import { EoaAgentWallet, deriveNpcAgentAccount, npcAddressIndex } from '../agent-eoa';

// Standard well-known test mnemonic (NOT a real key) — deterministic addresses.
const MNEMONIC = 'test test test test test test test test test test test junk';

const JX = 'npc:jiu-jianxian';
const AZ = 'npc:azhu';

async function main() {
  const jx = new EoaAgentWallet(MNEMONIC, JX);
  const az = new EoaAgentWallet(MNEMONIC, AZ);

  // each NPC has a valid, distinct on-chain address
  assert.ok(isAddress(jx.address), '酒剑仙 address is a valid EVM address');
  assert.ok(isAddress(az.address), '阿珠 address is valid');
  assert.notEqual(jx.address.toLowerCase(), az.address.toLowerCase(), 'different NPCs → different addresses');

  // deterministic: same npcId + mnemonic → same address
  const jx2 = new EoaAgentWallet(MNEMONIC, JX);
  assert.equal(jx2.address, jx.address, 'derivation is deterministic per (mnemonic, npcId)');
  assert.equal(npcAddressIndex(JX), npcAddressIndex(JX), 'address index stable');
  assert.notEqual(npcAddressIndex(JX), npcAddressIndex(AZ), 'distinct index per npcId');
  assert.ok(npcAddressIndex(JX) >= 0 && npcAddressIndex(JX) < 2 ** 31, 'index is a valid uint31');

  // the EOA can sign an EIP-712 payload, and it verifies against its own address
  const payload = {
    domain: { name: 'AI.GG AgentAuth', version: '1', chainId: 8453 },
    types: {
      ApproveAgent: [
        { name: 'agent', type: 'address' },
        { name: 'maxAmount', type: 'uint256' },
        { name: 'token', type: 'address' }
      ]
    },
    primaryType: 'ApproveAgent',
    message: { agent: jx.address, maxAmount: 1000n, token: '0x0000000000000000000000000000000000000001' }
  };
  const sig = await jx.signTypedData(payload as any);
  assert.ok(sig.startsWith('0x'), 'signTypedData returns a 0x signature');
  const ok = await verifyTypedData({ address: jx.address as `0x${string}`, ...(payload as any), signature: sig });
  assert.ok(ok, 'signature recovers to the NPC EOA address');

  // balanceGcc is not read here (funding EOA holds GCC in the demo)
  assert.equal(await jx.balanceGcc(), null, 'balanceGcc null until RPC wired');

  // sanity: helper matches the wallet
  assert.equal(deriveNpcAgentAccount(MNEMONIC, JX).address, jx.address, 'helper ≡ wallet address');

  console.log(`✓ per-NPC EOA: 酒剑仙=${jx.address.slice(0, 10)}… 阿珠=${az.address.slice(0, 10)}… (distinct, deterministic, signs EIP-712)`);
  console.log('\nALL AGENT-EOA SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('AGENT-EOA SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
