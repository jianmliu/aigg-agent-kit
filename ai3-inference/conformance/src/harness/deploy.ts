/**
 * Contract deployment for the hermetic run (extraction plan T7) — deploys
 * ServiceRegistry(bondWei) + InferenceLedger from the contracts package's
 * compiled artifacts, using legacy type-0 transactions exactly like the
 * production deploy script (Auto EVM rejects EIP-1559 fields).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ARTIFACTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'contracts', 'artifacts', 'src', 'market',
);

export interface Deployment {
  chain: Chain;
  serviceRegistry: Address;
  inferenceLedger: Address;
  bondWei: bigint;
}

function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = join(ARTIFACTS, `${name}.sol`, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `missing artifact ${path} — run \`pnpm --filter @ai3-inference/contracts build\` first`,
    );
  }
  const j = JSON.parse(raw) as { abi: Abi; bytecode: Hex };
  return { abi: j.abi, bytecode: j.bytecode };
}

export const SERVICE_REGISTRY_ARTIFACT = () => loadArtifact('ServiceRegistry');
export const INFERENCE_LEDGER_ARTIFACT = () => loadArtifact('InferenceLedger');

/** a viem Chain for an arbitrary local/dev RPC (id fetched live). */
export async function chainFor(rpcUrl: string): Promise<Chain> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const id = await probe.getChainId();
  return defineChain({
    id,
    name: `conformance-${id}`,
    nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** deployMarket — both contracts, legacy txs, funded by `deployerKey`. */
export async function deployMarket(
  rpcUrl: string,
  deployerKey: Hex,
  bond: string = '0.1',
): Promise<Deployment> {
  const chain = await chainFor(rpcUrl);
  const account = privateKeyToAccount(deployerKey);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const gasPrice = await pub.getGasPrice();
  const bondWei = parseEther(bond);

  const deployOne = async (name: 'ServiceRegistry' | 'InferenceLedger', args: unknown[]) => {
    const art = loadArtifact(name);
    const hash = await wallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode,
      args,
      gasPrice, // explicit gasPrice → legacy type-0
      type: 'legacy',
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (!rcpt.contractAddress) throw new Error(`${name} deploy produced no address`);
    return rcpt.contractAddress;
  };

  const serviceRegistry = await deployOne('ServiceRegistry', [bondWei]);
  const inferenceLedger = await deployOne('InferenceLedger', []);
  return { chain, serviceRegistry, inferenceLedger, bondWei };
}
