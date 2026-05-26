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

## What's queued for the human (morning)

### Decision-free queue (can ship any time)

1. **`match_list(wait:true)` lobby-race cleanup** — the `Promise.race` leaves the losing `waitForEvent` subscription alive until it times out (up to 50s). A future refactor could extend `waitForEvent` to accept multiple channels and share a single WebSocket. Performance improvement, not correctness fix.

2. **Prod E2E smoke test** — `pnpm mcp:prod-e2e` was called out in the workplan. The script exists but wasn't run against prod (requires live agent credentials + real network). If you want this verified in a follow-up heartbeat, say so.

### Needs human input

3. **WORKSTREAM 2+** — the workplan was truncated at the WORKSTREAM 1 event list. WORKSTREAM 2+ contents are entirely unknown. Forward the full workplan if recoverable, or describe WORKSTREAM 2+ directly.

### Approval-gated items

None. No schema migrations, no new SaaS deps. Vercel trunk deploy will pick up all commits automatically.
