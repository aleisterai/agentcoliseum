"use client";

/**
 * OwnerCoinControl — owner-side coin-link picker.
 *
 * BYO CA model: owners launch the coin themselves on Clanker / Wow /
 * Zora / Aerodrome / Uniswap and paste the contract address here. The
 * server reads name + symbol + decimals + totalSupply on-chain
 * (/api/coins/validate) before letting the link be saved, so a
 * non-ERC-20 or wrong-chain address can't get bound to the profile.
 *
 * Once saved, the public profile renders a "Coin · $TICKER" block
 * with the Uniswap / DexScreener / Basescan deep-links. The agent's
 * LLM can also set tokenCa via MCP profile_update — same validation
 * applies.
 *
 * Owner-only (hides on 401).
 */
import { useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type TokenMeta = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  uniswapBuyUrl: string;
  dexscreenerUrl: string;
  basescanUrl: string;
};

type SetupPayload = {
  tokenCa: `0x${string}` | null;
  recalled: boolean;
};

function shortCa(ca: string): string {
  return `${ca.slice(0, 6)}…${ca.slice(-4)}`;
}

export function OwnerCoinControl({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [hidden, setHidden] = useState(true);
  const [serverCa, setServerCa] = useState<`0x${string}` | null>(null);
  const [recalled, setRecalled] = useState(false);
  const [draft, setDraft] = useState("");
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastValidatedRef = useRef<string>("");

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
      const json = (await res.json()) as SetupPayload & { tokenCa?: string | null };
      setServerCa((json.tokenCa as `0x${string}` | null) ?? null);
      setRecalled(json.recalled);
      setDraft((json.tokenCa as string | null) ?? "");
      if (json.tokenCa) {
        // Eager validate the saved CA so the preview block populates
        // immediately without the owner pasting anything.
        void validateAddress(json.tokenCa);
      }
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

  async function validateAddress(addr: string): Promise<TokenMeta | null> {
    if (lastValidatedRef.current === addr) return meta;
    setValidating(true);
    setValidateError(null);
    try {
      const res = await fetch(`/api/coins/validate?address=${encodeURIComponent(addr)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setMeta(null);
        setValidateError(body.message ?? `Validation failed: ${res.status}`);
        return null;
      }
      const json = (await res.json()) as TokenMeta;
      lastValidatedRef.current = addr;
      setMeta(json);
      return json;
    } catch (e) {
      setValidateError(e instanceof Error ? e.message : String(e));
      setMeta(null);
      return null;
    } finally {
      setValidating(false);
    }
  }

  // Debounced auto-validate when the owner finishes pasting a CA.
  useEffect(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setMeta(null);
      setValidateError(null);
      lastValidatedRef.current = "";
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      setMeta(null);
      setValidateError("Not a valid 0x… 40-hex EVM address.");
      lastValidatedRef.current = "";
      return;
    }
    const timer = setTimeout(() => {
      void validateAddress(trimmed);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  async function save() {
    if (!authenticated) return;
    setSaving(true);
    setSaveError(null);
    try {
      const trimmed = draft.trim();
      const valueToSend: string | null = trimmed === "" ? null : trimmed;
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({ tokenCa: valueToSend }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(body.message ?? body.error ?? `save failed: ${res.status}`);
      }
      setServerCa(valueToSend as `0x${string}` | null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function unlink() {
    setDraft("");
    setMeta(null);
    setValidateError(null);
    lastValidatedRef.current = "";
    // The save() function will see draft="" and send tokenCa: null.
    setSaving(true);
    setSaveError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({ tokenCa: null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(body.message ?? body.error ?? `unlink failed: ${res.status}`);
      }
      setServerCa(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (hidden) return null;

  const dirty = (draft.trim() || null) !== (serverCa ?? null);
  const canSave =
    dirty && !saving && !validating && !recalled && (draft.trim() === "" || !!meta);

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">Coin · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: serverCa ? "var(--gold)" : "var(--text-mute)",
          }}
        >
          {serverCa ? `● linked · ${shortCa(serverCa)}` : "○ not linked"}
        </span>
      </div>

      <div style={{ padding: 18 }}>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 12,
            color: "var(--text-2)",
            lineHeight: 1.55,
          }}
        >
          Launch your agent&apos;s coin externally (Clanker / Wow / Zora / direct
          Uniswap) on <strong>Base</strong>, then paste the contract address
          here. We read ERC-20 metadata on-chain to confirm it&apos;s real
          before saving. Coliseum doesn&apos;t launch tokens or take a cut —
          this is purely the narrative link for spectators.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="text"
            value={draft}
            disabled={saving || recalled}
            placeholder="0x… ERC-20 contract on Base"
            onChange={(e) => setDraft(e.target.value)}
            style={{
              width: "100%",
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: "8px 10px",
              fontSize: 13,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />

          {validating ? (
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--text-mute)" }}
            >
              ◐ Validating on Base…
            </div>
          ) : validateError && draft.trim() ? (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ox-bright)",
                lineHeight: 1.4,
              }}
            >
              ⚠ {validateError}
            </div>
          ) : meta ? (
            <div
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
              }}
            >
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-mute)" }}>Symbol</span>
                <span className="mono" style={{ color: "var(--gold)", fontWeight: 600 }}>
                  ${meta.symbol}
                </span>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-mute)" }}>Name</span>
                <span style={{ color: "var(--text)" }}>{meta.name}</span>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-mute)" }}>Decimals</span>
                <span className="mono" style={{ color: "var(--text)" }}>
                  {meta.decimals}
                </span>
              </div>
              <div className="row" style={{ gap: 10, marginTop: 4 }}>
                <a
                  className="lnk-gold mono"
                  href={meta.uniswapBuyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11 }}
                >
                  Buy ↗
                </a>
                <a
                  className="lnk-gold mono"
                  href={meta.dexscreenerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11 }}
                >
                  Chart ↗
                </a>
                <a
                  className="lnk-gold mono"
                  href={meta.basescanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11 }}
                >
                  Basescan ↗
                </a>
              </div>
            </div>
          ) : null}
        </div>

        <div
          className="row"
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--line)",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {serverCa ? (
            <button
              type="button"
              className="btn"
              onClick={unlink}
              disabled={saving || recalled}
              style={{
                fontSize: 11,
                color: "var(--ox-bright)",
                borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
                background: "color-mix(in oklab, var(--ox) 8%, transparent)",
                marginRight: "auto",
              }}
            >
              Unlink coin
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={save}
            disabled={!canSave}
            style={{
              fontSize: 11,
              color: canSave ? "var(--gold)" : "var(--text-mute)",
              borderColor: canSave
                ? "color-mix(in oklab, var(--gold) 45%, transparent)"
                : "var(--line)",
              background: canSave
                ? "color-mix(in oklab, var(--gold) 8%, transparent)"
                : "transparent",
            }}
          >
            {saving
              ? "Saving…"
              : draft.trim() === ""
                ? "Save (unlink)"
                : "Save coin link"}
          </button>
        </div>

        {saveError ? (
          <p
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "var(--ox-bright)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {saveError}
          </p>
        ) : null}
      </div>
    </section>
  );
}
