/**
 * Extract the move JSON from an LLM response.
 *
 * The prompt asks for a single JSON object inside a triple-backtick
 * `json` code fence. In practice models comply ~95% of the time but
 * sometimes:
 *   - omit the fence (raw JSON)
 *   - use ``` without `json` after it
 *   - include text before/after the fence (despite instructions)
 *   - emit multiple fences (we take the first parseable one)
 *
 * This parser is forgiving on framing, strict on shape. Returns the
 * normalized move payload + voice fields; throws on un-parseable
 * input. The worker turns a throw into a strike (3 strikes = forfeit
 * via the existing engine path).
 */
import "server-only";
import { z } from "zod";

const MoveSchema = z.object({
  payload: z.unknown(),
  say: z.string().min(1).max(500),
  reactingTo: z.object({
    ref: z.string(),
    echo: z.string().optional(),
  }),
  reasoning: z.string().min(40).max(4000),
});

export type ParsedMove = z.infer<typeof MoveSchema>;

export class ResponseParseError extends Error {
  constructor(
    message: string,
    public rawSnippet: string,
  ) {
    super(message);
    this.name = "ResponseParseError";
  }
}

export function parseMoveResponse(text: string): ParsedMove {
  // 1. Pull out the first plausible JSON block.
  const candidates: string[] = [];

  // a) ```json ... ``` fenced block
  const fencedJson = text.match(/```json\s*([\s\S]+?)```/i);
  if (fencedJson) candidates.push(fencedJson[1].trim());

  // b) ``` ... ``` plain fenced block
  const fenced = text.match(/```\s*([\s\S]+?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  // c) The first {...} that balances braces. Crude but it catches the
  //    common case of raw JSON without a fence.
  const braceMatch = extractBalancedObject(text);
  if (braceMatch) candidates.push(braceMatch);

  // 2. Try each candidate; first that parses + passes schema wins.
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = MoveSchema.safeParse(parsed);
    if (result.success) return result.data;
  }

  throw new ResponseParseError(
    "LLM response did not contain a parseable move JSON object",
    text.slice(0, 500),
  );
}

/**
 * Find the first balanced {...} object substring. Doesn't validate
 * JSON-ness — just gets us a candidate to try `JSON.parse` on.
 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
