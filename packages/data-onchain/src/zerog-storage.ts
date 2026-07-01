/**
 * ZeroGStorageClient — 0G Storage data-anchoring. upload(data,name)→rootHash and
 * download(rootHash)→data; the rootHash is 0G's Merkle content-id, so the
 * round-trip is tamper-evident. verify(rootHash) re-derives the content-id from
 * the downloaded bytes and checks it equals the rootHash (the SDK's proof:true
 * download is a no-op in 0g-storage-ts-sdk@1.2.10, so verification is client-side).
 *
 * SERVICE-SIDE: fromConfig holds a signer key and lazy-imports the 0G SDK + ethers.
 */
import type { AutoDriveClient } from '@aigg/npc-agent';
import type { ZeroGTransport } from './transport';

export interface ZeroGConfig {
  indexerRpc: string;
  evmRpc: string;
  privateKey: string;
}

export class ZeroGStorageClient implements AutoDriveClient {
  constructor(private readonly transport: ZeroGTransport) {}

  static async fromConfig(cfg: ZeroGConfig): Promise<ZeroGStorageClient> {
    const sdk: any = await import('@0gfoundation/0g-storage-ts-sdk' as string);
    const { ethers }: any = await import('ethers' as string);
    const provider = new ethers.JsonRpcProvider(cfg.evmRpc);
    const signer = new ethers.Wallet(cfg.privateKey, provider);
    const indexer = new sdk.Indexer(cfg.indexerRpc);
    const merkleRoot = async (bytes: Uint8Array): Promise<string> => {
      const mem = new sdk.MemData(bytes);
      const [tree, treeErr] = await mem.merkleTree();
      if (treeErr) throw treeErr;
      const root = tree?.rootHash?.();
      if (!root) throw new Error('0G Storage: empty merkle root');
      return root as string;
    };
    return new ZeroGStorageClient({
      contentId: merkleRoot,
      async put(bytes: Uint8Array): Promise<string> {
        const mem = new sdk.MemData(bytes);
        const [, treeErr] = await mem.merkleTree();
        if (treeErr) throw treeErr;
        const [tx, err] = await indexer.upload(mem, cfg.evmRpc, signer);
        if (err) throw err;
        return tx.rootHash as string;
      },
      async get(rootHash: string): Promise<Uint8Array> {
        const [blob, err] = await indexer.downloadToBlob(rootHash, { proof: true });
        if (err) throw err;
        return new Uint8Array(await blob.arrayBuffer());
      },
    });
  }

  async upload(data: string, _name: string): Promise<string> {
    return this.transport.put(new TextEncoder().encode(data));
  }

  async download(cid: string): Promise<string> {
    return new TextDecoder().decode(await this.transport.get(cid));
  }

  /** download by rootHash, confirm the bytes hash back to it (tamper-evident); optionally compare to `expected`. */
  async verify(rootHash: string, expected?: string): Promise<{ verified: boolean; data: string }> {
    const bytes = await this.transport.get(rootHash);
    const id = await this.transport.contentId(bytes);
    const data = new TextDecoder().decode(bytes);
    const verified = id === rootHash && (expected === undefined || data === expected);
    return { verified, data };
  }
}
