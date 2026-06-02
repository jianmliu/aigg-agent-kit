/**
 * verify-on-facilitator — drive a REAL POST /verify against the AIGG facilitator
 * (node2 sub2api-facilitator). No on-chain tx is sent (verify only validates
 * signature + state). The per-NPC EoaAgentWallet signs a real EIP-3009
 * TransferWithAuthorization over the real Base-mainnet GCC contract.
 *
 * Inputs (env, NEVER on argv — keep them out of shell history / process listings):
 *   AIGG_FACILITATOR_URL   e.g. http://140.143.30.201:18081
 *   AIGG_FACILITATOR_TOKEN the Bearer (in /tmp/facilitator-token.txt — pipe in)
 *   NPC_MNEMONIC           BIP-44 master mnemonic for the per-NPC EOA derivation
 *   GCC_AMOUNT_ATOMS       (optional) GCC value in atoms, default 1 (smallest unit)
 *   NPC_ID                 (optional) which NPC's EOA signs, default npc:jiu-jianxian
 *
 * Constants below are pinned from the AIGG gcc-rebrand-cutover-handoff doc.
 *
 * Run:
 *   AIGG_FACILITATOR_URL=http://140.143.30.201:18081 \
 *   AIGG_FACILITATOR_TOKEN=$(cat /tmp/facilitator-token.txt) \
 *   NPC_MNEMONIC='test test test test test test test test test test test junk' \
 *   pnpm --filter @onchainpal/game-engine verify:facilitator
 */
import { AiggFacilitatorClient } from '../aigg-facilitator-client';
import { EoaAgentWallet } from '../agent-eoa';
import { X402GccEip3009Settlement } from '../x402-gcc-eip3009';

// Defaults: Base Sepolia (chainId 84532) — facilitator currently registered there;
// GCC test deploy 0x628626de13dd4b5b1cb80d468c261c15df00d717 (aigg-cca broadcast
// DeployGCC.s.sol/84532/run-latest.json; verified via RPC on 2026-06-03).
// Mainnet (chainId 8453, GCC 0x135f...7779) is reachable by overriding via env.
const GCC_TOKEN = (process.env.GCC_TOKEN || '0x628626de13dd4b5b1cb80d468c261c15df00d717') as `0x${string}`;
const GCC_NAME = process.env.GCC_NAME || 'Guaranteed Capacity Credit';
const PAY_TO = (process.env.PAY_TO || '0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26') as `0x${string}`;
const CHAIN_ID = Number(process.env.CHAIN_ID || 84532);
const NETWORK = process.env.NETWORK || `eip155:${CHAIN_ID}`;

function need(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[verify-on-facilitator] missing env ${name}`);
    process.exit(2);
  }
  return v.trim();
}

async function main() {
  const url = need('AIGG_FACILITATOR_URL');
  const token = need('AIGG_FACILITATOR_TOKEN');
  const mnemonic = need('NPC_MNEMONIC');
  const npcId = process.env.NPC_ID || 'npc:jiu-jianxian';
  const amountAtoms = BigInt(process.env.GCC_AMOUNT_ATOMS || '1');

  const wallet = new EoaAgentWallet(mnemonic, npcId);
  const client = new AiggFacilitatorClient({ baseUrl: url, authToken: token });

  console.log(`facilitator: ${url}`);
  console.log(`NPC: ${npcId}  EOA: ${wallet.address}`);
  console.log(`amount: ${amountAtoms} GCC-atoms (display: ${Number(amountAtoms) / 1e18})`);

  console.log('\n--- GET /supported ---');
  const cap = await client.supported();
  console.log(JSON.stringify(cap));

  // Build the x402 payload by hand (no GccLedger; we don't have one here).
  // gccCost arg goes through `Math.round(* 1e18)` in the settlement, so pass an
  // already-atomic amount via display-units to avoid drift.
  const displayUnits = Number(amountAtoms) / 1e18;
  const settlement = new X402GccEip3009Settlement({
    config: { gccToken: GCC_TOKEN, gccName: GCC_NAME, chainId: CHAIN_ID, network: NETWORK, payTo: PAY_TO, decimals: 18, maxTimeoutSeconds: 300 },
    walletFor: () => wallet,
    facilitator: client,
    verifyOnly: true
  });
  const built = await settlement.build(npcId, { model: 'verify-dry-run', inputTokens: 0, outputTokens: 0, gccCost: displayUnits });
  console.log('\n--- built x402 wire (pre-verify) ---');
  console.log(JSON.stringify({ paymentRequirements: built.requirements, paymentPayload: built.payload }, null, 2));

  console.log('\n--- POST /verify (no on-chain tx) ---');
  const v = await client.verify({ paymentPayload: built.payload, paymentRequirements: built.requirements });
  console.log(JSON.stringify(v, null, 2));
  if (v.isValid) {
    console.log('\n✅ facilitator accepted the signature + payload. Real /settle would broadcast a Base-mainnet tx.');
  } else {
    console.log(`\n❌ facilitator REJECTED: ${v.invalidReason ?? 'unknown'} — fix the wire and retry.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('verify-on-facilitator failed:', err); process.exit(1); });
