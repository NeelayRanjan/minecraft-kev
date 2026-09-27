#!/usr/bin/env bash
# Leader live: watch the bot play in a browser and steer it from the game chat. Starts kev.serve (mc-v3, port
# 8009, warmed the way scripts/leader_round2.sh does), checks the desktop leader URL answers with the expected
# model, then runs one episode in the foreground with --goal nether --leader subgoals, video recording, and
# --live-view 3007 so a browser can watch while it plays. Meant to be run interactively (it blocks until the
# episode ends or is interrupted), not detached with setsid nohup.
# Usage: scripts/leader_live.sh [seed=3000] [minutes=120]
set -u
cd "$(dirname "$0")/.."
seed=${1:-3000}; minutes=${2:-120}
KEV=${KEV:-../overcooked-kev/kev}
LEADER_URL=${LEADER_URL:-http://100.109.91.95:11434}
LEADER_MODEL=${LEADER_MODEL:-qwen38-27b-iq2s}

say() { echo "[$(date '+%F %T')] leader_live: $*"; }

# ---- kev.serve (mc-v3) ---------------------------------------------------------------------------------------------
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run runs/mc-v3 --port 8009 > ".serve-mc-v3-leader.log" 2>&1 < /dev/null & )
for i in $(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve (mc-v3) did not come up"; exit 1; }
node scripts/warm_kev.mjs | tail -1

# ---- the leader URL -------------------------------------------------------------------------------------------------
say "checking the leader URL $LEADER_URL for $LEADER_MODEL"
curl -s -m 10 "$LEADER_URL/api/tags" | grep -q "$LEADER_MODEL" || { say "leader URL $LEADER_URL does not answer with $LEADER_MODEL"; exit 1; }

# Preload the leader model (with askLeader's num_ctx, 6144, so the first call does not reload it) before the run so the first call never spends the 300 s first-call budget on a cold load.
t_load=$(date +%s)
curl -s -m 600 "$LEADER_URL/api/generate" -d "{\"model\":\"$LEADER_MODEL\",\"prompt\":\"ok\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":6144,\"num_predict\":2},\"keep_alive\":\"90m\"}" > /dev/null
say "leader model $LEADER_MODEL preloaded in $(( $(date +%s) - t_load )) s"

name="live_s${seed}_$(date '+%H%M')"
say "Join 127.0.0.1:25580 with a 1.20.4 client (offline mode, any name), press T and type a request such as \"make a compass\" (\"plan\" shows the plans). Watch at http://127.0.0.1:3007"
say "Status page (plans, goal stack, forecasts, chat, leader, plugins): http://127.0.0.1:3008"
say "running $name"
node agent/run_episode.mjs --seed "$seed" --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --goal nether \
  --leader subgoals --leader-model "$LEADER_MODEL" --leader-url "$LEADER_URL" --minutes "$minutes" --out "$name" --video --live-view 3007 --status-port 3008 --name Kevin
say "$name run done (exit $?)"

node scripts/leader_report.mjs "$name"

pkill -f "[k]ev.serve --run runs/mc-v3"
say "done"
