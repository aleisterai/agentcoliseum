/**
 * Operator-only gate.
 *
 * Allows access to /admin/* pages + admin API routes ONLY for wallets
 * listed in the `OPERATOR_WALLETS` env (comma-separated, case-insensitive).
 * The wallet identity comes from the same Privy session the dashboard
 * uses — no separate admin login.
 *
 * If OPERATOR_WALLETS is unset, every request is denied — fail closed.
 * (Dev override: set OPERATOR_WALLETS in .env.local to your test wallet.)
 */
import "server-only";
import { getAddress } from "viem";

function allowedOperators(): Set<string> {
  const raw = process.env.OPERATOR_WALLETS ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      set.add(getAddress(trimmed).toLowerCase());
    } catch {
      // Skip malformed entries silently so a single typo doesn't lock
      // out the whole list. The console.warn is intentional so the
      // operator notices on startup.
      console.warn(`[auth/operator] OPERATOR_WALLETS entry is not a valid address: ${trimmed}`);
    }
  }
  return set;
}

export function isOperatorWallet(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  let normalized: string;
  try {
    normalized = getAddress(walletAddress).toLowerCase();
  } catch {
    return false;
  }
  return allowedOperators().has(normalized);
}
