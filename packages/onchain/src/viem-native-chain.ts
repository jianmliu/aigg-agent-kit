/**
 * ViemNativeChain — the production NativeChain port for Native0gSettlementLayer.
 * Reads native balances and sends native coin on an EVM chain (0G Chain by
 * default) via viem. Owns the treasury signer + derives per-NPC signers from the
 * master mnemonic. SERVICE-SIDE ONLY (holds keys).
 */
import {
  createPublicClient, createWalletClient, http, type Chain, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { zeroGMainnet, zeroGTestnet } from 'viem/chains';
import { npcAddressIndex } from './agent-eoa';
import type { NativeChain } from './native-0g-settlement';

export interface ViemNativeChainOptions {
  /** 'mainnet' (16661) | 'testnet' (16602). Default mainnet. */
  net?: 'mainnet' | 'testnet';
  /** override RPC url (else the viem chain default). */
  rpcUrl?: string;
  npcMnemonic: string;
  treasuryPrivateKey: `0x${string}`;
}

export class ViemNativeChain implements NativeChain {
  private readonly chain: Chain;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly mnemonic: string;
  private readonly treasuryPk: `0x${string}`;

  constructor(opts: ViemNativeChainOptions) {
    this.chain = (opts.net === 'testnet' ? zeroGTestnet : zeroGMainnet) as Chain;
    const transport = http(opts.rpcUrl); // undefined → viem uses the chain's default rpc
    this.pub = createPublicClient({ chain: this.chain, transport });
    this.wallet = createWalletClient({ chain: this.chain, transport });
    this.mnemonic = opts.npcMnemonic;
    this.treasuryPk = opts.treasuryPrivateKey;
  }

  async getBalanceWei(address: `0x${string}`): Promise<bigint> {
    return this.pub.getBalance({ address });
  }

  async estimateGasCostWei(): Promise<bigint> {
    const fees = await this.pub.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 1_000_000_000n;
    return 21_000n * maxFee;
  }

  async sendNative(from: 'treasury' | string, to: `0x${string}`, valueWei: bigint): Promise<`0x${string}`> {
    const account = from === 'treasury'
      ? privateKeyToAccount(this.treasuryPk)
      : mnemonicToAccount(this.mnemonic, { addressIndex: npcAddressIndex(from) });
    const hash = await this.wallet.sendTransaction({ account, to, value: valueWei, chain: this.chain });
    // Robust receipt wait: a laggy RPC can make viem's waitForTransactionReceipt throw
    // TransactionReceiptNotFoundError transiently even when the tx mines fine (observed on 0G
    // testnet). Poll the receipt directly, tolerating not-found, for up to ~60s.
    for (let i = 0; i < 30; i++) {
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) return hash;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return hash; // submitted but receipt not observed within ~60s — the caller can verify on-chain
  }
}
