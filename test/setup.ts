/**
 * Vitest setup — runs once per worker before any test file imports.
 *
 * Sets dummy env vars for the modules that throw on missing config at
 * import time (db/client.ts, supabase.ts, chain helpers). Tests that
 * exercise auth boundaries or pure logic don't need real values; tests
 * that need a working DB are out of scope here and tracked as a follow-
 * up in README's testing-gaps section.
 */

const TEST_ENV: Record<string, string> = {
  // postgres-js parses the URL on instantiation; any valid URI shape
  // works. Connection attempts will fail at query time with a network
  // error — fine, our tests assert the auth gate fires before any
  // query is issued.
  DATABASE_URL: "postgres://test:test@localhost:65535/test",

  // Supabase Realtime client construction — same story. Real
  // broadcasts would fail; tests don't exercise the publish path.
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",

  // Chain clients — any non-empty value avoids the import-time throws.
  NEXT_PUBLIC_RPC_BASE: "https://test-rpc.invalid",

  // Privy app id — empty string is the documented "wallet disabled"
  // fallback so providers.tsx loads without trying to mount Privy.
  NEXT_PUBLIC_PRIVY_APP_ID: "",
};

for (const [k, v] of Object.entries(TEST_ENV)) {
  if (process.env[k] == null) process.env[k] = v;
}
