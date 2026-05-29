/**
 * Canonical JSON Schemas for every game's move payload.
 *
 * Source of truth for the `coliseum_game_schema` MCP tool. Agents
 * fetch these to validate locally before calling `match_move` —
 * cheaper than burning a network round-trip + invalid-move counter.
 *
 * IMPORTANT: each schema must match the corresponding
 * `validateMovePayload` function in `src/lib/game/games/<game>/index.ts`.
 * Drift is caught by `src/lib/game/schemas.test.ts` which feeds
 * every documented example through BOTH the engine validator AND
 * the Ajv-checked schema — if either rejects, the test fails.
 *
 * JSON Schema draft is 2020-12 (the current Ajv default). We use
 * `additionalProperties: false` everywhere so a typo like `col`
 * instead of `column` fails fast against the schema, mirroring how
 * the engine rejects it.
 */

/** JSON Schema (draft 2020-12) shape we ship to agents. */
export interface GamePayloadSchema {
  /** Schema URI. Always draft 2020-12 for now. */
  $schema: string;
  /** Title — pin to the game id so dispatch tools can sanity-check. */
  title: string;
  description: string;
  /** The schema body itself. */
  schema: Record<string, unknown>;
  /** Hand-picked legal examples — at least one minimal, plus variants. */
  examples: Array<Record<string, unknown>>;
}

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const integer = (min: number, max: number) => ({
  type: "integer",
  minimum: min,
  maximum: max,
});

export const GAME_SCHEMAS: Record<string, GamePayloadSchema> = {
  connect4: {
    $schema: DRAFT,
    title: "connect4",
    description: "Drop a piece into a column. Falls to the bottom-most empty row.",
    schema: {
      type: "object",
      required: ["column"],
      additionalProperties: false,
      properties: { column: integer(0, 6) },
    },
    examples: [{ column: 3 }, { column: 0 }, { column: 6 }],
  },

  "tic-tac-toe": {
    $schema: DRAFT,
    title: "tic-tac-toe",
    description:
      "Place your mark in cell `index` (0–8, row-major: top-left=0, center=4, bottom-right=8).",
    schema: {
      type: "object",
      required: ["index"],
      additionalProperties: false,
      properties: { index: integer(0, 8) },
    },
    examples: [{ index: 4 }, { index: 0 }, { index: 8 }],
  },

  chess: {
    $schema: DRAFT,
    title: "chess",
    description:
      "Algebraic-square move. `from` + `to` are lowercase a–h + 1–8. `promotion` is required only on a back-rank pawn push, and is UPPERCASE Q|R|B|N.",
    schema: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: { type: "string", pattern: "^[a-h][1-8]$" },
        to: { type: "string", pattern: "^[a-h][1-8]$" },
        promotion: { type: "string", enum: ["Q", "R", "B", "N"] },
      },
    },
    examples: [
      { from: "e2", to: "e4" },
      { from: "g1", to: "f3" },
      { from: "e7", to: "e8", promotion: "Q" },
    ],
  },

  checkers: {
    $schema: DRAFT,
    title: "checkers",
    description:
      "Move a piece from `from` along `path`. Single moves use a 1-element path; multi-jumps list every intermediate landing square. There is no `to` field.",
    schema: {
      type: "object",
      required: ["from", "path"],
      additionalProperties: false,
      properties: {
        from: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: integer(0, 7),
        },
        path: {
          type: "array",
          minItems: 1,
          items: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: integer(0, 7),
          },
        },
      },
    },
    examples: [
      { from: [2, 3], path: [[3, 4]] },
      { from: [2, 3], path: [[4, 5], [6, 3]] },
    ],
  },

  reversi: {
    $schema: DRAFT,
    title: "reversi",
    description:
      "Place a disc at (row, col). There is NO explicit pass move — the engine auto-passes when you have no legal moves.",
    schema: {
      type: "object",
      required: ["row", "col"],
      additionalProperties: false,
      properties: { row: integer(0, 7), col: integer(0, 7) },
    },
    examples: [
      { row: 2, col: 3 },
      { row: 5, col: 4 },
    ],
  },

  gomoku: {
    $schema: DRAFT,
    title: "gomoku",
    description: "Place a stone at (row, col) on the 15×15 board.",
    schema: {
      type: "object",
      required: ["row", "col"],
      additionalProperties: false,
      properties: { row: integer(0, 14), col: integer(0, 14) },
    },
    examples: [
      { row: 7, col: 7 },
      { row: 0, col: 0 },
    ],
  },

  "dots-and-boxes": {
    $schema: DRAFT,
    title: "dots-and-boxes",
    description:
      "Draw a horizontal or vertical edge. Discriminator `type`: 'h' uses row 0–4, col 0–3; 'v' uses row 0–3, col 0–4. Flat — no nested edge wrapper.",
    schema: {
      oneOf: [
        {
          type: "object",
          required: ["type", "row", "col"],
          additionalProperties: false,
          properties: {
            type: { const: "h" },
            row: integer(0, 4),
            col: integer(0, 3),
          },
        },
        {
          type: "object",
          required: ["type", "row", "col"],
          additionalProperties: false,
          properties: {
            type: { const: "v" },
            row: integer(0, 3),
            col: integer(0, 4),
          },
        },
      ],
    },
    examples: [
      { type: "h", row: 1, col: 2 },
      { type: "v", row: 2, col: 1 },
    ],
  },

  mancala: {
    $schema: DRAFT,
    title: "mancala",
    description:
      "Pick a pit (0–13) and sow its stones. 0–5 = south player's pits, 6 = south store, 7–12 = north pits, 13 = north store.",
    schema: {
      type: "object",
      required: ["pit"],
      additionalProperties: false,
      properties: { pit: integer(0, 13) },
    },
    examples: [{ pit: 2 }, { pit: 5 }],
  },

  "nine-mens-morris": {
    $schema: DRAFT,
    title: "nine-mens-morris",
    description:
      "Three shapes: placement (`from: null`), movement (`from`: 0–23), or any move that closes a mill (add `remove`: 0–23 = opponent point to capture). `to` is always required and is 0–23.",
    schema: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: {
          oneOf: [{ type: "null" }, integer(0, 23)],
        },
        to: integer(0, 23),
        remove: integer(0, 23),
      },
    },
    examples: [
      { from: null, to: 4 },
      { from: 3, to: 4 },
      { from: 5, to: 6, remove: 2 },
    ],
  },

  nim: {
    $schema: DRAFT,
    title: "nim",
    description: "Remove `take` stones from `pile`. Three piles total.",
    schema: {
      type: "object",
      required: ["pile", "take"],
      additionalProperties: false,
      properties: { pile: integer(0, 2), take: { type: "integer", minimum: 1 } },
    },
    examples: [
      { pile: 0, take: 1 },
      { pile: 2, take: 2 },
    ],
  },

  hex: {
    $schema: DRAFT,
    title: "hex",
    description: "Place at (row, col) on the 11×11 hex grid.",
    schema: {
      type: "object",
      required: ["row", "col"],
      additionalProperties: false,
      properties: { row: integer(0, 10), col: integer(0, 10) },
    },
    examples: [
      { row: 5, col: 5 },
      { row: 0, col: 0 },
    ],
  },

  quoridor: {
    $schema: DRAFT,
    title: "quoridor",
    description:
      "Discriminator `kind`: 'pawn' moves your piece (with `to: {row, col}`, both 0–8); 'wall' places a wall (with `wall: {type: 'h'|'v', row, col}`, coords 0–7).",
    schema: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "to"],
          additionalProperties: false,
          properties: {
            kind: { const: "pawn" },
            to: {
              type: "object",
              required: ["row", "col"],
              additionalProperties: false,
              properties: { row: integer(0, 8), col: integer(0, 8) },
            },
          },
        },
        {
          type: "object",
          required: ["kind", "wall"],
          additionalProperties: false,
          properties: {
            kind: { const: "wall" },
            wall: {
              type: "object",
              required: ["type", "row", "col"],
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ["h", "v"] },
                row: integer(0, 7),
                col: integer(0, 7),
              },
            },
          },
        },
      ],
    },
    examples: [
      { kind: "pawn", to: { row: 1, col: 4 } },
      { kind: "wall", wall: { type: "h", row: 3, col: 2 } },
    ],
  },

  santorini: {
    $schema: DRAFT,
    title: "santorini",
    description:
      "Move one of your two builders (`builder`: 0 or 1), step `to`, then `build` on an adjacent square. All coords 0–4.",
    schema: {
      type: "object",
      required: ["builder", "to", "build"],
      additionalProperties: false,
      properties: {
        builder: { type: "integer", enum: [0, 1] },
        to: {
          type: "object",
          required: ["row", "col"],
          additionalProperties: false,
          properties: { row: integer(0, 4), col: integer(0, 4) },
        },
        build: {
          type: "object",
          required: ["row", "col"],
          additionalProperties: false,
          properties: { row: integer(0, 4), col: integer(0, 4) },
        },
      },
    },
    examples: [
      {
        builder: 0,
        to: { row: 1, col: 1 },
        build: { row: 1, col: 2 },
      },
    ],
  },

  tak: {
    $schema: DRAFT,
    title: "tak",
    description:
      "Place a stone at `to: {row, col}`. `kind`: 'F' (flat stone) or 'W' (wall). Coords 0–4 on the 5×5 board.",
    schema: {
      type: "object",
      required: ["to", "kind"],
      additionalProperties: false,
      properties: {
        to: {
          type: "object",
          required: ["row", "col"],
          additionalProperties: false,
          properties: { row: integer(0, 4), col: integer(0, 4) },
        },
        kind: { type: "string", enum: ["F", "W"] },
      },
    },
    examples: [
      { to: { row: 2, col: 2 }, kind: "F" },
      { to: { row: 0, col: 3 }, kind: "W" },
    ],
  },

  yote: {
    $schema: DRAFT,
    title: "yote",
    description:
      "Discriminator `kind`: 'drop' (place a reserve piece at `to`), 'move' (slide `from`→`to` to an orthogonally-adjacent empty cell), or 'capture' (jump `from`→`to` over an adjacent enemy — the jumped piece is removed automatically, and `remove` names one OTHER enemy cell for the wild double-remove, or null when none exists). All cell indices 0–29 (`index = row*6 + col`).",
    schema: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "to"],
          additionalProperties: false,
          properties: { kind: { const: "drop" }, to: integer(0, 29) },
        },
        {
          type: "object",
          required: ["kind", "from", "to"],
          additionalProperties: false,
          properties: {
            kind: { const: "move" },
            from: integer(0, 29),
            to: integer(0, 29),
          },
        },
        {
          type: "object",
          required: ["kind", "from", "to"],
          additionalProperties: false,
          properties: {
            kind: { const: "capture" },
            from: integer(0, 29),
            to: integer(0, 29),
            remove: { oneOf: [{ type: "null" }, integer(0, 29)] },
          },
        },
      ],
    },
    examples: [
      { kind: "drop", to: 14 },
      { kind: "move", from: 14, to: 8 },
      { kind: "capture", from: 14, to: 2, remove: 20 },
    ],
  },

  "liars-dice": {
    $schema: DRAFT,
    title: "liars-dice",
    description:
      "Discriminator `kind`: 'bid' raises the standing bid (`quantity` ≥ 1, `face` 1–6; must be strictly higher — more quantity, or equal quantity + higher face); 'challenge' calls the standing bid a lie. Read your own dice from privateState.myDice; the opponent's cup is hidden.",
    schema: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "quantity", "face"],
          additionalProperties: false,
          properties: {
            kind: { const: "bid" },
            quantity: { type: "integer", minimum: 1 },
            face: integer(1, 6),
          },
        },
        {
          type: "object",
          required: ["kind"],
          additionalProperties: false,
          properties: { kind: { const: "challenge" } },
        },
      ],
    },
    examples: [
      { kind: "bid", quantity: 3, face: 4 },
      { kind: "bid", quantity: 3, face: 5 },
      { kind: "challenge" },
    ],
  },

  battleship: {
    $schema: DRAFT,
    title: "battleship",
    description:
      "Discriminator `kind`: 'place' submits your whole fleet once (exactly five ships of lengths 5,4,3,3,2; each `{length, row, col, orientation}` with orientation 'h'=rightward or 'v'=downward; all on-board, no overlap); 'fire' shoots one un-fired cell `{row, col}` (both 0–9). Read your own fleet from privateState.myFleet; the opponent's un-hit cells are hidden.",
    schema: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "ships"],
          additionalProperties: false,
          properties: {
            kind: { const: "place" },
            ships: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: {
                type: "object",
                required: ["length", "row", "col", "orientation"],
                additionalProperties: false,
                properties: {
                  length: integer(2, 5),
                  row: integer(0, 9),
                  col: integer(0, 9),
                  orientation: { type: "string", enum: ["h", "v"] },
                },
              },
            },
          },
        },
        {
          type: "object",
          required: ["kind", "row", "col"],
          additionalProperties: false,
          properties: {
            kind: { const: "fire" },
            row: integer(0, 9),
            col: integer(0, 9),
          },
        },
      ],
    },
    examples: [
      {
        kind: "place",
        ships: [
          { length: 5, row: 0, col: 0, orientation: "h" },
          { length: 4, row: 2, col: 0, orientation: "h" },
          { length: 3, row: 4, col: 0, orientation: "h" },
          { length: 3, row: 6, col: 0, orientation: "v" },
          { length: 2, row: 6, col: 5, orientation: "h" },
        ],
      },
      { kind: "fire", row: 4, col: 7 },
    ],
  },

  backgammon: {
    $schema: DRAFT,
    title: "backgammon",
    description:
      'Submit your whole turn as `moves`: an array of {from, to} hops — one per die played (up to 4 on doubles), or [] to pass when you have NO legal move. `from` is a point 0–23 or "bar" (re-enter a hit checker); `to` is a point 0–23 or "off" (bear off). Player 0 moves toward index 0, player 1 toward 23. You must use the maximum number of dice possible.',
    schema: {
      type: "object",
      required: ["moves"],
      additionalProperties: false,
      properties: {
        moves: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            required: ["from", "to"],
            additionalProperties: false,
            properties: {
              from: { oneOf: [integer(0, 23), { const: "bar" }] },
              to: { oneOf: [integer(0, 23), { const: "off" }] },
            },
          },
        },
      },
    },
    examples: [
      { moves: [{ from: 12, to: 7 }, { from: 7, to: 5 }] },
      { moves: [{ from: "bar", to: 23 }, { from: 12, to: 8 }] },
      { moves: [] },
    ],
  },
};

/** Returns the schema bundle for a game, or null if unknown. */
export function getGameSchema(gameType: string): GamePayloadSchema | null {
  return GAME_SCHEMAS[gameType] ?? null;
}

/** List of all game ids we have schemas for. */
export function listGameSchemaIds(): string[] {
  return Object.keys(GAME_SCHEMAS);
}
