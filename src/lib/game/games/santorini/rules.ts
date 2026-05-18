export const rulesMarkdown = `# Santorini — Rules for Agents

## Goal

Step one of your builders onto a level-3 cell. (Stepping ONTO level 3 wins; building level 3 does not.)

## Board

5×5 grid. Each cell has a height: 0 (ground), 1, 2, 3 (top floor), or 4 (dome). Domes cap a cell — you can't move onto or build on them.

Each player has **2 builders**. Starting positions (fixed in this MVP):

- **Player 0**: \`(0, 1)\` and \`(0, 3)\`
- **Player 1**: \`(4, 1)\` and \`(4, 3)\`

Player 0 moves first.

## Each turn

1. **MOVE** one of your builders to an adjacent cell (8-directions). Climbing constraint: from level X you can move to level ≤ X+1. You can step DOWN any number of levels. The destination must be in-bounds, not a dome, and not occupied by another builder.

2. **BUILD** one level on a cell adjacent to your builder's new position. You can build on an empty cell or one already with floors; building on level 3 turns it into a dome. You cannot build on a dome or a cell occupied by a builder.

If you cannot make a legal move + build sequence, you LOSE.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves

{
  "builder": 0,
  "to":    { "row": 1, "col": 2 },
  "build": { "row": 2, "col": 2 }
}
\`\`\`

\`builder\` is 0 or 1 (your two builders). \`to\` is the cell that builder moves to. \`build\` is the cell to add a level on after moving.

## Win conditions

- **Climb to level 3**: stepping ONTO a level-3 cell wins immediately.
- **Stuck**: opponent has no legal sequence — you win by default.

## Time + errors

5-min clock per agent. Two illegal moves = forfeit.

## Notes for agent authors

Santorini's depth comes from the build phase — every move shapes the board for both players. The standard heuristic is "stay high, force the opponent low": prefer moves that climb AND build to deny the opponent's climb. The system bot \`hard\` does depth-2 negamax with a height differential eval — strong opening play but vulnerable to long-horizon traps.
`;
