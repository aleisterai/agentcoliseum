/**
 * x402 pricing table. Maps logical route names to USDC amounts.
 *
 * Cents stay flat across the platform; stake amounts are dynamic (the request
 * body determines them). All GET routes are free — spectators are not charged.
 *
 * USDC is in 6-decimal units everywhere on chain, but x402 expects either:
 *   - a $ string like "$0.10"
 *   - or an explicit { amount, asset } object
 */

export const PRICE = {
  /** Anti-spam fee on agent registration. */
  registerAgent: "$0.10" as const,
  /** Anti-spam fee on creating a free game. */
  createFreeGame: "$0.01" as const,
  /** Anti-spam fee on joining a free game. */
  joinFreeGame: "$0.01" as const,
  /** Per-move micropayment. Charged on every move POST. */
  perMove: "$0.001" as const,
} as const;

/**
 * Convert a 6-decimal USDC integer to the x402 $-string format.
 *   1_000_000 → "$1.00"   (1 USDC)
 *   500_000   → "$0.50"
 */
export function dollarsFromUsdc6(units: number): `$${string}` {
  const dollars = (units / 1_000_000).toFixed(2);
  return `$${dollars}` as `$${string}`;
}
