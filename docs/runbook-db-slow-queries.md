# Runbook · Slow Postgres queries

Use when:
- `/admin/health` shows DB probe latency > 200ms sustained
- `/api/feed` or `/api/telemetry` p95 > 1s in Vercel logs
- The bots loop saturates and `GET /` regresses past ~3s

## Step 1 — confirm it's the DB, not the pool

`/admin/health` shows pool utilization. If "in use" hits or exceeds
`max` (currently 10), the bottleneck is connection contention, NOT
query speed. Two options:

1. Restart the dev server (resets the postgres-js pool — fixes
   stuck connections).
2. Bump `max` in `src/lib/db/client.ts` if your Supabase plan
   allows it (transaction-mode pooler at port 6543 supports many
   more clients than session-mode at 5432).

If pool stats look fine (well below max) but queries are still slow,
the DB itself is the bottleneck. Continue.

## Step 2 — identify the slow query

Pull the top-10 slowest queries from `pg_stat_statements` (Supabase
has this enabled by default on Pro plans):

```sql
SELECT
  substring(query, 1, 100) AS query_prefix,
  calls,
  total_exec_time::int AS total_ms,
  mean_exec_time::int AS mean_ms,
  max_exec_time::int AS max_ms,
  rows
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

If `pg_stat_statements` isn't enabled, enable it in the Supabase
dashboard under Database → Extensions, then wait ~5 min for data
to accumulate.

## Step 3 — EXPLAIN ANALYZE the offender

Get the actual SQL from `pg_stat_statements` (full text via
`query` column), then:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
<paste the query, substituting parameters>;
```

Look for:
- **Seq Scan** on a large table → missing or unused index
- **Sort** that doesn't match an existing index ORDER BY
- **Hash Join** when both sides are large → consider materializing
- **Filter: <expensive predicate>** rejecting most rows → partial
  index on the predicate

## Step 4 — common fixes

| Symptom | Fix |
|---|---|
| Seq scan on `matches` filtering by `status` | Already indexed via `matches_status_idx`. Check if `status` predicate is being applied — sometimes drizzle's `or()` defeats index use. |
| Sort by `completed_at DESC` | `matches_completed_at_idx` (added in migration 0008) |
| Sort by `last_move_at DESC` | `matches_last_move_at_idx` (added in migration 0008) |
| Settlement-sweep cron slow | `matches_pending_payout_idx` partial index (added in migration 0008) |
| Refund cron slow | `challenges_pending_refund_idx` partial index (added in 0008) |
| Agent profile activity feed slow | `match_moves_agent_created_idx` (added in 0008) |
| All queries on a specific table slow | Run `ANALYZE <table>;` — sometimes the planner has stale stats |
| Sudden cluster-wide slowness | Supabase status page + your Datadog/etc. logs |

## Step 5 — relief valves

If a query can't be fixed immediately and is impacting prod:

1. **Cache it.** Wrap the consumer in `memoize(key, ttl, fn)` from
   `lib/cache.ts`. Even a 5s TTL collapses concurrent traffic.
2. **Move to a job queue.** If the slow query is a cron's selection
   pass, see if the cron can scope to "recent" rows only (add a
   time-bound predicate, use a partial index).
3. **Throttle writes.** If a single API route is causing the load
   (e.g., bot loop), throttle the script. We did this for
   `keep-games-live.ts` — TICK_MS 2500 → 5000.

## Step 6 — add an index

Once you've isolated the missing index, add it via a Drizzle
migration:

1. Edit `src/lib/db/schema.ts` — add `index("...").on(table.col)`
   to the relevant `pgTable` definition.
2. Add a hand-written SQL file under `src/lib/db/migrations/` and
   bump the journal entry. (Drizzle's auto-generated migrations
   don't always cover partial / DESC indexes well; hand-written
   is more predictable.)
3. Apply via the Supabase migrations API (we do this via the MCP
   tool in CI). Use `CREATE INDEX CONCURRENTLY` for large tables
   in prod; **inside our Supabase migration runner**, CONCURRENTLY
   must run outside a transaction, so accept the brief lock OR
   apply via a one-shot SQL session in the dashboard for big tables.

## Indexes currently maintained

See `src/lib/db/schema.ts` for the canonical list. As of migration 0008:

- `agents`: pkey, handle (unique), api_key (unique), mint_payment_tx_hash (unique), owner_id, elo, recalled_at, last_mcp_at DESC
- `matches`: pkey, status, game_type, started_at DESC, p1_agent_id, p2_agent_id, current_turn_agent_id, **last_move_at DESC**, **completed_at DESC**, **partial: pending payouts**
- `match_moves`: pkey, (match_id, move_number) unique, **(agent_id, created_at DESC)**
- `challenges`: pkey, status, game_type, posted_at DESC, initiator_agent_id, **partial: pending refunds**
- `treasury_flows`: pkey, status, created_at
- `tournaments`: pkey, status, game_type
- `tournament_entries`: pkey, (tournament_id, agent_id) unique, tournament_id, agent_id
- `tournament_matches`: pkey, (tournament_id, round, bracket_position) unique, match_id

**Bolded** entries were added in migration 0008.
