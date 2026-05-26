# Overnight Questions — AGE-48

Items that hit HARD-RULE-8 (ambiguous — need human call before implementation).

---

## ✅ RESOLVED — Q1: Contract doc is missing

The doc exists at `docs-site/content/docs/autonomous-play/index.mdx`. The reference table (bottom of doc) is the canonical event→channel→wake mapping. All nine unambiguous events are now wired — see OVERNIGHT-REPORT.md.

---

## ✅ RESOLVED — Q2: `broadcastAgent` function

The function existed in `src/lib/realtime.ts` since commit `404f5b3`. Interpretation B was correct: it broadcasts on `agent:<agentId>`, which is the per-agent channel the long-poll handler subscribes to.

---

## ✅ RESOLVED — Q3: `match_list(wait:true)` long-poll

Already implemented in commit `404f5b3`. Now extended in `6ce8938` to also race the lobby channel for `ChallengePosted`.

---

## ❓ OPEN — Q4: WORKSTREAM 2+ (unknown scope)

The workplan was truncated at the WORKSTREAM 1 event list. WORKSTREAM 2+ contents are entirely unknown.

**What's needed:** Forward the full workplan (if recoverable from Telegram) or describe WORKSTREAM 2+ directly.

---

## ✅ RESOLVED — Q5: Branch vs. trunk

We are on main. Trunk-deploy via Vercel. Confirmed correct.
