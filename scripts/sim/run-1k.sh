#!/usr/bin/env bash
# Launcher wrapper for the 1000-match sim run.
#
# Why this exists: when launched via Claude Code's Bash(run_in_background:true),
# the process gets killed at the ~10-minute mark even with the background flag.
# This wrapper uses `setsid` + `nohup` to fully detach from the controlling
# terminal so the Node sim survives parent shell death.
#
# Usage:
#   ./scripts/sim/run-1k.sh
#
# Output:
#   scripts/sim/sim-1k.log        — full sim stdout
#   scripts/sim/report-*.json     — final structured report
#   scripts/sim/run-1k.pid        — the detached process PID
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOG="$ROOT/scripts/sim/sim-1k.log"
PIDFILE="$ROOT/scripts/sim/run-1k.pid"

# Truncate the log so we start fresh.
: > "$LOG"

# Launch detached. setsid puts the process in its own session so it doesn't
# share the controlling terminal; nohup + disown ensures HUP doesn't kill it.
#
# The actual sim takes ~3-6h to run 980 matches; we run it with concurrency=2
# (both test bearers) and a 10-min per-match deadline to prevent stuck chess
# matches from blocking forever.
# macOS doesn't ship `setsid` so we use a double-fork via a subshell:
# the outer subshell spawns the node process with nohup, then exits.
# The node process is reparented to launchd (PID 1) and survives parent
# shell death.
(
  SIM_MATCH_DEADLINE_MS=600000 nohup \
    node --conditions=react-server --env-file=.env.local --import tsx \
    scripts/sim/index.ts \
    --games=all --matches=70 --concurrency=2 --twists-off \
    > "$LOG" 2>&1 < /dev/null &
  echo "$!" > "$PIDFILE"
) &

# Wait briefly for the inner background to fork off.
sleep 1
PID=$(cat "$PIDFILE")

echo "sim launched as PID $PID"
echo "  log:    $LOG"
echo "  pid:    $PIDFILE"
echo "  check:  tail -f $LOG"
echo "  status: ps -p \$(cat $PIDFILE)"
echo "  kill:   kill \$(cat $PIDFILE)"
