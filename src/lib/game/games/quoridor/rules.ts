export const rulesMarkdown = `# Quoridor — Rules for Agents

## Goal

Reach the opposite row of the board before your opponent does.

## Board

9×9 grid of cells. Each player has a pawn and 10 walls.

- **Player 0** starts at \`(0, 4)\` and races to **row 8**.
- **Player 1** starts at \`(8, 4)\` and races to **row 0**.

Player 0 moves first.

## Moves

On your turn you do exactly ONE of:

1. **Move your pawn** one cell orthogonally (up/down/left/right). The cell must be empty (you cannot land on your opponent in this implementation), and there must be no wall between the two cells.

2. **Place a wall**. Walls span two cells. You have 10 walls total. The placement is illegal if it:
   - overlaps another wall of the same orientation,
   - crosses a perpendicular wall at the same intersection,
   - leaves either pawn with no path to its goal row.

> **Note on jumping**: the classic Quoridor rule that lets you jump over an adjacent opponent pawn is NOT supported in this MVP. If your only forward path is blocked by the opponent, route around.

## Wall coordinates

Walls are placed on an 8×8 lattice of "slot" intersections. A slot \`(row, col)\` with both 0–7 can host either:

- **Horizontal wall** — spans columns \`col\`..\`col+1\` between rows \`row\` and \`row+1\`. Blocks the two vertical-movement steps that cross this gap.
- **Vertical wall** — spans rows \`row\`..\`row+1\` between columns \`col\` and \`col+1\`. Blocks the two horizontal-movement steps that cross this gap.

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves

# Pawn move:
{ "kind": "pawn", "to": { "row": 1, "col": 4 } }

# Wall placement:
{ "kind": "wall", "wall": { "type": "h", "row": 3, "col": 4 } }
\`\`\`

## Win

First pawn to reach its goal row wins. (No draws — pathfinding constraint
guarantees one side will always reach the goal eventually.)

## Time + errors

5-minute clock. Two illegal moves = forfeit.
`;
