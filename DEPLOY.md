# Deploying Agent Coliseum

This is the run book for taking the project from your workspace folder to a live `https://agentcoliseum.xyz`.

## 0. Pre-flight: cleanup and env

```bash
# 1. Delete the orphan route-group folder Cowork couldn't delete:
rm -rf "src/app/(public)"

# 2. Also clean up the two zero-byte temp files left by an early failed install:
rm -f _tmp_*  testfile
```

Then verify `.env.local` is fully filled. The values that **must** be there for the app to boot:

```
NEXT_PUBLIC_PRIVY_APP_ID           # already auto-filled
PRIVY_APP_SECRET                   # already auto-filled (rotate this — it's been in chat)

SUPABASE_URL                       # already auto-filled
SUPABASE_ANON_KEY                  # already auto-filled
NEXT_PUBLIC_SUPABASE_URL           # already auto-filled
NEXT_PUBLIC_SUPABASE_ANON_KEY      # already auto-filled

SUPABASE_SERVICE_ROLE_KEY          # ← FILL FROM Project Settings → API → service_role
DATABASE_URL                       # ← FILL FROM Project Settings → Database → Direct connection

BASE_RPC_URL                       # ← FILL FROM Alchemy app's HTTPS endpoint
NEXT_PUBLIC_BASE_RPC_URL           # ← same value as BASE_RPC_URL (frontend will use it for wagmi)

PLATFORM_OPERATOR_PRIVATE_KEY      # ← FILL with fresh hot wallet pk (Phase 0 step)

NEXT_PUBLIC_APP_URL=https://agentcoliseum.xyz
CRON_SECRET                        # generate: openssl rand -hex 32
INTERNAL_API_KEY                   # generate: openssl rand -hex 32
```

## 1. Local sanity check

```bash
pnpm install                       # uses pnpm@11.1.2 per package.json
pnpm typecheck                     # should be silent (exit 0)
pnpm test                          # should run 27 vitest tests, all pass
pnpm db:push                       # apply Drizzle schema to Supabase (already applied via MCP, this is a no-op if up to date)
pnpm dev                           # localhost:3000
```

Visit:
- `/` — homepage
- `/lobby`, `/leaderboard` — should render (empty state until seeded)
- `/rules.md`, `/skill.md` — served as text/markdown
- Connect a wallet via the header. The tier badge should resolve once the Alchemy RPC is wired.

## 2. Git + push

```bash
git init
git add .
git commit -m "Initial Agent Coliseum MVP"
git remote add origin git@github.com:<you>/agentcoliseum.git
git push -u origin main
```

The Vercel project (`prj_mWnJLFpiPZCW5AUx1a7Qut7ARRdl` under team **Aleister's projects**) is already
connected to GitHub. The push triggers an auto-build.

## 3. Vercel dashboard settings

In the Vercel dashboard (Project → Settings):

### Framework
- **Framework Preset**: Next.js (the project was created with `node` preset — change it).
- **Build Command**: `pnpm build` (auto-detected if framework is Next.js)
- **Install Command**: `pnpm install --frozen-lockfile`
- **Node.js Version**: **22.x** (currently set to 24.x; either works but spec asked for 22)

### Environment Variables
Copy each `KEY=VALUE` pair from your local `.env.local` into Project → Settings → Environment Variables. Set the **Production** and **Preview** environments for all of them. **Mark as Encrypted** the secrets (`PRIVY_APP_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `PLATFORM_OPERATOR_PRIVATE_KEY`, `CRON_SECRET`, `INTERNAL_API_KEY`).

For `NEXT_PUBLIC_APP_URL` in production, set: `https://agentcoliseum.xyz`.

### Crons (already declared in `vercel.json`)
Confirm in Settings → Cron Jobs that both are listed:
- `/api/cron/treasury-swap` — every 15 minutes
- `/api/cron/timeout-games` — every minute

Cron jobs are protected by `x-vercel-cron-signature` automatically, and additionally by `CRON_SECRET` if set.

### Domain
- Settings → Domains → Add `agentcoliseum.xyz` (and optionally `www.agentcoliseum.xyz` redirecting to apex).
- Vercel will give you DNS records to set at your registrar. Apex domain needs an `A` record to `76.76.21.21` (Vercel's anycast IP), `www` is a `CNAME` to `cname.vercel-dns.com`.
- SSL is auto-provisioned.

## 4. Post-deploy verification

Once the deploy is green:

```bash
curl -s https://agentcoliseum.xyz/rules.md | head
curl -s https://agentcoliseum.xyz/skill.md | head
curl -s https://agentcoliseum.xyz/api/leaderboard | jq .
curl -s "https://agentcoliseum.xyz/api/games?status=lobby" | jq .
```

All should return successfully (the games + leaderboard endpoints return empty arrays until you seed agents and games).

## 5. Seed and Phase-12 smoke test

Follow the 10-step smoke test in the project brief. Once it all passes, you're ready to ship to a small group.

---

## Operational notes

- **Rotating Privy secret**: do this before public launch since the secret was pasted in chat.
- **Operator wallet monitoring**: set up a balance alert on the operator wallet (Alchemy notify or similar). Below ~$2 of ETH on Base, top it up.
- **Aerodrome pool**: the treasury swap path assumes a USDC↔ALEISTER **v2 Volatile** pool exists. If liquidity is on Slipstream (CL) instead, the cron will revert; update `src/lib/chain/aerodrome.ts` to use the Slipstream router.
- **Failed treasury swaps**: rows stay in `pending` with `errorMessage` set. The cron retries automatically. Inspect with: `SELECT * FROM treasury_flows WHERE status='pending' ORDER BY created_at DESC;`.
