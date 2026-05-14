/**
 * Helpers that wrap a Next.js route handler in x402 payment enforcement.
 *
 * Usage in a route handler:
 *
 *   export const POST = withFixedPayment(handler, PRICE.registerAgent);
 *
 *   // or with a dynamic price derived from the request body:
 *   export const POST = withDynamicPayment(handler, async (req) => {
 *     const body = await req.clone().json();
 *     return dollarsFromUsdc6(body.stakeUsdc);
 *   });
 *
 * The wrapper:
 *   1. Settles only on success (status < 400), per x402-next semantics.
 *   2. Routes proceeds to the platform operator wallet on Base.
 *   3. Stake-based payments accumulate in the operator wallet for later
 *      payout to winner / treasury (see Phase 9).
 */
import type { NextRequest, NextResponse } from "next/server";
import { withX402, type RouteConfig } from "x402-next";
import { getAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/**
 * Lazily derive the platform operator's address from its private key.
 * The address is the *destination* for all x402 payments; we derive it once
 * and reuse for every route. Server-only.
 */
let cachedPayTo: `0x${string}` | undefined;

export function getPayToAddress(): `0x${string}` {
  if (cachedPayTo) return cachedPayTo;
  const pk = process.env.PLATFORM_OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "PLATFORM_OPERATOR_PRIVATE_KEY is not set. Generate a fresh wallet and add to .env.local.",
    );
  }
  const normalized = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  cachedPayTo = getAddress(privateKeyToAddress(normalized)) as `0x${string}`;
  return cachedPayTo;
}

type Handler<T = unknown> = (req: NextRequest) => Promise<NextResponse<T>>;

function baseRouteConfig(price: `$${string}`, description: string): RouteConfig {
  return {
    price,
    network: "base",
    config: { description },
  };
}

/** Wrap a handler with a fixed-price payment. */
export function withFixedPayment<T = unknown>(
  handler: Handler<T>,
  price: `$${string}`,
  description: string,
) {
  return withX402(handler, getPayToAddress(), baseRouteConfig(price, description));
}

/**
 * Wrap a handler whose price is derived from the request (e.g. a stake amount
 * in the body). The price function is invoked once per request, before the
 * handler runs.
 */
export function withDynamicPayment<T = unknown>(
  handler: Handler<T>,
  priceFn: (req: NextRequest) => Promise<`$${string}`>,
  description: string,
) {
  return withX402(handler, getPayToAddress(), async (req) => {
    const price = await priceFn(req);
    return baseRouteConfig(price, description);
  });
}
