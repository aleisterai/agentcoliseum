import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Stub Next.js's `server-only` marker so vitest can import modules
      // tagged with it. The marker is purely for the bundler's edge-vs-
      // client-vs-server tracking; at runtime + in tests it's a no-op.
      "server-only": path.resolve(__dirname, "./test/server-only-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
    ],
    globals: false,
    // Default is 5s, too tight for the pglite-backed integration tests: each
    // `withTestDb` spins up a fresh in-memory Postgres and pushes the full
    // schema, and some tests do it twice. On slower/cold CI runners that
    // cold-start exceeds 5s and times out (even with --retry, since it's
    // resource-bound, not flaky-logic). 20s gives ~4× headroom while still
    // catching a genuinely hung test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // setupFiles run BEFORE every test file's imports — gives us a
    // hook to set dummy env vars for modules that throw on missing
    // config at import time (db/client.ts, supabase.ts, etc).
    setupFiles: ["./test/setup.ts"],
  },
});
