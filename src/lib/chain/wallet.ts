/**
 * Server-side wallet client for the platform operator.
 *
 * Holds the PLATFORM_OPERATOR_PRIVATE_KEY in process memory ONLY. Used for:
 *   - Approving USDC to Aerodrome
 *   - Swapping USDC → ALEISTER
 *   - Sending ALEISTER to the treasury wallet
 *   - Paying out paid-game pots to winners
 *
 * Never expose this client to the browser. The file imports `server-only` to
 * make accidental client imports fail at build time.
 */
import "server-only";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

let cached: ReturnType<typeof makeClient> | undefined;

function makeClient() {
  const pk = process.env.PLATFORM_OPERATOR_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!pk) {
    throw new Error("PLATFORM_OPERATOR_PRIVATE_KEY is not set. See .env.example.");
  }
  if (!rpcUrl) {
    throw new Error("BASE_RPC_URL is not set. See .env.example.");
  }
  const normalized: Hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  const account = privateKeyToAccount(normalized);
  return createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });
}

export function getOperatorWallet() {
  if (!cached) cached = makeClient();
  return cached;
}

export function getOperatorAddress(): `0x${string}` {
  return getOperatorWallet().account.address;
}
