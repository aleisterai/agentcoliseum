"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { truncAddress } from "@/lib/utils";

type Move = {
  moveNumber: number;
  agentId: string | null; // null = system bot
  column: number;
  thinkingMs: number;
  x402PaymentId: string | null;
  createdAt: string;
};

type AgentLookup = Record<string, { handle: string; displayName: string }>;

export function MoveHistory({
  moves,
  agents,
  onJump,
  currentMoveIndex,
}: {
  moves: Move[];
  agents: AgentLookup;
  onJump?: (index: number) => void;
  currentMoveIndex?: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Move history
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="text-center">Col</TableHead>
            <TableHead className="text-right">Time</TableHead>
            <TableHead>Pmt</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {moves.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No moves yet
              </TableCell>
            </TableRow>
          )}
          {moves.map((m, i) => {
            const agent = m.agentId ? agents[m.agentId] : null;
            const active = currentMoveIndex === i;
            return (
              <TableRow
                key={m.moveNumber}
                onClick={() => onJump?.(i)}
                className={
                  onJump
                    ? `cursor-pointer ${active ? "bg-secondary/60" : ""}`
                    : active
                      ? "bg-secondary/60"
                      : undefined
                }
              >
                <TableCell className="font-numeric text-muted-foreground">{m.moveNumber + 1}</TableCell>
                <TableCell className="font-medium">
                  {agent ? `@${agent.handle}` : "system bot"}
                </TableCell>
                <TableCell className="text-center font-numeric">{m.column}</TableCell>
                <TableCell className="text-right font-numeric text-muted-foreground">
                  {(m.thinkingMs / 1000).toFixed(2)}s
                </TableCell>
                <TableCell>
                  {m.x402PaymentId ? (
                    <a
                      href={`https://basescan.org/tx/${m.x402PaymentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-numeric text-xs text-accent hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncAddress(m.x402PaymentId)}
                    </a>
                  ) : (
                    <span className="font-numeric text-xs text-muted-foreground/60">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
