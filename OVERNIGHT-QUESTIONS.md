# Overnight Questions — AGE-48

Items that hit HARD-RULE-8 (ambiguous — need human call before implementation).

---

## Q1 — Contract doc is missing

**Question:** The workplan names `docs-site/content/docs/autonomous-play/index.mdx` as
the canonical event contract for WORKSTREAM 1. That path does not exist in the repo —
there is no `docs-site/` directory at all. Without it, the complete event list for
WORKSTREAM 1 is unknown.

**What I recovered from the code:**
- `realtimeEvent` registry in `src/lib/supabase.ts` lists nine events.
- Seven are already wired with a broadcast call (`MovePlayed`, `GameEnded`, `ChatMessage`,
  `Reaction`, `ReactionAdded`, `ChatPosted`, `MoveAnnotated`).
- One was clearly missing and unambiguous: `GameJoined` — registered, subscribed to on
  the frontend lobby, never fired at accept time. **Shipped in this run** (commit `0bde19c`).
- One (`GameCreated`) is only fired for free/paid mode; system-mode `postChallenge` creates
  a match directly without any lobby broadcast. **Unclear if this is intentional** — system
  matches don't show in the open-challenge list, so the broadcast may be a no-op. Did not
  touch this.

**What's needed from you:**
- Does the contract doc need to be written first? Or is the seven-event + GameJoined
  coverage sufficient?
- Is the system-mode `postChallenge` → lobby `GameCreated` gap a real gap?

---

## Q2 — `broadcastAgent` function

**Question:** The workplan excerpt says to add `broadcastAgent(agentId, realtimeEvent.X,
payload)` calls. No such function exists in `src/lib/realtime.ts`, and there is no
per-agent channel in `channelName` (only `lobby` and `game:{matchId}`).

**Candidate interpretations:**
A) `broadcastAgent` is a NEW function to write — adds a per-agent channel like
   `agent:{agentId}` — used by a future `match_list(wait:true)` long-poll to notify
   a specific agent when a relevant event fires.
B) The workplan was using `broadcastAgent` as a loose name for the existing
   `broadcastLobby` / `broadcastGame` calls (the actual events all live on those channels).
C) Something else entirely.

**Blocked:** Can't implement without knowing which interpretation is correct.

---

## Q3 — `match_list(wait:true)` long-poll

**Question:** The workplan says "Without these [broadcasts], match_list(wait:true) hangs
but never wakes on challenge events." The current `coliseum_match_list` tool has no
`wait` parameter — it's a pure read that returns immediately. Either:

A) `wait:true` is a planned feature (blocked on Q2 / the agent channel being built first).
B) It exists somewhere I didn't find.

The `GameJoined` broadcast I shipped will help IF a future `wait:true` subscribes to the
lobby channel. But the long-poll mechanism itself needs to be designed and built.

**What's needed:** Confirm whether `wait:true` on `match_list` is planned scope for this
overnight run, and if so, provide the design (channel to subscribe to, timeout, response
shape when woken vs. timed-out).

---

## Q4 — WORKSTREAM 2+ (unknown scope)

The workplan was truncated at the WORKSTREAM 1 event list. WORKSTREAM 2+ contents are
entirely unknown. Cannot implement without the source.

**What's needed:** Forward the full workplan (if recoverable from Telegram) or describe
WORKSTREAM 2+ directly.

---

## Q5 — Branch vs. trunk

The harness placed me on branch `senior-review-fixes` (which the git log shows is ahead
of its merge base with main). The workplan says "Push to main directly after each green
commit. Don't create feature branches." Turned out the current branch IS `main` (the HEAD
ref resolved to main despite the display name), so the commit went to main. Confirming:
the `senior-review-fixes` display in the harness status was the branch we were reviewing
FROM before the overnight started, not a feature branch. If this is wrong, flag me before
the next heartbeat.
