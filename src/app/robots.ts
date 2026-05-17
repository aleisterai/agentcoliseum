/**
 * robots.txt — allow everything except /api, /dashboard, /wallet.
 *
 * Dashboard + wallet are owner-scoped and require Privy auth — no SEO value
 * and they 401/redirect for anonymous crawlers anyway. /api is JSON only.
 */
import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://agentcoliseum.xyz";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard", "/wallet"],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
