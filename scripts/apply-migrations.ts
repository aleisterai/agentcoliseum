#!/usr/bin/env tsx
/**
 * apply-migrations — manually apply pending SQL migration files against
 * the production database. Used when `drizzle-kit push` chokes on
 * existing schema (a known issue with some CHECK constraints in older
 * Postgres versions of the drizzle-kit version we're pinned to).
 *
 * Reads /src/lib/db/migrations/*.sql, ordered by filename. Skips
 * migrations already recorded in a tiny `_applied_migrations`
 * tracking table.
 *
 * Run:  node --env-file=.env.local --import tsx scripts/apply-migrations.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Work in CJS (tsx) AND ESM modes. We resolve the script's own
// directory from import.meta.url (set by tsx) and fall through to
// process.cwd() if neither is available.
const HERE = (() => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    /* import.meta not available in some CJS contexts */
  }
  return join(process.cwd(), "scripts");
})();
const ROOT = resolve(HERE, "..");
const MIGRATIONS_DIR = join(ROOT, "src", "lib", "db", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: "require" });

  // Tracking table — idempotent.
  await sql`
    CREATE TABLE IF NOT EXISTS "_applied_migrations" (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = await sql<{ tag: string }[]>`SELECT tag FROM "_applied_migrations"`;
  const appliedSet = new Set(applied.map((r) => r.tag));

  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  for (const file of sqlFiles) {
    const tag = file.replace(/\.sql$/, "");
    if (appliedSet.has(tag)) {
      console.log(`skip  ${tag} (already applied)`);
      continue;
    }
    const path = join(MIGRATIONS_DIR, file);
    const body = await readFile(path, "utf8");
    // Strip the drizzle "statement-breakpoint" comments + split on them.
    const statements = body
      .split(/-->[ ]*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`apply ${tag} (${statements.length} statements)`);
    try {
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`INSERT INTO "_applied_migrations" (tag) VALUES (${tag})`;
      });
      console.log(`  ✓ ${tag}`);
    } catch (err) {
      // For baseline migrations that already partially exist (most of
      // the 0000_baseline / 0001 stuff), mark them as applied without
      // re-running so future ADD-COLUMN migrations can proceed.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists/.test(msg) && tag.startsWith("0000") || /already exists/.test(msg) && tag.startsWith("0001")) {
        console.log(`  ~ ${tag} (already-exists; marking as applied)`);
        await sql`INSERT INTO "_applied_migrations" (tag) VALUES (${tag})`;
        continue;
      }
      console.error(`  ✗ ${tag}:`, msg);
      throw err;
    }
  }

  await sql.end();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
