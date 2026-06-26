# @aigg/inference-proxy

The server-side hop that lets the **browser** drive GCC-consuming NPC inference
**without ever holding the ai.gg / sub2api credential**.

```
browser  ──POST /api/npc-infer──▶  inference-proxy (holds UPSTREAM_TOKEN, ledger, rate-limit)
                                     └─▶ UPSTREAM /v1/messages (local sub2api / ai.gg) ─▶ Claude, burns GCC
```

Zero deps, zero build — `node server.mjs` (Node 18+ for global `fetch`).

## Donations indexer (B4)

`GET /api/donations/:npcId` resolves each NPC's ERC-6551 **TBA** (via the registry
`account()` view), reads its GCC balance, and aggregates inbound GCC `Transfer`
logs by donor — all over raw JSON-RPC (still zero-dep). Off unless `DONATIONS_NFT`
is set.

```
DONATIONS_NFT=0x<deployed OnchainPalNPC>
DONATIONS_GCC=0x628626de13dd4b5b1cb80d468c261c15df00d717   # Sepolia test GCC (default)
DONATIONS_RPC=https://sepolia.base.org                      # default
DONATIONS_CHAIN=84532                                       # default
DONATIONS_FROM_BLOCK=0x0
DONATIONS_NPC_TOKENS={"npc:azhu":1,"npc:li-daniang":2,"npc:jiu-jianxian":3}
```

Response: `{ npcId, tokenId, tba, balanceGcc, totalDonatedGcc, donors:[{from,gcc}], transfers }`.
A player donates by sending GCC to the `tba` address from their own wallet — the
proxy only reads. Test: `node donations-smoke.mjs` (fake RPC).

## Env
| var | default | note |
|---|---|---|
| `PORT` | `8090` | listen port |
| `UPSTREAM_URL` | `https://www.ai.gg` | the gateway; **production AI.GG (burns real GCC)** is the default. For dev/dry-runs only, point at node1's local TEST sub2api: `http://sub2api:8080` (same Docker network) — **not billed**. |
| `UPSTREAM_TOKEN` | — | ai.gg / sub2api Bearer — **server-side only** |
| `PROXY_SECRET` | — | shared secret the browser must send as `x-proxy-secret` |
| `CORS_ORIGIN` | `*` | set to the game origin in prod |
| `MODEL_DEFAULT` | `claude-opus-4-8` | |
| `MAX_TOKENS` | `1024` | |
| `RATE_PER_MIN` | `60` | per-IP |
| `GCC_PRICING` | `{}` | `{"claude-opus-4-8":{"in":5,"out":25},"default":{"in":1,"out":2}}` (GCC / 1M tokens) |

## Endpoints
- `POST /api/npc-infer` `{ npcId, system?, prompt, model?, maxTokens?, thinking?, output_config? }` → `{ text, usage:{model,inputTokens,outputTokens,gccCost} }`
- `GET /api/ledger` → per-NPC `{ gccSpent, calls, inputTokens, outputTokens, lastAt }`
- `GET /healthz`

## Local test
```bash
pnpm --filter @aigg/inference-proxy smoke   # fake upstream, asserts forward + ledger
```

## AI.GG topology (read this first)

| node | role | use for the proxy upstream? |
|---|---|---|
| **`ai.gg` clawserver `49.51.34.136`** | **production** sub2api gateway — *this is where GCC actually burns* | ✅ **yes** (`UPSTREAM_URL=https://www.ai.gg`) |
| **node1 staging `139.199.105.56`** | **test** sub2api gateway (the `:8080` container we inspected) — *not billed* | dev / dry-runs only (`UPSTREAM_URL=http://sub2api:8080`) |
| node2 `140.143.30.201:18081` | x402 facilitator (real on-chain settlement, post-demo) | not yet |

The proxy itself can run on **either** node1 (test/ops host we can ssh to) or clawserver (production). What burns GCC is the **upstream**, not where the proxy lives.

## Deploy on node1 (the ops host) — upstream = ai.gg production

Add a service to `/opt/sub2api-staging/docker-compose.yml`:
```yaml
  inference-proxy:
    image: onchainpal-inference-proxy:latest
    restart: unless-stopped
    environment:
      UPSTREAM_URL: https://www.ai.gg     # production — burns real GCC
      UPSTREAM_TOKEN: ${AIGG_TOKEN}       # production ai.gg Bearer, in node1's .env
      PROXY_SECRET: ${PROXY_SECRET}
      GCC_PRICING: '{"claude-opus-4-8":{"in":5,"out":25}}'
      CORS_ORIGIN: '*'
    ports:
      - "8090:8090"
```
> Dev/dry-run variant: set `UPSTREAM_URL=http://sub2api:8080` (node1's local **test** sub2api, same Docker network) — talks to the test gateway, not billed.
Build + load the image (old Docker has no buildx; classic build is fine):
```bash
# from this dir, on a machine that can reach node1:
docker build -t onchainpal-inference-proxy:latest .
docker save onchainpal-inference-proxy:latest | gzip > /tmp/inference-proxy.tar.gz
scp -i <sub2api.pem> /tmp/inference-proxy.tar.gz ubuntu@139.199.105.56:~/
ssh -i <sub2api.pem> ubuntu@139.199.105.56 'gunzip -c ~/inference-proxy.tar.gz | sudo docker load'
ssh -i <sub2api.pem> ubuntu@139.199.105.56 'cd /opt/sub2api-staging && sudo docker-compose up -d inference-proxy'
# smoke from the box:
ssh -i <sub2api.pem> ubuntu@139.199.105.56 'curl -s localhost:8090/healthz'
```
Browser then points `ProxyProvider` at `http://139.199.105.56:8090` (or behind TLS) with `PROXY_SECRET`.

> Security: `UPSTREAM_TOKEN` lives only in node1's env / this container. The browser only ever has `PROXY_SECRET` (rotate/scope as needed). Per-NPC EOA keys and x402 signing (post-demo) belong here too — the proxy is onchainpal's server-side home.
