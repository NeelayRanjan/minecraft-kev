#!/usr/bin/env bash
# Task 9: the six-configuration leader run on mc-v3, one seed, back to back. Serves $KEV/runs/mc-v3 on 8009 (the way
# scripts/supervisor_eval.sh does, with scripts/warm_kev.mjs), checks the leader URL answers with the expected model,
# then runs kev in chain mode (--goal nether, agent/run_episode.mjs) under all three leader trigger policies
# (agent/leader.js: events, periodic30_interrupts, periodic15), each once with thinking off and once on, one at a
# time in that order. A configuration whose out/<name>.json already exists is skipped (restartable). A report
# (scripts/leader_report.mjs) is written after every run, plus a one-line stage-reached summary.
# Usage: scripts/leader_runs.sh [seed=3000] [minutes=60]
# Log for the whole batch (the caller redirects, this script does not): data/leader_runs.log
#   setsid nohup scripts/leader_runs.sh > data/leader_runs.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
seed=${1:-3000}; minutes=${2:-60}
KEV=${KEV:-../overcooked-kev/kev}
LEADER_URL=${LEADER_URL:-http://100.109.91.95:11434}
LEADER_MODEL=${LEADER_MODEL:-qwen38-27b-iq2s}
RUN_THINK=${RUN_THINK:-0}   # 1 re-enables the three thinking configurations (2026-09-25: a 27B thinking at ~45 tok/s answers in 30-70 s, after the subtask it judged has ended: 25 of 55 calls truncated, 23 stale)

say() { echo "[$(date '+%F %T')] leader_runs: $*"; }

# ---- kev.serve (mc-v3) ---------------------------------------------------------------------------------------------
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run runs/mc-v3 --port 8009 > ".serve-mc-v3-leader.log" 2>&1 < /dev/null & )
for i in $(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve (mc-v3) did not come up"; exit 1; }
node scripts/warm_kev.mjs | tail -1

# ---- the leader URL -------------------------------------------------------------------------------------------------
say "checking the leader URL $LEADER_URL for $LEADER_MODEL"
curl -s -m 10 "$LEADER_URL/api/tags" | grep -q "$LEADER_MODEL" || { say "leader URL $LEADER_URL does not answer with $LEADER_MODEL"; exit 1; }

stage_of() {   # stage_of <name> -> a one-line stage/deaths/end-reason summary from out/<name>.json
  node -e '
    const fs = require("node:fs")
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const m = j.meta || {}
    console.log(`stage ${m.stage_reached ?? "?"}/5, deaths ${m.deaths ?? 0}, end ${m.end_reason ?? "?"} at t=${m.ended_t ?? "?"}s`)
  ' "out/$1.json"
}

run_config() {   # run_config <name> <leader-mode> [extra run_episode.mjs args, e.g. --leader-think --leader-num-predict 3000]
  local name=$1 mode=$2; shift 2
  case "$*" in *--leader-think*) [ "$RUN_THINK" = 1 ] || { say "$name skipped (RUN_THINK=0)"; return 0; } ;; esac
  if [ -s "out/${name}.json" ]; then say "$name exists, skipping"; return 0; fi
  # Preload the leader model so the first call never spends the 300 s first-call budget on a cold load (~265 s for a 27B).
  local t_load=$(date +%s)
  curl -s -m 600 "$LEADER_URL/api/generate" -d "{\"model\":\"$LEADER_MODEL\",\"prompt\":\"ok\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":6144,\"num_predict\":2},\"keep_alive\":\"90m\"}" > /dev/null
  say "leader model $LEADER_MODEL preloaded in $(( $(date +%s) - t_load )) s"
  say "running $name (mode=$mode${*:+, $*})"
  node agent/run_episode.mjs --seed "$seed" --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --goal nether \
    --leader "$mode" "$@" --leader-model "$LEADER_MODEL" --leader-url "$LEADER_URL" --minutes "$minutes" --out "$name" --video
  say "$name run done (exit $?)"
  node scripts/leader_report.mjs "$name"
  say "$name: $(stage_of "$name")"
}

# ---- the six configurations, in order --------------------------------------------------------------------------
run_config "leader_events_s${seed}"       events
run_config "leader_events_think_s${seed}" events                --leader-think --leader-num-predict 3000
run_config "leader_p30i_s${seed}"         periodic30_interrupts
run_config "leader_p30i_think_s${seed}"   periodic30_interrupts --leader-think --leader-num-predict 3000
run_config "leader_p15_s${seed}"          periodic15
run_config "leader_p15_think_s${seed}"    periodic15            --leader-think --leader-num-predict 3000

pkill -f "[k]ev.serve --run runs/mc-v3"
say "all six configurations done"
