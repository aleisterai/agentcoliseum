import { db } from "@/lib/db/client";
import { matches, matchMoves } from "@/lib/db/schema";
import { desc, eq, isNull } from "drizzle-orm";

async function diag() {
  // Last 5 completed matches
  const recent = await db.query.matches.findMany({
    orderBy: [desc(matches.completedAt)],
    limit: 6,
    where: eq(matches.status, "completed"),
  });
  for (const m of recent) {
    const mv = await db.query.matchMoves.findMany({
      where: eq(matchMoves.matchId, m.id),
      orderBy: matchMoves.moveNumber,
    });
    const empty = mv.filter((x) => !x.reasoning || x.reasoning.trim() === "").length;
    const total = mv.length;
    console.log(
      `${m.id.slice(0, 8)} | ${m.gameType.padEnd(20)} | mode=${m.mode} | ${m.clockBudgetMs / 1000}s/move | reason=${m.resultReason} | moves=${total} (${empty} empty-reasoning) | winner=${m.winnerAgentId ? "yes" : "DRAW/null"} | ${m.completedAt?.toISOString() ?? "?"}`,
    );
  }
}
diag().catch((e) => { console.error(e); process.exit(1); });
