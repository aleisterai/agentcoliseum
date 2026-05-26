# Overnight Report — AGE-48
**Run date:** 2026-05-25 / 2026-05-26  
**Agent:** Engineering Lead (a3fe7fe8)

---

## What shipped

### Commit `0bde19c` — GameJoined broadcast in `acceptChallenge`

- `src/lib/realtime-types.ts` — added `LobbyGameJoinedPayload` type
- `src/lib/game/flow/lobby.ts` — fire `broadcastLobby(GameJoined, …)` after tx commit

`GameJoined` was registered and subscribed to on the frontend lobby, but `acceptChallenge()` never fired it. Lobby subscribers couldn't retire the challenge row on an event — they had to poll. Pattern: fire-and-forget via `void broadcastLobby(...)` AFTER the `db.transaction` commits, mirroring `finalize.ts`.

---

### Commit `b53bf9d` — overnight report + questions (HARD-RULE-8 stops)

Previous run stopped correctly at ambiguous items. The contract doc (`docs-site/content/docs/autonomous-play/index.mdx`) turned out to exist and resolved the questions.

---

### Commit `6ce8938` — remaining WORKSTREAM 1 broadcasts

**Files changed:**
- `src/lib/game/flow/lobby.ts` — also fire `ChallengePosted` (challenge.posted) on lobby after `postChallenge` creates a free/paid challenge, so hunter agents wake on `match_list(wait:true)`.
- `src/app/api/cron/refund-expired-challenges/route.ts` — broadcast `ChallengeExpired` on `agent:<id>` for both free and paid paths after marking challenges abandoned.
- `src/app/api/mcp/tools/match-list.ts` — `wait:true` now races both the per-agent channel AND the lobby channel (`ChallengePosted`) via `Promise.race`. Hunter agents wake on new challenges, not just lifecycle events.
- `src/lib/game/flow/integration.test.ts` — add `broadcastAgent: vi.fn()` to realtime mock; 57 tests were failing due to the new import.

**Verification:** `pnpm typecheck` clean · `pnpm test` 585/585 green.

---

## Broadcast coverage summary — final state

| Event (contract name) | Channel | Status |
|---|---|---|
| `OpponentMoved` | match | ✅ committed (broadcastGame in match.ts) |
| `MatchStarted` / `MatchActivated` | agent | ✅ committed — fires in `postChallenge` (system mode) + `acceptChallenge` |
| `ChallengePosted` | lobby | ✅ shipped this run (6ce8938) |
| `ChallengeAccepted` | agent + lobby | ✅ committed — agent channel fires in `acceptChallenge` for proposer + acceptor; lobby via `GameJoined` (0bde19c) |
| `ChallengeExpired` | agent | ✅ shipped this run (6ce8938) — fires in expiry cron |
| `MatchEnded` | match + spectator + agent | ✅ committed — broadcastGame + broadcastLobby + broadcastAgent in finalize.ts |
| `ClockExpired` | match | ✅ committed — time_forfeit path runs through finalize which fires GameEnded |
| `AgentRecalled` | agent | ✅ committed — fires in recall route |
| `TournamentRoundStarted` | agent | ⏸ out of scope — no tournament code in repo |
| `TournamentEliminated` | agent | ⏸ out of scope — no tournament code in repo |

---

## What broke + how fixed

- 57 integration tests broke when `lobby.ts` imported `broadcastAgent` — the test mock for `@/lib/realtime` didn't include it. Fixed in the same commit by adding `broadcastAgent: vi.fn(() => Promise.resolve())` to the mock.

---

## What's queued for the human (morning)

### Decision-free queue (can ship any time)

1. **`match_list(wait:true)` lobby-race cleanup** — the `Promise.race` pattern leaves the losing `waitForEvent` subscription alive until it times out (up to 50s). A future refactor could extend `waitForEvent` to accept multiple channels and share a single WebSocket, but this is a performance improvement, not a correctness fix. Log as tech debt if desired.

2. **`MovePlayed` in match_list events list** — `match-list.ts` lists `realtimeEvent.MovePlayed` as an agent-channel event (comment: "mirrored from match channel"), but no code actually broadcasts `MovePlayed` on the agent channel — only on `match:<id>`. The contract doc says `OpponentMoved` wakes `match_state` but NOT `match_list`, so this entry is dead code. Safe to remove without behaviour change.

### Needs human input

3. **WORKSTREAM 2+** — workplan was truncated. Content unknown. If you want to forward the full overnight workplan, I'll continue.

4. **Prod E2E smoke test** — `pnpm mcp:prod-e2e` was called out in the workplan. The script exists but I didn't run it against prod; that would require live agent credentials and a real network call. If you want this run in a follow-up heartbeat, say so.

### Approval-gated items

None. No schema migrations, no new SaaS deps. Vercel trunk deploy will pick up `6ce8938` automatically.
