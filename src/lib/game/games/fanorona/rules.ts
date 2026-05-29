export const rulesMarkdown = `# Fanorona (Fanoron-Tsivy)

The national board game of Madagascar. A capture race on a 5×9 grid of
intersections, famous for its two capture mechanisms and its mandatory-capture
rule. Deterministic and perfect-information — fully replayable on-chain.

## The board

45 intersections, \`index = row * 9 + col\` (\`row ∈ 0..4\`, \`col ∈ 0..8\`).
Lines connect every orthogonally-adjacent point. **Diagonal** lines exist only
at *strong* intersections — points where \`(row + col)\` is even (the corners,
the centre, and the edge-midpoints). At a strong point a piece may move in all
eight directions; at a *weak* point only the four orthogonal directions.

Each side starts with 22 pieces; only the centre point is empty:

\`\`\`
1 1 1 1 1 1 1 1 1
1 1 1 1 1 1 1 1 1
0 1 0 1 . 1 0 1 0
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 0 0 0
\`\`\`

Player 0 holds the bottom two rows, player 1 the top two. Player 0 moves first.

## Moving and capturing

A piece moves **one step** to an adjacent empty connected point. A move
captures by one of two mechanisms:

- **Approach** — you move *toward* an enemy line. The unbroken run of enemy
  pieces that begins on the cell **just beyond** where you land (continuing in
  the direction you moved) is captured.
- **Withdrawal** — you move *away from* an enemy line. The unbroken run of
  enemy pieces that begins on the cell **just behind** your starting point
  (opposite the direction you moved) is captured.

If a single step lines up an enemy run on *both* sides, you choose which one to
take — you cannot take both with the same step.

## Mandatory capture

If you have any capturing move, you **must** capture — a non-capturing
("paika") move is illegal while a capture is on the board. A paika move is only
legal when no capture exists anywhere for you.

## Capture chains

After a capture, the **same piece** may keep capturing in the same turn:

- every continuation must itself be a capture;
- it may **not** move in the same direction as its immediately preceding hop;
- it may **not** land on a point it has already occupied this turn.

Continuing is optional — you may stop after any capture. Submit the whole turn
at once (see the move contract).

## Winning

Capture **all** of the opponent's pieces, or leave the player to move with no
legal move — they lose. A long game hits a ply cap and is scored a draw to
guarantee verifiable termination.
`;
