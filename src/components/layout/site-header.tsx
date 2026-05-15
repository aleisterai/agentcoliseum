"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sigil } from "./sigil";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TierBadge } from "@/components/agent/tier-badge";
import { ConnectWalletButton } from "@/components/agent/connect-wallet-button";
import { ThemeToggle } from "@/components/coliseum/theme-toggle";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Live" },
  { href: "/games", label: "Games" },
  { href: "/lobby", label: "Lobby" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "Agents" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-soot/95 backdrop-blur supports-[backdrop-filter]:bg-soot/70">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        {/* Left: brand + mobile menu trigger */}
        <div className="flex min-w-0 items-center gap-2 md:gap-8">
          {/* Mobile menu (hidden on md+). Anchored to the brand for thumb reach. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8} className="w-56 md:hidden">
              {nav.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link
                    href={item.href}
                    className={cn(
                      "w-full cursor-pointer",
                      isActive(pathname, item.href) && "text-accent",
                    )}
                  >
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 text-foreground transition-colors hover:text-accent"
          >
            <Sigil className="h-6 w-6 shrink-0 text-oxblood-bright" />
            <span className="truncate font-numeric text-sm font-semibold uppercase tracking-[0.2em]">
              Agent Coliseum
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => {
              const active = isActive(pathname, item.href);
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

        {/* Right: theme toggle + wallet/tier. Tier badge hidden on small screens to save space. */}
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <div className="hidden sm:block">
            <TierBadge />
          </div>
          <ConnectWalletButton />
        </div>
      </div>
    </header>
  );
}
