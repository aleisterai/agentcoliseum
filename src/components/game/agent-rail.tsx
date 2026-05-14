"use client";

import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Agent = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
};

export function AgentRail({
  agent,
  isTurn,
  side,
  className,
}: {
  agent: Agent | null; // null = system bot
  isTurn: boolean;
  side: "left" | "right";
  className?: string;
}) {
  if (!agent) {
    return (
      <div
        className={cn(
          "flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
          side === "right" && "items-end text-right",
          className,
        )}
      >
        <div className="flex items-center gap-3">
          {side === "left" && <SystemBotAvatar />}
          <div className={cn(side === "right" ? "text-right" : "text-left")}>
            <div className="font-semibold">System Bot</div>
            <div className="font-numeric text-xs text-muted-foreground">no Elo</div>
          </div>
          {side === "right" && <SystemBotAvatar />}
        </div>
        <ThinkingIndicator active={isTurn} />
      </div>
    );
  }

  const total = agent.wins + agent.losses + agent.draws;
  const winRate = total > 0 ? Math.round((agent.wins / total) * 100) : 0;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
        side === "right" && "items-end text-right",
        isTurn && "ring-2 ring-primary/40",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {side === "left" && (
          <Avatar className="h-12 w-12" aria-label={agent.displayName}>
            <AvatarImage src={agent.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{agent.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        )}
        <div className={cn(side === "right" && "items-end text-right")}>
          <Link
            href={`/agents/${agent.handle}`}
            className="font-semibold hover:text-accent"
          >
            {agent.displayName}
          </Link>
          <div className="font-numeric text-xs text-muted-foreground">@{agent.handle}</div>
        </div>
        {side === "right" && (
          <Avatar className="h-12 w-12" aria-label={agent.displayName}>
            <AvatarImage src={agent.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{agent.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        )}
      </div>

      <div className="flex items-baseline gap-3">
        <Badge variant="gold" className="font-numeric">
          Elo {agent.elo}
        </Badge>
        <span className="font-numeric text-xs text-muted-foreground">
          {agent.wins}W · {agent.losses}L · {agent.draws}D · {winRate}%
        </span>
      </div>

      <ThinkingIndicator active={isTurn} />
    </div>
  );
}

function ThinkingIndicator({ active }: { active: boolean }) {
  if (!active) {
    return (
      <span className="font-numeric text-xs uppercase tracking-widest text-muted-foreground/60">
        waiting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 font-numeric text-xs uppercase tracking-widest text-primary">
      <span className="live-pulse" />
      thinking…
    </span>
  );
}

function SystemBotAvatar() {
  return (
    <Avatar className="h-12 w-12 ring-1 ring-accent/40" aria-label="System bot">
      <AvatarFallback className="bg-muted text-accent">SYS</AvatarFallback>
    </Avatar>
  );
}
