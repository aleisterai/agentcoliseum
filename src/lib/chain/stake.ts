/**
 * Server-side helpers for moving stake USDC into / out of the operator
 * wallet via the owner's pre-approved allowance.
 *
 * Phase 1 v1 escrow model: operator wallet holds stakes between
 * challenge propose/accept and settlement. Owner approves operator
 * once via OwnerStakeControl; this module's pullStake() is what the
 * lobby endpoints call to actually move the money on propose/accept.
 *
 * NOT used directly by the LLM — server-only. The LLM never sees a
 * private key. The operator's PLATFORM_OPERATOR_PRIVATE_KEY signs the
 * USDC.transferFrom call which is the entire on-chain action.
 *
 * Failure modes the caller must handle:
 *   - insufficient_allowance: owner hasn't approved enough; tell the
 *     LLM to ask the owner to bump approval.
 *   - insufficient_balance: owner approved enough but doesn't have
 *     the USDC; tell the LLM to fund the wallet.
 *   - rpc / network errors propagate; caller decides if it retries.
 */
import "server-only";
import { erc20Abi } from "viem";
import { base } from "viem/chains";
import { getOperatorWallet, getOperatorAddress } from "./wallet";
import { publicClient } from "./viem";
import { USDC_BASE } from "./aerodrome";
import { submitOperatorTx } from "./operator-nonce";

export interface PullStakeResult {
  txHash: `0x${string}`;
  ownerWallet: `0x${string}`;
  operatorWallet: `0x${string}`;
  stakeUsdc: number;
}

export class StakePullError extends Error {
  constructor(
    public readonly code:
      | "insufficient_allowance"
      | "insufficient_balance"
      | "transferFrom_reverted"
      | "rpc_error",
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StakePullError";
  }
}

/**
 * Pull `stakeUsdc` microUSDC from `ownerWallet` to the operator wallet
 * via USDC.transferFrom. Resolves with the tx hash after the tx is
 * mined (status: success). Throws StakePullError on any failure with a
 * machine-parseable code the lobby route can map to a user-facing
 * message.
 *
 * Pre-flight checks run before submitting the tx: balance and
 * allowance reads via publicClient. This converts most failure modes
 * into clean rejections instead of reverted-tx blockchain debris.
 */
export async function pullStake(
  ownerWallet: `0x${string}`,
  stakeUsdc: number,
): Promise<PullStakeResult> {
  if (!Number.isInteger(stakeUsdc) || stakeUsdc <= 0) {
    throw new StakePullError(
      "transferFrom_reverted",
      `pullStake stakeUsdc must be a positive integer (got ${stakeUsdc})`,
    );
  }
  const operator = getOperatorAddress();
  const stake = BigInt(stakeUsdc);

  // Pre-flight: read balance + allowance. Both reads via the platform
  // RPC, so a failure here returns rpc_error.
  let balance: bigint;
  let allowance: bigint;
  try {
    [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ownerWallet],
      }),
      publicClient.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ownerWallet, operator],
      }),
    ]);
  } catch (err) {
    throw new StakePullError("rpc_error", "Failed to read USDC balance/allowance", err);
  }

  if (allowance < stake) {
    throw new StakePullError(
      "insufficient_allowance",
      `Owner has approved only ${allowance} microUSDC to the operator; need ${stake} for this stake. Owner must call USDC.approve(operator, ≥ ${stake}) before retrying.`,
    );
  }
  if (balance < stake) {
    throw new StakePullError(
      "insufficient_balance",
      `Owner balance ${balance} microUSDC < required stake ${stake}. Top up the owner wallet first.`,
    );
  }

  const wallet = getOperatorWallet();
  let txHash: `0x${string}`;
  try {
    // Serialize through the nonce manager so concurrent stake-pulls
    // (e.g. two acceptors hitting the lobby at once, or stake-pull
    // + a settlement-sweep payout firing the same tick) don't collide
    // on the same nonce.
    txHash = await submitOperatorTx((nonce) =>
      wallet.writeContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "transferFrom",
        args: [ownerWallet, operator, stake],
        chain: base,
        account: wallet.account,
        nonce,
      }),
    );
  } catch (err) {
    throw new StakePullError(
      "transferFrom_reverted",
      `transferFrom write failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Wait for the receipt — we want to know it actually moved before
  // the caller records the row + considers the stake escrowed.
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });
  if (receipt.status !== "success") {
    throw new StakePullError(
      "transferFrom_reverted",
      `transferFrom reverted on-chain. tx: ${txHash}`,
    );
  }

  return {
    txHash,
    ownerWallet,
    operatorWallet: operator,
    stakeUsdc,
  };
}

/**
 * Refund a previously pulled proposer stake — operator wallet sends
 * USDC.transfer(ownerWallet, stake). Used by the refund cron when a
 * challenge expires without acceptance. Acceptor refunds (rare; only
 * if the match gets voided server-side) also go through this.
 */
export async function refundStake(
  ownerWallet: `0x${string}`,
  stakeUsdc: number,
): Promise<`0x${string}`> {
  if (!Number.isInteger(stakeUsdc) || stakeUsdc <= 0) {
    throw new StakePullError(
      "transferFrom_reverted",
      `refundStake stakeUsdc must be a positive integer (got ${stakeUsdc})`,
    );
  }
  const wallet = getOperatorWallet();
  const txHash = await submitOperatorTx((nonce) =>
    wallet.writeContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: "transfer",
      args: [ownerWallet, BigInt(stakeUsdc)],
      chain: base,
      account: wallet.account,
      nonce,
    }),
  );
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });
  if (receipt.status !== "success") {
    throw new StakePullError(
      "transferFrom_reverted",
      `refund transfer reverted on-chain. tx: ${txHash}`,
    );
  }
  return txHash;
}
