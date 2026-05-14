/**
 * Wagmi config — Base mainnet only. Connectors are managed by Privy
 * (we wrap with PrivyProvider → WagmiProvider).
 */
import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";

export const wagmiConfig = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL ?? process.env.BASE_RPC_URL ?? undefined,
      { batch: true },
    ),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
