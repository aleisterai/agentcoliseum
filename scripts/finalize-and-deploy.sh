#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Agent Coliseum — finalize and deploy
#
# Run this from your workspace folder (the directory containing this script's
# parent). It handles the last-mile cleanup that Cowork couldn't do, then
# inits git, commits, and pushes. Vercel auto-deploys on push (project already
# linked to GitHub).
#
# Run it like:
#   chmod +x scripts/finalize-and-deploy.sh
#   ./scripts/finalize-and-deploy.sh
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "Working in: $ROOT"
echo ""

# --- 1. Remove the orphan route-group folder Cowork couldn't delete -----------
if [[ -d "src/app/(public)" ]]; then
  echo "Removing orphan src/app/(public)/ …"
  rm -rf "src/app/(public)"
fi

# --- 2. Remove leftover _tmp_* and testfile from the failed pnpm bootstrap ---
for stale in _tmp_* testfile; do
  if compgen -G "./$stale" > /dev/null; then
    echo "Removing leftover: $stale"
    rm -rf ./$stale
  fi
done

# --- 3. Nuke any half-initialized .git from the FUSE constraint --------------
if [[ -d .git ]] && [[ -f .git/index.lock ]]; then
  echo "Removing stuck .git/ folder (had a stale index.lock) …"
  rm -rf .git
fi

# --- 4. Verify env --- -------------------------------------------------------
if [[ ! -f .env.local ]]; then
  echo "ERROR: .env.local is missing. Copy from .env.example and fill in:"
  echo "       DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BASE_RPC_URL,"
  echo "       PLATFORM_OPERATOR_PRIVATE_KEY, CRON_SECRET, INTERNAL_API_KEY"
  exit 1
fi

# Check the must-have values are present (anything left empty after =).
missing=()
for var in DATABASE_URL SUPABASE_SERVICE_ROLE_KEY BASE_RPC_URL \
           NEXT_PUBLIC_BASE_RPC_URL PLATFORM_OPERATOR_PRIVATE_KEY \
           PRIVY_APP_SECRET; do
  if ! grep -E "^${var}=.+" .env.local > /dev/null 2>&1; then
    missing+=("$var")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: these env vars are not set in .env.local:"
  printf '   %s\n' "${missing[@]}"
  echo "See DEPLOY.md section 0 for where to get each value."
  exit 1
fi

# --- 5. Local sanity check ---------------------------------------------------
echo ""
echo "=== pnpm install ==="
pnpm install --frozen-lockfile 2>&1 | tail -5

echo ""
echo "=== typecheck ==="
pnpm typecheck

echo ""
echo "=== tests ==="
pnpm test

# --- 6. Init git, commit, push ------------------------------------------------
echo ""
echo "=== git ==="
git init -b main
git add -A
git commit -m "Initial Agent Coliseum MVP

12 phases shipped. See DEPLOY.md + SMOKE_TEST.md."

# Set the remote — adjust the URL if your GitHub username/repo differs.
GH_REPO="${GH_REPO:-git@github.com:${USER:-virusavuk}/agentcoliseum.git}"
echo ""
echo "Adding remote: $GH_REPO"
git remote add origin "$GH_REPO" 2>/dev/null || git remote set-url origin "$GH_REPO"

echo ""
echo "Pushing to origin/main …"
git push -u origin main

echo ""
echo "============================================================"
echo "Done. Vercel will auto-build and deploy."
echo "Monitor at: https://vercel.com/aleisters-projects/agentcoliseum"
echo ""
echo "Once the deploy is live:"
echo "  curl https://agentcoliseum.xyz/rules.md   # should return text/markdown"
echo "  curl https://agentcoliseum.xyz/skill.md   # same"
echo ""
echo "Then run the 10-step smoke test in SMOKE_TEST.md."
echo "============================================================"
