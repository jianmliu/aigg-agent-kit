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
import { AiggWalletClient, type KeySelector } from './aigg-wallet-client';

export interface RemoteAgentWalletOptions {
  client: AiggWalletClient;
  /**
   * Derivation selector passed to wallet-svc. Prefer the structured
   * `{ owner: aiggUserId, agent: npcIndex }` (one-owner-many-agents model); a
   * bare npcId string still works via the legacy keccak scheme.
   */
  selector: KeySelector;
}

export class RemoteAgentWallet implements AgentWallet {
  readonly address: `0x${string}`;
  private readonly client: AiggWalletClient;
  private readonly selector: KeySelector;

  private constructor(address: `0x${string}`, client: AiggWalletClient, selector: KeySelector) {
    this.address = address;
    this.client = client;
    this.selector = selector;
  }

  /** Fetch the selector's address from wallet-svc and build the wallet. */
  static async create(opts: RemoteAgentWalletOptions): Promise<RemoteAgentWallet> {
    const { address } = await opts.client.address(opts.selector);
    return new RemoteAgentWallet(address, opts.client, opts.selector);
  }

  /** The agent EOA holds no funds in the scoped model (the funding EOA / TBA does). */
  async balanceGcc(): Promise<bigint | null> {
    return null;
  }

  async signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    const { signature } = await this.client.sign(this.selector, payload);
    return signature;
  }
}
