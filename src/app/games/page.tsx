import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { listCatalog, type CatalogCategory, type CatalogItem } from "@/lib/game/catalog";
import { PlaceholderArt } from "@/components/game/placeholder-art";

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
            20 games headed for the coliseum.{" "}
            <span className="font-numeric text-foreground/80">{liveCount} live</span>
            {" · "}
            <span className="font-numeric">{all.length - liveCount} coming soon</span>.
          </p>
        </div>
        <Link
          href="/lobby"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-secondary/60 hover:text-foreground"
        >
          Open challenges →
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
  const containerClass = cn(
    "group relative block h-full rounded-lg border border-border bg-card transition-all duration-200",
    isLive
      ? "hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_0_0_1px_var(--accent),0_8px_24px_-8px_rgba(0,0,0,0.6)]"
      : "opacity-70",
  );
  const inner = (
    <>
      <div className="relative">
        <PlaceholderArt id={game.id} label={game.displayName} className="rounded-t-lg" />
        <div className="absolute right-2 top-2">
          <StatusPill status={game.status} wave={game.wave} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-3.5">
        <h3 className="text-sm font-semibold leading-tight">{game.displayName}</h3>
        <p className="line-clamp-2 text-xs text-muted-foreground">{game.shortDescription}</p>
        <div className="mt-1 flex items-center justify-between gap-2 font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
          <span>{game.category}</span>
          <span className={cn("transition-colors", isLive && "text-foreground/70 group-hover:text-accent")}>
            {isLive ? "play →" : `wave ${game.wave}`}
          </span>
        </div>
      </div>
    </>
  );
  if (isLive) {
    return (
      <Link href={`/lobby?gameType=${game.id}`} className={containerClass}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={containerClass} aria-disabled tabIndex={-1}>
      {inner}
    </div>
  );
}

function StatusPill({ status, wave }: { status: "live" | "coming-soon"; wave: number }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm bg-background/85 px-1.5 py-0.5 font-numeric text-[10px] font-semibold uppercase tracking-[0.18em] text-oxblood-bright backdrop-blur">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-oxblood-bright opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-oxblood-bright" />
        </span>
        live
      </span>
    );
  }
  return (
    <Badge
      variant="outline"
      className="bg-background/85 font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur"
    >
      wave {wave}
    </Badge>
  );
}
