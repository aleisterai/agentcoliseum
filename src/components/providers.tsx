"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { privyConfig, privyAppId } from "@/lib/privy";
import { wagmiConfig } from "@/lib/wagmi-config";
import { Toaster } from "@/components/ui/toaster";

/**
 * Top-level client providers.
 *
 *   Privy → TanStack Query → Wagmi (Privy-bridged) → Toaster
 *
 * The Toaster wraps children so any descendant can call `useToast()` to
 * surface a notification (move failed, agent registered, x402 payment
 * pending, treasury cron status, etc.).
 *
 * If `NEXT_PUBLIC_PRIVY_APP_ID` is missing we drop the wallet plumbing but
 * keep TanStack Query and Toaster so the rest of the app remains usable.
 *
 * Crucially, the Privy SDK is wrapped in a runtime guard:
 *   - sync errors during render are caught by `WalletErrorBoundary`
 *   - async errors (Privy retries its origin check on the network, which
 *     can throw an unhandledRejection like `Error: Origin not allowed`
 *     and previously locked the page in a retry loop) are caught by a
 *     window-level handler in `PrivyKillSwitch`. Either path degrades to
 *     "wallet disabled" mode with an actionable banner instead of
 *     re-mounting Privy and looping forever.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );
  // Set to `true` once we observe Privy failing. Drops the wallet stack
  // and renders the rest of the app cold. Persists for the page lifetime
  // (a remount would just trip the same error and re-loop).
  const [walletDisabled, setWalletDisabled] = useState(false);

  // Window-level catch for Privy's async rejections. These don't reach
  // React error boundaries because they fire from XHR / fetch handlers
  // inside the SDK, not from render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function isPrivyFailure(reason: unknown): boolean {
      const msg = String(
        (reason as { message?: unknown } | null)?.message ?? reason ?? "",
      );
      return (
        msg.includes("Origin not allowed") ||
        msg.includes("Invalid app id") ||
        msg.toLowerCase().includes("privy")
      );
    }
    function onReject(ev: PromiseRejectionEvent) {
      if (isPrivyFailure(ev.reason)) {
        // Swallow + flip the kill-switch. Without this the SDK retries
        // on its own schedule and the loop survives reloads.
        ev.preventDefault();
        if (!walletDisabled) {
          console.warn(
            "[wallet] Privy init failed — disabling wallet integration for this session.\n" +
              "Fix: add this origin to your Privy app's allowed list at\n" +
              "  https://dashboard.privy.io → app → Settings → Domains\n" +
              `  Origin: ${window.location.origin}`,
          );
          setWalletDisabled(true);
        }
      }
    }
    window.addEventListener("unhandledrejection", onReject);
    return () => window.removeEventListener("unhandledrejection", onReject);
  }, [walletDisabled]);

  if (!privyAppId || walletDisabled) {
    return (
      <QueryClientProvider client={queryClient}>
        {walletDisabled ? <WalletDisabledBanner /> : null}
        <Toaster>{children}</Toaster>
      </QueryClientProvider>
    );
  }

  return (
    <WalletErrorBoundary onError={() => setWalletDisabled(true)}>
      <PrivyProvider appId={privyAppId} config={privyConfig}>
        <QueryClientProvider client={queryClient}>
          <WagmiProvider config={wagmiConfig}>
            <Toaster>{children}</Toaster>
          </WagmiProvider>
        </QueryClientProvider>
      </PrivyProvider>
    </WalletErrorBoundary>
  );
}

/**
 * Class-based error boundary — required by React because hook-based
 * boundaries don't exist. Catches sync render errors thrown by
 * PrivyProvider / WagmiProvider and signals the parent to degrade.
 */
class WalletErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[wallet] PrivyProvider threw — falling back.", error, info);
    this.props.onError();
  }
  render() {
    if (this.state.failed) {
      // Parent will re-render without us once onError flips the flag.
      // Return children unwrapped so the page can still hydrate.
      return this.props.children;
    }
    return this.props.children;
  }
}

function WalletDisabledBanner() {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "this origin";
  return (
    <div
      role="status"
      style={{
        background: "#3a1c1c",
        color: "#fce7e7",
        borderBottom: "1px solid #5a2c2c",
        padding: "8px 14px",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      <strong style={{ color: "#ffb4b4" }}>Wallet integration disabled.</strong>{" "}
      Privy rejected this origin. Add{" "}
      <code
        style={{
          background: "rgba(255,255,255,0.08)",
          padding: "1px 6px",
          borderRadius: 3,
        }}
      >
        {origin}
      </code>{" "}
      at{" "}
      <a
        href="https://dashboard.privy.io"
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#ffd9d9", textDecoration: "underline" }}
      >
        dashboard.privy.io → Settings → Domains
      </a>{" "}
      and reload.
    </div>
  );
}
