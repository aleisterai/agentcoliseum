/**
 * realtime-loopback — minimal diagnostic: subscribe and broadcast from
 * the SAME process to verify Supabase Realtime delivery works at all
 * outside the Vercel serverless context.
 *
 * If this passes locally but the WS1 e2e against Vercel fails, the bug
 * is Vercel-specific (function suspends WS, singleton-client corruption,
 * or similar). If this fails locally too, the bug is config / project
 * level (RLS, broadcast feature disabled, etc.).
 *
 * Usage:
 *   pnpm tsx scripts/realtime-loopback.ts
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */
import { config as dotenvConfig } from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenvConfig({ path: ".env.local" });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const CHANNEL = `loopback:${Math.random().toString(36).slice(2, 8)}`;
const EVENT = "ping";
const PAYLOAD = { hello: "world", t: Date.now() };

async function main() {
  console.log(`URL: ${url}`);
  console.log(`Channel: ${CHANNEL}`);

  // Subscriber client.
  const subClient = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const subChannel = subClient.channel(CHANNEL, {
    config: { broadcast: { self: false, ack: false } },
  });

  let received: unknown = null;
  subChannel.on("broadcast", { event: EVENT }, (msg) => {
    received = msg.payload;
    console.log(`[sub] received broadcast:`, msg.payload);
  });

  console.log(`[sub] subscribing…`);
  const subscribedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("subscribe timeout 10s")), 10_000);
    subChannel.subscribe((status) => {
      console.log(`[sub] status: ${status}`);
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        clearTimeout(timeout);
        reject(new Error(`subscribe ended with status ${status}`));
      }
    });
  });
  console.log(`[sub] SUBSCRIBED in ${Date.now() - subscribedAt}ms`);

  // Wait a beat to settle.
  await new Promise((r) => setTimeout(r, 500));

  // Publisher client (separate instance, same as production splits).
  const pubClient = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pubChannel = pubClient.channel(CHANNEL);
  console.log(`[pub] sending broadcast…`);
  const sendStart = Date.now();
  const sendResult = await pubChannel.send({
    type: "broadcast",
    event: EVENT,
    payload: PAYLOAD,
  });
  console.log(`[pub] send returned in ${Date.now() - sendStart}ms: ${sendResult}`);

  // Wait up to 5s for delivery.
  const deadline = Date.now() + 5_000;
  while (received === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (received) {
    console.log(`\n✓ PASS — broadcast delivered loopback`);
    process.exit(0);
  } else {
    console.log(`\n✗ FAIL — broadcast NOT delivered after 5s`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
