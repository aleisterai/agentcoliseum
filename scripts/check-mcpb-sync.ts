/**
 * scripts/check-mcpb-sync.ts
 *
 * Fail-loud sanity check that the two committed copies of the MCP
 * bundle source stay byte-identical:
 *
 *   - `mcpb/server/coliseum-mcp.mjs`  → canonical source (edit here)
 *   - `public/coliseum-mcp.mjs`       → derived artifact (copied at build)
 *
 * The `build:mcpb` script does `cp mcpb/server/coliseum-mcp.mjs
 * public/coliseum-mcp.mjs` at build time, so the public copy is the
 * downstream artifact. But the public file is ALSO committed to git
 * so `next dev` can serve it before any build runs. Manual edits to
 * public/ are a footgun — the next `pnpm build` overwrites them
 * silently.
 *
 * This script catches divergence at CI / pre-commit time. Run via
 *   pnpm check:mcpb-sync
 *
 * Exit 0 if identical, non-zero with a clear diagnostic otherwise.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// process.cwd() = repo root when invoked via `pnpm check:mcpb-sync`.
// tsx transpiles to CJS where `import.meta.dirname` is undefined, so
// process.cwd() is the more portable choice.
const ROOT = process.cwd();
const CANONICAL = resolve(ROOT, "mcpb/server/coliseum-mcp.mjs");
const ARTIFACT = resolve(ROOT, "public/coliseum-mcp.mjs");

async function md5(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("md5").update(buf).digest("hex");
}

async function main(): Promise<number> {
  const [canonicalHash, artifactHash] = await Promise.all([
    md5(CANONICAL),
    md5(ARTIFACT),
  ]);

  if (canonicalHash === artifactHash) {
    console.log(
      `✓ mcpb bundle in sync (${canonicalHash.slice(0, 12)}) — mcpb/server == public`,
    );
    return 0;
  }

  console.error("✗ mcpb bundle out of sync:");
  console.error(`  mcpb/server/coliseum-mcp.mjs  ${canonicalHash}`);
  console.error(`  public/coliseum-mcp.mjs       ${artifactHash}`);
  console.error("");
  console.error("Fix: edit the canonical source at mcpb/server/coliseum-mcp.mjs,");
  console.error("then run `pnpm build:mcpb` (or just `pnpm build`) to refresh");
  console.error("the public/ copy. Never edit public/coliseum-mcp.mjs directly —");
  console.error("the next build will overwrite it.");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("check:mcpb-sync crashed", err);
    process.exit(2);
  });
