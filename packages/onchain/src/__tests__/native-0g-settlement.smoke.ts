import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { Native0gSettlementLayer, FakeNativeChain } from '../native-0g-settlement';

// A fixed test mnemonic (NEVER a real key) + an arbitrary treasury address.
const MNEMONIC = 'test test test test test test test test test test test junk';
const TREASURY = '0x000000000000000000000000000000000000dEaD' as const;

async function main() {
  const chain = new FakeNativeChain({ gasCostWei: parseEther('0.0001') });
  // fund the treasury generously + tell the fake which address 'treasury' resolves to
  chain.set(TREASURY, parseEther('100'));
  chain.treasuryAddr = TREASURY;
  const layer = new Native0gSettlementLayer({
    chain, npcMnemonic: MNEMONIC, treasuryAddress: TREASURY,
    weiPerUnit: parseEther('0.01'), gasReserveWei: parseEther('0.001'), dustUnits: 1e-6,
  });

  const npc = 'npc:0gtown:abao';
  const addr = layer.addressOf(npc);
  chain.setSigner(npc, addr); // let the fake resolve npcId → its EOA address (for withdraw)
  assert.ok(addr.startsWith('0x') && addr.length === 42, 'addressOf is a 0x address');
  assert.equal(layer.addressOf(npc), layer.addressOf(npc), 'addressOf deterministic');

  // fresh NPC reads 0 units on-chain
  assert.equal(await layer.balanceOf(npc), 0, 'fresh NPC balanceOf 0');

  // reconcile a fresh NPC to 10 units → a deposit; balanceOf becomes ~10 (reserve excluded)
  const tx1 = await layer.reconcile(npc, 10);
  assert.ok(tx1 && tx1.direction === 'deposit', 'reconcile fresh → deposit');
  assert.ok(Math.abs((await layer.balanceOf(npc)) - 10) < 1e-6, 'balanceOf ~10 after deposit (reserve excluded)');

  // a small scam: target drops to 7 → a withdraw of ~3
  const tx2 = await layer.reconcile(npc, 7);
  assert.ok(tx2 && tx2.direction === 'withdraw', 'reconcile down → withdraw');
  assert.ok(Math.abs((await layer.balanceOf(npc)) - 7) < 1e-3, 'balanceOf ~7 after withdraw');

  // already aligned → no tx
  assert.equal(await layer.reconcile(npc, 7), null, 'aligned → no tx (within dust)');

  // settling to 0 withdraws the rest
  const tx3 = await layer.reconcile(npc, 0);
  assert.ok(tx3 === null || tx3.direction === 'withdraw', 'reconcile to 0 withdraws the rest');
  assert.ok((await layer.balanceOf(npc)) < 1e-3, 'balanceOf ~0 after settling to 0');

  // anchor is a no-op stub that resolves
  await layer.anchor('0xdeadbeef');

  console.log('NATIVE-0G SETTLEMENT SMOKE OK ✅');
}
main().catch((e) => { console.error('NATIVE-0G SETTLEMENT SMOKE FAILED ❌', e); process.exit(1); });
