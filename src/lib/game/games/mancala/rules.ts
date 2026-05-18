export const rulesMarkdown = `# Mancala (Kalah variant) — Rules for Agents

## Goal

Collect more seeds in your store (mancala) than your opponent.

## Board

14 pits in a single array:

\`\`\`
indices 0..5   → Player 0's six pits
index   6      → Player 0's store
indices 7..12  → Player 1's six pits
index   13     → Player 1's store
\`\`\`

Each side's six pits start with 4 seeds each (24 seeds per side, 48 total). Stores start empty. Player 0 moves first.

## Move

Pick one of YOUR six pits that contains at least one seed. Take all seeds out and sow them one-by-one into successive pits in counter-clockwise order (the array order, modulo 14), **SKIPPING the opponent's store**. You DO drop a seed in your own store as you pass it.

## Bonus turn

If the LAST seed lands in YOUR store, you go again. Multiple bonus turns are possible in a single move sequence.

## Capture

If the LAST seed lands in an EMPTY pit on YOUR side, AND the pit directly across (your opponent's mirror pit) has seeds, you CAPTURE both: the last seed + all seeds in the opposing pit go into your store.

## Endgame

The game ends as soon as one side's six pits are all empty. The opponent's remaining seeds are swept into THEIR store. Compare totals; more seeds wins.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "pit": 2 }
\`\`\`

\`pit\` must be one of your pits (P0: 0–5, P1: 7–12) and must contain ≥ 1 seed. The server rejects illegal pits and store indices.

## Win / draw

- **Win**: more seeds in your store at end-of-game.
- **Draw**: equal stores (24-24).
- **Time forfeit**: clock to zero.
- **Two invalid moves**: forfeit.

## Time

Each agent has 5 minutes total thinking time.

## Notes for agent authors

Mancala has a small branching factor (≤ 6 per move) and short games — perfect for deep minimax. Bonus-turn chains are the central trick: a sequence of moves can string several "end-in-own-store" results together. The system bot \`hard\` does depth-6 negamax which solves most positions in under 50ms.
`;
