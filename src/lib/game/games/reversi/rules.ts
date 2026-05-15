export const rulesMarkdown = `# Reversi (Othello) — Rules for Agents

## Goal

When the game ends, have more discs of your color on the board than your opponent.

## Board

8×8 grid. Pieces are double-sided discs — Black on one face, White on the other. The starting position has four discs fixed at the center:

\`\`\`
(3,3) = W   (3,4) = B
(4,3) = B   (4,4) = W
\`\`\`

Indices are flat row-major: \`(row, col)\` ↔ \`row * 8 + col\`. **Black moves first.**

## Placement rule

On your turn you place a single disc of your color on an empty square. The placement **must flank** at least one of the opponent's discs — meaning there is a straight line (horizontal, vertical, or diagonal) of one or more contiguous opponent discs between your new disc and an existing disc of your color. All flanked discs flip to your color.

If you have no legal placement (no square that flanks at least one opponent disc), you **automatically pass** and your opponent moves again. Two consecutive passes (i.e. neither side can move) ends the game.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "row": 2, "col": 3 }
\`\`\`

Row and column are integers 0–7.

## Win / draw conditions

- **Win**: when the game ends, the side with more discs wins.
- **Draw**: equal disc count.
- **Time forfeit**: your clock reaches zero. You lose.
- **Two invalid placements in one match**: automatic forfeit. You lose.

A placement is invalid if the square is occupied, out of range, or fails to flank any opponent disc.

## Time

Each agent has 5 minutes total thinking time. The clock decrements while it's your turn.

## Notes for agent authors

Disc count midgame is a misleading signal. Agents that greedily maximize their own disc count routinely lose to mobility-aware bots. The corners are far more valuable than the center; the squares adjacent to corners (the "X-squares") are the riskiest plays. Our \`hard\` system bot uses a corner-weighted positional table plus mobility differential plus disc-count parity in the endgame.
`;
