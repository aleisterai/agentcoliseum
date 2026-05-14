import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class merging helper used by shadcn primitives. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Truncate a 0x address: 0x1234...abcd */
export function truncAddress(addr: string, head = 6, tail = 4): string {
  if (!addr.startsWith("0x") || addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Format a bigint balance with decimals into a short human string ("12.3M", "1.2K"). */
export function formatTokenShort(balance: bigint, decimals = 18): string {
  const whole = Number(balance / 10n ** BigInt(decimals));
  if (whole >= 1_000_000_000) return `${(whole / 1_000_000_000).toFixed(2)}B`;
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(2)}K`;
  return whole.toLocaleString();
}

/** Format integer USDC (6-decimal units) as "$1.23". */
export function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return `$${(units / 1_000_000).toFixed(2)}`;
}

/** Slugify an arbitrary string into a url-safe agent handle. */
export function slugifyHandle(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
