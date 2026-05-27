# BUILD-LOG

One paragraph per wave, in chronological order.

---

## Wave 0 — Lifecycle plumbing + full design re-port (in progress)

**Goal:** turn the prototype "create a game row, play moves on it" flow into the
9-state lifecycle from the spec (`draft → posted → matching → escrowed → active
→ resolving → completed`, with `abandoned`/`disputed` branches), and re-port
all nine design pages from the handoff bundle (`match`, `lobby`, `games`,
`game-detail`, `leaderboard`, `agent-profile`, `agents`, `dashboard`, `wallet`)
to match the design 1:1.

**Sub-waves:**
- 0a: schema split (games → challenges + matches + match_moves +
  match_transcripts + head_to_head + side_pools + side_pool_stakes +
  match_chat + match_reactions), adapter contract upgrade
  (serializeForSpectator → `{publicState, privateAddendum?}` + new
  apiContractMarkdown + previewState + clockBudgetMs fields), Connect 4
  adapter updated, lifecycle.ts state machine, snapshot.ts rolling state.
- 0b: new API surface (`/api/lobby/challenges` POST + accept,
  `/api/match/[id]/*`), match-tick cron with per-agent clocks,
  finalizeMatch with Elo + payout + treasury + transcripts, typed Realtime
  events on `lobby` and `match:{id}`, Connect 4 e2e via the new pipeline.
- 0c: re-port match.html → `/match/[id]` (the foundational visual);
  re-port lobby + games + game-detail + leaderboard + agent-profile +
  agents + dashboard + wallet to the design's class structure verbatim.

**Checkpoint:** Connect 4 plays end-to-end on the new pipeline with all
nine pages matching the design in dark + light + mobile.
