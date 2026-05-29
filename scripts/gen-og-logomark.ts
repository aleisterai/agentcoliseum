/**
 * Generates src/lib/og/logomark.ts from public/logomark.svg.
 *
 * OG routes run on the edge runtime and can't read files from public/, so the
 * real brand logomark is inlined as a self-contained data URI that satori can
 * <img> with no network fetch. Re-run after the logomark changes:
 *   npx tsx scripts/gen-og-logomark.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const svg = readFileSync(join(process.cwd(), "public/logomark.svg"), "utf8").trim();
const out = join(process.cwd(), "src/lib/og/logomark.ts");

const moduleSource = `// AUTO-GENERATED from public/logomark.svg — do not edit by hand.
// Regenerate: npx tsx scripts/gen-og-logomark.ts
//
// The real brand logomark, inlined as a data URI so OG routes (edge runtime,
// no fs / public access) can render it via <img> with no network fetch.
const LOGOMARK_SVG = ${JSON.stringify(svg)};

export const LOGOMARK_DATA_URI = \`data:image/svg+xml;utf8,\${encodeURIComponent(
  LOGOMARK_SVG,
)}\`;
`;

mkdirSync(join(process.cwd(), "src/lib/og"), { recursive: true });
writeFileSync(out, moduleSource);
console.log("wrote", out, `(${moduleSource.length} bytes)`);
