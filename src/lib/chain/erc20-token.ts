/**
 * Server-side ERC-20 metadata reader for agent-linked coins.
 *
 * Owners paste a tokenCa from their preferred launcher (Clanker / Wow /
 * Zora / Aerodrome / pure Uniswap launch). We don't trust the input —
 * we ON-CHAIN read name / symbol / decimals / totalSupply against Base
 * to confirm the address is actually an ERC-20 before letting it onto
 * the public profile. Anything that throws (EOA, non-ERC-20, wrong
 * chain) returns null and the caller rejects the link.
 *
 * Future hardening (Phase 1.5):
 *   - Goplus / De.Fi risk-screen call (honeypot, locked LP, mintability)
 *   - Aerodrome / Uniswap pool existence check + 24h volume
 *   - LP-lock proof (so the agent's coin can't get rugged immediately)
 *
 * For now: structural ERC-20 check + simple sanity caps on decimals.
 */
import "server-only";
import { parseAbi } from "viem";
import { publicClient } from "./viem";
import { memoize } from "@/lib/cache";

export interface ErcMetadata {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string; // BigInt stringified — JSON-safe
}

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

async function readErc20MetadataDirect(
  address: `0x${string}`,
): Promise<ErcMetadata | null> {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);
    if (typeof name !== "string" || name.length === 0 || name.length > 80) return null;
    if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 20) return null;
    // 0–24 is the de-facto sane range for ERC-20 decimals. USDC is 6,
    // most ERC-20s are 18.
    if (typeof decimals !== "number" || decimals < 0 || decimals > 24) return null;
    return {
      address,
      name,
      symbol,
      decimals,
      totalSupply: (totalSupply as bigint).toString(),
    };
  } catch {
    return null;
  }
}

/**
 * Cached version (30-min TTL via KV-or-memory). Coin metadata is
 * effectively immutable for well-behaved tokens, and a popular agent
 * profile gets viewed N times. Without this, every render = 4 RPC
 * calls. With it, every render = one map lookup.
 *
 * Null results are also cached (a non-ERC-20 address won't suddenly
 * become valid). That's intentional.
 */
const TOKEN_META_TTL_SECONDS = 30 * 60;

export async function readErc20Metadata(
  address: `0x${string}`,
): Promise<ErcMetadata | null> {
  return memoize(`erc20:${address.toLowerCase()}`, TOKEN_META_TTL_SECONDS, () =>
    readErc20MetadataDirect(address),
  );
}
