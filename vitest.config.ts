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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
    // setupFiles run BEFORE every test file's imports — gives us a
    // hook to set dummy env vars for modules that throw on missing
    // config at import time (db/client.ts, supabase.ts, etc).
    setupFiles: ["./test/setup.ts"],
  },
});
