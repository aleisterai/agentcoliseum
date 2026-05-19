/**
 * Pure tests for the receipt-verification logic. Covers:
 *   - EOA tx: top-level USDC transfer logs match
 *   - Smart account tx: bundler is tx.from, but a USDC Transfer log still
 *     fires with from = smart account → must match
 *   - Wrong recipient / wrong amount / wrong token → reject
 *   - Reverted tx → reject
 *   - Stale tx (block timestamp older than maxAge) → reject
 *
 * Receipts are hand-built — we don't need a real chain since the verifier
 * only reads logs/status/blockHash/blockNumber from the receipt shape.
 */
import { describe, it, expect } from "vitest";
import { encodeEventTopics, type Log } from "viem";
import { verifyReceipt } from "./verify-payment";

// All addresses are all-lowercase so they're valid hex without needing
// a proper EIP-55 checksum.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;
const OPERATOR = "0xb8080f8944dc7df8aa2a3d1d51c90b534c3852b0" as `0x${string}`;
const USER_EOA = "0x80bc0f31b6f33936635550301e821e010cad93e6" as `0x${string}`;
const SMART_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000bb" as `0x${string}`;
const REGISTER_FEE = 100_000n; // 0.10 USDC (6-decimal base units)

/**
 * Build a synthetic ERC-20 Transfer log. address = token contract; topics
 * are [Transfer event signature, indexed from, indexed to]; data = value.
 */
function makeTransferLog(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
): Log {
  const topics = encodeEventTopics({
    abi: [
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ],
    eventName: "Transfer",
    args: { from, to },
  }) as [`0x${string}`, `0x${string}`, `0x${string}`];
  const data = `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
  return {
    address: token,
    topics,
    data,
    blockHash: ("0x" + "11".repeat(32)) as `0x${string}`,
    blockNumber: 1n,
    transactionHash: ("0x" + "22".repeat(32)) as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function receipt(logs: Log[], status: "success" | "reverted" = "success") {
  return {
    status,
    // Test fixtures use mined logs (non-null blockHash). Cast for the
    // tighter `Log<bigint, number, false>` type viem narrows to in
    // verifyReceipt's receipt.logs parameter.
    logs: logs as unknown as Parameters<typeof import("./verify-payment").verifyReceipt>[0]["receipt"]["logs"],
    blockNumber: 1n,
    blockHash: ("0x" + "11".repeat(32)) as `0x${string}`,
  };
}

const nowTs = BigInt(Math.floor(Date.now() / 1000));

describe("verifyReceipt", () => {
  describe("happy path", () => {
    it("accepts an EOA → USDC.transfer(operator, 100_000)", () => {
      const result = verifyReceipt({
        receipt: receipt([
          makeTransferLog(USDC_BASE, USER_EOA, OPERATOR, REGISTER_FEE),
        ]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts a smart-wallet tx where the bundler is tx.from but Transfer log fires from the smart account", () => {
      // The bundler / entrypoint tx contains gas payment logs + the USDC
      // transfer log. The verifier should still find the Transfer event
      // with from = smart wallet, ignoring everything else.
      const ENTRYPOINT_GAS_LOG = makeTransferLog(
        USDC_BASE,
        SMART_WALLET,
        ("0x" + "bb".repeat(20)) as `0x${string}`, // some other recipient
        50_000n, // gas paymaster fee
      );
      const REAL_PAYMENT = makeTransferLog(USDC_BASE, SMART_WALLET, OPERATOR, REGISTER_FEE);
      const result = verifyReceipt({
        receipt: receipt([ENTRYPOINT_GAS_LOG, REAL_PAYMENT]),
        blockTimestamp: nowTs,
        expectedFrom: SMART_WALLET,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result.ok).toBe(true);
    });

    it("case-insensitive on address matching", () => {
      const result = verifyReceipt({
        receipt: receipt([
          makeTransferLog(
            USDC_BASE.toLowerCase() as `0x${string}`,
            USER_EOA.toLowerCase() as `0x${string}`,
            OPERATOR.toLowerCase() as `0x${string}`,
            REGISTER_FEE,
          ),
        ]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("rejections", () => {
    it("rejects when tx reverted", () => {
      const result = verifyReceipt({
        receipt: receipt(
          [makeTransferLog(USDC_BASE, USER_EOA, OPERATOR, REGISTER_FEE)],
          "reverted",
        ),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "tx_reverted" });
    });

    it("rejects when no matching Transfer event exists", () => {
      const result = verifyReceipt({
        receipt: receipt([]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "no_matching_transfer" });
    });

    it("rejects when recipient is wrong", () => {
      const wrong = ("0x" + "cc".repeat(20)) as `0x${string}`;
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(USDC_BASE, USER_EOA, wrong, REGISTER_FEE)]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "no_matching_transfer" });
    });

    it("rejects when amount is wrong (e.g., user underpaid 0.05 USDC)", () => {
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(USDC_BASE, USER_EOA, OPERATOR, 50_000n)]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "no_matching_transfer" });
    });

    it("rejects when token is wrong (e.g., random ERC-20)", () => {
      const fakeToken = ("0x" + "dd".repeat(20)) as `0x${string}`;
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(fakeToken, USER_EOA, OPERATOR, REGISTER_FEE)]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "no_matching_transfer" });
    });

    it("rejects when sender is wrong (e.g., claim someone else's payment)", () => {
      const otherUser = ("0x" + "ee".repeat(20)) as `0x${string}`;
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(USDC_BASE, otherUser, OPERATOR, REGISTER_FEE)]),
        blockTimestamp: nowTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result).toMatchObject({ ok: false, code: "no_matching_transfer" });
    });

    it("rejects stale tx (block older than maxAgeSeconds)", () => {
      const staleTs = nowTs - 7200n; // 2 hours old
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(USDC_BASE, USER_EOA, OPERATOR, REGISTER_FEE)]),
        blockTimestamp: staleTs,
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
        maxAgeSeconds: 3600,
      });
      expect(result).toMatchObject({ ok: false, code: "tx_too_old" });
    });

    it("accepts tx with timestamp not provided (block fetch failed, freshness skipped)", () => {
      const result = verifyReceipt({
        receipt: receipt([makeTransferLog(USDC_BASE, USER_EOA, OPERATOR, REGISTER_FEE)]),
        // blockTimestamp omitted
        expectedFrom: USER_EOA,
        expectedTo: OPERATOR,
        expectedAmount: REGISTER_FEE,
      });
      expect(result.ok).toBe(true);
    });
  });
});
