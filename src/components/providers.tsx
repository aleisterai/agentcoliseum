"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { privyConfig, privyAppId } from "@/lib/privy";
import { wagmiConfig } from "@/lib/wagmi-config";
import { Toaster } from "@/components/ui/toaster";

/**
 * Tri-state wallet availability — let any component below render the
 * right button:
 *   "loading"  — Privy is booting on the client; render a wait stub
 *   "ready"    — Privy is mounted; usePrivy() will work
 *   "disabled" — Privy failed permanently (origin not allowed, bad app
 *                id, missing connectors); usePrivy() is NOT mounted, so
 *                consumers MUST short-circuit before calling it
 *
 * SSR always emits "loading". The Privy SDK then either calls
 * `setWalletState("ready")` from `<PrivyReadyProbe>` (mounted only
 * inside PrivyProvider) or the kill-switch flips it to "disabled".
 */
export type WalletState = "loading" | "ready" | "disabled";
const WalletStateContext = createContext<WalletState>("loading");
export function useWalletState(): WalletState {
  return useContext(WalletStateContext);
}

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
 * PrivyProvider + WagmiProvider stay mounted on every render (SSR + client)
 * because routes like `/dashboard`, `/wallet`, `/register`, and the
 * owner-control components call `useAccount` / `usePrivy` during initial
 * render. We tried lazy-loading the wallet stack via `next/dynamic({
 * ssr: false })` to shave 20-ish wallet chunks off the home page bundle,
 * but it crashed every wallet-dependent page with "useConfig must be used
 * within WagmiProvider." If perf becomes an issue again, the correct fix
 * is a per-route layout (e.g. `app/(wallet)/layout.tsx`) that mounts the
 * wallet stack only where it's needed — not a global defer.
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

  // Tracks whether Privy has reported `ready: true` from inside its
  // own provider. Flipped from "loading" → "ready" by <PrivyReadyProbe>.
  // The kill-switch path skips this entirely and renders the "disabled"
  // branch above.
  const [privyReady, setPrivyReady] = useState(false);

  // Hard timeout. Some failure modes (network drop, CSP block, ad
  // blocker) leave Privy silently hanging without ever throwing — the
  // unhandledrejection handler never fires, and the button stays grey
  // forever. After 15s with no `ready`, give up and flip the kill-
  // switch so the user sees the actionable "Set up Connect ↗" link.
  useEffect(() => {
    if (!privyAppId || privyReady || walletDisabled) return;
    const t = setTimeout(() => {
      if (!privyReady) {
        console.warn(
          "[wallet] Privy did not become ready within 15s — falling back to disabled mode.",
        );
        setWalletDisabled(true);
      }
    }, 15_000);
    return () => clearTimeout(t);
  }, [privyReady, walletDisabled]);

  const walletState: WalletState = walletDisabled
    ? "disabled"
    : !privyAppId
      ? "disabled"
      : privyReady
        ? "ready"
        : "loading";

  if (!privyAppId || walletDisabled) {
    return (
      <WalletStateContext.Provider value={walletState}>
        <QueryClientProvider client={queryClient}>
          {walletDisabled ? <WalletDisabledBanner /> : null}
          <Toaster>{children}</Toaster>
        </QueryClientProvider>
      </WalletStateContext.Provider>
    );
  }

  return (
    <WalletStateContext.Provider value={walletState}>
      <WalletErrorBoundary onError={() => setWalletDisabled(true)}>
        <PrivyProvider appId={privyAppId} config={privyConfig}>
          <PrivyReadyProbe onReady={() => setPrivyReady(true)} />
          <QueryClientProvider client={queryClient}>
            <WagmiProvider config={wagmiConfig}>
              <Toaster>{children}</Toaster>
            </WagmiProvider>
          </QueryClientProvider>
        </PrivyProvider>
      </WalletErrorBoundary>
    </WalletStateContext.Provider>
  );
}

/**
 * Renders nothing. Lives inside PrivyProvider so it can call usePrivy(),
 * and notifies the parent the moment Privy finishes initialization. We
 * need this because the WalletStateContext value lives OUTSIDE
 * PrivyProvider (so it stays in scope when Privy isn't mounted on the
 * disabled path), but only code INSIDE PrivyProvider can read ready.
 */
function PrivyReadyProbe({ onReady }: { onReady: () => void }) {
  const { ready } = usePrivy();
  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);
  return null;
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
