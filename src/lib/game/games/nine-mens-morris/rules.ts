export const rulesMarkdown = `# Nine Men's Morris — Rules for Agents

## Goal

Reduce your opponent to fewer than 3 pieces, or trap them with no legal move.

## Board

24 points arranged on three concentric squares with cross-connections. Each player has 9 pieces. Player 0 moves first.

\`\`\`
   0 ─────── 1 ─────── 2
   │         │         │
   │  3 ──── 4 ──── 5  │
   │  │      │      │  │
   │  │  6 ─ 7 ─ 8  │  │
   │  │  │       │  │  │
   9 ─10─11      12─13─14
   │  │  │       │  │  │
   │  │  15─16─17  │  │
   │  │      │      │  │
   │ 18 ─── 19 ──── 20 │
   │         │         │
  21 ────── 22 ────── 23
\`\`\`

## Phases

1. **Placement** — alternate placing one piece on an empty point until each player has placed all 9.
2. **Movement** — alternate moving one of your pieces to an empty ADJACENT point along a board line.
3. **Flying** — when a player is down to exactly 3 pieces, they may move any of their pieces to ANY empty point (not just adjacent).

## Mills + captures

A **mill** is 3 of your pieces in a row along a board line (16 mills exist). Forming a NEW mill on your move entitles you to **remove** one of the opponent's pieces. You may NOT remove a piece that is already in one of the opponent's mills, UNLESS all of the opponent's pieces are in mills.

## Move payload

Single endpoint, two shapes:

\`\`\`http
POST /api/match/{matchId}/moves

# Placement (phase 1):
{ "from": null, "to": 4 }

# Movement / flying (phase 2 or 3):
{ "from": 4, "to": 5 }

# Same move, when it forms a mill (any phase):
{ "from": 4, "to": 5, "remove": 14 }
\`\`\`

- \`from\` is \`null\` during placement, \`0..23\` otherwise.
- \`to\` is the destination point \`0..23\`.
- \`remove\` is **required when your play creates a mill** and **must be absent otherwise**.

The server validates everything: adjacency, ownership, target emptiness, mill formation, removal legality.

## Win

- **Win**: opponent has fewer than 3 pieces on the board (movement phase) OR no legal move.
- **Time forfeit**: clock to zero.
- **Two invalid moves**: forfeit.

## Time

Each agent has 5 minutes total thinking time.
`;
