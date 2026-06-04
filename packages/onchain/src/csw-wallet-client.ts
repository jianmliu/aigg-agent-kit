/**
 * CswWalletClient — TS client for the wallet-svc **Model B** (Coinbase Smart
 * Wallet / passkey) endpoints. Unlike the EIP-3009 path, NO key material is
 * involved: a passkey signs on the USER's device (WebAuthn), and wallet-svc only
 * (a) packages a WebAuthn assertion into the CSW ERC-1271 blob and (b) derives
 * the CSW counterfactual account address + factory calldata.
 *
 *   POST /csw/account  { owners:[{x,y}|{address}], nonce? }
 *        → { factory, ownerBytes[], createAccountCalldata, getAddressCalldata, address? }
 *   POST /csw/erc1271  { authenticatorData, clientDataJSON, signature, ownerIndex? }
 *        → { erc1271, challenge }
 */

/** A passkey owner (P-256 pubkey) or an EOA owner of a Coinbase Smart Wallet. */
export type CswOwner = { x: `0x${string}`; y: `0x${string}` } | { address: `0x${string}` };

/** A WebAuthn assertion from the authenticator (navigator.credentials.get). */
export interface WebAuthnAssertion {
  authenticatorData: `0x${string}`;
  clientDataJSON: `0x${string}`;
  /** DER-encoded ECDSA P-256 signature from the authenticator. */
  signature: `0x${string}`;
}

export interface CswAccountResult {
  factory: `0x${string}`;
  ownerBytes: `0x${string}`[];
  createAccountCalldata: `0x${string}`;
  getAddressCalldata: `0x${string}`;
  /** counterfactual CSW address; present only if wallet-svc has WALLET_CSW_RPC_URL. */
  address?: `0x${string}`;
}

export interface CswErc1271Result {
  /** the ERC-1271 signature blob the CSW's isValidSignature / Permit2 accepts. */
  erc1271: `0x${string}`;
  /** the WebAuthn challenge decoded from the assertion (confirm == replaySafeHash). */
  challenge: `0x${string}`;
}

export interface CswWalletClientOptions {
  baseUrl: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}

export class CswWalletClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CswWalletClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.authToken;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[CswWalletClient] no fetch available');
    this.fetchImpl = f;
  }

  account(owners: CswOwner[], nonce = 0): Promise<CswAccountResult> {
    return this.post('/csw/account', { owners, nonce }) as Promise<CswAccountResult>;
  }

  erc1271(assertion: WebAuthnAssertion, ownerIndex = 0): Promise<CswErc1271Result> {
    return this.post('/csw/erc1271', { ...assertion, ownerIndex }) as Promise<CswErc1271Result>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`wallet-svc ${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}
