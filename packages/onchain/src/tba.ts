/**
 * ERC-6551 Token Bound Account (TBA) address computation.
 *
 * Each NPC NFT (OnchainPalNPC) has a counterfactual TBA — its on-chain wallet
 * that can HOLD GCC and receive donations. The address is deterministic (CREATE2
 * via the canonical registry); the account contract need NOT be deployed to know
 * its address, so the long tail of NPCs costs nothing until first use.
 *
 * Algorithm verified against the live Base-Sepolia registry (registry.account()
 * view returns the identical address) on 2026-06-03.
 */
import { keccak256, encodePacked, encodeAbiParameters, getCreate2Address } from 'viem';

/** Canonical ERC-6551 registry — same address on every EVM chain. */
export const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758' as const;
/** Tokenbound v0.3.1 AccountV3 implementation (canonical; confirm per chain). */
export const TOKENBOUND_ACCOUNT_V3 = '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC' as const;
const ZERO_SALT = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface TbaParams {
  tokenContract: `0x${string}`;
  tokenId: bigint | number | string;
  chainId: number;
  /** defaults to the canonical ERC-6551 registry. */
  registry?: `0x${string}`;
  /** defaults to Tokenbound AccountV3. */
  implementation?: `0x${string}`;
  /** defaults to bytes32(0). */
  salt?: `0x${string}`;
}

/**
 * Compute the counterfactual ERC-6551 TBA address. Pure — no RPC, no deploy.
 * Mirrors the registry's `account(implementation, salt, chainId, tokenContract,
 * tokenId)` CREATE2 computation exactly.
 */
export function computeTbaAddress(params: TbaParams): `0x${string}` {
  const registry = params.registry ?? ERC6551_REGISTRY;
  const implementation = params.implementation ?? TOKENBOUND_ACCOUNT_V3;
  const salt = params.salt ?? ZERO_SALT;

  const encodedParams = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
    [salt, BigInt(params.chainId), params.tokenContract, BigInt(params.tokenId)]
  );
  const creationCode = encodePacked(
    ['bytes', 'address', 'bytes', 'bytes'],
    ['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3', encodedParams]
  );
  return getCreate2Address({ from: registry, salt, bytecodeHash: keccak256(creationCode) });
}
