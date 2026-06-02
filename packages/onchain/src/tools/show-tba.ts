/**
 * show-tba — for a deployed OnchainPalNPC contract, print each hero NPC's
 * ERC-6551 TBA address + live GCC balance (Base Sepolia by default). Read-only.
 *
 * Env:
 *   NFT_ADDRESS   the deployed OnchainPalNPC address (required)
 *   GCC_TOKEN     GCC ERC-20 (default Sepolia 0x628626…d717)
 *   CHAIN_ID      default 84532
 *   RPC_URL       default https://sepolia.base.org
 *   TOKEN_IDS     comma list, default "1,2,3"
 *   NPC_IDS       comma list aligned to TOKEN_IDS, default "npc:azhu,npc:li-daniang,npc:jiu-jianxian"
 *
 * Run:
 *   NFT_ADDRESS=0x... pnpm --filter @onchainpal/game-engine show:tba
 */
import { formatUnits } from 'viem';
import { computeTbaAddress } from '../tba';
import { TbaAgentWallet } from '../tba-agent-wallet';

function need(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`[show-tba] missing env ${name}`); process.exit(2); }
  return v;
}

async function main() {
  const nft = need('NFT_ADDRESS') as `0x${string}`;
  const gccToken = (process.env.GCC_TOKEN || '0x628626de13dd4b5b1cb80d468c261c15df00d717') as `0x${string}`;
  const chainId = Number(process.env.CHAIN_ID || 84532);
  const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
  const tokenIds = (process.env.TOKEN_IDS || '1,2,3').split(',').map((s) => s.trim());
  const npcIds = (process.env.NPC_IDS || 'npc:azhu,npc:li-daniang,npc:jiu-jianxian').split(',').map((s) => s.trim());

  console.log(`NFT contract : ${nft}`);
  console.log(`GCC token    : ${gccToken}`);
  console.log(`chain / rpc  : ${chainId} / ${rpcUrl}\n`);

  for (let i = 0; i < tokenIds.length; i++) {
    const tokenId = tokenIds[i];
    const npcId = npcIds[i] ?? `token#${tokenId}`;
    const addr = computeTbaAddress({ tokenContract: nft, tokenId, chainId });
    const wallet = new TbaAgentWallet({ tokenContract: nft, tokenId, chainId, gccToken, rpcUrl });
    let bal: bigint | null = null;
    try { bal = await wallet.balanceGcc(); } catch (e) { /* unreachable rpc */ }
    const balStr = bal === null ? '(rpc error)' : `${formatUnits(bal, 18)} GCC`;
    console.log(`#${tokenId}  ${npcId}`);
    console.log(`     TBA: ${addr}`);
    console.log(`     bal: ${balStr}`);
    console.log(`     donate GCC by sending to the TBA address above.\n`);
  }
}

main().catch((err) => { console.error('show-tba failed:', err); process.exit(1); });
