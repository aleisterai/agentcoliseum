#!/usr/bin/env tsx
/**
 * check-prerender-discipline
 *
 * Guards against the build-worker regression where a Client Component
 * page (with Privy / wagmi / Coinbase Smart Wallet imports) gets
 * picked up by Next.js's static-prerender pass and saturates the
 * Vercel build pool. Symptom: build time jumps from ~35s to 150s+.
 *
 * Rule: every `page.tsx` and `layout.tsx` under `src/app` that begins
 * with `"use client"` MUST also declare its render mode by exporting
 * `const dynamic = "..."`. This is a discipline check, not a security
 * boundary — the dynamic export forces Next.js to skip the static-
 * prerender pass for that route.
 *
 * Accepted values: "force-dynamic" (the common case here) or
 * "force-static" (explicit opt-in to prerender — rare for Client
 * Components, but allowed).
 *
 * Wired into package.json as `pnpm check:prerender-discipline`. Runs
 * in well under 1s; safe to add to pre-commit or CI.
 *
 * To intentionally allow a Client Component without a dynamic export
 * (e.g. a static marketing splash with no heavy imports), add the
 * file path to the ALLOWLIST below with a one-line justification.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const APP_DIR = join(ROOT, "src", "app");

/**
 * Files we explicitly allow to be Client Components without a
 * `dynamic` export. Keep this list short and justified — every entry
 * is a build-time risk if its imports change.
 */
const ALLOWLIST = new Set<string>([
  // intentionally empty
]);

interface Violation {
  file: string;
  reason: string;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      await walk(full, out);
    } else if (name === "page.tsx" || name === "layout.tsx") {
      out.push(full);
    }
  }
  return out;
}

/**
 * A file is a Client Component if its first non-blank line (allowing
 * leading // or /* comments) is the literal "use client" directive.
 * Next.js's own parser is strict about this — `"use client"` must be
 * the first non-comment line of the module — so we match that.
 */
function isClientComponent(source: string): boolean {
  const lines = source.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    return line === '"use client";' || line === "'use client';" ||
      line === '"use client"' || line === "'use client'";
  }
  return false;
}

/**
 * Returns the declared `dynamic` value if the file exports one,
 * otherwise null. We accept double or single quotes, and "force-dynamic"
 * or "force-static". Anything else (e.g. "auto") is rejected — be
 * explicit about render mode.
 */
function declaredDynamic(source: string): "force-dynamic" | "force-static" | null {
  const m = source.match(
    /export\s+const\s+dynamic\s*=\s*['"]([^'"]+)['"]/,
  );
  if (!m) return null;
  const v = m[1];
  if (v === "force-dynamic" || v === "force-static") return v;
  return null;
}

async function main() {
  const files = await walk(APP_DIR);
  const violations: Violation[] = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const source = await readFile(file, "utf8");
    if (!isClientComponent(source)) continue;
    const dyn = declaredDynamic(source);
    if (!dyn) {
      violations.push({
        file: rel,
        reason:
          'Client Component must export `const dynamic = "force-dynamic"` (or "force-static" if you really mean static). Missing this saturates Vercel build workers and balloons build time from 35s → 150s+.',
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `[32mok[0m prerender-discipline: ${files.length} pages/layouts checked, no violations.`,
    );
    process.exit(0);
  }

  console.error(
    `[31mfail[0m prerender-discipline: ${violations.length} violation${
      violations.length === 1 ? "" : "s"
    } found.\n`,
  );
  for (const v of violations) {
    console.error(`  • ${v.file}`);
    console.error(`    ${v.reason}\n`);
  }
  console.error(
    "Fix by adding to the top of the offending file (after \"use client\"):\n",
  );
  console.error('  export const dynamic = "force-dynamic";\n');
  console.error(
    "Or, if the page is genuinely safe to prerender (no Privy/wagmi/server I/O),",
  );
  console.error(
    "add it to ALLOWLIST in scripts/check-prerender-discipline.ts with a comment",
  );
  console.error("explaining why.\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("check-prerender-discipline crashed:", err);
  process.exit(2);
});
