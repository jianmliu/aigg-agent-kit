/**
 * stub-gateway (extraction plan T7) — a minimal provider gateway that signs
 * every response with a test enclave key, Phase-A style, over exactly the
 * bytes it sends:
 *
 *   digest = keccak(reqHash ‖ respHash ‖ model ‖ be64(inTok) ‖ be64(outTok))
 *   signature = EIP-191(digest) by the enclave key
 *
 * Two response paths, mirroring the real gateway (aigg-src):
 *   • buffered JSON (POST /chat/completions): attestation as LEADING headers
 *     (a Content-Length response would drop trailers — the gateway's known
 *     non-streamed limitation, avoided here the same way);
 *   • SSE (body {"stream":true}): chunked event stream; signer + response-id
 *     lead, signature + metered fields arrive as HTTP TRAILERS after the
 *     body — the transport the Go gateway uses for streamed responses.
 *
 * Token counts are deterministic functions of the request/response sizes so a
 * grader can replay a call and get identical metering.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { keccak256, hexToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { computeResponseDigest } from '@ai3-inference/core';
import { ATTEST_HEADERS } from '@ai3-inference/verify';

export interface StubGateway {
  endpoint: string; // base URL; serves POST /chat/completions
  enclaveAddress: Address;
  /** uncompressed pubkey minus the 0x04 prefix — what report_data binds. */
  enclavePubkey: Uint8Array;
  stop(): Promise<void>;
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

/** deterministic metering: ~4 bytes per token, never zero. */
export const meterTokens = (byteLen: number) => Math.floor(byteLen / 4) + 1;

async function signFields(
  account: PrivateKeyAccount,
  fields: { requestHash: Hex; responseHash: Hex; model: string; inputTokens: number; outputTokens: number },
): Promise<Hex> {
  return account.signMessage({ message: { raw: computeResponseDigest(fields) } });
}

export async function startStubGateway(opts: { enclaveKey: Hex }): Promise<StubGateway> {
  const account = privateKeyToAccount(opts.enclaveKey);
  const enclavePubkey = hexToBytes(account.publicKey).slice(1);

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const rawReq = Buffer.concat(chunks);
        const requestHash = keccak256(new Uint8Array(rawReq));
        let body: any = {};
        try {
          body = JSON.parse(rawReq.toString('utf8'));
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        const model: string = body.model ?? 'conformance-model';
        const lastUser = Array.isArray(body.messages)
          ? [...body.messages].reverse().find((m: any) => m?.role === 'user')?.content ?? ''
          : '';
        const content = `stub-gateway echo: ${String(lastUser).slice(0, 64)}`;
        const inputTokens = meterTokens(rawReq.length);
        const outputTokens = meterTokens(content.length);
        const responseId = randomUUID();

        if (body.stream === true) {
          // ── SSE + HTTP trailers ────────────────────────────────────────────
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Trailer: [
              ATTEST_HEADERS.signature,
              ATTEST_HEADERS.payloadHash,
              ATTEST_HEADERS.model,
              ATTEST_HEADERS.inputTokens,
              ATTEST_HEADERS.outputTokens,
              ATTEST_HEADERS.verification,
            ].join(', '),
            [ATTEST_HEADERS.signer]: account.address,
            [ATTEST_HEADERS.responseId]: responseId,
          });
          const bodyParts: Uint8Array[] = [];
          const send = (s: string) => {
            const b = utf8(s);
            bodyParts.push(b);
            res.write(b);
          };
          for (const piece of [content.slice(0, 10), content.slice(10)]) {
            send(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          send(`data: ${JSON.stringify({ usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}\n\n`);
          send('data: [DONE]\n\n');
          const streamed = new Uint8Array(Buffer.concat(bodyParts.map((b) => Buffer.from(b))));
          const responseHash = keccak256(streamed);
          const signature = await signFields(account, { requestHash, responseHash, model, inputTokens, outputTokens });
          res.addTrailers({
            [ATTEST_HEADERS.signature]: signature,
            [ATTEST_HEADERS.payloadHash]: responseHash,
            [ATTEST_HEADERS.model]: model,
            [ATTEST_HEADERS.inputTokens]: String(inputTokens),
            [ATTEST_HEADERS.outputTokens]: String(outputTokens),
            [ATTEST_HEADERS.verification]: `dstack:verified:${responseId}`,
          });
          res.end();
          return;
        }

        // ── buffered JSON + leading headers ──────────────────────────────────
        const respBody = JSON.stringify({
          id: responseId,
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
        });
        const responseHash = keccak256(utf8(respBody));
        const signature = await signFields(account, { requestHash, responseHash, model, inputTokens, outputTokens });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          [ATTEST_HEADERS.signer]: account.address,
          [ATTEST_HEADERS.responseId]: responseId,
          [ATTEST_HEADERS.signature]: signature,
          [ATTEST_HEADERS.payloadHash]: responseHash,
          [ATTEST_HEADERS.model]: model,
          [ATTEST_HEADERS.inputTokens]: String(inputTokens),
          [ATTEST_HEADERS.outputTokens]: String(outputTokens),
          [ATTEST_HEADERS.verification]: `dstack:verified:${responseId}`,
        });
        res.end(respBody);
      })().catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub-gateway: no address');
  return {
    endpoint: `http://127.0.0.1:${addr.port}`,
    enclaveAddress: account.address,
    enclavePubkey,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
