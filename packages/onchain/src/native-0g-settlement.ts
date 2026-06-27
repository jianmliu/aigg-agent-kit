/**
 * Native0gSettlementLayer — settles in-game NPC balances to REAL native coin
 * (e.g. $0G on 0G Chain) in per-NPC derived EOAs. Conforms structurally to the
 * engine's SettlementLayer seam (deposit/withdraw/balanceOf/anchor) but for the
 * native coin of any EVM chain, via an injectable NativeChain port.
 *
 * SERVICE-SIDE ONLY: holds the master mnemonic + (via the chain port) the
 * treasury signer. Never import into a browser bundle.
 */
import { parseEther } from 'viem';
import { deriveNpcAgentAccount } from './agent-eoa';

/** Injectable chain port — production = ViemNativeChain; tests = FakeNativeChain. */
export interface NativeChain {
  getBalanceWei(address: `0x${string}`): Promise<bigint>;
  estimateGasCostWei(): Promise<bigint>;
  sendNative(from: 'treasury' | string, to: `0x${string}`, valueWei: bigint): Promise<`0x${string}`>;
}

export interface Native0gSettlementOptions {
  chain: NativeChain;
  npcMnemonic: string;
  treasuryAddress: `0x${string}`;
  weiPerUnit?: bigint;
  gasReserveWei?: bigint;
  dustUnits?: number;
}

export interface SettleTx {
  npcId: string;
  address: `0x${string}`;
  direction: 'deposit' | 'withdraw';
  units: number;
  txHash: `0x${string}`;
}

const clampMin0 = (x: bigint) => (x > 0n ? x : 0n);

export class Native0gSettlementLayer {
  private readonly chain: NativeChain;
  private readonly mnemonic: string;
  private readonly treasury: `0x${string}`;
  private readonly weiPerUnit: bigint;
  private readonly gasReserveWei: bigint;
  private readonly dustUnits: number;

  constructor(opts: Native0gSettlementOptions) {
    this.chain = opts.chain;
    this.mnemonic = opts.npcMnemonic;
    this.treasury = opts.treasuryAddress;
    this.weiPerUnit = opts.weiPerUnit ?? parseEther('0.01');
    this.gasReserveWei = opts.gasReserveWei ?? parseEther('0.001');
    this.dustUnits = opts.dustUnits ?? 1e-6;
  }

  addressOf(npcId: string): `0x${string}` {
    return deriveNpcAgentAccount(this.mnemonic, npcId).address as `0x${string}`;
  }

  private unitsToWei(units: number): bigint {
    const u = Math.max(0, units);
    const scaled = BigInt(Math.round(u * 1e9));
    return (scaled * this.weiPerUnit) / 1_000_000_000n;
  }
  private weiToUnits(wei: bigint): number {
    return Number((wei * 1_000_000_000n) / this.weiPerUnit) / 1e9;
  }

  async balanceOf(npcId: string): Promise<number | null> {
    const raw = await this.chain.getBalanceWei(this.addressOf(npcId));
    return this.weiToUnits(clampMin0(raw - this.gasReserveWei));
  }

  private async depositTx(npcId: string, units: number): Promise<`0x${string}` | null> {
    if (units <= 0) return null;
    const addr = this.addressOf(npcId);
    const raw = await this.chain.getBalanceWei(addr);
    let send = this.unitsToWei(units);
    if (raw < this.gasReserveWei) send += this.gasReserveWei - raw;
    if (send <= 0n) return null;
    return this.chain.sendNative('treasury', addr, send);
  }
  /** NPC → treasury. The NPC pays gas OUT OF the withdrawn amount, so its reported
   *  balance nets to exactly `target` (reserve stays a stable buffer; reconcile converges).
   *  Returns the tx hash (or null if the diff is too small to cover its own gas). */
  private async withdrawTx(npcId: string, units: number): Promise<`0x${string}` | null> {
    if (units <= 0) return null;
    const addr = this.addressOf(npcId);
    const raw = await this.chain.getBalanceWei(addr);
    const gas = await this.chain.estimateGasCostWei();
    const want = this.unitsToWei(units);
    const net = want > gas ? want - gas : 0n;          // NPC's own gas comes out of `want`
    const maxSendable = clampMin0(raw - gas);          // can't send more than balance-minus-gas
    const send = net < maxSendable ? net : maxSendable;
    if (send <= 0n) return null;                       // sub-gas diff — can't be settled economically
    return this.chain.sendNative(npcId, this.treasury, send);
  }

  async deposit(npcId: string, units: number): Promise<void> { await this.depositTx(npcId, units); }
  async withdraw(npcId: string, units: number): Promise<{ ok: boolean; reason?: string }> {
    const tx = await this.withdrawTx(npcId, units);
    return tx ? { ok: true } : { ok: false, reason: 'insufficient-gas' };
  }
  async anchor(_stateRoot: string): Promise<void> { /* no-op — anchoring is ⑤ data-on-chain */ }

  async reconcile(npcId: string, targetUnits: number): Promise<SettleTx | null> {
    const current = (await this.balanceOf(npcId)) ?? 0;
    const diff = targetUnits - current;
    if (Math.abs(diff) < this.dustUnits) return null;
    const addr = this.addressOf(npcId);
    if (diff > 0) {
      const txHash = await this.depositTx(npcId, diff);
      return txHash ? { npcId, address: addr, direction: 'deposit', units: diff, txHash } : null;
    }
    const txHash = await this.withdrawTx(npcId, -diff);
    return txHash ? { npcId, address: addr, direction: 'withdraw', units: -diff, txHash } : null;
  }
}

/** In-memory NativeChain for hermetic tests. Models gas as a fixed debit from the sender. */
export class FakeNativeChain implements NativeChain {
  private readonly bal = new Map<string, bigint>();
  private readonly gasCostWei: bigint;
  private readonly signers = new Map<string, `0x${string}`>();
  private nonce = 0;
  treasuryAddr: `0x${string}` = '0x0000000000000000000000000000000000000000';

  constructor(opts: { gasCostWei: bigint }) { this.gasCostWei = opts.gasCostWei; }
  set(addr: string, wei: bigint) { this.bal.set(addr.toLowerCase(), wei); }
  setSigner(npcId: string, address: `0x${string}`) { this.signers.set(npcId, address); }

  async getBalanceWei(address: `0x${string}`): Promise<bigint> { return this.bal.get(address.toLowerCase()) ?? 0n; }
  async estimateGasCostWei(): Promise<bigint> { return this.gasCostWei; }
  async sendNative(from: 'treasury' | string, to: `0x${string}`, valueWei: bigint): Promise<`0x${string}`> {
    const fromAddr = this.resolve(from);
    const fb = this.bal.get(fromAddr.toLowerCase()) ?? 0n;
    const total = valueWei + this.gasCostWei;
    if (fb < total) throw new Error(`FakeNativeChain: insufficient ${fromAddr} has ${fb} needs ${total}`);
    this.bal.set(fromAddr.toLowerCase(), fb - total);
    this.bal.set(to.toLowerCase(), (this.bal.get(to.toLowerCase()) ?? 0n) + valueWei);
    this.nonce += 1;
    return (`0x${this.nonce.toString(16).padStart(64, '0')}`) as `0x${string}`;
  }
  private resolve(from: string): `0x${string}` {
    if (from === 'treasury') return this.treasuryAddr;
    const a = this.signers.get(from);
    if (!a) throw new Error(`FakeNativeChain: no signer for ${from}`);
    return a;
  }
}
