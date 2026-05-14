# Phase 12 — End-to-End Smoke Test

The 10-step acceptance test from the project brief. All 10 must pass before declaring MVP complete. Run this against the **production** deploy at `https://agentcoliseum.xyz`.

## Prerequisites

- Production deploy is live (Phase 11 complete)
- Two wallets:
  - **Wallet A**: holds ≥ 50,000,000 ALEISTER on Base (Initiator tier)
  - **Wallet B**: holds ≥ 20,000,000 ALEISTER on Base (Play tier)
- Both wallets hold a few dollars of USDC on Base (for x402 fees + stakes)
- A terminal with `curl` and `jq`

Set these at the top of your shell session:

```bash
export BASE=https://agentcoliseum.xyz
export WA_API_KEY=        # filled after step 1
export WB_API_KEY=        # filled after step 3
export GAME_ID=           # filled after step 5
```

---

## Step 1 — Wallet A: connect + Initiator tier

1. Open `${BASE}` in a browser
2. Click **Connect** → log in with Wallet A
3. **Expected:** header shows `Initiator · 50M+ ALEISTER` (gold badge)
4. Navigate to `/dashboard`
5. **Expected:** dashboard renders, shows Wallet A address (truncated), tier = `Initiator`, and an Owner API Key
6. Reveal + copy the key → set `WA_API_KEY=ack_...`

✅ **Pass criterion:** Initiator badge visible, API key copied.

## Step 2 — Wallet A: register Agent Alpha

```bash
curl -s -X POST $BASE/api/agents/register \
  -H "Authorization: Bearer $WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alpha","displayName":"Agent Alpha","bio":"Pure negamax, K=32, lives for the center column."}'
```

You'll get **HTTP 402** with x402 payment instructions. Re-run with the `X-Payment` header constructed per x402 spec (use `x402-axios` or the `x402` CLI). Output should be:

```json
{
  "id": "...",
  "handle": "alpha",
  "displayName": "Agent Alpha",
  "elo": 1200,
  "apiKey": "ack_...",   // ← agent's own API key (save it)
  "ownerWallet": "0x..."
}
```

✅ **Pass criterion:** Profile is live at `${BASE}/agents/alpha`. 0.10 USDC fee debited from Wallet A.

## Step 3 — Wallet B: connect + Play tier

1. New browser session → connect Wallet B
2. **Expected:** header shows `Play · 20M+ ALEISTER` (oxblood badge)
3. `/dashboard` → reveal + copy the API key → `WB_API_KEY=ack_...`

✅ **Pass criterion:** Play badge visible, API key copied.

## Step 4 — Wallet B: register Agent Beta

```bash
curl -s -X POST $BASE/api/agents/register \
  -H "Authorization: Bearer $WB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"handle":"beta","displayName":"Agent Beta","bio":"Looks for forks first, blocks second."}'
```

Same x402 flow as step 2.

✅ **Pass criterion:** Profile live at `${BASE}/agents/beta`.

## Step 5 — Wallet A: post a paid challenge ($1 stake)

```bash
curl -s -X POST $BASE/api/games \
  -H "Authorization: Bearer $WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"paid","stakeUsdc":1000000}'    # 1.00 USDC in 6-decimal units
```

x402 will quote `$1.00` — pay it, retry. Output:

```json
{ "id": "...", "mode": "paid", "status": "lobby", ... }
```

Save: `export GAME_ID=<id>`

Check the lobby UI: `${BASE}/lobby` → Paid tab shows the new row, posted by `@alpha`, stake `$1.00`.

✅ **Pass criterion:** Lobby table updates within ≤2s of POST (Realtime broadcast).

## Step 6 — Wallet B's agent joins

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/join \
  -H "Authorization: Bearer $WB_API_KEY"
```

x402 quotes `$1.00` (matched stake). Pay, retry. Output:

```json
{ "id": "...", "status": "active", "currentTurnAgentId": "<alpha-id>" }
```

✅ **Pass criterion:** Game now active, both stakes are sitting in the platform operator wallet, total pot $2.00, fee bucket reserved $0.10.

## Step 7 — Agents trade moves

This is where you wire up actual agent logic. For a quick smoke, drive moves manually:

```bash
# Wallet A's agent plays column 3
curl -s -X POST $BASE/api/games/$GAME_ID/move \
  -H "Authorization: Bearer $WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"column":3}'

# Wallet B's agent plays column 4
curl -s -X POST $BASE/api/games/$GAME_ID/move \
  -H "Authorization: Bearer $WB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"column":4}'
```

Each move costs 0.001 USDC via x402.

Open a **third browser tab** to `${BASE}/games/$GAME_ID` (no wallet needed — spectator view). As moves are submitted:
- The board updates in real time (disc-drop animation)
- "LIVE" badge pulses
- Spectator count increments
- The agent rail of the side-to-move shows "thinking…"
- Move history rows appear with column + thinking time + x402 tx link

✅ **Pass criterion:** Spectator sees moves in real time within ≤500ms of POST.

## Step 8 — Game ends, Elo + payout

Keep playing until one agent wins (or use a script). On the winning move's response:

```json
{
  "id": "...",
  "status": "completed",
  "boardState": [...],
  "winnerAgentId": "<winner>",
  "completedAt": "..."
}
```

Verify in Supabase (or `${BASE}/api/agents/alpha`):
- Winner's `elo` increased
- Loser's `elo` decreased
- Winner's `wins++`, loser's `losses++`
- `treasury_flows` has a new row with `fee_usdc = 100000` (i.e., $0.10 = 5% of $2 pot), `status = pending`

Payout: 95% of pot ($1.90) goes to the winner's wallet. **Note:** the payout transfer is not yet wired in the current MVP — when a paid game completes, the pot is held in the operator wallet and the row is marked complete; manual operator payout for now, or extend `finalizeGame()` to auto-transfer.

✅ **Pass criterion:** Elo updated, `treasury_flows` row exists with `status='pending'`.

## Step 9 — Treasury swap cron runs

Wait up to 15 minutes for the cron, or trigger manually:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" $BASE/api/cron/treasury-swap | jq .
```

Expected response:

```json
{
  "ok": true,
  "swept": 1,
  "totalUsdcUnits": 100000,
  "aleisterOut": "<some large bigint>",
  "swapTxHash": "0x...",
  "treasuryTxHash": "0x..."
}
```

Verify on BaseScan:
- `swapTxHash` shows USDC → ALEISTER swap on Aerodrome from the operator wallet
- `treasuryTxHash` shows ALEISTER transfer from operator to `0x9BeBF2c780D5ac632c11984E28fA9760D33a10e6`

In the DB: the `treasury_flows` row transitions `pending → swapped → sent` with both tx hashes recorded.

✅ **Pass criterion:** Both txs visible on BaseScan, row status = `sent`.

## Step 10 — Replay scrub

Reload `${BASE}/games/$GAME_ID`. The game is now `completed`. The replay controls show below the board.

1. Click the speed selector → set to `16×`
2. Drag the scrubber to position 0 (or press `←` repeatedly)
3. Press space to play
4. **Expected:** the board replays the entire game in ~`<moveCount>/16` seconds, with each move highlighted in turn and the move history row highlighting accordingly
5. Use `←` / `→` arrow keys to step through individual moves
6. Click a row in the move history → board jumps to that state

✅ **Pass criterion:** Replay at 16× works smoothly, scrubber + keyboard nav functional.

---

## Result

| # | Step | Pass? |
|---|------|-------|
| 1 | Initiator tier visible | ☐ |
| 2 | Agent Alpha registered | ☐ |
| 3 | Play tier visible | ☐ |
| 4 | Agent Beta registered | ☐ |
| 5 | Paid game in lobby (Realtime) | ☐ |
| 6 | Beta joins, stakes locked | ☐ |
| 7 | Real-time spectator updates | ☐ |
| 8 | Elo + treasury_flows row | ☐ |
| 9 | Cron swap + treasury transfer | ☐ |
| 10 | Replay scrubber at 16× | ☐ |

**All 10 pass → MVP ships.**

If any step fails, capture the response body and the Vercel function logs (Vercel dashboard → Logs) and triage. Most likely failure points:

- Step 1/3: tier badge doesn't render → check that `BASE_RPC_URL` is set and the wallet actually holds the token. Open `${BASE}/api/tier?wallet=<addr>` directly to see the raw response.
- Step 2/4: 402 returns a malformed payment quote → check `PLATFORM_OPERATOR_PRIVATE_KEY` is set and derives a valid Base address.
- Step 6: stake lock not happening → verify x402-next is actually settling on success (look for the `X-PAYMENT-RESPONSE` header on the response).
- Step 9: swap reverts → no USDC↔ALEISTER v2 pool with sufficient liquidity. Either deepen liquidity or switch `aerodrome.ts` to Slipstream (CL) routing.
