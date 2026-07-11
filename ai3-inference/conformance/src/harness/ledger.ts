/**
 * InferenceLedger client for conformance (extraction plan T9) — the escrow /
 * settlement calls the Phase-B group drives, all legacy type-0 like every
 * other conformance transaction. One class serves both roles: the USER side
 * (deposit / transferTo / refunds) and the PROVIDER side (settle / accrued).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Voucher } from '@ai3-inference/voucher';

export const LEDGER_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function', name: 'transferTo', stateMutability: 'nonpayable',
    inputs: [{ name: 'provider', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'requestRefund', stateMutability: 'nonpayable',
    inputs: [{ name: 'provider', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'withdrawRefund', stateMutability: 'nonpayable',
    inputs: [{ name: 'provider', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'settle', stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'vs', type: 'tuple[]',
        components: [
          { name: 'user', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'nonce', type: 'uint128' },
          { name: 'maxFee', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      { name: 'sigs', type: 'bytes[]' },
      { name: 'fees', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'provider', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'unallocated', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'accrued', stateMutability: 'view', inputs: [{ name: 'provider', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'nonceUsed', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'nonce', type: 'uint128' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'refunds', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'provider', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }, { name: 'releaseAt', type: 'uint64' }],
  },
  { type: 'function', name: 'REFUND_UNLOCK', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  // error defs so viem decodes revert names — the T9 rejection checks assert on them.
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'Insufficient', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'NotVoucherProvider', inputs: [{ type: 'address' }, { type: 'address' }] },
  { type: 'error', name: 'FeeAboveMax', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'VoucherExpired', inputs: [{ type: 'uint64' }, { type: 'uint256' }] },
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'NonceUsed', inputs: [{ type: 'uint128' }] },
  { type: 'error', name: 'RefundLocked', inputs: [{ type: 'uint64' }, { type: 'uint256' }] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [] },
  { type: 'error', name: 'SendFailed', inputs: [] },
] as const;

export const asVoucherTuple = (v: Voucher) =>
  ({ user: v.user, provider: v.provider, nonce: v.nonce, maxFee: v.maxFee, expiry: v.expiry }) as const;

export class LedgerClient {
  readonly address: Address;
  readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly pub: PublicClient;
  private readonly wallet: ReturnType<typeof createWalletClient>;

  constructor(rpcUrl: string, chain: Chain, ledgerAddress: string, key: Hex) {
    this.address = getAddress(ledgerAddress);
    this.account = privateKeyToAccount(key);
    this.pub = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  private async send(functionName: string, args: unknown[], value?: bigint): Promise<{ gasCostWei: bigint; txHash: Hex }> {
    const gasPrice = await this.pub.getGasPrice();
    const hash = await this.wallet.writeContract({
      chain: this.wallet.chain,
      account: this.account,
      address: this.address,
      abi: LEDGER_ABI,
      functionName,
      args,
      value,
      gasPrice, // legacy type-0
      type: 'legacy',
    } as never);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
    return { gasCostWei: rcpt.gasUsed * rcpt.effectiveGasPrice, txHash: hash };
  }

  deposit(amount: bigint) { return this.send('deposit', [], amount); }
  transferTo(provider: Address, amount: bigint) { return this.send('transferTo', [provider, amount]); }
  requestRefund(provider: Address, amount: bigint) { return this.send('requestRefund', [provider, amount]); }
  withdrawRefund(provider: Address) { return this.send('withdrawRefund', [provider]); }

  settle(batch: Array<{ voucher: Voucher; signature: Hex; fee: bigint }>) {
    return this.send('settle', [
      batch.map((b) => asVoucherTuple(b.voucher)),
      batch.map((b) => b.signature),
      batch.map((b) => b.fee),
    ]);
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.address, abi: LEDGER_ABI, functionName, args } as never) as Promise<T>;
  }

  balanceOf(user: Address, provider: Address) { return this.read<bigint>('balanceOf', [user, provider]); }
  unallocated(user: Address) { return this.read<bigint>('unallocated', [user]); }
  accrued(provider: Address) { return this.read<bigint>('accrued', [provider]); }
  nonceUsed(user: Address, provider: Address, nonce: bigint) { return this.read<boolean>('nonceUsed', [user, provider, nonce]); }
  refunds(user: Address, provider: Address) { return this.read<readonly [bigint, bigint]>('refunds', [user, provider]); }
  refundUnlock() { return this.read<bigint>('REFUND_UNLOCK'); }

  walletBalance(): Promise<bigint> { return this.pub.getBalance({ address: this.account.address }); }

  /** latest block timestamp — vouchers must anchor expiry to CHAIN time. */
  async chainNow(): Promise<bigint> {
    return (await this.pub.getBlock()).timestamp;
  }
}

/** dev-chain time travel (anvil & hardhat node both support these). */
export async function increaseChainTime(rpcUrl: string, seconds: bigint): Promise<void> {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
  };
  await call('evm_increaseTime', [Number(seconds)]);
  await call('evm_mine', []);
}
