#!/usr/bin/env bash
# Leader round two: on the same seed and the same code, kev alone (no --leader) against kev plus the leader under
# the "events" trigger with thinking off (agent/leader.js). Serves $KEV/runs/mc-v3 on 8009 (the way
# scripts/leader_runs.sh does, with scripts/warm_kev.mjs), checks the leader URL answers with the expected model,
# then runs the two arms back to back: r2_kev_s<seed> (--policy kev, no leader) and r2_leader_s<seed> (the same
# plus --leader events). An arm whose out/<name>.json already exists is skipped (restartable). A report
# (scripts/leader_report.mjs) is written after every arm that actually ran, and at the end a milestone-2
# comparison line is printed for both arms via scripts/leader_report.mjs --line (agent/leader_report.js's
# renderComparisonLine), whether or not this run just produced them.
# Usage: scripts/leader_round2.sh [seed=3000] [minutes=60]
# Log for the whole run (the caller redirects, this script does not): data/leader_round2.log
#   setsid nohup scripts/leader_round2.sh > data/leader_round2.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
seed=${1:-3000}; minutes=${2:-60}
KEV=${KEV:-../overcooked-kev/kev}
LEADER_URL=${LEADER_URL:-http://100.109.91.95:11434}
LEADER_MODEL=${LEADER_MODEL:-qwen38-27b-iq2s}

say() { echo "[$(date '+%F %T')] leader_round2: $*"; }

# ---- kev.serve (mc-v3) ---------------------------------------------------------------------------------------------
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run runs/mc-v3 --port 8009 > ".serve-mc-v3-leader.log" 2>&1 < /dev/null & )
for i in $(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve (mc-v3) did not come up"; exit 1; }
node scripts/warm_kev.mjs | tail -1

# ---- the leader URL -------------------------------------------------------------------------------------------------
say "checking the leader URL $LEADER_URL for $LEADER_MODEL"
curl -s -m 10 "$LEADER_URL/api/tags" | grep -q "$LEADER_MODEL" || { say "leader URL $LEADER_URL does not answer with $LEADER_MODEL"; exit 1; }

run_arm() {   # run_arm <name> [--leader events --leader-model ... --leader-url ...]
  local name=$1; shift
  if [ -s "out/${name}.json" ]; then say "$name exists, skipping"; return 0; fi
  if [ "$#" -gt 0 ]; then
    # Preload the leader model before the leader arm only, so the first call never spends the 300 s first-call
    # budget on a cold load (~265 s for a 27B).
    local t_load=$(date +%s)
    curl -s -m 600 "$LEADER_URL/api/generate" -d "{\"model\":\"$LEADER_MODEL\",\"prompt\":\"ok\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":6144,\"num_predict\":2},\"keep_alive\":\"90m\"}" > /dev/null
    say "leader model $LEADER_MODEL preloaded in $(( $(date +%s) - t_load )) s"
  fi
  say "running $name${*:+ ($*)}"
  node agent/run_episode.mjs --seed "$seed" --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --goal nether \
    "$@" --minutes "$minutes" --out "$name" --video
  say "$name run done (exit $?)"
  node scripts/leader_report.mjs "$name"
}

# ---- the two arms, in order -----------------------------------------------------------------------------------
run_arm "r2_kev_s${seed}"
run_arm "r2_leader_s${seed}" --leader events --leader-model "$LEADER_MODEL" --leader-url "$LEADER_URL"

# ---- comparison block ------------------------------------------------------------------------------------------
say "comparison:"
node scripts/leader_report.mjs "r2_kev_s${seed}" --line
node scripts/leader_report.mjs "r2_leader_s${seed}" --line

pkill -f "[k]ev.serve --run runs/mc-v3"
say "both arms done"
