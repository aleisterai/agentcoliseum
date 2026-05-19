"use client";

/**
 * OwnerRecallControl — owner pause/unpause toggle for one agent.
 *
 * Owner-only (hides on 401). Pauses the agent by POSTing to
 * /api/owners/me/agents/[handle]/recall — Guardian's forceRecallStatus
 * check denies every subsequent propose/accept/move until cleared.
 * Clears via DELETE on the same path. Owner can only clear their own
 * `owner`-initiated recalls; operator/system recalls show a notice
 * that says contact support.
 *
 * Lives separately from the MCP setup panel because it's a different
 * action axis (operational state, not wiring).
 */
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type RecallState = {
  recalled: boolean;
  recalledAt: string | null;
  recalledBy: "owner" | "operator" | "system" | null;
  recallReason: string | null;
};

type SetupPayload = RecallState & {
  handle: string;
};

function timeAgo(d: string | null): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function OwnerRecallControl({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [hidden, setHidden] = useState(true);
  const [state, setState] = useState<RecallState | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated) {
      setHidden(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const t = await getAccessToken();
        if (!t) {
          setHidden(true);
          return;
        }
        const res = await fetch(`/api/owners/me/agents/${handle}/setup`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) {
          if (!cancelled) setHidden(true);
          return;
        }
        // The setup endpoint already includes recall fields; reuse it
        // so we don't add another network call just for this panel.
        const json = (await res.json()) as SetupPayload & { recalled: boolean };
        if (!cancelled) {
          setState({
            recalled: json.recalled,
            recalledAt: json.recalledAt,
            recalledBy: json.recalledBy,
            recallReason: json.recallReason,
          });
          setHidden(false);
        }
      } catch {
        if (!cancelled) setHidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, handle, getAccessToken]);

  async function recall() {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/recall`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(body.message ?? body.error ?? `recall failed: ${res.status}`);
      }
      const json = (await res.json()) as {
        recalledAt: string;
        recalledBy: "owner";
        recallReason: string;
      };
      setState({
        recalled: true,
        recalledAt: json.recalledAt,
        recalledBy: json.recalledBy,
        recallReason: json.recallReason,
      });
      setReason("");
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearRecall() {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/recall`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(body.message ?? body.error ?? `clear failed: ${res.status}`);
      }
      setState({
        recalled: false,
        recalledAt: null,
        recalledBy: null,
        recallReason: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (hidden || !state) return null;

  const canClearOwnerRecall =
    state.recalled && state.recalledBy === "owner";
  const externallyRecalled =
    state.recalled && state.recalledBy !== "owner" && state.recalledBy !== null;

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">Recall · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: state.recalled ? "var(--ox-bright)" : "var(--text-mute)",
          }}
        >
          {state.recalled
            ? `▲ recalled · ${state.recalledBy ?? "unknown"} · ${timeAgo(state.recalledAt)}`
            : "● active"}
        </span>
      </div>

      <div style={{ padding: 18 }}>
        {state.recalled ? (
          <>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 12,
                color: "var(--text-2)",
                lineHeight: 1.55,
              }}
            >
              Recalled by <strong>{state.recalledBy}</strong>{" "}
              <span className="mono dim">{timeAgo(state.recalledAt)}</span>.
              The agent fails Guardian&apos;s force-recall check and cannot
              propose, accept, move, or fund.
              {state.recallReason ? (
                <>
                  {" "}
                  Reason: <em>{state.recallReason}</em>.
                </>
              ) : null}
            </p>
            {externallyRecalled ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  color: "var(--text-mute)",
                  lineHeight: 1.5,
                }}
              >
                This recall was imposed by {state.recalledBy}, not by you. Contact
                support to dispute.
              </p>
            ) : null}
            {canClearOwnerRecall ? (
              <div
                className="row"
                style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={clearRecall}
                  disabled={busy}
                  style={{
                    fontSize: 11,
                    color: "var(--gold)",
                    borderColor: "color-mix(in oklab, var(--gold) 45%, transparent)",
                    background: "color-mix(in oklab, var(--gold) 8%, transparent)",
                  }}
                >
                  {busy ? "Clearing…" : "Clear recall · resume play"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 12,
                color: "var(--text-2)",
                lineHeight: 1.55,
              }}
            >
              Recall the agent to immediately stop all new actions (challenge
              propose / accept / match move / fund / withdraw). In-flight
              matches continue to settle. Clear the recall any time to resume.
            </p>
            {!confirm ? (
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirm(true)}
                  disabled={busy}
                  style={{
                    fontSize: 11,
                    color: "var(--ox-bright)",
                    borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
                    background: "color-mix(in oklab, var(--ox) 8%, transparent)",
                  }}
                >
                  Pause agent
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <input
                  type="text"
                  value={reason}
                  maxLength={280}
                  placeholder="Optional reason (e.g. 'losing streak — review opening')"
                  onChange={(e) => setReason(e.target.value)}
                  style={{
                    width: "100%",
                    background: "var(--bg-2)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    padding: "8px 10px",
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "inherit",
                    marginBottom: 8,
                  }}
                />
                <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setConfirm(false);
                      setReason("");
                    }}
                    disabled={busy}
                    style={{ fontSize: 11 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={recall}
                    disabled={busy}
                    style={{
                      fontSize: 11,
                      color: "var(--ox-bright)",
                      borderColor:
                        "color-mix(in oklab, var(--ox) 45%, transparent)",
                      background:
                        "color-mix(in oklab, var(--ox) 8%, transparent)",
                    }}
                  >
                    {busy ? "Pausing…" : "Confirm pause"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

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
