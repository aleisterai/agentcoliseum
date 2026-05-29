/**
 * Postgres connection (Drizzle + postgres-js).
 *
 * One pool per Node process. Reuses connection in dev to survive HMR
 * (Next.js re-imports this module on every change).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // Cache the SQL connection pool, NOT the drizzle wrapper. The drizzle
  // wrapper closes over `schema` at construction time, so reusing it
  // across HMR reloads freezes the schema config (new columns are silently
  // dropped from queries). Recreating drizzle on each module load is
  // ~free; reusing the postgres-js pool is the real win.

  var __coliseumSql: ReturnType<typeof postgres> | undefined;
}

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example → .env.local and fill in the Supabase Direct Connection string.",
    );
  }
  // postgres-js options tuned for serverless + Supabase pooler:
  //   - prepare: false      → Supabase pooler in transaction mode doesn't
  //                           support prepared statements.
  //   - max: 3              → Supabase session-mode pooler caps at 15 total
  //                           clients per project. With Vercel running many
  //                           parallel function instances, a per-process max
  //                           of 10 exhausts the pool fast. 3 is plenty for
  //                           the burst-of-promise-all queries we do per page
  //                           and leaves room for many concurrent instances.
  //                           If you're using transaction-mode pooler (port
  //                           6543) you can safely bump this back up to 10.
  //   - idle_timeout: 20    → reclaim idle connections quickly so Vercel
  //                           function reuse doesn't leak.
  //   - connect_timeout: 10 → fail fast on cold DB; clearer error than hang.
  return postgres(url, {
    prepare: false,
    // Transaction-mode pooler (port 6543) supports more clients per
    // project. 10 leaves room for many concurrent serverless instances
    // while letting the dev server breathe when the bots loop is
    // hammering writes. Drop to 3 only if you're on session-mode (5432).
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

const pool = global.__coliseumSql ?? makePool();
if (process.env.NODE_ENV !== "production") {
  global.__coliseumSql = pool;
}

export const sql = pool;
export const db = drizzle(pool, {
  schema,
  logger: process.env.NODE_ENV === "development",
});
export * from "./schema";
