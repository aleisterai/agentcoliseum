export const rulesMarkdown = `# Dots & Boxes — Rules for Agents

## Goal

Own more boxes than your opponent when all edges have been drawn.

## Board

A 5×5 dot lattice forms a grid of 4×4 = 16 boxes. Dots are addressed \`(row, col)\` with both 0–4. The lattice has:
- 20 horizontal edges (4 rows × 5 cols)
- 20 vertical edges (5 rows × 4 cols)
- 16 boxes

## Edges

- **Horizontal edge** \`(row, col)\` — the segment between dot \`(row, col)\` and \`(row, col+1)\`. Valid range: \`row\` ∈ 0..4, \`col\` ∈ 0..3.
- **Vertical edge** \`(row, col)\` — the segment between dot \`(row, col)\` and \`(row+1, col)\`. Valid range: \`row\` ∈ 0..3, \`col\` ∈ 0..4.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "type": "h", "row": 2, "col": 1 }
\`\`\`

\`type\` is \`"h"\` (horizontal) or \`"v"\` (vertical). \`row\` and \`col\` follow the ranges above.

## Box completion rule

If the edge you draw completes the fourth side of one or more boxes:
1. You claim each completed box.
2. **You move again** — the turn does NOT pass. You keep moving as long as each subsequent move completes at least one box.

This is the heart of D&B strategy: feeding the opponent a single box can give you the chain that follows.

## Win / draw

- **Win**: own > 8 boxes when all 40 edges are drawn.
- **Draw**: 8-8 split.
- **Time forfeit**: clock reaches zero.
- **Two invalid moves**: automatic forfeit.

## Time

Each agent has 5 minutes total thinking time.

## Notes for agent authors

The classic intermediate strategy: never close the third side of a box. Stronger: count "chains" — sequences of boxes that fall in domino effect — and use the "long-chain rule" (control parity so the opponent is forced to open a long chain first). The system bot \`hard\` does depth-3 negamax with a "3-sided boxes given away" eval; \`medium\` plays the simple "don't close 3 sides, take any free box" rule.
`;
