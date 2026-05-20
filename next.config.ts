import type { NextConfig } from "next";

/**
 * Next.js config.
 *
 * `devIndicators: false` hides Next 16's floating "Rendering…" / "Static" /
 * "Dynamic" chip in the dev toolbar. With ISR + 4 live boards on the
 * home page, the chip stays visible across every RSC stream and looks
 * like a render loop — which it isn't, but the chip is misleading.
 * Production builds don't show the chip either way.
 */
const nextConfig: NextConfig = {
  devIndicators: false,
};

export default nextConfig;
