/**
 * donations — zero-dep on-chain indexer for per-NPC GCC donations.
 *
 * Each NPC NFT has an ERC-6551 TBA (its wallet). Anyone can donate GCC by sending
 * the ERC-20 to that TBA address. This module, given the NFT contract + per-NPC
 * tokenId, resolves each TBA via the registry's account() view, reads its GCC
 * balance, and aggregates inbound Transfer logs by donor — all via raw JSON-RPC
 * over fetch (no viem, keeping the proxy dependency-free).
 *
 * Selectors/topics pinned (computed once via viem):
 *   account(address,bytes32,uint256,address,uint256) = 0x246a0021
 *   balanceOf(address)                                = 0x70a08231
 *   Transfer(address,address,uint256) topic0 = 0xddf252ad…523b3ef
 */
const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758';
const TOKENBOUND_ACCOUNT_V3 = '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC';
const ACCOUNT_SELECTOR = '0x246a0021';
const BALANCEOF_SELECTOR = '0x70a08231';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO32 = '0'.repeat(64);

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const pad32 = (hexNo0x) => hexNo0x.padStart(64, '0');
/** left-pad a 20-byte address to a 32-byte word. */
export function addrTo32(addr) { return pad32(strip0x(addr).toLowerCase()); }
/** uint → 32-byte word. */
function uintTo32(n) { return pad32(BigInt(n).toString(16)); }
/** last 20 bytes of a 32-byte word → checksummed-ish lowercase address. */
export function word32ToAddr(word) { const h = strip0x(word); return '0x' + h.slice(-40); }
/** decode a 32-byte hex word as a bigint. */
export function decodeUint(word) { const h = strip0x(word); return h ? BigInt('0x' + h) : 0n; }

/** Make a JSON-RPC caller bound to an rpcUrl (injectable for tests). */
export function makeRpc(rpcUrl, fetchImpl = fetch) {
  let id = 0;
  return async function rpc(method, params) {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  };
}

/** Resolve an NPC's TBA via the on-chain registry account() view. */
export async function computeTba(rpc, { chainId, tokenContract, tokenId, registry = ERC6551_REGISTRY, implementation = TOKENBOUND_ACCOUNT_V3 }) {
  const data = ACCOUNT_SELECTOR
    + addrTo32(implementation) + ZERO32 /* salt */
    + uintTo32(chainId) + addrTo32(tokenContract) + uintTo32(tokenId);
  const result = await rpc('eth_call', [{ to: registry, data }, 'latest']);
  return word32ToAddr(result);
}

/** Read GCC.balanceOf(addr). */
export async function balanceOf(rpc, gccToken, addr) {
  const data = BALANCEOF_SELECTOR + addrTo32(addr);
  const result = await rpc('eth_call', [{ to: gccToken, data }, 'latest']);
  return decodeUint(result);
}

/** Aggregate inbound GCC Transfer logs to `tba` by donor (from). */
export async function donationsTo(rpc, { gccToken, tba, fromBlock = '0x0', toBlock = 'latest' }) {
  const logs = await rpc('eth_getLogs', [{
    address: gccToken,
    fromBlock, toBlock,
    topics: [TRANSFER_TOPIC, null, '0x' + addrTo32(tba)] // to == tba
  }]);
  const byDonor = new Map();
  let total = 0n;
  for (const log of logs || []) {
    const from = word32ToAddr(log.topics[1]);
    const value = decodeUint(log.data);
    byDonor.set(from, (byDonor.get(from) || 0n) + value);
    total += value;
  }
  const donors = [...byDonor.entries()]
    .map(([from, v]) => ({ from, total: v.toString() }))
    .sort((a, b) => (BigInt(b.total) > BigInt(a.total) ? 1 : -1));
  return { total: total.toString(), donors, count: (logs || []).length };
}

const toDisplay = (atoms, decimals = 18) => Number(BigInt(atoms)) / 10 ** decimals;

/**
 * DonationsIndexer — config-driven; serves one NPC's donation view.
 * config: { nftAddress, chainId, gccToken, rpcUrl, npcTokens:{npcId:tokenId},
 *           fromBlock?, registry?, implementation?, fetchImpl? }
 */
export class DonationsIndexer {
  constructor(config) {
    this.cfg = config;
    this.rpc = makeRpc(config.rpcUrl, config.fetchImpl);
    this._tbaCache = new Map();
  }

  configured() { return !!(this.cfg.nftAddress && this.cfg.gccToken && this.cfg.rpcUrl); }

  async tbaFor(npcId) {
    const tokenId = this.cfg.npcTokens?.[npcId];
    if (tokenId == null) return null;
    if (this._tbaCache.has(npcId)) return this._tbaCache.get(npcId);
    const tba = await computeTba(this.rpc, {
      chainId: this.cfg.chainId, tokenContract: this.cfg.nftAddress, tokenId,
      registry: this.cfg.registry, implementation: this.cfg.implementation
    });
    this._tbaCache.set(npcId, tba);
    return tba;
  }

  async view(npcId) {
    const tokenId = this.cfg.npcTokens?.[npcId];
    if (tokenId == null) return { error: 'unknown_npc', npcId };
    const tba = await this.tbaFor(npcId);
    const [balAtoms, agg] = await Promise.all([
      balanceOf(this.rpc, this.cfg.gccToken, tba),
      donationsTo(this.rpc, { gccToken: this.cfg.gccToken, tba, fromBlock: this.cfg.fromBlock })
    ]);
    return {
      npcId, tokenId, tba,
      balanceGcc: toDisplay(balAtoms),
      balanceAtoms: balAtoms.toString(),
      totalDonatedGcc: toDisplay(agg.total),
      donors: agg.donors.slice(0, 10).map((d) => ({ from: d.from, gcc: toDisplay(d.total) })),
      transfers: agg.count
    };
  }
}
