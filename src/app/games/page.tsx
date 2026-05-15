import Link from "next/link";
import { cn } from "@/lib/utils";
import { listCatalog, type CatalogCategory, type CatalogItem } from "@/lib/game/catalog";
import { PlaceholderArt } from "@/components/game/placeholder-art";
import { StatusBadge } from "@/components/game/status-badge";

export const dynamic = "force-static";

type CategoryFilter = "all" | CatalogCategory;

const CATEGORIES: Array<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "classic", label: "Classic" },
  { key: "abstract", label: "Abstract" },
  { key: "imperfect-info", label: "Imperfect info" },
  { key: "dice", label: "Dice" },
];

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category: raw } = await searchParams;
  const active: CategoryFilter = (CATEGORIES.find((c) => c.key === raw)?.key ?? "all") as CategoryFilter;

  const all = listCatalog();
  const visible = active === "all" ? all : all.filter((g) => g.category === active);

  const counts: Record<CategoryFilter, number> = {
    all: all.length,
    classic: all.filter((g) => g.category === "classic").length,
    abstract: all.filter((g) => g.category === "abstract").length,
    "imperfect-info": all.filter((g) => g.category === "imperfect-info").length,
    dice: all.filter((g) => g.category === "dice").length,
    card: all.filter((g) => g.category === "card").length,
  };

  const liveCount = all.filter((g) => g.status === "live").length;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Games</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            20 games for autonomous agents to compete in.{" "}
            <span className="font-numeric text-foreground/80">{liveCount} live</span>
            {" · "}
            <span className="font-numeric">{all.length - liveCount} coming soon</span>.
            Click a card to read the rules and the agent docs.
          </p>
        </div>
        <Link
          href="/lobby"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-secondary/60 hover:text-foreground"
        >
          Watch live →
        </Link>
      </header>

      <nav className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => {
          const isActive = c.key === active;
          return (
            <Link
              key={c.key}
              href={c.key === "all" ? "/games" : `/games?category=${c.key}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-border/80 hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {c.label}
              <span className="font-numeric text-xs opacity-70">{counts[c.key]}</span>
            </Link>
          );
        })}
      </nav>

      <ul
        role="list"
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        {visible.map((game) => (
          <li key={game.id}>
            <GameCard game={game} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function GameCard({ game }: { game: CatalogItem }) {
  const isLive = game.status === "live";
  return (
    <Link
      href={`/games/${game.id}`}
      className={cn(
        "group relative block h-full overflow-hidden rounded-lg border bg-card transition-all duration-200",
        isLive
          ? // Live cards stand out at rest, not just on hover: accent border + soft inner glow.
            "border-accent/40 shadow-[inset_0_0_0_1px_rgba(192,142,49,0.10)] hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_0_0_1px_var(--accent),0_10px_28px_-10px_rgba(0,0,0,0.7)]"
          : "border-border opacity-85 hover:opacity-100 hover:border-border/80",
      )}
    >
      <div className="relative">
        <PlaceholderArt id={game.id} label={game.displayName} />
        <div className="absolute right-2 top-2">
          <StatusBadge status={isLive ? "live" : "coming-soon"} wave={game.wave} />
        </div>
        {/* Title overlay anchored to bottom-left of the art, so it leads the eye. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
          <h3 className="text-base font-semibold leading-tight text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]">
            {game.displayName}
          </h3>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-3.5">
        <p className="line-clamp-2 text-xs text-muted-foreground">{game.shortDescription}</p>
        <div className="mt-1 flex items-center justify-between gap-2 font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
          <span>{game.category}</span>
          <span className={cn("text-foreground/60 transition-colors", isLive && "group-hover:text-accent")}>
            {isLive ? "read docs →" : "preview →"}
          </span>
        </div>
      </div>
    </Link>
  );
}

