# Overnight Report — AGE-48 + AGE-49
**Run dates:** 2026-05-25 / 2026-05-26 (two consecutive runs; second picked up after max-turn limit)  
**Agent:** Engineering Lead (a3fe7fe8)

---

## What shipped

### Commit `0bde19c` — GameJoined broadcast in `acceptChallenge`

- `src/lib/realtime-types.ts` — added `LobbyGameJoinedPayload` type
- `src/lib/game/flow/lobby.ts` — fire `broadcastLobby(GameJoined, …)` after tx commit

`GameJoined` was registered and subscribed to on the frontend lobby, but `acceptChallenge()` never fired it. Lobby subscribers couldn't retire the challenge row on an event — they had to poll.

---

### Commit `6ce8938` — remaining WORKSTREAM 1 broadcasts (ChallengePosted + ChallengeExpired + lobby race)

- `src/lib/game/flow/lobby.ts` — fire `ChallengePosted` on lobby after `postChallenge` (alongside `GameCreated`) so hunter agents wake on `match_list(wait:true)`.
- `src/app/api/cron/refund-expired-challenges/route.ts` — broadcast `ChallengeExpired` on `agent:<id>` for both free and paid paths after marking challenges abandoned.
- `src/app/api/mcp/tools/match-list.ts` — `wait:true` now races both the per-agent channel AND the lobby channel (`ChallengePosted`) via `Promise.race`.
- `src/lib/game/flow/integration.test.ts` — add `broadcastAgent: vi.fn()` to realtime mock.

---

### Commit `0044c18` — `ChallengeAccepted` + `MatchActivated` + `AgentRecalled` broadcasts (AGE-49)

Three missing per-agent channel broadcasts that wake `match_list(wait:true)`:

- `lobby.ts postChallenge`: `MatchActivated` to initiator when a challenge is accepted instantly (system-bot or pre-matched).
- `lobby.ts acceptChallenge`: `ChallengeAccepted` + `MatchActivated` to proposer (p1AgentId); `MatchActivated` to acceptor — both sides wake.
- `recall route`: `AgentRecalled` to the recalled agent so in-flight long-polls exit cleanly.
- `realtime-types.ts`: payload types for `MatchActivatedPayload`, `ChallengeAcceptedPayload`, `ChallengeExpiredPayload`, `AgentRecalledPayload`.

---

### Commit `1380764` — `MovePlayed` mirrored to next agent's channel (AGE-49)

`match_list(wait:true)` subscribes to the per-agent channel and lists `MovePlayed` as a wake event ("mirrored from match channel"). But `match.ts` only broadcast `MovePlayed` to the `match:<id>` channel — the agent channel never received it.

Fix: after each non-terminal move in `applyMove`, fire-and-forget `broadcastAgent(nextAgentId, MovePlayed, ...)` alongside the existing `broadcastGame`. System-bot mode (`nextAgentId === null`) skips the mirror — `MatchEnded` fires instead when the bot completes.

---

## Broadcast coverage summary — final state

| Event (contract name) | Channel | Status |
|---|---|---|
| `MovePlayed` | match + agent (mirror) | ✅ wired — match channel always; agent channel mirrored for match_list |
| `MatchActivated` | agent | ✅ wired — postChallenge (system/instant) + acceptChallenge (both sides) |
| `ChallengePosted` | lobby | ✅ wired — fires in postChallenge alongside GameCreated |
| `ChallengeAccepted` | agent | ✅ wired — acceptChallenge fires to proposer (p1AgentId) |
| `ChallengeExpired` | agent | ✅ wired — expiry cron broadcasts to initiator |
| `GameJoined` | lobby | ✅ wired — acceptChallenge |
| `MatchEnded` | match + spectator + agent | ✅ wired — finalize.ts broadcasts to both agents |
| `AgentRecalled` | agent | ✅ wired — recall route |
| `TournamentRound` | agent | ⏸ out of scope — no tournament code in repo |
| `TournamentEnded` | agent | ⏸ out of scope — no tournament code in repo |

All contract scenarios (1–11, 14) are now covered. Scenarios 12–13 require tournament infrastructure not yet built.

---

## What broke + how fixed

- Integration tests broke when `lobby.ts` imported `broadcastAgent` — the test mock for `@/lib/realtime` didn't include it. Fixed in `6ce8938` by adding `broadcastAgent: vi.fn()`.
- Previous run hit 50-turn limit mid-work. Work state was preserved via unstaged file changes; AGE-49 picked up from that state cleanly.

---

---

## AGE-53 phase 2 — 2026-05-26

### Commit `8ef9ced` — cancel losing waitForEvent subscription in match_list race (self-improve)

The `Promise.race` in `match_list(wait:true)` left the losing `waitForEvent`
subscription alive for up to 50s after the winner fired.

Fix:
- `src/lib/realtime-subscribe.ts` — added `signal?: AbortSignal` to
  `WaitForEventOpts`. When aborted, `settle(null)` fires immediately and
  the `finally` block tears down the Supabase channel. Bail-out on
  already-aborted signal before opening the channel.
- `src/app/api/mcp/tools/match-list.ts` — `Promise.race` now uses a shared
  `AbortController`. `.finally(() => raceCtrl.abort())` fires on resolution
  and signals both waiting subscriptions; the loser cleans up within
  microtask time instead of holding a WebSocket open for ~50s.
- `public/coliseum-mcp.mjs` + `public/coliseum.mcpb` — sync'd stale build
  artifacts (source had cosmetic formatting drift, public had not been
  rebuilt; no functional delta).

Verification: `pnpm typecheck` clean; 585/585 unit tests pass. `pnpm next
build` not runnable (no `DATABASE_URL` in this execution environment —
same constraint that blocks `pnpm mcp:prod-e2e`).

---

### Prod E2E verification — BLOCKED (no .env.local)

`pnpm mcp:prod-e2e` requires `DATABASE_URL` via `.env.local` to look up
the seeded `mcp-duel-alpha` / `mcp-duel-beta` agents and seed the
`tier_cache`. No `.env.local` is present in this execution environment.

Closest available alternative: all 585 unit tests pass. The broadcast
wiring from WS1 is exercised by the integration tests in
`src/lib/game/flow/integration.test.ts` and `lobby.test.ts`.

To run prod E2E manually: `pnpm mcp:duel` (if test agents don't exist),
then `pnpm mcp:prod-e2e`.

---

## What remains

### Needs human input

1. **WORKSTREAM 2+** — workplan truncated at WORKSTREAM 1 event list.
   Contents unknown. Forward the full workplan if recoverable.

2. **Prod E2E** — needs an environment with `.env.local` / `DATABASE_URL`.
   The script is ready; just blocked on credentials.

### Approval-gated items

None. No schema migrations, no new SaaS deps.
