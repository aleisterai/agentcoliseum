# Overnight Report — AGE-48
**Run date:** 2026-05-25  
**Agent:** Engineering Lead (a3fe7fe8)

---

## What shipped

### GameJoined broadcast — `acceptChallenge` (commit `0bde19c`)

**Files changed:**
- `src/lib/realtime-types.ts` — added `LobbyGameJoinedPayload` type
- `src/lib/game/flow/lobby.ts` — fire `broadcastLobby(GameJoined, …)` after tx commit

**Why:** `GameJoined` was registered in `realtimeEvent` (supabase.ts) and in the frontend
lobby subscriber since initial design, but `acceptChallenge()` committed the match row
and returned without firing anything on the lobby channel. Lobby subscribers couldn't
retire the challenge row on an event; they had to poll. Any future `match_list(wait:true)`
long-poll listening to the lobby channel would never wake on a challenge-accepted event.

**Pattern:** fire-and-forget via `void broadcastLobby(...)` AFTER the `db.transaction`
commits — identical to `fireFinalizeBroadcasts` in finalize.ts. Broadcast failure does
not fail the accept.

**Verification:** `pnpm typecheck` clean · `pnpm test` 585/585 green.

---

## What broke + how fixed

Nothing broke. All 585 pre-existing tests still pass.

---

## What's queued for the human (morning)

### Needs a decision before implementation can continue

1. **Contract doc is missing** — `docs-site/content/docs/autonomous-play/index.mdx`
   does not exist. The complete WORKSTREAM 1 event list can't be recovered without it.
   See OVERNIGHT-QUESTIONS.md Q1.

2. **`broadcastAgent` semantics unknown** — the workplan references a `broadcastAgent`
   function and per-agent channels. Neither exists in the codebase. Needs design
   clarification before building. See OVERNIGHT-QUESTIONS.md Q2.

3. **`match_list(wait:true)` is not implemented** — the current tool is a point-in-time
   read. The long-poll mechanism needs a design before building. See
   OVERNIGHT-QUESTIONS.md Q3.

4. **WORKSTREAM 2+** — workplan was truncated. Contents unknown. See
   OVERNIGHT-QUESTIONS.md Q4.

### Approval-gated items

None. No schema migrations, no new SaaS deps, no prod deploy changes triggered this run.
The Vercel trunk deploy will pick up commit `0bde19c` automatically (no human action needed
for the code that shipped).

---

## Broadcast coverage summary (WORKSTREAM 1 audit)

| Event | Channel | Status |
|---|---|---|
| `game.created` | lobby | **partial** — fired for free/paid, not system-mode |
| `game.joined` | lobby | **shipped** this run (was missing) |
| `move.played` | match:{id} | present |
| `match.ended` | match:{id} + lobby | present |
| `chat.message` | match:{id} | present |
| `reaction` | match:{id} | present |
| `reaction.added` | match:{id} | present |
| `chat.posted` | match:{id} | present |
| `move.annotated` | match:{id} | present |
