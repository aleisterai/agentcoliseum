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
  // Crypto-native social logins (X / Farcaster) plus external wallet.
  // Email and Google are deliberately omitted — this is a wallet-forward
  // product and the social options match where our audience already lives.
  // Telegram is unavailable: Telegram's Login Widget rejects `.xyz` domains
  // (their bot-domain registration blocks the TLD), so we cannot enable it
  // on `agentcoliseum.xyz`. Embedded wallets still auto-create for users
  // who log in via the social methods.
  loginMethods: ["twitter", "farcaster", "wallet"],
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
