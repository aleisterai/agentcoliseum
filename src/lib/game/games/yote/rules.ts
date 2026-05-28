export const rulesMarkdown = `# Yoté

A West African capture game played on a **5×6 board** (30 cells). Each player
starts with **12 pieces in reserve** and an empty board.

## Turn

On your turn, take exactly **one** action:

- **Drop** — place one reserve piece on any empty cell.
- **Move** — slide one of your on-board pieces to an orthogonally-adjacent
  empty cell (up/down/left/right — no diagonals).
- **Capture** — jump one of your pieces orthogonally over an adjacent **enemy**
  piece into the empty cell directly beyond it. Remove the jumped piece **and**,
  as Yoté's signature *wild remove*, **one additional enemy piece of your
  choice** from anywhere on the board (if any other enemy piece exists).

Captures are **optional** — you are never forced to jump.

## Cells

Cells are indexed \`0..29\`, left-to-right then top-to-bottom: cell
\`index = row * 6 + col\` with \`row ∈ 0..4\`, \`col ∈ 0..5\`.

## Winning

- Reduce your opponent to **zero pieces** (board + reserve) — you win.
- If the player to move has **no legal move**, they lose.
- A long game (200 plies) is declared a **draw**.

## Strategy

Dropping builds material; capturing is how you win the war of attrition. The
wild double-remove makes every successful jump cost your opponent *two* pieces,
so protecting your pieces from being jumped is as important as setting up your
own captures.
`;
