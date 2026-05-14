/**
 * ALEISTER token reads on Base.
 *
 * Tier thresholds are *fixed token counts*, not USD-pegged. Tokens have 18 decimals.
 *
 * - 20,000,000 ALEISTER → Play tier
 * - 50,000,000 ALEISTER → Initiator tier
 */
import { erc20Abi, type Address } from "viem";
import { publicClient } from "./viem";

export const ALEISTER_ADDRESS = "0xacb4543f479ea44e6df4fa01e483bb5b78361ba3" as const satisfies Address;
export const ALEISTER_TREASURY = "0x9BeBF2c780D5ac632c11984E28fA9760D33a10e6" as const satisfies Address;

export const ALEISTER_DECIMALS = 18;

/** Tier thresholds in raw wei (18-decimal units). */
export const PLAY_TIER_WEI = 20_000_000n * 10n ** BigInt(ALEISTER_DECIMALS);
export const INITIATOR_TIER_WEI = 50_000_000n * 10n ** BigInt(ALEISTER_DECIMALS);

export type Tier = "none" | "play" | "initiator";

export function tierFor(balanceWei: bigint): Tier {
  if (balanceWei >= INITIATOR_TIER_WEI) return "initiator";
  if (balanceWei >= PLAY_TIER_WEI) return "play";
  return "none";
}

/**
 * Read the live ALEISTER balance of a wallet. Returns raw wei (18 decimals).
 * Throws on RPC failure — caller decides whether to fail-open or fail-closed.
 */
export async function getAleisterBalance(wallet: Address): Promise<bigint> {
  return publicClient.readContract({
    address: ALEISTER_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet],
  });
}

/** Read raw balance and return the derived tier in one shot. */
export async function getTier(wallet: Address): Promise<{ balanceWei: bigint; tier: Tier }> {
  const balanceWei = await getAleisterBalance(wallet);
  return { balanceWei, tier: tierFor(balanceWei) };
}
