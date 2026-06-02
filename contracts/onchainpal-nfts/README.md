# onchainpal-nfts

ERC-721 contract for **AI NPCs as on-chain identities**. Each minted token =
one hero NPC (酒剑仙, 阿珠, 李大娘, …). Paired with **ERC-6551** (Tokenbound
v0.3.1), every NPC NFT has its own Token Bound Account (TBA) that can hold GCC
and receive donations — the NPC's on-chain wallet + economic identity.

This is **step B1** of the B+I roadmap: contract + deploy script only. ERC-6551
TBA integration (computed addresses, signing, AgentWallet impl) lands in B2.

## Build / Test

```bash
forge build
forge test -vv     # 6 tests, all pass
```

## Dry-run the deploy script

No broadcast, no key — sanity-checks gas + log output:

```bash
NPC_OWNER=0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26 \
AZHU_URI=ipfs://bafy-azhu \
LI_DANIANG_URI=ipfs://bafy-lida \
JIU_JIANXIAN_URI=ipfs://bafy-jjx \
MINT_TO=0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26 \
forge script script/DeployOnchainPalNPC.s.sol \
  --sender 0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26
```

## Deploy for real (Sepolia)

```bash
NPC_OWNER=0x30B10c22F2b136b3dCcFe8d5904A85FE45426b26 \
AZHU_URI=ipfs://<auto-drive-cid-or-uri> \
LI_DANIANG_URI=ipfs://<…> \
JIU_JIANXIAN_URI=ipfs://<…> \
forge script script/DeployOnchainPalNPC.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --private-key <KEY>
```

The script broadcasts from `msg.sender` (the `--private-key` account). If you
pass `--private-key` for the deployer-owner we're already using on AIGG side
(`0x30B1…26b26`), it deploys, sets owner, and mints the 3 hero NPCs in one batch
(~1.4M gas).

## Token URI

`tokenURI(tokenId)` returns whatever was set at mint (or via `setTokenURI`).
Conventionally an Auto Drive CID, e.g. `ipfs://<cid>` whose blob is the JSON
metadata (image / persona summary) that wallets render.

## Why ERC-6551 TBAs (post-B1)

NFT alone can't hold tokens. The Tokenbound v0.3.1 registry+account give every
NFT a counterfactual contract account; we wrap that as a `TbaAgentWallet` in B2
so the npc-agent runtime can `balanceGcc(npcId)` and `signTypedData(…)` against
the NPC's TBA. TBA owner == NFT owner (game treasury for hero NPCs; or a patron
player for player-owned ones, see I phase).
