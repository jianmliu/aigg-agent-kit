/**
 * RemoteAgentWallet — an AgentWallet whose key lives in the Go wallet-svc, not
 * here. `address` is fetched once from /address; `signTypedData` delegates to
 * /sign. This is the PRODUCTION-shaped signer (keys in TEE, off the TS process),
 * a drop-in for the same AgentWallet seam used by X402GccEip3009Settlement —
 * EoaAgentWallet (mnemonic-in-process) stays the dev/local variant.
 *
 * Construct via the async factory `create()` because the address must be fetched.
 */
import type { AgentWallet, TypedDataPayload } from '@onchainpal/npc-agent';
import { AiggWalletClient } from './aigg-wallet-client';

export interface RemoteAgentWalletOptions {
  client: AiggWalletClient;
  /** subject = npcId / user id passed to wallet-svc derivation. */
  subject: string;
}

export class RemoteAgentWallet implements AgentWallet {
  readonly address: `0x${string}`;
  private readonly client: AiggWalletClient;
  private readonly subject: string;

  private constructor(address: `0x${string}`, client: AiggWalletClient, subject: string) {
    this.address = address;
    this.client = client;
    this.subject = subject;
  }

  /** Fetch the subject's address from wallet-svc and build the wallet. */
  static async create(opts: RemoteAgentWalletOptions): Promise<RemoteAgentWallet> {
    const { address } = await opts.client.address(opts.subject);
    return new RemoteAgentWallet(address, opts.client, opts.subject);
  }

  /** The agent EOA holds no funds in the scoped model (the funding EOA / TBA does). */
  async balanceGcc(): Promise<bigint | null> {
    return null;
  }

  async signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    const { signature } = await this.client.sign(this.subject, payload);
    return signature;
  }
}
