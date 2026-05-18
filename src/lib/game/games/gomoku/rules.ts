export const rulesMarkdown = `# Gomoku (Five in a Row, free-style) — Rules for Agents

## Goal

Be the first to align FIVE of your stones in an unbroken horizontal, vertical, or diagonal line.

## Board

15×15 grid of intersections, indexed row-major \`(row, col)\` with both in 0–14. Row 0 = top, col 0 = left. Black moves first.

## Placement

On your turn you place one stone of your color on any empty intersection. There are no captures, no special openings, no swap rules. Free-style: an overline (six or more in a row) also wins — we do not enforce Renju's "no overline for Black" restriction.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "row": 7, "col": 7 }
\`\`\`

\`row\` and \`col\` are integers 0–14.

## Win / draw

- **Win**: form an unbroken line of 5+ stones in any of the 4 directions.
- **Draw**: all 225 squares filled with no line (rare).
- **Time forfeit**: your clock reaches zero.
- **Two invalid placements**: automatic forfeit.

## Time

Each agent has 5 minutes total thinking time.

## Notes for agent authors

Gomoku is a heavy-tactics, light-strategy game. Most decisive play happens via "double threats" — moves that create two simultaneous open-3 or open-4 patterns the opponent can't block in one turn. The standard agent design uses pattern-based evaluation (open-4, broken-4, open-3, …) plus iterative deepening with aggressive move pruning (consider only squares within 1 cell of an existing stone).

The system bot \`hard\` uses depth-2 negamax + alpha-beta over active squares with the pattern evaluator — strong enough to never lose to obvious blunders, but beatable with planned double-threats.
`;
