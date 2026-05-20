/**
 * Test DB harness — in-process Postgres via pglite (WASM Postgres),
 * with the live Drizzle schema pushed in via drizzle-kit's `pushSchema`.
 *
 * Why pglite over alternatives:
 *   - testcontainers: requires Docker; slow startup (~5s); CI-hostile
 *   - pg-mem: not real Postgres; lacks SELECT FOR UPDATE, transactions
 *   - shared dev DB: couples tests to live state
 *   - pglite: real Postgres in ~100ms, no Docker, isolated per call
 *
 * Why pushSchema over migration replay: the migrations directory has
 * gaps (some tables were created via `drizzle-kit push` during early
 * dev without a corresponding migration file). pushSchema reads
 * schema.ts directly and emits the DDL drizzle-kit would generate,
 * matching whatever the schema currently says.
 *
 * Usage:
 *
 *   import { withTestDb } from "../../test/db-harness";
 *
 *   it("does the thing", async () => {
 *     await withTestDb(async ({ db, sql }) => {
 *       await db.insert(owners).values({ ... });
 *       const rows = await db.select().from(owners);
 *       expect(rows).toHaveLength(1);
 *     });
 *   });
 *
 * Each call gets a FRESH pglite instance — no leakage between tests,
 * no per-suite cleanup. The instance is GC'd at function exit.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "../src/lib/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbContext {
  db: TestDb;
  pg: PGlite;
}

/**
 * Run `fn` with a fresh in-process Postgres. The DB has the full
 * production schema pushed in (every table + enum + index in
 * src/lib/db/schema.ts). Closes the connection on exit.
 */
export async function withTestDb<T>(
  fn: (ctx: TestDbContext) => Promise<T>,
): Promise<T> {
  const pg = await PGlite.create();
  // drizzle-orm's pglite driver. The cast through `unknown` is because
  // pglite's client type doesn't perfectly match drizzle's expectation —
  // works at runtime, types just need a nudge.
  const db = drizzle(pg as unknown as never, { schema, casing: "snake_case" });

  try {
    // pushSchema takes the imported schema module + a drizzle instance
    // and applies whatever DDL is needed to bring the DB to match.
    // Against an empty pglite that means "create every table + enum +
    // index" — exactly what we want for tests.
    const { apply } = await pushSchema(
      schema as unknown as Record<string, unknown>,
      db as unknown as Parameters<typeof pushSchema>[1],
    );
    await apply();
    return await fn({ db, pg });
  } finally {
    await pg.close();
  }
}

/**
 * Sugar for tests that just need the `db` object — no need to destructure.
 */
export async function withTestDbDb<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
  return withTestDb(({ db }) => fn(db));
}
