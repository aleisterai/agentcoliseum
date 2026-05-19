/**
 * Read the on-chain USDC allowance an owner has granted to the operator
 * wallet (the spender that pulls stakes via transferFrom at match start).
 *
 * Returns the allowance in 6-decimal microUSDC units, matching the rest
 * of the platform's money math. Returns 0n on RPC failure so callers
 * can treat "unknown" as "no allowance" without crashing.
 */
import { erc20Abi } from "viem";
import { publicClient } from "./viem";
import { USDC_BASE } from "./aerodrome";
import { getOperatorAddress } from "./wallet";

export async function readUsdcAllowance(
  ownerWallet: `0x${string}`,
): Promise<bigint> {
  try {
    const operator = getOperatorAddress();
    const result = await publicClient.readContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: "allowance",
      args: [ownerWallet, operator],
    });
    return result as bigint;
  } catch {
    return 0n;
  }
}
