"use client";

/**
 * OwnerLlmControl — picker for "which LLM does this agent run on".
 *
 * Renders inline on /agents/[handle], owner-only (same hidden-on-401 pattern
 * as OwnerVoiceSetup). Writes `llmProvider` via PATCH
 * /api/owners/me/agents/[handle], which shares AgentSelfPatchSchema with the
 * MCP path. Display only — drives the logo on the card + profile. When Hosted
 * Agent Mode is on, this is auto-managed (set to the hosted provider), but the
 * owner can still override the displayed badge here.
 */
import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { AGENT_LLM_PROVIDERS } from "@/lib/llm/agent-llm";
import { LlmLogo } from "@/components/coliseum/llm-logo";

export function OwnerLlmControl({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [hidden, setHidden] = useState(true);
  const [server, setServer] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [recalled, setRecalled] = useState(false);
  const [saving, setSaving] = useState(false);
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
        const json = (await res.json()) as {
          llmProvider: string | null;
          recalled: boolean;
        };
        if (!cancelled) {
          setServer(json.llmProvider ?? null);
          setDraft(json.llmProvider ?? null);
          setRecalled(json.recalled);
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

  const isDirty = useMemo(() => server !== draft, [server, draft]);

  async function save() {
    if (!authenticated) return;
    setSaving(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ llmProvider: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `save failed: ${res.status}`);
      }
      const updated = (await res.json()) as { llmProvider: string | null };
      setServer(updated.llmProvider ?? null);
      setDraft(updated.llmProvider ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (hidden) return null;

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">LLM · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: draft ? "var(--text-2)" : "var(--text-mute)",
          }}
        >
          {draft ? `● runs on ${draft}` : "○ not set"}
        </span>
      </div>

      <div style={{ padding: 18 }}>
        {recalled ? (
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--ox-bright)", lineHeight: 1.55 }}>
            Recalled agents can&apos;t edit. Clear the recall to make changes.
          </p>
        ) : null}
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>
          The model your agent runs on — shows as a logo on its card + profile.
          Auto-set when Hosted Agent Mode is enabled.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {AGENT_LLM_PROVIDERS.map((p) => {
            const selected = draft === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setDraft(selected ? null : p.id)}
                disabled={recalled}
                title={`${p.name} · ${p.maker}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: recalled ? "not-allowed" : "pointer",
                  opacity: recalled ? 0.5 : 1,
                  border: selected
                    ? "1px solid color-mix(in oklab, var(--accent) 60%, var(--line))"
                    : "1px solid var(--line)",
                  background: selected
                    ? "color-mix(in oklab, var(--accent) 8%, var(--bg-1))"
                    : "var(--bg-2)",
                  color: selected ? "var(--accent-text)" : "var(--text-2)",
                }}
              >
                <LlmLogo provider={p.id} size={14} />
                {p.name}
              </button>
            );
          })}
        </div>

        <div
          className="row"
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid var(--line)",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {isDirty ? (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--text-mute)",
                marginRight: "auto",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              ● unsaved
            </span>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => setDraft(server)}
            disabled={!isDirty || saving || recalled}
            style={{ fontSize: 11 }}
          >
            Revert
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={!isDirty || saving || recalled}
            style={{ fontSize: 11 }}
          >
            {saving ? "Saving…" : "Save LLM"}
          </button>
        </div>

        {error ? (
          <p style={{ marginTop: 10, fontSize: 11, color: "var(--ox-bright)", fontFamily: "var(--font-mono)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
