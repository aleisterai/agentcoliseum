/**
 * POST /api/owners/me/wallet
 *
 * Returns the wallet/x402 payload for the connected owner:
 *   - spendable balance (placeholder until on-chain reads are wired)
 *   - aggregate in-escrow USDC + match count
 *   - 30-day P&L (wins - losses, fees out)
 *   - 30-day move spend
 *   - escrowed open matches
 *   - flat payment history (POT WIN, x402 MOVE, BET, TOP-UP)
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 *
 * Note: USDC balance reads are stubbed for Wave 0 — agent earnings from
 * completed matches are the only on-app numbers we have. When the wallet
 * integration lands, swap the `spendable` block for an on-chain call.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { erc20Abi, getAddress } from "viem";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  matchMoves,
  owners,
} from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { publicClient } from "@/lib/chain/viem";
import { USDC_BASE } from "@/lib/chain/aerodrome";

export const dynamic = "force-dynamic";

const X402_PER_MOVE_USDC = 800; // $0.0008 in microUSDC

/**
 * Read live USDC (6-decimal base units) + ETH (in whole ether) balances for
 * the connected wallet on Base. Returns zeroed values on RPC failure so the
 * page renders gracefully — the operator can investigate via /live.
 */
async function readOnChainBalances(
  wallet: `0x${string}`,
): Promise<{ usdc: number; eth: number }> {
  try {
    const [usdcRaw, ethWei] = await Promise.all([
      publicClient.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }) as Promise<bigint>,
      publicClient.getBalance({ address: wallet }),
    ]);
    return {
      usdc: Number(usdcRaw),
      eth: Number(ethWei) / 1e18,
    };
  } catch {
    return { usdc: 0, eth: 0 };
  }
}

export async function POST(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) throw new UnauthorizedError("unauthorized", "Privy session required");
    const checksummed = getAddress(wallet);
    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner)
      return jsonError(404, "owner_not_found", "Owner row not seeded — POST /api/owners/me first");

    const ownedAgents = await db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(eq(agents.ownerId, owner.id));
    const ids = ownedAgents.map((a) => a.id);
    const handleById = Object.fromEntries(ownedAgents.map((a) => [a.id, a.handle]));

    if (ids.length === 0) {
      const spendable = await readOnChainBalances(checksummed);
      return NextResponse.json({
        walletAddress: owner.walletAddress,
        ownerId: owner.id,
        spendable,
        inEscrow: { usdc: 0, matches: 0 },
        pnl30d: { netUsdc: 0, wins: 0, losses: 0, draws: 0 },
        moveSpend30d: { usdc: 0, paidMoves: 0 },
        escrowed: [],
        history: [],
      });
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fleetClause = or(
      inArray(matches.p1AgentId, ids),
      inArray(matches.p2AgentId, ids),
    );

    const [escrowedRows, completed30d, paidMoves30d, paymentRows] =
      await Promise.all([
        db
          .select({
            id: matches.id,
            gameType: matches.gameType,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            stakeUsdc: matches.stakeUsdc,
            potUsdc: matches.potUsdc,
          })
          .from(matches)
          .where(and(eq(matches.status, "active"), fleetClause))
          .limit(40),
        db
          .select({
            id: matches.id,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            winnerAgentId: matches.winnerAgentId,
            potUsdc: matches.potUsdc,
            platformFeeUsdc: matches.platformFeeUsdc,
            stakeUsdc: matches.stakeUsdc,
            completedAt: matches.completedAt,
            mode: matches.mode,
            gameType: matches.gameType,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              fleetClause,
              gte(matches.completedAt, since30d),
            ),
          )
          .orderBy(desc(matches.completedAt))
          .limit(100),
        db
          .select({
            paidMoves: sql<number>`COUNT(*)::int`,
            createdAt: sql<Date>`MIN(${matchMoves.createdAt})`,
          })
          .from(matchMoves)
          .where(
            and(
              inArray(matchMoves.agentId, ids),
              gte(matchMoves.createdAt, since30d),
              sql`${matchMoves.x402PaymentId} IS NOT NULL`,
            ),
          ),
        // Most recent paid-mode moves (their x402 settlements appear in history)
        db
          .select({
            id: matchMoves.id,
            createdAt: matchMoves.createdAt,
            x402PaymentId: matchMoves.x402PaymentId,
            agentId: matchMoves.agentId,
            matchId: matchMoves.matchId,
          })
          .from(matchMoves)
          .where(
            and(
              inArray(matchMoves.agentId, ids),
              sql`${matchMoves.x402PaymentId} IS NOT NULL`,
            ),
          )
          .orderBy(desc(matchMoves.createdAt))
          .limit(50),
      ]);

    // Resolve opponent handles for escrow rows
    const oppIds = Array.from(
      new Set(
        escrowedRows
          .flatMap((m) => [m.p1AgentId, m.p2AgentId])
          .filter((x) => x && !ids.includes(x)) as string[],
      ),
    );
    const oppRows =
      oppIds.length > 0
        ? await db
            .select({ id: agents.id, handle: agents.handle })
            .from(agents)
            .where(inArray(agents.id, oppIds))
        : [];
    const oppMap = Object.fromEntries(oppRows.map((o) => [o.id, o.handle]));

    const inEscrowUsdc = escrowedRows.reduce(
      (acc, m) => acc + (m.stakeUsdc ?? 0),
      0,
    );

    // 30d P&L: sum wins (pot - fee) minus losses (stake)
    let wins = 0,
      losses = 0,
      draws = 0,
      netUsdc = 0;
    for (const m of completed30d) {
      const isP1 = m.p1AgentId && ids.includes(m.p1AgentId);
      const myAgent = isP1 ? m.p1AgentId : m.p2AgentId;
      if (!myAgent) continue;
      if (!m.winnerAgentId) {
        draws++;
      } else if (m.winnerAgentId === myAgent) {
        wins++;
        netUsdc += (m.potUsdc ?? 0) - (m.platformFeeUsdc ?? 0);
      } else {
        losses++;
        netUsdc -= m.stakeUsdc ?? 0;
      }
    }

    const paidMovesTotal = Number(paidMoves30d[0]?.paidMoves ?? 0);
    const moveSpendUsdc = paidMovesTotal * X402_PER_MOVE_USDC;

    // Build flat history. Pot wins/losses first (recent), then x402 moves.
    type Entry = {
      id: string;
      ts: string;
      type: string;
      counterparty: string;
      detail: string;
      amountUsdc: number;
      txHash: string | null;
    };
    const history: Entry[] = [];
    for (const m of completed30d.slice(0, 25)) {
      const isP1 = m.p1AgentId && ids.includes(m.p1AgentId);
      const myAgent = isP1 ? m.p1AgentId : m.p2AgentId;
      if (!myAgent) continue;
      const oppId = isP1 ? m.p2AgentId : m.p1AgentId;
      const oppHandle = oppId ? oppMap[oppId] ?? "?" : "system";
      if (!m.winnerAgentId) {
        history.push({
          id: `pot-${m.id}`,
          ts: (m.completedAt ?? new Date()).toISOString(),
          type: "POT DRAW",
          counterparty: `@${oppHandle}`,
          detail: `${m.gameType}`,
          amountUsdc: 0,
          txHash: null,
        });
      } else if (m.winnerAgentId === myAgent) {
        history.push({
          id: `pot-${m.id}`,
          ts: (m.completedAt ?? new Date()).toISOString(),
          type: "POT WIN",
          counterparty: `@${oppHandle}`,
          detail: `${m.gameType}`,
          amountUsdc: (m.potUsdc ?? 0) - (m.platformFeeUsdc ?? 0),
          txHash: null,
        });
      } else {
        history.push({
          id: `pot-${m.id}`,
          ts: (m.completedAt ?? new Date()).toISOString(),
          type: "POT LOSS",
          counterparty: `@${oppHandle}`,
          detail: `${m.gameType}`,
          amountUsdc: -(m.stakeUsdc ?? 0),
          txHash: null,
        });
      }
    }
    for (const pm of paymentRows.slice(0, 25)) {
      history.push({
        id: `x402-${pm.id}`,
        ts: pm.createdAt.toISOString(),
        type: "x402 MOVE",
        counterparty: "facilitator",
        detail: `move on @${handleById[pm.agentId ?? ""] ?? "?"}`,
        amountUsdc: -X402_PER_MOVE_USDC,
        txHash: pm.x402PaymentId,
      });
    }
    history.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    const spendable = await readOnChainBalances(checksummed);

    return NextResponse.json({
      walletAddress: owner.walletAddress,
      ownerId: owner.id,
      spendable,
      inEscrow: { usdc: inEscrowUsdc, matches: escrowedRows.length },
      pnl30d: { netUsdc, wins, losses, draws },
      moveSpend30d: { usdc: moveSpendUsdc, paidMoves: paidMovesTotal },
      escrowed: escrowedRows.map((m) => {
        const isP1 = m.p1AgentId && ids.includes(m.p1AgentId);
        const myAgent = isP1 ? m.p1AgentId : m.p2AgentId;
        const oppId = isP1 ? m.p2AgentId : m.p1AgentId;
        return {
          matchId: m.id,
          yourAgent: handleById[myAgent ?? ""] ?? "?",
          opponent: oppId ? oppMap[oppId] ?? "?" : "system",
          gameType: m.gameType,
          lockedUsdc: m.stakeUsdc ?? 0,
          potUsdc: m.potUsdc ?? 0,
        };
      }),
      history: history.slice(0, 50),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
