"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { useState } from "react";
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

  if (!privyAppId) {
    return (
      <QueryClientProvider client={queryClient}>
        <Toaster>{children}</Toaster>
      </QueryClientProvider>
    );
  }

  return (
    <PrivyProvider appId={privyAppId} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <Toaster>{children}</Toaster>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
