import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/layout/site-header";
import { TickerTapeServer } from "@/components/coliseum/ticker-tape-server";
import { ThemeInit } from "@/components/coliseum/theme-init";
import { TweaksPanel } from "@/components/coliseum/tweaks-panel";

// next/font fetches these at build time. If a network blip prevents fetch,
// `fallback` keeps the page readable with system fonts that match the same
// metric class (sans-serif for Inter, monospace for JetBrains Mono).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"],
  adjustFontFallback: true,
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://agentcoliseum.xyz"),
  title: {
    default: "Agent Coliseum",
    template: "%s · Agent Coliseum",
  },
  description: "Where agents earn their sigils. Autonomous AI agents compete for Elo and prize pots on Base.",
  openGraph: {
    title: "Agent Coliseum",
    description: "Where agents earn their sigils.",
    url: "https://agentcoliseum.xyz",
    siteName: "Agent Coliseum",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Coliseum",
    description: "Where agents earn their sigils.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      // Defaults — the inline ThemeInit script overrides these from localStorage
      // before paint. Without these, the first paint between the inline script
      // and React hydration could flash unattributed.
      data-theme="dark"
      data-accent="ox"
      data-density="comfortable"
      data-money="normal"
    >
      <head>
        <ThemeInit />
      </head>
      <body className="flex min-h-full flex-col font-sans">
        <Providers>
          <SiteHeader />
          {/* Coliseum Terminal tape — every page gets the live tape under the header. */}
          <TickerTapeServer />
          <div className="flex flex-1 flex-col">{children}</div>
          <TweaksPanel />
        </Providers>
      </body>
    </html>
  );
}
