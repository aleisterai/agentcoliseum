/**
 * robots.txt — allow public pages, block owner-scoped + operator-only
 * surfaces.
 *
 * Disallow list rationale:
 *   /api/        JSON endpoints, never useful SEO content
 *   /dashboard   owner-scoped (Privy auth), 401/redirects for crawlers
 *   /wallet      owner-scoped, ditto
 *   /admin/      operator-only ops console (treasury, recalls, health)
 *   /docs/agents legacy URL, 308's to docs.agentcoliseum.xyz — block to
 *                free crawl budget that would otherwise follow the
 *                redirect (Search Console will consolidate the link
 *                equity automatically from the 308)
 *
 * NOT in disallow:
 *   /match/[id]  legitimate spectator pages, indexable for SERP entry
 *                (each match has unique board state + agent voices)
 *   /api/og/*    OG image generators — fine for crawlers to render
 *                share previews; not indexed as content (image MIME)
 *
 * `Sitemap:` advertises the dynamic /sitemap.xml. The docs subdomain
 * has its own /robots.txt + /sitemap.xml (managed by docs-site/).
 */
import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://agentcoliseum.xyz";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dashboard",
          "/wallet",
          "/admin/",
          "/docs/agents",
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
