"use client";

/**
 * HeaderWallet — wallet button in the site header. Tri-state, driven by
 * the WalletStateContext from `@/components/providers`:
 *
 *   "disabled" — Privy threw permanently (origin not allowed, bad app id,
 *                missing connectors). Renders a clickable "Set up
 *                Connect ↗" link straight to the Privy dashboard so the
 *                user can fix their allowed-origins list. We do NOT call
 *                any Privy/Wagmi hooks here — the kill-switch in
 *                Providers tore down PrivyProvider and the hooks would
 *                crash.
 *
 *   "loading"  — SSR + client pre-init. Shows a wait stub the exact same
 *                width as the eventual button so the header doesn't
 *                reflow on hydration.
 *
 *   "ready"    — Privy is mounted and reported `ready: true`. Defers to
 *                ConnectedWallet (in a separate file) so the
 *                usePrivy/useAccount/useDisconnect hooks ONLY run when
 *                PrivyProvider is actually in the tree.
 *
 * The split prevents this whole component from getting stuck in the
 * grey "Privy still booting" state when Privy is dead — which is what
 * was happening on localhost when the origin wasn't whitelisted.
 */
import dynamic from "next/dynamic";
import { useState } from "react";
import { useWalletState } from "@/components/providers";

// Lazy-load the connected branch — it pulls in `usePrivy` + `wagmi`,
// which themselves pull in viem + WalletConnect + Coinbase Smart Wallet.
// Static `import { ConnectedWallet }` forced the entire wallet bundle
// onto every page (home, lobby, leaderboard, agent profiles) even
// though those pages only need the "loading" stub. Dynamic gates it
// behind the actual walletState === "ready" branch below, which only
// resolves after the wallet stack has been mounted by `Providers`.
const ConnectedWallet = dynamic(
  () => import("./header-wallet-connected").then((m) => m.ConnectedWallet),
  { ssr: false, loading: () => null },
);

interface HeaderWalletProps {
  /** When true, render full-width for the mobile menu. */
  fullWidth?: boolean;
}

export function HeaderWallet({ fullWidth = false }: HeaderWalletProps) {
  const walletState = useWalletState();
  const [copied, setCopied] = useState(false);

  const triggerStyle: React.CSSProperties | undefined = fullWidth
    ? { width: "100%", justifyContent: "center", padding: 12, fontSize: 14 }
    : undefined;

  if (walletState === "disabled") {
    return (
      <a
        href="https://dashboard.privy.io"
        target="_blank"
        rel="noopener noreferrer"
        className="btn-connect"
        style={triggerStyle}
        title="Wallet integration disabled. Click to open the Privy dashboard and add this origin to the allowed list."
      >
        <WalletIcon />
        Set up Connect ↗
      </a>
    );
  }

  if (walletState === "loading") {
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

  return (
    <ConnectedWallet
      fullWidth={fullWidth}
      triggerStyle={triggerStyle}
      copied={copied}
      setCopied={setCopied}
    />
  );
}

function WalletIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M16 12h2" />
    </svg>
  );
}
