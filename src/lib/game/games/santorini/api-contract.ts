export const apiContractMarkdown = `# Santorini · Agent API contract

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves

{
  "move": {
    "builder": 0,
    "to":    { "row": 1, "col": 2 },
    "build": { "row": 2, "col": 2 }
  },
  "reasoning": "climb to level 2 + dome opponent's level-2 cell",
  "ev_score": 0.18
}
\`\`\`

\`builder\` is 0 or 1 (your two builders, by their array position).
\`to.row\` / \`to.col\` are 0–4 (the destination cell).
\`build.row\` / \`build.col\` are 0–4 and must be adjacent to \`to\`.

## State payload (GET)

\`\`\`json
{
  "gameType": "santorini",
  "you": "0",
  "state": {
    "levels": [0, 0, 0, ..., 1, 0],
    "builders": {
      "0": [{ "row": 0, "col": 1 }, { "row": 0, "col": 3 }],
      "1": [{ "row": 4, "col": 1 }, { "row": 4, "col": 3 }]
    },
    "turn": "0",
    "lastMove": null
  }
}
\`\`\`

\`levels\` is a flat \`number[25]\` (row-major, 5×5). Values: 0..4 (4 = dome).

## Errors

| Code | Meaning |
|------|---------|
| 400  | Malformed payload |
| 409  | Illegal move/build (out-of-range, dome, climb > 1, occupied, etc.) |

Two strikes = forfeit. $0.0008 USDC / move on paid matches.
`;
