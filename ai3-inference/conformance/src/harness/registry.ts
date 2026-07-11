/**
 * ServiceRegistry client helpers for conformance (extraction plan T7) —
 * write-side ABI + a tiny wrapper for register/update/deactivate with legacy
 * type-0 transactions (Auto EVM requirement). Read-side listing reuses
 * @ai3-inference/broker's ViemRegistryReader.
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

export const SERVICE_TUPLE = [
  { name: 'endpoint', type: 'string' },
  { name: 'models', type: 'string[]' },
  { name: 'inputPriceWei', type: 'uint256' },
  { name: 'outputPriceWei', type: 'uint256' },
  { name: 'attestationRef', type: 'bytes32' },
  { name: 'attestedSigner', type: 'address' },
  { name: 'verifiability', type: 'string' },
  { name: 'updatedAt', type: 'uint64' },
  { name: 'active', type: 'bool' },
] as const;

const REGISTER_INPUTS = [
  { name: 'endpoint', type: 'string' },
  { name: 'models', type: 'string[]' },
  { name: 'inputPriceWei', type: 'uint256' },
  { name: 'outputPriceWei', type: 'uint256' },
  { name: 'attestationRef', type: 'bytes32' },
  { name: 'attestedSigner', type: 'address' },
  { name: 'verifiability', type: 'string' },
] as const;

export const REGISTRY_ABI = [
  { type: 'function', name: 'register', stateMutability: 'payable', inputs: REGISTER_INPUTS, outputs: [] },
  { type: 'function', name: 'update', stateMutability: 'nonpayable', inputs: REGISTER_INPUTS, outputs: [] },
  { type: 'function', name: 'deactivate', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'bondWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'providerCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getService',
    stateMutability: 'view',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [{ name: 's', type: 'tuple', components: SERVICE_TUPLE }],
  },
  {
    type: 'function',
    name: 'list',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      { name: 'addrs', type: 'address[]' },
      { name: 'svcs', type: 'tuple[]', components: SERVICE_TUPLE },
    ],
  },
] as const;

export interface ServiceFields {
  endpoint: string;
  models: string[];
  inputPriceWei: bigint;
  outputPriceWei: bigint;
  attestationRef: Hex;
  attestedSigner: Address;
  verifiability: string;
}

/** RegistryWriter — provider-side calls, all legacy type-0. */
export class RegistryWriter {
  readonly address: Address;
  readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly pub: PublicClient;
  private readonly wallet: ReturnType<typeof createWalletClient>;

  constructor(rpcUrl: string, chain: Chain, registryAddress: string, providerKey: Hex) {
    this.address = getAddress(registryAddress);
    this.account = privateKeyToAccount(providerKey);
    this.pub = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  get providerAddress(): Address {
    return this.account.address;
  }

  balance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.account.address });
  }

  bondWei(): Promise<bigint> {
    return this.pub.readContract({ address: this.address, abi: REGISTRY_ABI, functionName: 'bondWei' }) as Promise<bigint>;
  }

  async getService(provider: Address): Promise<{ active: boolean; endpoint: string; verifiability: string }> {
    const s = (await this.pub.readContract({
      address: this.address,
      abi: REGISTRY_ABI,
      functionName: 'getService',
      args: [provider],
    })) as { active: boolean; endpoint: string; verifiability: string };
    return s;
  }

  /** send a state-changing call; returns {gasCostWei} for exact balance math. */
  private async send(
    functionName: 'register' | 'update' | 'deactivate',
    args: unknown[],
    value?: bigint,
  ): Promise<{ gasCostWei: bigint }> {
    const gasPrice = await this.pub.getGasPrice();
    // cast: `value` is only typed on the payable overload, but this helper
    // serves register (payable) and update/deactivate (nonpayable) alike.
    const hash = await this.wallet.writeContract({
      chain: this.wallet.chain,
      account: this.account,
      address: this.address,
      abi: REGISTRY_ABI,
      functionName,
      args,
      value,
      gasPrice, // explicit gasPrice → legacy type-0
      type: 'legacy',
    } as never);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
    return { gasCostWei: rcpt.gasUsed * rcpt.effectiveGasPrice };
  }

  register(s: ServiceFields, bond: bigint) {
    return this.send(
      'register',
      [s.endpoint, s.models, s.inputPriceWei, s.outputPriceWei, s.attestationRef, s.attestedSigner, s.verifiability],
      bond,
    );
  }

  update(s: ServiceFields) {
    return this.send('update', [
      s.endpoint, s.models, s.inputPriceWei, s.outputPriceWei, s.attestationRef, s.attestedSigner, s.verifiability,
    ]);
  }

  deactivate() {
    return this.send('deactivate', []);
  }
}
