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
  // eslint-disable-next-line no-var
  var __coliseumDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __coliseumSql: ReturnType<typeof postgres> | undefined;
}

function makeClient() {
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
  const sql = postgres(url, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema, logger: process.env.NODE_ENV === "development" });
  return { db, sql };
}

const cached =
  global.__coliseumDb && global.__coliseumSql
    ? { db: global.__coliseumDb, sql: global.__coliseumSql }
    : makeClient();

if (process.env.NODE_ENV !== "production") {
  global.__coliseumDb = cached.db;
  global.__coliseumSql = cached.sql;
}

export const db = cached.db;
export const sql = cached.sql;
export * from "./schema";
