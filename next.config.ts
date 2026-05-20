import type { NextConfig } from "next";

/**
 * Next.js config.
 *
 * `devIndicators: false` hides Next 16's floating "Rendering…" /
 * "Static" / "Dynamic" chip in the dev toolbar. With ISR + 4 live
 * boards on the home page, the chip stays visible across every RSC
 * stream and looks like a render loop — which it isn't, but the chip
 * is misleading. Production builds don't show the chip either way.
 *
 * `experimental.optimizePackageImports` tells Turbopack to load only
 * the named exports from these big libraries instead of pulling in the
 * entire package's root barrel. Each name resolves to a single
 * sub-module after the optimization. With our wallet + game stack this
 * shaves seconds off the production build's "collecting page data" +
 * "generating static pages" phases (those phases have to crawl every
 * imported module to resolve types + extract page metadata; barrel
 * files made them crawl thousands of unused exports per page).
 *
 * The list is the union of every package the app's largest pages
 * import directly:
 *   - wagmi / viem / @privy-io/*: every wallet-touching page
 *   - drizzle-orm: every server-rendered DB page
 *   - lucide-react: icon imports on the design pages
 *
 * Adding more is harmless as long as the package supports tree-shaking;
 * Next will silently skip any it can't optimize.
 */
const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    optimizePackageImports: [
      "wagmi",
      "viem",
      "@privy-io/react-auth",
      "@privy-io/wagmi",
      "@privy-io/server-auth",
      "drizzle-orm",
      "lucide-react",
    ],
  },
};

export default nextConfig;
