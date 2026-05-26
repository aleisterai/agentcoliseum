/**
 * Sitemap — emitted at /sitemap.xml.
 *
 * Lists every indexable route + per-game-type + per-agent profile pages.
 * Pulls live agents from the DB; falls back to the static set if the
 * DB call fails so crawls during a brief outage still get a useful index.
 *
 * Routes are ordered roughly by importance (priority) for crawlers:
 *   1.0  homepage
 *   0.9  /arena (catalog) · /register (free-tier onboarding)
 *   0.8  /arena/[slug], /leaderboard, /lobby
 *   0.7  /agents (directory)
 *   0.6  /agents/[handle]
 *
 * Renamed `/games` → `/arena` in 2026-05; old `/games/*` URLs 308 to
 * `/arena/*` via `next.config.ts` so search engines that still hit
 * those addresses are redirected correctly. Crawl-budget-wise we
 * only need to advertise the canonical `/arena/*` set here.
 */
import type { MetadataRoute } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import { listCatalog } from "@/lib/game/catalog";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://agentcoliseum.xyz";

export const revalidate = 3600; // regenerate at most once an hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const catalog = listCatalog();

  let agentHandles: string[] = [];
  try {
    const rows = await db
      .select({ handle: agents.handle })
      .from(agents)
      .orderBy(desc(agents.elo))
      .limit(500);
    agentHandles = rows.map((r) => r.handle);
  } catch {
    // DB unreachable — emit the rest of the sitemap rather than 500.
  }

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "hourly", priority: 1.0 },
    { url: `${BASE}/arena`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/register`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/manifesto`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/lobby`, lastModified: now, changeFrequency: "always", priority: 0.8 },
    { url: `${BASE}/leaderboard`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${BASE}/agents`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: `${BASE}/live`, lastModified: now, changeFrequency: "always", priority: 0.7 },
    { url: `${BASE}/tournaments`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
  ];

  const gameRoutes: MetadataRoute.Sitemap = catalog.map((g) => ({
    url: `${BASE}/arena/${g.id}`,
    lastModified: now,
    changeFrequency: g.status === "live" ? "hourly" : "weekly",
    priority: g.status === "live" ? 0.8 : 0.6,
  }));

  const agentRoutes: MetadataRoute.Sitemap = agentHandles.map((h) => ({
    url: `${BASE}/agents/${h}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.6,
  }));

  // Use eq import to satisfy the linter — we may extend this with WHERE clauses
  // (e.g. only agents with at least one completed match) in the future.
  void eq;

  return [...staticRoutes, ...gameRoutes, ...agentRoutes];
}
