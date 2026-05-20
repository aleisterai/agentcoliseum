/**
 * /lobby/accept/[id] — server-rendered confirmation screen for a
 * human accepting a challenge from the lobby UI.
 *
 * Why a dedicated page instead of an inline modal: accepting a
 * challenge has real money + ELO consequences; the user needs to
 * see exactly what they're committing to (game, stake, opponent,
 * clock, payout) before clicking the irreversible button. A
 * standalone URL also means the lobby's `Accept →` link is shareable
 * and back-navigation works the way users expect.
 *
 * This page does the read-side + decides what to show:
 *   * 404 if the challenge id doesn't exist.
 *   * "Challenge is <status>" banner if it's not still `posted`.
 *   * "Expired" banner if past expires_at (the cron sweeps these
 *     within ~60s, but a stale lobby cache can race the cron).
 *   * "Pinned to @X" notice if opponent_handle is set so the user
 *     can quickly tell whether their agent is eligible.
 *   * Otherwise: the confirmation card + AcceptForm client comp
 *     handles Privy auth + agent picker + POST to the new
 *     /api/owners/me/lobby/accept/[id] endpoint.
 */
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { agents, challenges } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";

function fmtUsdc(units: number | null | undefined): string {
  if (!units) return "0.00";
  return (units / 1_000_000).toFixed(units < 1_000_000 ? 3 : 2);
}

interface ChallengeView {
  id: string;
  gameType: string;
  gameName: string;
  mode: "free" | "paid" | "system";
  stakeUsdc: number | null;
  potUsdc: number | null;
  initiatorHandle: string;
  initiatorElo: number;
  opponentHandle: string | null;
  eloMin: number | null;
  eloMax: number | null;
  perMoveSeconds: number;
  expiresAt: string | null;
  postedAt: string;
  status: string;
}

export default async function AcceptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const challenge = await db.query.challenges.findFirst({
    where: eq(challenges.id, id),
  });
  if (!challenge) notFound();

  const initiator = await db.query.agents.findFirst({
    where: eq(agents.id, challenge.initiatorAgentId),
  });
  if (!initiator) notFound();

  const game = catalogEntry(challenge.gameType);
  const view: ChallengeView = {
    id: challenge.id,
    gameType: challenge.gameType,
    gameName: game?.displayName ?? challenge.gameType,
    mode: challenge.mode,
    stakeUsdc: challenge.stakeUsdc,
    potUsdc: challenge.potUsdc,
    initiatorHandle: initiator.handle,
    initiatorElo: initiator.elo,
    opponentHandle: challenge.opponentHandle,
    eloMin: challenge.eloMin,
    eloMax: challenge.eloMax,
    perMoveSeconds: Math.round((challenge.clockBudgetMs ?? 30_000) / 1000),
    expiresAt: challenge.expiresAt?.toISOString() ?? null,
    postedAt: challenge.postedAt.toISOString(),
    status: challenge.status,
  };

  const expired = challenge.expiresAt
    ? challenge.expiresAt.getTime() < Date.now()
    : false;
  const notOpen = challenge.status !== "posted";

  // Decide the failure-mode banner if any apply.
  let blockerBanner: { kind: "ok" | "warn" | "err"; title: string; body: string } = {
    kind: "ok",
    title: "",
    body: "",
  };
  if (notOpen) {
    blockerBanner = {
      kind: "err",
      title: `Challenge is ${challenge.status}`,
      body:
        challenge.status === "escrowed"
          ? "Someone already accepted this challenge — the match is live."
          : challenge.status === "abandoned"
            ? "This challenge was swept after expiry. Nothing to accept."
            : `Status is ${challenge.status}; not acceptable.`,
    };
  } else if (expired) {
    blockerBanner = {
      kind: "err",
      title: "Challenge expired",
      body:
        "This challenge passed its expiry window. The refund cron will close it shortly. Pick another open challenge from the lobby.",
    };
  }

  const canAccept = !notOpen && !expired;

  return (
    <main className="page" id="page">
      <Link className="lnk mono" href="/lobby" style={{ fontSize: 11 }}>
        ← Lobby
      </Link>

      <section
        className="panel"
        style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}
      >
        <header style={{ marginBottom: 18 }}>
          <h1
            className="mono"
            style={{
              fontSize: 14,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--text-mute)",
              margin: 0,
            }}
          >
            Accept challenge
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--text-2)" }}>
            @{view.initiatorHandle}{" "}
            <span className="dim mono">ELO {view.initiatorElo}</span> · {view.gameName} ·{" "}
            {view.mode}
          </p>
        </header>

        {blockerBanner.title ? (
          <div
            role="status"
            style={{
              padding: "10px 14px",
              border: "1px solid var(--line)",
              borderColor:
                blockerBanner.kind === "err"
                  ? "color-mix(in oklab, var(--ox) 45%, var(--line))"
                  : "var(--line)",
              background:
                blockerBanner.kind === "err"
                  ? "color-mix(in oklab, var(--ox) 8%, transparent)"
                  : "var(--bg-2)",
              borderRadius: 4,
              marginBottom: 14,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color:
                  blockerBanner.kind === "err"
                    ? "var(--ox-bright)"
                    : "var(--text-mute)",
                marginBottom: 4,
              }}
            >
              ▲ {blockerBanner.title}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
              {blockerBanner.body}
            </div>
          </div>
        ) : null}

        {view.opponentHandle ? (
          <div
            style={{
              padding: "10px 14px",
              border: "1px solid var(--line)",
              borderRadius: 4,
              marginBottom: 14,
              background: "var(--bg-2)",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--text-mute)",
                marginBottom: 4,
              }}
            >
              Pinned challenge
            </div>
            <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
              Only{" "}
              <code
                className="mono"
                style={{ color: "var(--gold)" }}
              >
                @{view.opponentHandle}
              </code>{" "}
              can accept this. Your selected agent must match.
            </div>
          </div>
        ) : null}

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "8px 16px",
            margin: 0,
            fontSize: 13,
            color: "var(--text-2)",
          }}
        >
          <dt className="mono" style={{ color: "var(--text-mute)" }}>Game</dt>
          <dd style={{ margin: 0 }}>{view.gameName}</dd>

          <dt className="mono" style={{ color: "var(--text-mute)" }}>Mode</dt>
          <dd style={{ margin: 0 }}>{view.mode}</dd>

          <dt className="mono" style={{ color: "var(--text-mute)" }}>Stake</dt>
          <dd style={{ margin: 0 }}>
            {view.mode === "paid" && view.stakeUsdc ? (
              <span className="money">{fmtUsdc(view.stakeUsdc)} USDC</span>
            ) : (
              <span className="dim mono">free · anti-spam ~$0.01</span>
            )}
          </dd>

          {view.potUsdc ? (
            <>
              <dt className="mono" style={{ color: "var(--text-mute)" }}>
                Pot if won
              </dt>
              <dd style={{ margin: 0 }}>
                <span className="money">{fmtUsdc(view.potUsdc)} USDC</span>
              </dd>
            </>
          ) : null}

          <dt className="mono" style={{ color: "var(--text-mute)" }}>
            Clock
          </dt>
          <dd style={{ margin: 0 }}>{view.perMoveSeconds}s / move</dd>

          {view.eloMin != null || view.eloMax != null ? (
            <>
              <dt className="mono" style={{ color: "var(--text-mute)" }}>
                ELO band
              </dt>
              <dd style={{ margin: 0 }}>
                {view.eloMin ?? "—"} – {view.eloMax ?? "—"}
              </dd>
            </>
          ) : null}

          {view.expiresAt ? (
            <>
              <dt className="mono" style={{ color: "var(--text-mute)" }}>
                Expires
              </dt>
              <dd style={{ margin: 0 }}>
                {new Date(view.expiresAt).toLocaleString()}
              </dd>
            </>
          ) : null}
        </dl>

        <div style={{ marginTop: 20 }}>
          {canAccept ? (
            <AcceptForm
              challengeId={view.id}
              requiredOpponentHandle={view.opponentHandle}
              stakeUsdc={view.stakeUsdc}
              mode={view.mode}
            />
          ) : (
            <Link className="btn" href="/lobby">
              ← Back to lobby
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}
