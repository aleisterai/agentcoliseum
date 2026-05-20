/**
 * Privy configuration — defaults, supported chains, login methods.
 *
 * Embedded wallets are auto-created for users who log in via email/social.
 * External wallets (MetaMask, Coinbase Wallet, etc.) are also accepted.
 * Both surface to Wagmi via Privy's bridging.
 */
import type { PrivyClientConfig } from "@privy-io/react-auth";
import { base } from "viem/chains";

/**
 * Hex mirror of `--coliseum-oxblood` (oklch(0.48 0.18 22)). Privy's modal API
 * only accepts hex, so we keep this single literal here and reference it.
 * Update both this value AND the oklch in `globals.css` if the brand color
 * changes — there is no programmatic conversion at runtime.
 */
const COLISEUM_OXBLOOD_HEX = "#7a1c1c" as const;

export const privyConfig: PrivyClientConfig = {
  defaultChain: base,
  supportedChains: [base],
  // NOTE on the Solana warning: the SDK prints
  //   "App configuration has Solana wallet login enabled, but no
  //    Solana wallet connectors have been passed to Privy."
  // on every render in browser dev tools. The flag lives in the Privy
  // dashboard, not in code — Agent Coliseum is Base-only and we don't
  // want Solana login at all. Fix is dashboard-side:
  //   https://dashboard.privy.io → your app → Login methods →
  //   uncheck "Solana wallet". Save. Reload.
  // Until that's done the warning is cosmetic (no functional impact);
  // we deliberately don't pass `externalWallets.solana` here because
  // the type requires a full connector config that would import the
  // Solana adapter into our bundle for no reason.
  // Mirrors the methods enabled in the Privy dashboard for this app:
  //   X (twitter) · Farcaster · Email · SMS · External wallet.
  // Order here drives the order in the modal: crypto-native socials first,
  // then email/SMS fallbacks, then external wallet under the "OR" divider.
  // Passkeys are configured at the Privy dashboard level (added after first
  // sign-up, not a primary signup option) so they don't appear in this list.
  // Telegram is unavailable: their Login Widget rejects `.xyz` domains, so
  // we can't enable it on `agentcoliseum.xyz`.
  // Embedded wallets still auto-create for users who pick any social path.
  loginMethods: ["twitter", "farcaster", "email", "sms", "wallet"],
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
    showWalletUIs: true,
  },
  appearance: {
    theme: "dark",
    accentColor: COLISEUM_OXBLOOD_HEX,
    logo: "/sigil.svg",
    showWalletLoginFirst: false,
  },
};

export const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
