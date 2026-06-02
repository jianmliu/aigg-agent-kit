/**
 * Headless smoke for ERC-6551 TBA address computation + TbaAgentWallet.
 * The pinned reference vector below was verified equal to the LIVE Base-Sepolia
 * registry.account(...) on 2026-06-03 (off-chain == on-chain). No network here.
 * Run: pnpm --filter @onchainpal/game-engine test:tba
 */
import assert from 'node:assert/strict';
import { isAddress, getAddress } from 'viem';
import { computeTbaAddress, ERC6551_REGISTRY, TOKENBOUND_ACCOUNT_V3 } from '../tba';
import { TbaAgentWallet } from '../tba-agent-wallet';
import { EoaAgentWallet } from '../agent-eoa';

const MNEMONIC = 'test test test test test test test test test test test junk';

async function main() {
  // --- pinned reference vector (verified == live Sepolia registry.account) ---
  const ref = computeTbaAddress({
    tokenContract: '0x1111111111111111111111111111111111111111',
    tokenId: 7,
    chainId: 84532,
    implementation: TOKENBOUND_ACCOUNT_V3
  });
  assert.equal(
    ref,
    getAddress('0x22942f4C64B2C5ed385E7fe0c5B903948245bCA1'),
    'computeTbaAddress matches the on-chain ERC-6551 registry result'
  );

  // --- determinism + per-token uniqueness ---
  const nft = '0x9999999999999999999999999999999999999999' as const;
  const t1 = computeTbaAddress({ tokenContract: nft, tokenId: 1, chainId: 84532 });
  const t1b = computeTbaAddress({ tokenContract: nft, tokenId: 1, chainId: 84532 });
  const t2 = computeTbaAddress({ tokenContract: nft, tokenId: 2, chainId: 84532 });
  assert.ok(isAddress(t1), 'valid address');
  assert.equal(t1, t1b, 'deterministic for same (nft, tokenId, chain)');
  assert.notEqual(t1, t2, 'different tokenId → different TBA');
  // chain matters
  const t1mainnet = computeTbaAddress({ tokenContract: nft, tokenId: 1, chainId: 8453 });
  assert.notEqual(t1, t1mainnet, 'different chain → different TBA');
  assert.equal(ERC6551_REGISTRY, '0x000000006551c19487814612e58FE06813775758');

  // --- TbaAgentWallet identity + signing delegation ---
  const owner = new EoaAgentWallet(MNEMONIC, 'npc:jiu-jianxian'); // the controlling EOA
  const tba = new TbaAgentWallet({ tokenContract: nft, tokenId: 3, chainId: 84532, controller: owner });
  assert.ok(isAddress(tba.address), 'TBA wallet exposes a valid address');
  assert.equal(tba.address, computeTbaAddress({ tokenContract: nft, tokenId: 3, chainId: 84532 }), 'wallet address == computed TBA');
  assert.notEqual(tba.address.toLowerCase(), owner.address.toLowerCase(), 'TBA != controller EOA');

  // balanceGcc null when no rpc/token wired
  assert.equal(await tba.balanceGcc(), null, 'balanceGcc null without rpc');

  // signing delegates to controller (TBA validates via EIP-1271)
  const payload = {
    domain: { name: 'x', version: '1', chainId: 84532 },
    types: { Foo: [{ name: 'a', type: 'uint256' }] },
    primaryType: 'Foo',
    message: { a: 1n }
  };
  const sig = await tba.signTypedData(payload as any);
  const ownerSig = await owner.signTypedData(payload as any);
  assert.equal(sig, ownerSig, 'TBA signing delegates to the controller EOA');

  // no controller → clear error
  const tbaNoCtrl = new TbaAgentWallet({ tokenContract: nft, tokenId: 4, chainId: 84532 });
  await assert.rejects(() => tbaNoCtrl.signTypedData(payload as any), /no controller/, 'throws without controller');

  console.log(`✓ TBA addr matches live registry; deterministic; per-token/chain unique; wallet delegates signing`);
  console.log('\nALL TBA SMOKE TESTS PASSED ✅');
}

main().catch((err) => { console.error('TBA SMOKE TEST FAILED ❌', err); process.exit(1); });
