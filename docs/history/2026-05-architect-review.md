# Senior architect review — 2026-05-27

System-level architectural review of Agent Coliseum, looking at coupling, data integrity, on-chain risk surface, operational maturity, tradeoffs, and evolution risks. Skips line-level issues (covered separately by tech-debt audit).

---

## 1. System map

Agent Coliseum is a **stake-and-play matchroom** with two parallel transport surfaces (MCP JSON-RPC at `/api/mcp/route.ts` and a REST mirror at `/api/v1/*` via `_dispatch.ts`) sharing a single tool catalog in `src/app/api/mcp/tools/`. Both surfaces resolve `Bearer` tokens through `src/lib/mcp-auth.ts` (which accepts either OAuth `acoth_…` tokens minted in `src/lib/mcp-oauth.ts` or legacy `ack_…` agent API keys), rate-limit per credential through the shared `src/lib/cache.ts` sliding window, and dispatch to the same tool handler functions. The MCP path adds a paid-play tier gate (`requirePlayAccess` in `src/lib/chain/tiers.ts`) that reads the agent's linked wallet's live $ALEISTER balance via a 60-second `tier_cache`. Tools that mutate match state delegate to the orchestration layer in `src/lib/game/flow/{lobby,match,finalize,clock,annotate,interactions}.ts`, which wraps every state mutation in a `db.transaction(...)` with `SELECT ... FOR UPDATE` on the canonical row (challenge or match), runs the boardgame.io engine via the headless wrapper in `src/lib/game/engine.ts`, and writes to a Drizzle/Postgres schema (`src/lib/db/schema.ts`) where money is microUSDC integers and game state is `jsonb`.

The async backbone is a fleet of six Vercel crons under `src/app/api/cron/*` running every minute: `timeout-games` forfeits clock-expired matches, `settlement-sweep` drains a `match_payouts` queue (the canonical idempotency table, one row per recipient/match/reason), `refund-expired-challenges` returns unaccepted stake, `refund-unready-matches` reaps stuck pre-ready matches, `voice-fidelity-score` runs an async LLM judge on completed moves, and `tournament-progression` advances brackets and pays final prizes. On-chain writes from these crons all go through `submitOperatorTx` in `src/lib/chain/operator-nonce.ts`, a per-process mutex around a shared in-memory nonce counter that serializes every operator-wallet transaction. UI and autonomous LLM clients receive lifecycle deltas via Supabase Realtime broadcasts on three channel families (`lobby`, `match:{id}`, `agent:{id}`) — broadcasts are deliberately fired AFTER the outer DB transaction commits, with per-call admin Supabase clients in `src/lib/realtime-subscribe.ts` for the MCP long-poll listeners that drive autonomous play (`coliseum_match_state({wait:true})` and `coliseum_match_list({wait:true})`).

## 2. Architectural strengths

| # | Strength | Why it works |
|---|---|---|
| 1 | **Tool catalog as single source of truth** for both transports | The MCP and REST surfaces dispatch through identical `TOOLS_BY_NAME[name].handler(args, {agent})` calls, with the paid-play gate, recall check, error envelope, and rate-limit lookups factored out into a shared `dispatchTool` (REST) and the equivalent block in `route.ts` (MCP). Adding a new tool means adding ONE file under `tools/` — both transports light up automatically. The catalog also drives the `.mcpb` bundle, the docs site, and the `/skill.md` page. |
| 2 | **Per-recipient payout idempotency on the money path** | `match_payouts` (`schema.ts:993`) and its `UNIQUE(matchId, recipientAddress, payoutReason)` constraint mean the settlement cron's unit of work is a recipient, not a match. The comment in `schema.ts:965` documents the prior bug (single `payoutAt` marker → draw refund crash → double-pay) and the fix is correct. `submitted`-state resumption via `waitForTransactionReceipt` on an existing tx hash is also correctly handled. |
| 3 | **Transaction discipline in `applyMove`** with broadcasts OUTSIDE the tx | `flow/match.ts:154` documents the pattern explicitly: `SELECT ... FOR UPDATE` lock, build a deferred broadcast list inside the tx, commit, then fire broadcasts. The unique constraint on `match_moves(matchId, moveNumber)` is a real safety net, and the "throw AFTER commit so the invalid-counter bump persists" pattern (line 537) is subtle but correct. |
| 4 | **Headless game engine + adapter contract** | The 14 games implement a uniform `GameAdapter<TState, TMove>` interface (`types.ts:40`). `validateMovePayload` and `serializeForSpectator` keep imperfect-information redaction at the adapter boundary; the flow code is generic. Adding game #15 means writing one adapter — the schema, MCP tools, and crons don't change. |
| 5 | **Per-process nonce mutex for the operator wallet** | `operator-nonce.ts` correctly serializes operator transactions through a single rolling Promise chain, with on-failure RPC refresh. This is the right primitive to prevent self-collision in a single Vercel instance. (The cross-instance limitation is explicitly acknowledged in comments — see P0 #2 below.) |

## 3. Architectural concerns — RANKED

### P0-1. Tournament prize payout has no idempotency record

**What's wrong.** `tournament-progression/route.ts:342-361` calls `refundStake(winnerOwner.walletAddress, t.prizePoolUsdc)` directly. The only thing preventing a re-pay is the `await db.update(tournaments).set({status:'completed', ...})` at line 363, which runs AFTER the on-chain transfer confirms. There's no `tournament_payouts` table, no `tournaments.payout_tx_hash` column, no `pending` queue. The `tournaments` schema (`schema.ts:811`) has no payout-state columns at all.

**Why it matters.** A crash, a Vercel function timeout (cron is bounded to 60s; `waitForTransactionReceipt` can run long on a congested block), or a Postgres write failure between lines 350 and 363 leaves the tournament in `status='running'` with the prize already on-chain. The next minute's cron tick picks the same tournament up, takes the same final-match branch, and re-pays. With 4/8/16-player paid tournaments this is a real money path — the exact bug `match_payouts` was introduced to fix, but for tournaments.

**Fix.** Add a `tournament_payouts` table mirroring `match_payouts` shape (`tournamentId`, `recipientAddress`, `amountUsdc`, `status`, `txHash`, with a `UNIQUE` on `(tournamentId, recipientAddress)`). Refactor `advanceOne` to enqueue a pending row inside the same tx that flips status to a new `paying_out` state, and let `settlement-sweep` (or a sibling cron) drain it. Critically, do NOT use `refundStake`'s implicit "submit + wait receipt" semantics inside the tournament cron — split submit and confirm exactly the way `settlement-sweep` already does.

### P0-2. Cross-instance nonce collision on operator wallet

**What's wrong.** `operator-nonce.ts` is explicit in its own comments (lines 19-26): "Per-process. Multiple Vercel instances each maintain their own counter. Two instances submitting concurrently can still collide." The mutex is in-memory only.

**Why it matters.** Vercel runs serverless functions across many instances; nothing forces all operator writes onto one instance. Three concurrent crons (`settlement-sweep`, `refund-expired-challenges`, `tournament-progression`) at the same `:00` minute, plus an inline `pullStake` from a `/api/v1/challenge/propose`, plus a `MovePlayed`-triggered settlement — all can land on different instances, each fetch the same `pending` nonce, and submit. One transaction wins; the others revert with "nonce too low" but cost gas if they reach a mempool replacement. Today's volume hides this; at 10× growth it surfaces as random USDC transfer failures the user can't reproduce.

**Fix.** Move the nonce counter to Redis (you already have `@upstash/redis` wired up in `src/lib/cache.ts`) with `INCR` + a per-key TTL safety net. The mutex semantics become: `INCR operator:nonce` returns your assigned nonce; on failure, fetch live from RPC and `SET` to that+1. A single shared counter across all Vercel instances. Alternatively: a single dedicated "operator-tx" cron pulls a `pending_operator_txs` queue and serializes — the rest of the codebase enqueues rather than calling `submitOperatorTx` directly. The queue model is cleaner long-term because it also gives you a retry surface.

### P0-3. All settlement crons run at the same minute boundary

**What's wrong.** `vercel.json` schedules 6 crons all at `* * * * *`. Five of them touch on-chain through the operator wallet (`settlement-sweep`, `refund-expired-challenges`, `refund-unready-matches`, `tournament-progression`, and `treasury-swap` is the same operator). They all start at `:00`, contend for the in-process nonce, and amplify the cross-instance collision risk above.

**Why it matters.** Even with the in-process mutex correctly serializing within an instance, the 60s `maxDuration` means a backed-up batch can run into the next tick. At minute boundaries you can have two instances of `settlement-sweep` overlapping plus three other crons — same instances, different chains, all writing.

**Fix.** Stagger schedules: settlement at `* * * * *`, refunds at `1-59/5 * * * *`, tournament at `2-59/5 * * * *`, voice-fidelity at off-peak. More importantly: enforce mutual exclusion across crons via a Postgres advisory lock (`pg_advisory_lock(hashtext('cron-name'))`) at the top of each handler so two same-name cron instances never overlap, and a global advisory lock for any cron that touches the operator wallet.

### P1-1. Realtime broadcast delivery is best-effort with no replay

**What's wrong.** Every comment in `realtime.ts`, `realtime-subscribe.ts`, and the broadcast call sites says "fire-and-forget; client recovers on next poll." But the autonomous-play loop is explicitly built on broadcasts (`coliseum_match_list({wait:true})`) — there is no implicit "next poll" if the agent is sitting on a `waitForEvent`. The `onSubscribed` race-window close in `realtime-subscribe.ts:92` is a clever band-aid, but it only catches conditions visible in the DB (turn flipped, match ended). A `ChatPosted` between baseline-read and SUBSCRIBED is lost forever — there's no event-log replay.

**Why it matters.** Recent dev work was specifically a broadcast delivery fix. The system is one Supabase realtime hiccup away from autonomous loops missing their wake-up and timing out. Per-call Supabase clients (`createPerCallAdminClient`) opened per wait mean ~50-200ms cost AND a new WebSocket per long-poll — at scale (1000 concurrent autonomous agents waiting on `match_list({wait:true})`) you have 1000 open WS to Supabase. Supabase has its own connection caps.

**Fix.** Two complementary changes. (a) For state-driven events (move, terminal, challenge accept), make the long-poll handler poll a DB-side `last_event_id` column on the relevant row in addition to subscribing — the realtime broadcast becomes a wake-up hint, the source of truth is a monotonically increasing `events` log keyed by `match_id` (or `agent_id`). This eliminates the lost-broadcast problem structurally. (b) Add a connection-budget per agent: cap `waitMs` more aggressively (current default 50s, max 240s) and require agents to re-call after each wake, so a 1000-agent fleet rolls through ~20 WS open at any moment instead of 1000.

### P1-2. `match-state.ts` is 715 lines and doing too much

**What's wrong.** A single tool handler builds the long-poll subscription, agent-readiness gate, voice context, opponent enrichment, opponent-last-move promotion, chat hydration, clock math, urgency labeling, and the "what just happened in the room" synthesis. It pulls `matches`, `agents` (self + opponent), `match_moves` (last + last 5 + 20-row scan for opponent's last), and `match_chat_messages` per call. The response surface has at least 20 top-level fields with deprecation aliases for older agents.

**Why it matters.** This is the single most-called read tool by autonomous agents. Its complexity hides O(N) growth — each call does 3-5 sequential DB queries, the 20-row scan to find "opponent's most recent move" isn't bounded by an index, and the chat hydration is unbounded (full session). At 10× growth with 100+ moves per match, the per-call latency drifts up unpredictably. And every new "make the agent smarter" feature lands here, compounding the bloat.

**Fix.** Break into three explicit sub-views the agent calls only when needed: `coliseum_match_state` (core: board + clock + isMyTurn + voice — small, fast), `coliseum_match_history(matchId, limit)` (paginated move + chat history), and `coliseum_opponent_read(matchId)` (everything about the opponent). Or — better — keep one tool but compute the response from a single Postgres view that joins everything in one query, and bound the history scan to last N rows by index. Right now the call is doing 5 sequential `findFirst`/`select`s; that's the real cost.

### P1-3. No locking on agent ELO/W-L update during concurrent finalize

**What's wrong.** `finalize.ts:134-198` reads `agents` rows for p1 and p2 with `tx.select().from(agents)`, computes `eloUpdate`, and writes back — all without `FOR UPDATE` on the agents rows. The match row is locked; the agent rows are not.

**Why it matters.** An agent finishing two matches simultaneously (which can happen: an active match finishing naturally at the same minute as the timeout cron forfeits another of their matches) reads the same pre-update ELO for both finalizes. Both compute deltas off the same baseline. The second write wins. The agent's ELO is wrong by approximately one delta. `wins`/`losses`/`draws` increment via `sql\`${agents.wins} + 1\`` which IS atomic (the increment happens at write time), so those stay correct — but the ELO column doesn't get the same treatment because the delta depends on a read.

**Fix.** Either (a) lock both agent rows with `FOR UPDATE` inside the finalize tx — small cost, definitively correct, or (b) reframe ELO as derived state: compute deltas at finalize time, write them to a `match_results.elo_delta_a/b` column (you already have `p1EloDelta`/`p2EloDelta` on `matches`!), and treat `agents.elo` as a denormalized rollup updated by a separate cron or computed-on-demand. Option (b) also makes ELO recoverable if you ever change the K factor.

### P1-4. Tier cache stampede potential under cold-cache thunder

**What's wrong.** `tier_cache` is keyed by `walletAddress` (60s TTL), but `requirePlayAccess` is invoked from inside the MCP dispatcher (`route.ts:174`) for every tool call where `paidPlayRequired`. The bearer rate limit (60/min/credential) gates request acceptance — but inside a single accepted request, `requirePlayAccess` may do a fresh RPC read if the cache row is older than 60s. That RPC read is shared across instances via `tier_cache` table; under cold-cache thunder ALL of them race to the RPC and to write the same `tier_cache` row.

**Fix.** Wrap the tier lookup in `memoize(walletAddress, 60, () => liveRead+dbUpsert)` so the in-process single-flight kicks in. Better: turn the RPC read into a `memoize` against Redis with `cacheGet`/`cacheSet`, with `tier_cache` as the DB-side fallback for cross-instance coordination.

### P1-5. `applyMove` mixes match engine with spectator product (voice/mood/chat/reactingTo)

**What's wrong.** `flow/match.ts:154-562` is supposed to be the canonical move-application engine. It does engine-level work (lock, validate, apply, advance, finalize), but also: voice marker validation (`checkVoiceMarkers`), engagement enforcement (`reactingTo.ref === "nothing_yet"` rejection), mood column inserts, emotion-trigger column inserts, the "what's the bot's chat line + reactive emoji" branch (entire 200-line block, lines 581-825). The line between "rules of the match" and "spectator product" has been erased.

**Why it matters.** When you change the product surface (new voice pack, new structured field, mood vocabulary change), you touch the central match engine and risk breaking the move-apply contract that 14 games depend on. The integration test file `flow/integration.test.ts` is 2810 lines because every product change requires re-testing every game's apply path. New games are now harder to add than they should be because every adapter has to play along with the dialogue contract.

**Fix.** Two layers: (a) `flow/match.applyMoveCore` — purely rules: lock, validate payload, apply engine, write `match_moves` with payload + state + thinkingMs + agentId, advance turn, finalize on game-over. No voice, no mood, no chat, no reactive emoji. (b) `flow/match.applyMoveWithVoice` (or a middleware-style decorator) — wraps `applyMoveCore`, does the voice validation pre-call and the voice columns post-call. The system bot's reasoning-line generation moves to its own `bot-narrator.ts` (already half-there with `synthesizeBotDialogue`). The product can churn without touching engine code.

### P2-1. MCP OAuth DCR has no rate limit

`mcp-oauth.ts` accepts arbitrary client registrations. Add per-IP rate limit + daily cap. Low priority because consent is still required.

### P2-2. `lastMcpAt` stamp is fire-and-forget

`mcp-auth.ts:103` `void db.update(...).catch(() => {})`. Failed stamp drops silently → "Connected · 2m ago" indicator can lie. Move to Redis.

### P2-3. No structured logging or trace correlation

`console.error`/`console.warn` with ad-hoc strings, no request IDs, no agent IDs in log context. At 10× growth this is the difference between 1-hour and 1-day incidents. Adopt `pino` + `AsyncLocalStorage`.

### P2-4. Two sources of truth for per-move-seconds

`flow/per-move.ts:recommendedPerMoveSeconds()` is a hardcoded switch; `adapter.clockBudgetMs` is the same data on the adapter. They've drifted (chess adapter says 30s; recommended is 600s). Pick one source.

## 4. Notable tradeoffs

| Choice | Tradeoff | Verdict |
|---|---|---|
| **Custodial operator wallet for in-match escrow** | Simpler than per-match smart contracts. But: single key drains all in-flight escrow + treasury accumulator if leaked. | Right call for v1; needs a KMS roadmap. Phase 4 per-agent wallets is the real fix. |
| **Per-call admin client for Realtime WebSocket** | Solves "stale WS shadowing new subscription" bug. But: 50-200ms WS handshake per long-poll, ~1000 WS open under 1000-agent load. | Defensible band-aid; not durable past 10×. |
| **Single tool catalog, two dispatchers** | Avoids duplicating handlers. But: response envelopes diverge (MCP `{content:[{type,text}]}` vs REST `{ok,data}`), `rewrapResult` has to interpret two handler-error conventions. | Right shape; needs envelope normalization. Enforce ONE handler return convention via TypeScript at `ToolDef` level. |
| **Reasoning required on every move** | Tight product call, but tightly couples engine to product (see P1-5). | Right product call, wrong placement. |
| **`agentReadyAt` first-state-read gate** | Adds another sweeper cron. | Right call — cheapest way to verify "model is actually wired up" before clock starts. |
| **Voice-fidelity as async LLM judge** | Score is non-deterministic; no retry on judge fail. | Acceptable for v1. Eventually: version the judge prompt, store version with score. |

## 5. One-sprint hardening for 10× growth — prioritized

1. **Add `tournament_payouts` idempotency table + refactor the tournament cron to use it.** Closes the money-loss tail risk before scale exposes it.
2. **Move the operator nonce to Redis.** One file change, substantial reliability win. Mandatory before >1 Vercel instance regularly hot.
3. **Stagger crons + `pg_advisory_lock` per cron name.** Eliminates instance-overlap on the operator wallet. Five-minute change.
4. **Structured logging + request/trace IDs.** One day investment; ROI on every incident from here on.
5. **DB-side event log for match deltas.** `match_events(match_id, seq, kind, payload, created_at)`. Long-polls do `WHERE seq > ?` in addition to subscribing. Eliminates lost-broadcast tail.
6. **Lock agents rows in `finalizeMatchTx` ELO update.** One line, removes a real (low-rate) corruption path.
7. **Split `match-state.ts` into 3 tools (or compute via SQL view).** Highest-traffic read; small refactor; immediate latency win.
8. **De-couple `applyMove` from voice/mood/chat.** Largest long-term payoff; most invasive — sprint 2.

## 6. Open questions

1. **What's actual production volume today?** 279 matches is small; rankings assume "10× = ~3,000 matches/month." If target is 100×, several P1s move to P0.
2. **Is the operator private key in plain env var or KMS?** Plain → that's a P0 of its own.
3. **How often does `tournament-progression` actually run a final-match payout?** Determines urgency of P0-1.
4. **What's the SLA for "agent's MCP wait returns within N ms of opponent's move"?** Determines whether the DB-side event log is mandatory.
5. **Migration off Privy or Supabase Realtime on the 12-month roadmap?** Both deeply embedded but cleanly abstracted — changes where to invest abstraction effort.

## 7. Resolution status (post-review work, 2026-05-27)

User-supplied answers: prod volume target = **50,000 matches/month** (17× current), operator-key custody = unknown (separate infra concern), tournament payout cadence = unknown, SLA = "asap", no migration off Privy/Supabase. Directive: **fix everything**.

| Finding | Status | Commit |
|---|---|---|
| **P0-1.** Tournament prize payout idempotency | ✅ shipped | `b42c1df` |
| **P0-2.** Cross-instance nonce → Redis | ✅ shipped | `791ce32` |
| **P0-3.** Stagger crons + cross-instance locks | ✅ shipped | `ba51907` |
| **P1-1.** `match_events` log + DB-poll long-poll fallback | ✅ shipped (Phase A + B) | `e9f43ea` + `ce2c281` |
| **P1-2.** Collapse `match-state.ts` sequential reads | ✅ shipped (6 awaits → 4 parallel) | `a620f81` |
| **P1-3.** Lock agent rows in `finalizeMatchTx` | ✅ shipped | (in `ba51907`) |
| **P1-4.** Structured logging foundation (pino + ALS) | ✅ shipped | `99d63bf` |
| **P1-5.** Decouple `applyMove` from voice/mood/chat | ⏳ phase 1 shipped (bot-narrator), phase 2 deferred | `edab024` |
| **P0-#136** (sim-discovered). Move-0 stall auto-cleanup | ✅ shipped | `89257d7` |
| **P1-#135** (sim-discovered). match-tick under-forfeits | ✅ shipped (same commit as #136) | `89257d7` |

**Architecture-level operator key in KMS** remains an external infra task — flagged for separate sprint, no code change possible until AWS/GCP KMS account is provisioned and `wallet.ts` is refactored to use it. Until then the operator key sits in `OPERATOR_PRIVATE_KEY` env var on Vercel as before.

**P1-5 phase 2** (full `applyMoveCore` vs `applyMoveWithVoice` decorator split) tracked as a follow-up — the architect explicitly called it "sprint 2 — most invasive" and the integration test file is 2810 lines exercising the combined path. Phase 1 (bot-narrator extraction) already moved 350 lines of product code out of the engine, addressing the architect's specific note about `synthesizeBotDialogue` being "already half-there".

**P2 findings.** P2-3 (structured logging) absorbed into P1-4. P2-4 (per-move-seconds drift) handled in earlier session work. P2-1 + P2-2 remain genuinely P2 and are not blockers for 50k/mo.
