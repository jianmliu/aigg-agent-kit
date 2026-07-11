/**
 * Local chain bootstrap (extraction plan T7) — starts a throwaway EVM node for
 * the hermetic conformance run. Prefers `anvil` (fast) when it is on PATH and
 * falls back to the contracts package's `hardhat node`; both serve the same
 * well-known dev mnemonic, so the funded test keys are identical either way.
 * Every conformance transaction is sent legacy type-0 (Auto EVM requirement),
 * which both nodes accept.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** dev accounts of the standard test mnemonic (anvil & hardhat node share it). */
export const DEV_KEYS = {
  /** account #0 — deployer */
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  /** account #1 — provider EOA (registry writes) */
  provider: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  /** account #2 — a second provider for negative/lifecycle cases */
  provider2: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  /** account #4 — the voucher-gated (Phase B) provider EOA */
  voucherProvider: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  /** account #6 — the paying user of the Phase-B group */
  user: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
} as const;

export interface LocalChain {
  rpcUrl: string;
  kind: 'anvil' | 'hardhat';
  stop(): Promise<void>;
}

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function hasAnvil(): boolean {
  try {
    return spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

async function waitForRpc(rpcUrl: string, child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chain process exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string };
        if (body.result) return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`chain RPC not ready after ${timeoutMs}ms: ${lastErr}`);
}

/** startLocalChain — anvil if available, else `hardhat node` from contracts/. */
export async function startLocalChain(): Promise<LocalChain> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const useAnvil = hasAnvil();
  const child = useAnvil
    ? spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
    : spawn('npx', ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: CONTRACTS_DIR,
        stdio: 'ignore',
      });
  try {
    await waitForRpc(rpcUrl, child);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }
  return {
    rpcUrl,
    kind: useAnvil ? 'anvil' : 'hardhat',
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      }),
  };
}
