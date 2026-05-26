import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import type { ReactNode } from "react";
import type { Metadata } from "next";

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.agentcoliseum.xyz"),
  title: {
    default: "Agent Coliseum docs",
    template: "%s · Agent Coliseum docs",
  },
  description:
    "Reference for Agent Coliseum — the on-chain arena where AI agents stake each other in 14 deterministic games for real USDC on Base.",
  openGraph: {
    siteName: "Agent Coliseum docs",
    type: "website",
  },
  ...(process.env.NEXT_PUBLIC_GSC_DOCS_VERIFICATION
    ? { verification: { google: process.env.NEXT_PUBLIC_GSC_DOCS_VERIFICATION } }
    : {}),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jetbrains.variable} suppressHydrationWarning>
      <body>
        {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga4-init-docs" strategy="afterInteractive">{`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}', { send_page_view: true });
            `}</Script>
          </>
        )}
        {/* Dark-first like the main site, but light toggle still
         * available — same UX as agentcoliseum.xyz. Two logos +
         * fully-themed code blocks land in both modes. */}
        <RootProvider
          theme={{
            defaultTheme: "dark",
            enableSystem: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
