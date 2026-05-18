"use client";

/**
 * HeaderWallet — wallet button + dropdown for the site header.
 *
 *   Disconnected → "Connect" button that triggers Privy login()
 *   Connected    → truncated address with a dropdown containing:
 *                    - full address (click to copy)
 *                    - Dashboard link
 *                    - Wallet link
 *                    - View on Basescan
 *                    - Disconnect
 *
 * Uses the design's `.btn-connect` class for the trigger so it sits visually
 * alongside the rest of the header. The dropdown body uses Radix primitives
 * styled with the design tokens.
 */
import { useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useDisconnect } from "wagmi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { truncAddress } from "@/lib/utils";

interface HeaderWalletProps {
  /** When true, render full-width for the mobile menu. */
  fullWidth?: boolean;
}

export function HeaderWallet({ fullWidth = false }: HeaderWalletProps) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);

  const triggerStyle = fullWidth
    ? { width: "100%", justifyContent: "center", padding: 12, fontSize: 14 }
    : undefined;

  // Privy still booting — disabled stub matches the eventual button width.
  if (!ready) {
    return (
      <button
        type="button"
        className="btn-connect"
        style={{ ...triggerStyle, opacity: 0.55, cursor: "wait" }}
        disabled
      >
        <WalletIcon />
        Connect
      </button>
    );
  }

  // Not connected — primary CTA.
  if (!authenticated || !address) {
    return (
      <button
        type="button"
        className="btn-connect"
        style={triggerStyle}
        onClick={() => login()}
      >
        <WalletIcon />
        Connect
      </button>
    );
  }

  // Connected — wallet badge with dropdown.
  function copyAddress() {
    if (!address) return;
    void navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  async function handleDisconnect() {
    disconnect();
    await logout();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="btn-connect"
          style={triggerStyle}
          aria-label="Wallet menu"
        >
          <WalletIcon />
          <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
            {truncAddress(address)}
          </span>
          <ChevronDownIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-64"
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          padding: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}
      >
        <DropdownMenuLabel
          style={{
            padding: "8px 10px 6px",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--text-mute)",
            fontWeight: 600,
          }}
        >
          Connected wallet
        </DropdownMenuLabel>
        <button
          type="button"
          onClick={copyAddress}
          className="mono"
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 10px",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            fontSize: 12,
            color: "var(--text-2)",
            textAlign: "left",
            borderRadius: 4,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {truncAddress(address, 8, 6)}
          </span>
          <span
            style={{
              fontSize: 10,
              color: copied ? "var(--green-text)" : "var(--text-mute)",
            }}
          >
            {copied ? "copied" : "copy"}
          </span>
        </button>

        <DropdownMenuSeparator
          style={{ height: 1, background: "var(--line)", margin: "6px 0" }}
        />

        <DropdownMenuItem asChild>
          <Link href="/dashboard" style={menuItemStyle}>
            <GridIcon />
            <span>Dashboard</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <Link href="/wallet" style={menuItemStyle}>
            <WalletIcon />
            <span>Wallet &amp; treasury</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href={`https://basescan.org/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            style={menuItemStyle}
          >
            <ExternalLinkIcon />
            <span>View on Basescan</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator
          style={{ height: 1, background: "var(--line)", margin: "6px 0" }}
        />

        <DropdownMenuItem
          onSelect={() => void handleDisconnect()}
          style={{
            ...menuItemStyle,
            color: "var(--ox-bright)",
            cursor: "pointer",
          }}
        >
          <LogoutIcon />
          <span>Disconnect</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  fontSize: 13,
  color: "var(--text)",
  textDecoration: "none",
  borderRadius: 4,
  outline: "none",
  cursor: "pointer",
};

function WalletIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M16 12h2" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ marginLeft: 2, opacity: 0.85 }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
