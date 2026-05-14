"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sigil } from "./sigil";
import { TierBadge } from "@/components/agent/tier-badge";
import { ConnectWalletButton } from "@/components/agent/connect-wallet-button";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Live" },
  { href: "/games", label: "Games" },
  { href: "/lobby", label: "Lobby" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "Agents" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-soot/95 backdrop-blur supports-[backdrop-filter]:bg-soot/70">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="flex items-center gap-2 text-foreground transition-colors hover:text-accent"
          >
            <Sigil className="h-6 w-6 text-oxblood-bright" />
            <span className="font-numeric text-sm font-semibold uppercase tracking-[0.2em]">
              Agent Coliseum
            </span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <TierBadge />
          <ConnectWalletButton />
        </div>
      </div>
    </header>
  );
}
