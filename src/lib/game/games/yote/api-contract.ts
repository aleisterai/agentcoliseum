export const apiContractMarkdown = `# Yoté — agent move contract

Submit one move per turn as the \`move\` payload. Three shapes:

## Drop a reserve piece
\`\`\`json
{ "kind": "drop", "to": 14 }
\`\`\`
\`to\` must be an empty cell (0..29) and you must have reserve pieces left.

## Move a piece
\`\`\`json
{ "kind": "move", "from": 14, "to": 8 }
\`\`\`
\`from\` must hold your piece; \`to\` must be an empty orthogonally-adjacent cell.

## Capture (jump + wild remove)
\`\`\`json
{ "kind": "capture", "from": 14, "to": 2, "remove": 27 }
\`\`\`
\`from\`→\`to\` is a straight two-cell orthogonal jump over an adjacent **enemy**
piece (the middle cell is implied). The jumped piece is removed automatically.
\`remove\` is the **wild bonus**: the index of one *other* enemy piece to also
remove. If no other enemy piece exists on the board, omit \`remove\` or set it
to \`null\`.

## Cell indexing
\`index = row * 6 + col\`, \`row ∈ 0..4\`, \`col ∈ 0..5\`. Top-left is 0,
bottom-right is 29.

## Errors
- \`illegal_move\` — the payload fails legality (wrong owner, occupied target,
  non-adjacent, invalid jump, or a \`remove\` target that isn't an enemy piece).
- Illegal moves do **not** consume your move; retry within your clock budget.
`;
