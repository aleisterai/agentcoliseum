"use client";

/**
 * OwnerVoiceSetup — voice-pack picker for the agent owner.
 *
 * Renders inline on /agents/[handle], owner-only (same hidden-on-401
 * pattern as OwnerMcpSetup). Lets the owner:
 *
 *   1. Pick one of 5 default presets (one click writes all four lines).
 *   2. Or freeform-edit each line individually.
 *   3. Reset to the current preset's lines.
 *
 * Voice fields go to PATCH /api/owners/me/agents/[handle] which shares
 * the AgentSelfPatchSchema with the MCP path — anything the LLM can
 * write here, the owner can too. Recalled agents can't edit; the
 * endpoint returns 409 and we show a notice instead.
 */
import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { VOICE_PACKS, voicePackById, type VoicePack } from "@/lib/voice-packs";

type VoiceState = {
  voicePackId: string | null;
  catchphrase: string | null;
  winLine: string | null;
  lossLine: string | null;
  trashTalkTemplates: string[] | null;
};

type SetupPayload = VoiceState & {
  recalled: boolean;
  recallReason: string | null;
};

function diff(a: VoiceState, b: VoiceState): Partial<VoiceState> {
  const out: Partial<VoiceState> = {};
  if (a.voicePackId !== b.voicePackId) out.voicePackId = b.voicePackId;
  if (a.catchphrase !== b.catchphrase) out.catchphrase = b.catchphrase;
  if (a.winLine !== b.winLine) out.winLine = b.winLine;
  if (a.lossLine !== b.lossLine) out.lossLine = b.lossLine;
  const sameTrash =
    JSON.stringify(a.trashTalkTemplates ?? []) ===
    JSON.stringify(b.trashTalkTemplates ?? []);
  if (!sameTrash) out.trashTalkTemplates = b.trashTalkTemplates;
  return out;
}

export function OwnerVoiceSetup({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [hidden, setHidden] = useState(true);
  const [server, setServer] = useState<VoiceState | null>(null);
  const [draft, setDraft] = useState<VoiceState | null>(null);
  const [recalled, setRecalled] = useState(false);
  const [recallReason, setRecallReason] = useState<string | null>(null);
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
        const json = (await res.json()) as SetupPayload;
        const state: VoiceState = {
          voicePackId: json.voicePackId,
          catchphrase: json.catchphrase,
          winLine: json.winLine,
          lossLine: json.lossLine,
          trashTalkTemplates: json.trashTalkTemplates,
        };
        if (!cancelled) {
          setServer(state);
          setDraft(state);
          setRecalled(json.recalled);
          setRecallReason(json.recallReason);
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

  const isDirty = useMemo(() => {
    if (!server || !draft) return false;
    return Object.keys(diff(server, draft)).length > 0;
  }, [server, draft]);

  const appliedPreset: VoicePack | null = useMemo(() => {
    if (!draft) return null;
    const preset = voicePackById(draft.voicePackId);
    if (!preset) return null;
    // Only highlight the preset card if all four lines still match the preset.
    const exact =
      draft.catchphrase === preset.catchphrase &&
      draft.winLine === preset.winLine &&
      draft.lossLine === preset.lossLine &&
      JSON.stringify(draft.trashTalkTemplates ?? []) ===
        JSON.stringify(preset.trashTalkTemplates);
    return exact ? preset : null;
  }, [draft]);

  function applyPreset(p: VoicePack) {
    setDraft({
      voicePackId: p.id,
      catchphrase: p.catchphrase,
      winLine: p.winLine,
      lossLine: p.lossLine,
      trashTalkTemplates: p.trashTalkTemplates,
    });
  }

  async function save() {
    if (!authenticated || !draft || !server) return;
    setSaving(true);
    setError(null);
    try {
      const patch = diff(server, draft);
      if (Object.keys(patch).length === 0) return;
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `save failed: ${res.status}`);
      }
      const updated = (await res.json()) as VoiceState;
      setServer(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    if (server) setDraft(server);
  }

  if (hidden || !draft) return null;

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">Voice · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: appliedPreset ? "var(--gold)" : "var(--text-mute)",
          }}
        >
          {appliedPreset
            ? `● preset · ${appliedPreset.label.toLowerCase()}`
            : draft.voicePackId
              ? `◐ customized · was ${draft.voicePackId}`
              : "○ no voice set"}
        </span>
      </div>

      <div style={{ padding: 18 }}>
        {recalled ? (
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 12,
              color: "var(--ox-bright)",
              lineHeight: 1.55,
            }}
          >
            Recalled agents can&apos;t edit voice.
            {recallReason ? <> Reason: <em>{recallReason}</em>.</> : null} Clear
            the recall to make changes.
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
          Click a preset to copy all four lines, then customize. Lines appear on
          share cards and match-completion banners — keep them short (≤80 chars
          each).
        </p>

        {/* Preset cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 8,
            marginBottom: 18,
          }}
        >
          {VOICE_PACKS.map((p) => {
            const selected = appliedPreset?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                disabled={recalled}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 4,
                  border: selected
                    ? "1px solid color-mix(in oklab, var(--gold) 55%, transparent)"
                    : "1px solid var(--line)",
                  background: selected
                    ? "color-mix(in oklab, var(--gold) 10%, transparent)"
                    : "var(--bg-2)",
                  color: selected ? "var(--gold)" : "var(--text)",
                  cursor: recalled ? "not-allowed" : "pointer",
                  opacity: recalled ? 0.5 : 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600 }}>{p.label}</span>
                <span
                  className="mono"
                  style={{ fontSize: 10, color: "var(--text-mute)" }}
                >
                  {p.id}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-2)",
                    marginTop: 2,
                    fontStyle: "italic",
                  }}
                >
                  &ldquo;{p.catchphrase}&rdquo;
                </span>
              </button>
            );
          })}
        </div>

        {/* Free-form editors */}
        <VoiceField
          label="Catchphrase"
          hint="Short tagline shown next to your handle."
          value={draft.catchphrase ?? ""}
          max={80}
          disabled={recalled}
          onChange={(v) =>
            setDraft({ ...draft, catchphrase: v || null, voicePackId: draft.voicePackId })
          }
        />
        <VoiceField
          label="Win line"
          hint="Shown on the share card when you win a match."
          value={draft.winLine ?? ""}
          max={80}
          disabled={recalled}
          onChange={(v) => setDraft({ ...draft, winLine: v || null })}
        />
        <VoiceField
          label="Loss line"
          hint="Shown on the share card when you lose a match."
          value={draft.lossLine ?? ""}
          max={80}
          disabled={recalled}
          onChange={(v) => setDraft({ ...draft, lossLine: v || null })}
        />

        <TrashTalkEditor
          values={draft.trashTalkTemplates ?? []}
          disabled={recalled}
          onChange={(arr) =>
            setDraft({ ...draft, trashTalkTemplates: arr.length === 0 ? null : arr })
          }
        />

        {/* Save / revert */}
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
              ● unsaved changes
            </span>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={revert}
            disabled={!isDirty || saving || recalled}
            style={{ fontSize: 11 }}
          >
            Revert
          </button>
          <button
            type="button"
            className="btn"
            onClick={save}
            disabled={!isDirty || saving || recalled}
            style={{
              fontSize: 11,
              color: "var(--gold)",
              borderColor: "color-mix(in oklab, var(--gold) 45%, transparent)",
              background: "color-mix(in oklab, var(--gold) 8%, transparent)",
            }}
          >
            {saving ? "Saving…" : "Save voice"}
          </button>
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

function VoiceField({
  label,
  hint,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const remaining = max - value.length;
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-mute)",
          }}
        >
          {label}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: remaining < 0 ? "var(--ox-bright)" : "var(--text-mute)",
          }}
        >
          {remaining < 0 ? `${-remaining} over` : `${remaining} left`}
        </span>
      </div>
      <input
        type="text"
        value={value}
        maxLength={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        style={{
          width: "100%",
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 4,
          padding: "8px 10px",
          fontSize: 13,
          color: "var(--text)",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}

function TrashTalkEditor({
  values,
  disabled,
  onChange,
}: {
  values: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [next, setNext] = useState("");

  function add() {
    const trimmed = next.trim();
    if (!trimmed) return;
    if (values.length >= 20) return;
    if (trimmed.length > 120) return;
    onChange([...values, trimmed]);
    setNext("");
  }

  function remove(i: number) {
    onChange(values.filter((_, idx) => idx !== i));
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-mute)",
          }}
        >
          Trash-talk templates
        </span>
        <span
          className="mono"
          style={{ fontSize: 10, color: "var(--text-mute)" }}
        >
          {values.length}/20
        </span>
      </div>
      {values.length > 0 ? (
        <ul
          style={{
            margin: "0 0 6px",
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {values.map((v, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--text-2)",
              }}
            >
              <span style={{ flex: 1 }}>{v}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label="Remove"
                className="lnk mono"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: disabled ? "not-allowed" : "pointer",
                  fontSize: 11,
                  color: "var(--text-mute)",
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ gap: 6 }}>
        <input
          type="text"
          value={next}
          maxLength={120}
          disabled={disabled || values.length >= 20}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={
            values.length >= 20
              ? "Max 20 templates — remove one to add another"
              : "Add a taunt — enter to commit"
          }
          style={{
            flex: 1,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 13,
            color: "var(--text)",
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !next.trim() || values.length >= 20}
          className="btn"
          style={{ fontSize: 11 }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
