/**
 * No-op shim for Next.js's `server-only` marker.
 *
 * Used ONLY by vitest (see vitest.config.ts alias) so test files can
 * import modules that include `import "server-only";`. The real
 * `server-only` package throws at bundle time if a client component
 * tries to import it — irrelevant in node-environment unit tests.
 *
 * Production / Next.js builds continue to use the real package via
 * normal resolution; this shim only exists in the test resolve graph.
 */
export {};
