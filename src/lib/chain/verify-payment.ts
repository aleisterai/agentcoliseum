/**
 * verifyDirectUsdcPayment — server-side verification of a direct USDC
 * `transfer(operator, amount)` payment on Base.
 *
 * Used as the fallback for wallets that can't go through the x402 facilitator
 * (today: Coinbase Smart Wallet, due to upstream issue
 * github.com/x402-foundation/x402/issues/2110 — facilitator rejects
 * ERC-6492-wrapped signatures from deployed smart wallets).
 *
 * Verification matches a USDC Transfer EVENT inside the tx receipt logs
 * rather than the top-level call. That makes the check work for both:
 *   - EOA → USDC.transfer() (top-level call is the transfer)
 *   - Smart account → ERC-4337 EntryPoint → wallet contract → USDC.transfer()
 *     (the top-level tx is from the bundler, but a Transfer event still
 *     fires with from = smart account, to = operator)
 *
 * Returns a discriminated result so the caller can map specific failures
 * to specific HTTP error codes / messages without leaking arbitrary RPC
 * errors to the user.
 */
import {
  erc20Abi,
  parseEventLogs,
  type Log,
  type TransactionReceipt,
} from "viem";

// USDC native on Base (6 decimals). Duplicated from aerodrome.ts (which is
// server-only) so this helper stays testable without importing the wallet
// stack. Update both if Coinbase ever migrates the contract.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/**
 * Minimal structural client interface — avoids importing viem's PublicClient
 * type alias directly, which collides under pnpm's hoisted multi-viem
 * dependency graph (TS2719). The call sites infer the concrete type.
 */
interface MinimalPublicClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<TransactionReceipt>;
  getBlock(args: { blockHash: `0x${string}` }): Promise<{ timestamp: bigint }>;
}

export interface VerifyDirectUsdcPaymentArgs {
  publicClient: MinimalPublicClient;
  txHash: `0x${string}`;
  expectedFrom: `0x${string}`;
  expectedTo: `0x${string}`;
  expectedAmount: bigint;
  maxAgeSeconds?: number;
}

export interface VerifyReceiptArgs {
  receipt: Pick<TransactionReceipt, "status" | "logs" | "blockNumber" | "blockHash">;
  blockTimestamp?: bigint | number;
  expectedFrom: `0x${string}`;
  expectedTo: `0x${string}`;
  expectedAmount: bigint;
  maxAgeSeconds?: number;
}

export type VerifyDirectUsdcPaymentResult =
  | { ok: true; blockNumber: bigint }
  | { ok: false; code: VerifyFailureCode; detail?: string };

export type VerifyFailureCode =
  | "tx_not_found"
  | "tx_reverted"
  | "no_matching_transfer"
  | "tx_too_old";

/** Strict equality on hex addresses, normalized to lowercase. */
function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Pure: given a tx receipt (and optional block timestamp), check that it
 * contains a USDC Transfer with the expected from/to/amount. Used by both
 * the live verifier and the test suite.
 */
export function verifyReceipt(args: VerifyReceiptArgs): VerifyDirectUsdcPaymentResult {
  const { receipt, expectedFrom, expectedTo, expectedAmount } = args;
  const maxAge = args.maxAgeSeconds ?? 3600;

  if (receipt.status !== "success") return { ok: false, code: "tx_reverted" };

  const transferLogs = parseEventLogs({
    abi: erc20Abi,
    logs: receipt.logs as unknown as Log[],
    eventName: "Transfer",
  });

  const matching = transferLogs.find(
    (log) =>
      eqAddr(log.address, USDC_BASE) &&
      eqAddr(log.args.from, expectedFrom) &&
      eqAddr(log.args.to, expectedTo) &&
      log.args.value === expectedAmount,
  );
  if (!matching) {
    return {
      ok: false,
      code: "no_matching_transfer",
      detail: `Expected USDC transfer of ${expectedAmount} from ${expectedFrom} → ${expectedTo} (token ${USDC_BASE}); no matching Transfer event found.`,
    };
  }

  if (args.blockTimestamp != null) {
    const tsSec = Number(args.blockTimestamp);
    const ageSeconds = Math.floor(Date.now() / 1000) - tsSec;
    if (ageSeconds > maxAge) {
      return {
        ok: false,
        code: "tx_too_old",
        detail: `Tx is ${ageSeconds}s old; max ${maxAge}s.`,
      };
    }
  }

  return { ok: true, blockNumber: receipt.blockNumber };
}

/**
 * Live verifier — fetches the receipt + block, then delegates to verifyReceipt.
 * Used as the fallback for wallets that can't go through the x402 facilitator
 * (today: Coinbase Smart Wallet, due to upstream
 * github.com/x402-foundation/x402/issues/2110).
 *
 * Matches a USDC Transfer EVENT inside the receipt logs rather than the
 * top-level call so it works for both EOAs (which call transfer directly)
 * and ERC-4337 smart accounts (where the bundler is the tx.from but a
 * Transfer log still fires with from = smart account).
 */
export async function verifyDirectUsdcPayment(
  args: VerifyDirectUsdcPaymentArgs,
): Promise<VerifyDirectUsdcPaymentResult> {
  let receipt: TransactionReceipt | null = null;
  try {
    receipt = await args.publicClient.getTransactionReceipt({ hash: args.txHash });
  } catch {
    return { ok: false, code: "tx_not_found" };
  }
  if (!receipt) return { ok: false, code: "tx_not_found" };

  let blockTimestamp: bigint | undefined;
  try {
    const block = await args.publicClient.getBlock({ blockHash: receipt.blockHash });
    blockTimestamp = block.timestamp;
  } catch {
    // RPC blip → skip staleness check (other guards: dollar cap + unique tx hash).
  }

  return verifyReceipt({
    receipt,
    blockTimestamp,
    expectedFrom: args.expectedFrom,
    expectedTo: args.expectedTo,
    expectedAmount: args.expectedAmount,
    maxAgeSeconds: args.maxAgeSeconds,
  });
}
