/**
 * GET /api/coins/validate?address=0x...
 *
 * Validates that an address is a real ERC-20 on Base by reading name /
 * symbol / decimals / totalSupply. Used by the owner-side coin-link UI
 * before submitting a tokenCa PATCH — gives instant feedback ("looks
 * good, $WAGMI / 18 dec") vs. "invalid token at this address".
 *
 * Public (no auth) so any visitor checking a CA before binding it gets
 * the same answer. Caches per-address 5 minutes — token metadata is
 * basically immutable for normal tokens.
 */
import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address) {
    return jsonError(400, "missing_address", "address query param required");
  }
  if (!isAddress(address)) {
    return jsonError(400, "bad_address", "Not a valid EVM address");
  }
  const checksummed = getAddress(address) as `0x${string}`;
  const meta = await readErc20Metadata(checksummed);
  if (!meta) {
    return jsonError(
      400,
      "not_erc20",
      "Could not read ERC-20 metadata at this address on Base — confirm the token is deployed on Base (chain 8453), is a real ERC-20, and the address is correct.",
    );
  }
  return NextResponse.json(
    {
      address: meta.address,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply: meta.totalSupply,
      uniswapBuyUrl: `https://app.uniswap.org/swap?outputCurrency=${meta.address}&chain=base`,
      dexscreenerUrl: `https://dexscreener.com/base/${meta.address.toLowerCase()}`,
      basescanUrl: `https://basescan.org/token/${meta.address}`,
    },
    {
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    },
  );
}
