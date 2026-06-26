/**
 * CswAgentWallet — an AgentWallet backed by a passkey-owned Coinbase Smart Wallet
 * (aigg-wallet Model B). This is the spec's P3 path: truly non-custodial — the
 * passkey lives on the user's device (WebAuthn), wallet-svc holds no key.
 *
 *   address       = CSW counterfactual address (derived from the passkey pubkey)
 *   signTypedData = passkey signs the challenge on-device → wallet-svc packages
 *                   the WebAuthn assertion into the CSW ERC-1271 blob (the
 *                   "signature" Permit2 / the facilitator accepts; ERC-6492 for
 *                   an undeployed CSW is handled facilitator-side).
 *
 * The passkey signer is INJECTED (`PasskeySigner`): in the browser it wraps
 * navigator.credentials.get; in tests it's a synthetic assertion. So this class
 * is environment-agnostic and headless-testable.
 *
 * OPEN (flagged to AIGG): the WebAuthn challenge a CSW expects is
 * `replaySafeHash(digest)` (CSW EIP-712 envelope), not the raw EIP-712 digest.
 * `deriveChallenge` defaults to the raw typed-data hash; override it (or have
 * wallet-svc expose a challenge endpoint) once the replay-safe wrapping is wired.
 */
import { hashTypedData } from 'viem';
import type { AgentWallet, TypedDataPayload } from '@aigg/npc-agent';
import { CswWalletClient, type CswOwner, type WebAuthnAssertion } from './csw-wallet-client';

/** Signs a challenge with the user's passkey (browser WebAuthn) → assertion. */
export type PasskeySigner = (challenge: `0x${string}`) => Promise<WebAuthnAssertion>;

export interface CswAgentWalletOptions {
  client: CswWalletClient;
  /** the passkey (and/or EOA) owners of this NPC's CSW. */
  owners: CswOwner[];
  passkeySign: PasskeySigner;
  nonce?: number;
  ownerIndex?: number;
  /** override how the WebAuthn challenge is derived from the EIP-712 payload. */
  deriveChallenge?: (payload: TypedDataPayload) => `0x${string}`;
}

export class CswAgentWallet implements AgentWallet {
  readonly address: `0x${string}`;
  private readonly client: CswWalletClient;
  private readonly passkeySign: PasskeySigner;
  private readonly ownerIndex: number;
  private readonly deriveChallenge: (p: TypedDataPayload) => `0x${string}`;

  private constructor(address: `0x${string}`, opts: CswAgentWalletOptions) {
    this.address = address;
    this.client = opts.client;
    this.passkeySign = opts.passkeySign;
    this.ownerIndex = opts.ownerIndex ?? 0;
    this.deriveChallenge =
      opts.deriveChallenge ?? ((p) => hashTypedData({ domain: p.domain as any, types: p.types as any, primaryType: p.primaryType as any, message: p.message as any }));
  }

  /** Resolve the CSW counterfactual address from /csw/account, then build. */
  static async create(opts: CswAgentWalletOptions): Promise<CswAgentWallet> {
    const acct = await opts.client.account(opts.owners, opts.nonce ?? 0);
    if (!acct.address) {
      throw new Error('[CswAgentWallet] wallet-svc returned no CSW address (set WALLET_CSW_RPC_URL on wallet-svc)');
    }
    return new CswAgentWallet(acct.address, opts);
  }

  /** CSW holds no funds here by default; read balance off-chain if needed. */
  async balanceGcc(): Promise<bigint | null> {
    return null;
  }

  async signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    const challenge = this.deriveChallenge(payload);
    const assertion = await this.passkeySign(challenge);
    const { erc1271 } = await this.client.erc1271(assertion, this.ownerIndex);
    return erc1271;
  }
}
