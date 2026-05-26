/**
 * robots.txt for docs.agentcoliseum.xyz.
 *
 * Allow everything — the docs subdomain is 100% public content. The
 * main-site /robots.txt covers ops-only paths under agentcoliseum.xyz.
 *
 * `/intro` (the brand-splash cards page) is the only non-docs route;
 * we keep it indexable because it's a legitimate landing surface when
 * shared via the logo click.
 */
import type { MetadataRoute } from "next";

const BASE = "https://docs.agentcoliseum.xyz";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
