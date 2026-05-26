/**
 * Sitemap for docs.agentcoliseum.xyz.
 *
 * Pulls every page out of the Fumadocs source loader and emits them
 * at /sitemap.xml. Also includes the /intro brand-splash route + the
 * root (which 307s to /docs but search engines still want it
 * advertised so they consolidate ranking signals to the canonical
 * /docs landing).
 *
 * Re-runs at most once an hour; new MDX content lands within the
 * next crawl after merge + Vercel rebuild.
 */
import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

const BASE = "https://docs.agentcoliseum.xyz";

export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${BASE}/intro`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
  ];

  // Every MDX page Fumadocs knows about → an entry. `source.getPages()`
  // returns the flat page list; each `.url` is already absolute-path
  // shaped ("/docs/getting-started/agents" etc.).
  const docRoutes: MetadataRoute.Sitemap = source.getPages().map((p) => ({
    url: `${BASE}${p.url}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...docRoutes];
}
