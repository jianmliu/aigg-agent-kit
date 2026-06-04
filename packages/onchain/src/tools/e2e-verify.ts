/**
 * e2e-verify — drive the full production payment path end to end:
 *
 *   wallet-svc /sign/eip3009  (scoped, key in service/TEE)  →  signed x402 payload
 *      →  facilitator /verify  (or /settle with SETTLE=1)
 *
 * Same wire as RemoteEip3009Settlement, but transparent (prints the payload) and
 * with actionable hints on failure. verify is read-only (no chain tx); SETTLE=1
 * broadcasts a real Base tx and spends real GCC + ETH gas.
 *
 * Env (URLs default to localhost so you can `ssh -L` tunnel node1/node2):
 *   WALLET_SVC_URL        default http://localhost:8091   (node1 wallet-svc)
 *   WALLET_SVC_TOKEN      required (node1 /opt/sub2api-staging .env WALLET_AUTH_TOKEN)
 *   FACILITATOR_URL       default http://localhost:18081  (node2 facilitator)
 *   FACILITATOR_TOKEN     required (FACILITATOR_AUTH_TOKEN)
 *   NPC_ID                default npc:jiu-jianxian
 *   GCC_COST              display GCC for the call, default 0.0003
 *   DECIMALS              default 18
 *   SETTLE                "1" → real on-chain settle (default: verify only)
 *
 * Tunnels (run on a box that can't reach node1/node2 directly):
 *   ssh -fN -L 8091:localhost:8091  ubuntu@<node1>
 *   ssh -fN -L 18081:localhost:18081 ubuntu@<node2>
 *
 * Run: pnpm --filter @onchainpal/onchain e2e:verify
 */
import { AiggWalletClient, type KeySelector } from '../aigg-wallet-client';
import { AiggFacilitatorClient } from '../aigg-facilitator-client';
import { InMemoryNpcIndexRegistry, npcSelector } from '../npc-index-registry';

function need(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[e2e-verify] missing env ${name}`);
    process.exit(2);
  }
  return v.trim();
}
function envOr(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

async function main() {
  const walletUrl = envOr('WALLET_SVC_URL', 'http://localhost:8091');
  const facUrl = envOr('FACILITATOR_URL', 'http://localhost:18081');
  const npcId = envOr('NPC_ID', 'npc:jiu-jianxian');
  const gccCost = Number(envOr('GCC_COST', '0.0003'));
  const decimals = Number(envOr('DECIMALS', '18'));
  const doSettle = process.env.SETTLE === '1';
  const value = BigInt(Math.round(gccCost * 10 ** decimals));

  const wallet = new AiggWalletClient({ baseUrl: walletUrl, authToken: need('WALLET_SVC_TOKEN') });
  const facilitator = new AiggFacilitatorClient({ baseUrl: facUrl, authToken: need('FACILITATOR_TOKEN') });

  // Structured one-owner-many-agents selector when AIGG_OWNER_ID is set:
  // owner = onchainpal's aigg-src userID, agent = a stable per-NPC index.
  // Falls back to the legacy npcId-string (keccak subject) selector otherwise.
  const ownerId = Number(envOr('AIGG_OWNER_ID', '0'));
  const registry = new InMemoryNpcIndexRegistry();
  const selector: KeySelector = ownerId >= 1 ? npcSelector(ownerId, registry, npcId) : npcId;

  console.log(`wallet-svc : ${walletUrl}`);
  console.log(`facilitator: ${facUrl}`);
  console.log(
    `NPC=${npcId}  selector=${JSON.stringify(selector)}  value=${value} atoms (${gccCost} GCC)  mode=${doSettle ? 'SETTLE (on-chain!)' : 'verify-only'}\n`
  );

  // 1) scoped sign via wallet-svc (the service builds the typed data + signs)
  const signed = await wallet.signEip3009(selector, { value });
  console.log(`NPC EOA   : ${signed.address}`);
  console.log(`x402 payload:\n${JSON.stringify(signed.payload, null, 2)}\n`);

  // 2) verify (or settle) at the facilitator
  const req = { paymentPayload: signed.payload, paymentRequirements: signed.requirements };
  if (doSettle) {
    const s = await facilitator.settle(req);
    console.log('settle:', JSON.stringify(s));
    if (s.success) console.log(`\n✅ SETTLED on-chain — tx ${s.transaction}`);
    else { console.log(`\n❌ settle failed: ${s.errorReason ?? 'unknown'}`); process.exit(1); }
    return;
  }
  let v;
  try {
    v = await facilitator.verify(req);
  } catch (err) {
    handleFailure(String(err), signed);
    process.exit(1);
  }
  if (v.isValid) {
    console.log(`\n✅ VERIFY passed — wallet-svc signature accepted, on-chain simulation OK. payer=${v.payer ?? signed.address}`);
    console.log('   (set SETTLE=1 to broadcast the real settlement.)');
  } else {
    handleFailure(`isValid:false invalidReason=${v.invalidReason}`, signed);
    process.exit(1);
  }
}

function handleFailure(msg: string, signed: { address: string; requirements: any }) {
  console.log(`\n❌ verify rejected: ${msg}`);
  if (/simulation_failed/i.test(msg)) {
    const asset = signed.requirements?.asset ?? '<GCC>';
    console.log(`\nLikely cause: the NPC EOA has insufficient GCC (the transfer simulation reverts).`);
    console.log(`Mint test GCC to it (GCC owner / deployer key):`);
    console.log(`  cast send ${asset} "mint(address,uint256)" ${signed.address} 1000000000000000000 \\`);
    console.log(`    --rpc-url https://sepolia.base.org --private-key <deployer>`);
  }
}

main().catch((err) => { console.error('e2e-verify failed:', err); process.exit(1); });
