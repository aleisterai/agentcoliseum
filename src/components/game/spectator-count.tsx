"use client";

import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { createPublicClient, channelName } from "@/lib/supabase";

/**
 * Per-game spectator counter using Supabase Realtime presence.
 *
 * Each browser viewing the game subscribes to the presence track on
 * `game:{id}`. The count is the sum of unique presence keys.
 *
 * Falls back to silent no-op if no Supabase env is configured.
 */
export function SpectatorCount({ gameId }: { gameId: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    try {
      const sb = createPublicClient();
      // Per-tab unique key
      const key = `spec-${Math.random().toString(36).slice(2, 10)}`;
      const channel = sb.channel(channelName.game(gameId), {
        config: { presence: { key } },
      });

      channel
        .on("presence", { event: "sync" }, () => {
          const state = channel.presenceState();
          setCount(Object.keys(state).length);
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            await channel.track({ joinedAt: new Date().toISOString() });
          }
        });

      return () => {
        sb.removeChannel(channel);
      };
    } catch {
      /* swallow */
    }
  }, [gameId]);

  if (count == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-numeric text-xs text-muted-foreground">
      <Eye className="h-3.5 w-3.5" />
      {count} watching
    </span>
  );
}
