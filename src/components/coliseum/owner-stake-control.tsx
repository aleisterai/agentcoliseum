"use client";

/**
 * OwnerStakeControl — owner-facing stake-cap + allowance panel.
 *
 * Dual-cap model:
 *   - hard (owner-set, this UI)  — per-match ceiling. The LLM cannot
 *     stake above this.
 *   - soft (LLM-set via MCP)     — per-match preference, must be ≤ hard.
 *
 * The on-chain side is the owner's USDC.allowance to the operator
 * wallet. Operator pulls stake via `transferFrom` at match start, so
 * the allowance is the hard floor of what's actually spendable. We
 * display all three (hard, soft, allowance) plus the effective cap
 * (the min of all three with the rookie pool factored in).
 *
 * Approve button calls USDC.approve(operator, hard × 10) so a normal
 * burst of matches doesn't keep prompting the owner to re-approve.
 * Owner can revoke by setting allowance to 0 from any wallet UI.
 *
 * Owner-only — hides on 401 like the other manage-page panels.
 */
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { erc20Abi, parseUnits } from "viem";

type SetupPayload = {
  stakeCapHardUsdc: number;
  stakeCapSoftUsdc: number | null;
  onChainAllowanceUsdc: number;
  ownerWalletAddress: `0x${string}`;
  operatorAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  recalled: boolean;
};

function fmtUsdc(microUsdc: number | bigint): string {
  const n = typeof microUsdc === "bigint" ? Number(microUsdc) : microUsdc;
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(2)}M`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}k`;
  return (n / 1_000_000).toFixed(2);
}

export function OwnerStakeControl({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { address: connectedWallet } = useAccount();
  const [hidden, setHidden] = useState(true);
  const [data, setData] = useState<SetupPayload | null>(null);
  const [hardDraft, setHardDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch caps + allowance from the setup endpoint.
  async function refresh() {
    if (!authenticated) return;
    try {
      const t = await getAccessToken();
      if (!t) return;
      const res = await fetch(`/api/owners/me/agents/${handle}/setup`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) {
        setHidden(true);
        return;
      }
      const json = (await res.json()) as SetupPayload;
      setData(json);
      setHardDraft(fmtUsdc(json.stakeCapHardUsdc));
      setHidden(false);
    } catch {
      setHidden(true);
    }
  }

  useEffect(() => {
    if (!ready || !authenticated) {
      setHidden(true);
      return;
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, handle]);

  // Live on-chain allowance read via wagmi — useful so the panel updates
  // right after the approve tx confirms without re-hitting the setup
  // endpoint.
  const { data: liveAllowance, refetch: refetchAllowance } = useReadContract({
    address: data?.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args:
      data?.ownerWalletAddress && data?.operatorAddress
        ? [data.ownerWalletAddress, data.operatorAddress]
        : undefined,
    query: { enabled: !!data?.ownerWalletAddress },
  });
  const allowance =
    typeof liveAllowance === "bigint"
      ? Number(liveAllowance)
      : data?.onChainAllowanceUsdc ?? 0;

  // Approve tx (USDC.approve(operator, hard × 10)).
  const { writeContractAsync, isPending: isApproving } = useWriteContract();
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isWaitingApproval } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: !!approveTxHash },
  });

  async function approveAllowance(targetUsdc: number) {
    if (!data) return;
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: data.usdcAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [data.operatorAddress, BigInt(targetUsdc)],
      });
      setApproveTxHash(hash);
      // After receipt, refresh the on-chain read.
      setTimeout(() => void refetchAllowance(), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function revokeAllowance() {
    return approveAllowance(0);
  }

  async function saveHardCap() {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      // Parse the input (in USDC, decimal allowed) into microUSDC.
      const parsed = parseUnits(hardDraft || "0", 6);
      const microUsdc = Number(parsed);
      if (microUsdc < 0 || microUsdc > 10_000_000_000) {
        throw new Error("Hard cap must be between 0 and 10,000 USDC.");
      }
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({ stakeCapHardUsdc: microUsdc }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(body.message ?? body.error ?? `save failed: ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (hidden || !data) return null;

  const softOrHard = data.stakeCapSoftUsdc ?? data.stakeCapHardUsdc;
  const effective = Math.min(softOrHard, allowance);
  const allowanceShortfall = allowance < data.stakeCapHardUsdc;
  const wrongWallet =
    connectedWallet &&
    connectedWallet.toLowerCase() !== data.ownerWalletAddress.toLowerCase();
  const draftMicroUsdc = (() => {
    try {
      return Number(parseUnits(hardDraft || "0", 6));
    } catch {
      return NaN;
    }
  })();
  const dirty =
    !Number.isNaN(draftMicroUsdc) && draftMicroUsdc !== data.stakeCapHardUsdc;

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">Stake caps · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: effective > 0 ? "var(--gold)" : "var(--text-mute)",
          }}
        >
          effective · ◆ {fmtUsdc(effective)} / match
        </span>
      </div>

      <div style={{ padding: 18 }}>
        {data.recalled ? (
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 12,
              color: "var(--ox-bright)",
              lineHeight: 1.55,
            }}
          >
            Agent is recalled — caps are inert until the recall clears.
          </p>
        ) : null}

        <p
          style={{
            margin: "0 0 14px",
            fontSize: 12,
            color: "var(--text-2)",
            lineHeight: 1.55,
          }}
        >
          The owner (you) sets the <strong>hard cap</strong> — the per-match
          ceiling. The LLM picks a <strong>soft cap</strong> at or below the
          hard. The operator pulls stake from your wallet via{" "}
          <code className="mono">USDC.transferFrom</code> at match start, so
          the on-chain <strong>allowance</strong> is the real floor of what
          can move. Effective per-match cap is the minimum of all three.
        </p>

        {/* Three-row read-only summary + edit on hard. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            columnGap: 14,
            rowGap: 8,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {/* Hard */}
          <span style={{ color: "var(--text-mute)" }}>Hard cap (yours)</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mono" style={{ color: "var(--text-mute)" }}>
              ◆
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={hardDraft}
              disabled={saving || data.recalled}
              onChange={(e) => setHardDraft(e.target.value)}
              style={{
                width: 110,
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 13,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            />
            <span className="mono" style={{ color: "var(--text-mute)" }}>
              USDC
            </span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={saveHardCap}
            disabled={!dirty || saving || data.recalled}
            style={{
              fontSize: 11,
              color: dirty ? "var(--gold)" : "var(--text-mute)",
              borderColor: dirty
                ? "color-mix(in oklab, var(--gold) 45%, transparent)"
                : "var(--line)",
              background: dirty
                ? "color-mix(in oklab, var(--gold) 8%, transparent)"
                : "transparent",
            }}
          >
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>

          {/* Soft */}
          <span style={{ color: "var(--text-mute)" }}>Soft cap (LLM)</span>
          <span className="mono">
            ◆ {data.stakeCapSoftUsdc != null ? fmtUsdc(data.stakeCapSoftUsdc) : "—"}{" "}
            <span style={{ color: "var(--text-mute)", fontSize: 11 }}>
              {data.stakeCapSoftUsdc == null
                ? "(falls back to hard)"
                : "(LLM-set via MCP)"}
            </span>
          </span>
          <span />

          {/* Allowance */}
          <span style={{ color: "var(--text-mute)" }}>On-chain allowance</span>
          <span
            className="mono"
            style={{
              color: allowanceShortfall ? "var(--ox-bright)" : "var(--text)",
            }}
          >
            ◆ {fmtUsdc(allowance)}{" "}
            {allowanceShortfall ? (
              <span style={{ fontSize: 11 }}>
                — below hard cap, top up to enable real stakes
              </span>
            ) : null}
          </span>
          <span />
        </div>

        {/* Approve / revoke row */}
        <div
          style={{
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {wrongWallet ? (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ox-bright)",
                marginRight: "auto",
                letterSpacing: "0.04em",
              }}
            >
              ⚠ Connected wallet doesn&apos;t match the owner address. Switch
              wallets to approve.
            </span>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => approveAllowance(data.stakeCapHardUsdc * 10)}
            disabled={isApproving || isWaitingApproval || wrongWallet || data.recalled}
            style={{ fontSize: 11 }}
            title={`Approve operator to spend ${fmtUsdc(data.stakeCapHardUsdc * 10)} USDC (≈ 10 matches at the hard cap).`}
          >
            {isApproving || isWaitingApproval
              ? "Approving…"
              : `Approve ${fmtUsdc(data.stakeCapHardUsdc * 10)} USDC`}
          </button>
          {allowance > 0 ? (
            <button
              type="button"
              className="btn"
              onClick={revokeAllowance}
              disabled={isApproving || isWaitingApproval || wrongWallet}
              style={{
                fontSize: 11,
                color: "var(--ox-bright)",
                borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
                background: "color-mix(in oklab, var(--ox) 8%, transparent)",
              }}
              title="Revoke the operator's allowance (sets it to 0)."
            >
              Revoke
            </button>
          ) : null}
        </div>

        {error ? (
          <p
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "var(--ox-bright)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
