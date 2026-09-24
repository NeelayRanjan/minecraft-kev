#!/usr/bin/env bash
# Experiment 1 data collection: 40 training seeds + 12 holdout seeds, 20 in-game minutes each, 5 servers in parallel.
# Detached: setsid nohup systemd-inhibit --what=sleep:idle --who=minecraft-kev --why=collection --mode=block scripts/collect_mc1.sh > data/gen.log 2>&1 &
cd "$(dirname "$0")/.."
echo "[$(date '+%F %T')] collection start"
node agent/gen_data.mjs --seeds 40 --seed0 0 --procs 5 --minutes 20 --eps-action 0.1 --thin 8 --out data/mc1.jsonl --prefix gen --port0 25600
echo "[$(date '+%F %T')] train seeds done (exit $?)"
node agent/gen_data.mjs --seeds 12 --seed0 1000 --procs 5 --minutes 20 --eps-action 0.1 --thin 8 --out data/mc1_holdout.jsonl --prefix hold --port0 25600
echo "[$(date '+%F %T')] holdout seeds done (exit $?)"
python3 scripts/base_rates.py data/mc1.jsonl
python3 scripts/base_rates.py data/mc1_holdout.jsonl
touch data/mc1.done
echo "[$(date '+%F %T')] collection done"
