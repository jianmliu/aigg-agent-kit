/**
 * fake-dsn (extraction plan T7) — a minimal content-addressed HTTP blob store
 * standing in for the real DSN gateway in hermetic runs:
 *
 *   POST /            body bytes → stored; responds {"ref":"0x<keccak256>"}
 *   GET  /<hex>       the blob whose keccak256 matches (0x optional) | 404
 *
 * The GET shape matches @ai3-inference/broker's HttpQuoteFetcher default URL
 * layout (`${base}/<refHex-no-0x>`), so the broker consumes it unmodified.
 */
import { createServer, type Server } from 'node:http';
import { keccak256 } from 'viem';

export interface FakeDsn {
  baseUrl: string;
  /** store a blob directly (no HTTP round trip); returns its 0x ref. */
  put(blob: Uint8Array): `0x${string}`;
  stop(): Promise<void>;
}

export async function startFakeDsn(): Promise<FakeDsn> {
  const blobs = new Map<string, Uint8Array>(); // key: hex ref without 0x

  const put = (blob: Uint8Array): `0x${string}` => {
    const ref = keccak256(blob);
    blobs.set(ref.slice(2), blob);
    return ref;
  };

  const server: Server = createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const ref = put(new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ref }));
      });
      return;
    }
    if (req.method === 'GET') {
      const key = (req.url ?? '/').slice(1).replace(/^0x/i, '').toLowerCase();
      const blob = blobs.get(key);
      if (!blob) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(blob));
      return;
    }
    res.writeHead(405).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('fake-dsn: no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    put,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
