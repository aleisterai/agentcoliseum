/**
 * Aerodrome (Velodrome-fork) swap helpers for Base.
 *
 * MVP scope: swap USDC → ALEISTER via the **v2 Volatile** router, then transfer
 * the resulting ALEISTER to the treasury wallet. Slipstream (CL) integration
 * is deliberately deferred — most newly-listed memecoins on Base launch on
 * volatile pools first.
 *
 * Slippage tolerance: 2% (memecoin liquidity is thin and price impact + MEV
 * eats more than the typical 0.5%).
 *
 * Caller is responsible for ensuring there's enough USDC on the operator
 * wallet before invoking. Quote first via `quoteSwap()` to avoid surprises.
 */
import "server-only";
import { submitOperatorTx } from "./operator-nonce";
import {
  erc20Abi,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "./viem";
import { getOperatorWallet, getOperatorAddress } from "./wallet";
import { ALEISTER_ADDRESS, ALEISTER_TREASURY } from "./aleister";

// USDC native on Base (6 decimals).
export const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Aerodrome v2 Router (Volatile/Stable). Verified on BaseScan.
export const AERO_V2_ROUTER: Address = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

// Aerodrome's Velodrome-style factory. Used by the Router to disambiguate pools.
export const AERO_V2_FACTORY: Address = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

export const AERO_ROUTER_ABI = parseAbi([
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) external",
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) external view returns (uint256[] memory amounts)",
]);

export type Route = {
  from: Address;
  to: Address;
  stable: boolean;
  factory: Address;
};

export const USDC_TO_ALEISTER: Route[] = [
  { from: USDC_BASE, to: ALEISTER_ADDRESS, stable: false, factory: AERO_V2_FACTORY },
];

export const SLIPPAGE_BPS = 200; // 2.00%
const DEFAULT_DEADLINE_SECONDS = 600; // 10 minutes

/**
 * Quote a USDC→ALEISTER swap. Returns the expected ALEISTER output (wei).
 * Throws if no pool exists or the read reverts.
 */
export async function quoteSwap(usdcUnits: bigint): Promise<bigint> {
  const amounts = (await publicClient.readContract({
    address: AERO_V2_ROUTER,
    abi: AERO_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [usdcUnits, USDC_TO_ALEISTER],
  })) as bigint[];
  if (!amounts || amounts.length < 2) {
    throw new Error("aerodrome: getAmountsOut returned empty");
  }
  return amounts[amounts.length - 1];
}

/**
 * Ensure the operator wallet has approved at least `min` USDC to the router.
 * Idempotent — no-op if allowance already sufficient.
 *
 * Returns the approve tx hash if one was sent, undefined otherwise.
 */
export async function ensureUsdcApproval(min: bigint): Promise<Hex | undefined> {
  const operator = getOperatorAddress();
  const allowance = (await publicClient.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "allowance",
    args: [operator, AERO_V2_ROUTER],
  })) as bigint;
  if (allowance >= min) return undefined;

  const wallet = getOperatorWallet();
  const hash = await submitOperatorTx((nonce) =>
    wallet.sendTransaction({
      to: USDC_BASE,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [AERO_V2_ROUTER, 2n ** 256n - 1n], // max
      }),
      nonce,
    }),
  );
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Swap `usdcUnits` USDC for ALEISTER on Aerodrome. Returns the tx hash and
 * the realized output (read from the receipt's transfer event indirectly via
 * balance diff).
 */
export async function swapUsdcToAleister(usdcUnits: bigint): Promise<{
  swapTxHash: Hex;
  aleisterOut: bigint;
}> {
  const operator = getOperatorAddress();
  await ensureUsdcApproval(usdcUnits);

  const expectedOut = await quoteSwap(usdcUnits);
  const minOut = (expectedOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);

  const before = (await publicClient.readContract({
    address: ALEISTER_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [operator],
  })) as bigint;

  const wallet = getOperatorWallet();
  const hash = await submitOperatorTx((nonce) =>
    wallet.sendTransaction({
      to: AERO_V2_ROUTER,
      data: encodeFunctionData({
        abi: AERO_ROUTER_ABI,
        functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        args: [usdcUnits, minOut, USDC_TO_ALEISTER, operator, deadline],
      }),
      nonce,
    }),
  );
  await publicClient.waitForTransactionReceipt({ hash });

  const after = (await publicClient.readContract({
    address: ALEISTER_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [operator],
  })) as bigint;

  return { swapTxHash: hash, aleisterOut: after - before };
}

/** Send `amount` ALEISTER from operator wallet to the treasury. */
export async function sendAleisterToTreasury(amount: bigint): Promise<Hex> {
  const wallet = getOperatorWallet();
  const hash = await submitOperatorTx((nonce) =>
    wallet.sendTransaction({
      to: ALEISTER_ADDRESS,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [ALEISTER_TREASURY, amount],
      }),
      nonce,
    }),
  );
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
