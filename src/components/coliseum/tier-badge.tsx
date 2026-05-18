"use client";

/**
 * TierBadge — interactive tier chip with balance + thresholds + upgrade CTA.
 *
 * Click the badge to open a popover showing:
 *   - Live ALEISTER balance (formatted with M / K suffix)
 *   - All three tiers with thresholds; the one you currently hold is marked
 *   - If you're not at the max tier, an "Upgrade to NEXT" CTA shows the exact
 *     deficit in ALEISTER and deep-links to Uniswap on Base with ALEISTER as
 *     the output token.
 *
 * The badge itself uses the existing `.chip` class so it visually matches the
 * pre-existing pill — just adds a chevron and makes it clickable.
 */
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ALEISTER_ADDRESS,
  ALEISTER_DECIMALS,
  PLAY_TIER_WEI,
  INITIATOR_TIER_WEI,
  type Tier,
} from "@/lib/chain/aleister";

const UNISWAP_URL = `https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${ALEISTER_ADDRESS}&chain=base`;
const TIERS: Array<{ id: Tier; label: string; thresholdWei: bigint; unlocks: string }> = [
  { id: "none", label: "None", thresholdWei: 0n, unlocks: "Connect a wallet" },
  { id: "play", label: "Play", thresholdWei: PLAY_TIER_WEI, unlocks: "Register agents · play free + system matches" },
  { id: "initiator", label: "Initiator", thresholdWei: INITIATOR_TIER_WEI, unlocks: "Post paid challenges · stake USDC" },
];

interface TierBadgeProps {
  tier: Tier | undefined;
  balanceWei: bigint | undefined;
}

export function TierBadge({ tier, balanceWei }: TierBadgeProps) {
  const [open, setOpen] = useState(false);
  const currentTier = tier ?? "none";
  const balance = balanceWei ?? 0n;
  const nextTier = currentTier === "none"
    ? TIERS[1]
    : currentTier === "play"
      ? TIERS[2]
      : null;
  const deficit = nextTier ? deficitWei(balance, nextTier.thresholdWei) : 0n;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="chip"
          style={{
            fontSize: 9.5,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "transparent",
          }}
          aria-label="Tier details"
        >
          {currentTier.toUpperCase()} TIER
          <ChevronDownIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-80"
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          padding: 0,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Balance header */}
        <div
          style={{
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-2)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--text-mute)",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            ALEISTER balance
          </div>
          <div
            className="mono"
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: "var(--gold)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatAleister(balance)}
          </div>
          <a
            href={`https://basescan.org/token/${ALEISTER_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="lnk mono"
            style={{ fontSize: 10.5 }}
          >
            $ALEISTER on Basescan ↗
          </a>
        </div>

        {/* Tier ladder */}
        <div style={{ padding: "8px 0" }}>
          {TIERS.map((t) => {
            const meets = balance >= t.thresholdWei;
            const isCurrent = t.id === currentTier;
            return (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 16px",
                  borderLeft: isCurrent
                    ? "3px solid var(--gold)"
                    : "3px solid transparent",
                  opacity: meets ? 1 : 0.55,
                }}
              >
                <div
                  style={{
                    width: 18,
                    display: "flex",
                    justifyContent: "center",
                    color: isCurrent ? "var(--gold)" : meets ? "var(--green-text)" : "var(--text-mute)",
                  }}
                >
                  {meets ? <CheckIcon /> : <LockIcon />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: isCurrent ? "var(--gold)" : "var(--text)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    {t.label} {isCurrent ? "· current" : null}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-mute)",
                      marginTop: 2,
                    }}
                  >
                    {t.unlocks}
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--text-2)",
                    whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {t.thresholdWei === 0n ? "—" : `${formatAleisterWhole(t.thresholdWei)}`}
                </div>
              </div>
            );
          })}
        </div>

        {/* Upgrade CTA */}
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--line)",
            background: "var(--bg-2)",
          }}
        >
          {nextTier ? (
            <>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--text-2)",
                  marginBottom: 8,
                  lineHeight: 1.45,
                }}
              >
                Top up your wallet with{" "}
                <span
                  className="mono"
                  style={{ color: "var(--gold)", fontWeight: 600 }}
                >
                  +{formatAleister(deficit)}
                </span>{" "}
                ALEISTER to unlock {nextTier.label} tier.
              </div>
              <a
                href={UNISWAP_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="btn primary"
                style={{
                  display: "flex",
                  width: "100%",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  padding: "8px 12px",
                }}
              >
                Buy ALEISTER on Uniswap ↗
              </a>
            </>
          ) : (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--green-text)",
                textAlign: "center",
                padding: "6px 0",
              }}
            >
              ✓ Max tier reached
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function deficitWei(balance: bigint, target: bigint): bigint {
  return target > balance ? target - balance : 0n;
}

/** "12.5M" / "850K" / "342" — for display in the dropdown. */
function formatAleister(balanceWei: bigint): string {
  if (balanceWei === 0n) return "0";
  const whole = balanceWei / 10n ** BigInt(ALEISTER_DECIMALS);
  const wholeN = Number(whole);
  if (wholeN >= 1_000_000) {
    const m = wholeN / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (wholeN >= 1_000) {
    const k = wholeN / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return wholeN.toLocaleString();
}

/** "20M" / "50M" — used for the threshold column. */
function formatAleisterWhole(thresholdWei: bigint): string {
  const whole = thresholdWei / 10n ** BigInt(ALEISTER_DECIMALS);
  const n = Number(whole);
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return n.toString();
}

function ChevronDownIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ opacity: 0.7 }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
