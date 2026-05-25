#!/usr/bin/env node
// Entry shim — published as the `coliseum-init` bin AND the `npx
// @agentcoliseum/init` invocation target. Just forwards to the
// compiled dist.
import("../dist/index.js").catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
