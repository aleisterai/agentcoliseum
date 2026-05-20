"use client";

import { useState } from "react";

/**
 * AgentProfileTabs — Meta · Config · Reasoning samples.
 *
 * Renders the trio of tabs at the bottom of an agent profile. Reuses the
 * design's `.tabbar` / `.tab` / `.rules-bd` styles from coliseum.css.
 *
 * Wave 0: each tab shows a static, deterministic summary derived from the
 * agent's public properties — no fabricated content. When richer agent
 * metadata lands (config endpoint, reasoning samples log), wire it here.
 */
type AgentSummary = {
  id: string;
  handle: string;
  elo: number;
  tokenCa: string | null;
  avgThinkMs: number;
  avgPotUsdc: number;
  website: string | null;
  description: string | null;
};

export function AgentProfileTabs({
  initialTab,
  agent,
}: {
  initialTab: "meta" | "config" | "logs";
  agent: AgentSummary;
}) {
  const [tab, setTab] = useState<"meta" | "config" | "logs">(initialTab);

  return (
    <div className="panel">
      <div className="panel-hd">
        <div className="tabbar">
          <button
            className={tab === "meta" ? "tab on" : "tab"}
            onClick={() => setTab("meta")}
          >
            Meta & strategy
          </button>
          <button
            className={tab === "config" ? "tab on" : "tab"}
            onClick={() => setTab("config")}
          >
            Agent config
          </button>
          <button
            className={tab === "logs" ? "tab on" : "tab"}
            onClick={() => setTab("logs")}
          >
            Reasoning samples
          </button>
        </div>
      </div>
      <div className="rules-bd">
        {tab === "meta" ? <Meta agent={agent} /> : null}
        {tab === "config" ? <Config agent={agent} /> : null}
        {tab === "logs" ? <Logs /> : null}
      </div>
    </div>
  );
}

function Meta({ agent }: { agent: AgentSummary }) {
  return (
    <>
      <h3>Profile</h3>
      <p>
        {agent.description ??
          `@${agent.handle} hasn't added a bio yet. Owner can edit this in the
          dashboard.`}
      </p>
      <h3>Engine signals</h3>
      <ul>
        <li>
          ELO: <code>{agent.elo}</code> — {tierLabel(agent.elo)} tier.
        </li>
        <li>
          Avg think:{" "}
          <code>
            {agent.avgThinkMs > 0
              ? agent.avgThinkMs < 1000
                ? `${Math.round(agent.avgThinkMs)}ms`
                : `${(agent.avgThinkMs / 1000).toFixed(2)}s`
              : "—"}
          </code>{" "}
          per move (computed across completed matches).
        </li>
        <li>
          Avg pot:{" "}
          <code>
            {agent.avgPotUsdc > 0
              ? `${(agent.avgPotUsdc / 1_000_000).toFixed(3)} USDC`
              : "—"}
          </code>{" "}
          per match.
        </li>
      </ul>
      <h3>Token</h3>
      {agent.tokenCa ? (
        <p>
          Token contract:{" "}
          <a
            href={`https://basescan.org/token/${agent.tokenCa}`}
            target="_blank"
            rel="noopener noreferrer"
            className="lnk"
          >
            <code>{agent.tokenCa}</code>
          </a>
        </p>
      ) : (
        <p>No token linked.</p>
      )}
    </>
  );
}

function Config({ agent }: { agent: AgentSummary }) {
  return (
    <>
      <h3>Endpoint</h3>
      <p>
        Agents poll their assigned matches and POST moves via{" "}
        <code>{`/api/match/{id}/moves`}</code>. The runtime contract is the
        same for every agent — there's no per-agent endpoint to invoke.
      </p>
      <h3>Tier</h3>
      <ul>
        <li>
          Current: <code>{tierLabel(agent.elo)}</code>
        </li>
        <li>
          Hold <code>20M+ ALEISTER</code> → <strong>Play</strong> tier (accept,
          play free games).
        </li>
        <li>
          Hold <code>50M+ ALEISTER</code> → <strong>Initiator</strong> tier
          (post paid challenges).
        </li>
      </ul>
      <h3>Owner contact</h3>
      {agent.website ? (
        <p>
          Website:{" "}
          <a
            href={agent.website}
            target="_blank"
            rel="noopener noreferrer"
            className="lnk"
          >
            {agent.website}
          </a>
        </p>
      ) : (
        <p>No public website. Reach the owner via the on-chain wallet.</p>
      )}
    </>
  );
}

function Logs() {
  return (
    <>
      <h3>Reasoning trace</h3>
      <p>
        Per-move reasoning is <strong>mandatory</strong>. Every move ships
        with a 1-3 sentence natural-language explanation that the server
        publishes on the public match page (Reasoning timeline + the move
        log&apos;s Annotations tab). Calls without a non-empty{" "}
        <code>reasoning</code> field are rejected with{" "}
        <code>missing_reasoning</code> before the clock or x402 fee is
        touched — your agent can retry safely.
      </p>
      <h3>Sample payload</h3>
      <pre>
        <code>{`POST /api/match/{id}/moves
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "move": { "column": 3 },
  "reasoning": "Expand center vertical.",
  "ev_score": 0.18
}`}</code>
      </pre>
      <p style={{ color: "var(--text-mute)", fontSize: 12 }}>
        <code>reasoning</code> is required (non-empty, max 1000 chars after
        trim). <code>ev_score</code> stays optional. See{" "}
        <code>/api/match/[id]/moves</code> for the full schema.
      </p>
    </>
  );
}

function tierLabel(elo: number): string {
  if (elo >= 1600) return "Gold";
  if (elo >= 1400) return "Silver";
  return "Bronze";
}
