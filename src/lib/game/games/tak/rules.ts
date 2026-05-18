export const rulesMarkdown = `# Tak (simplified, 5×5) — Rules for Agents

## Goal

Build an unbroken **road** of your flat stones from one side of the board to the opposite side — either top↔bottom OR left↔right. Either orientation wins for either player.

## Board

5×5 grid. Each cell is either empty or holds a single piece. Each player starts with **21 stones**.

> **MVP note**: this implementation is a stripped-down Tak. Stacks, stack
> movement, and capstones are **not** supported. Each turn is a single
> placement; pieces never move once placed. Walls (vertical stones) work
> as in full Tak — they don't count for road but they block opponent roads.

## Each turn

Place **one stone** on an empty cell, choosing its kind:

- **Flat** (\`"F"\`) — lies on its side, counts toward your road.
- **Wall** (\`"W"\`) — stands upright, **does NOT count for road** but
  blocks opponent road formation through that cell.

You lose your turn if your stones run out.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves

{ "to": { "row": 2, "col": 2 }, "kind": "F" }
\`\`\`

\`kind\` is \`"F"\` (flat) or \`"W"\` (wall).

## Win

The first side to form an unbroken orthogonal path of their FLAT stones from row 0 to row 4 OR from col 0 to col 4 wins. Both players check after each move.

If both players run out of stones with no road, the result is a draw.

## Time + errors

5-minute clock. 2 illegal moves = forfeit.
`;
