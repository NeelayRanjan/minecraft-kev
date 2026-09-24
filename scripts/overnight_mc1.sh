#!/usr/bin/env bash
# Overnight experiment 1: wait for the collection marker, split, train mc-v1, evaluate, drive 20 unseen seeds (kev and
# teacher), reliability diagrams. Log: data/pipeline_mc1.log. Marker: data/mc1_pipeline.done.
# Launch detached: setsid nohup systemd-inhibit --what=sleep:idle --who=minecraft-kev --why=pipeline --mode=block scripts/overnight_mc1.sh > data/pipeline_mc1.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
KEV=${KEV:-../overcooked-kev/kev}; export KEV
CPY=${CPY:-../overcooked-kev/client/.venv/bin/python}
say() { echo "[$(date '+%F %T')] $*"; }
say "armed; waiting for data/mc1.done"
until [ -f data/mc1.done ]; do sleep 60; done
say "collection done"
mkdir -p reports/mc-v1
say "split"; scripts/split.sh data/mc1.jsonl data/mc1_holdout.jsonl data/mc1_ep 2>&1 | tail -25
say "train mc-v1"; scripts/train_mc1.sh mc-v1 data/mc1_ep/train.jsonl jaredpalmer/kev-0.8b; say "train exit $?"
[ -f "$KEV/runs/mc-v1/head.pt" ] || { say "no checkpoint, stopping"; exit 1; }
cp "$KEV/runs/mc-v1.log" reports/mc-v1/train.log 2>/dev/null
say "eval mc-v1"; scripts/eval_mc1.sh mc-v1 data/mc1_ep jaredpalmer/kev-0.8b 2>&1 | tail -20; say "eval exit $?"
for f in report.json; do cp "$KEV/runs/mc-v1-dev/$f" reports/mc-v1/dev-report.json 2>/dev/null; cp "$KEV/runs/mc-v1-base-dev/$f" reports/mc-v1/dev-report-baseline-0.8b.json 2>/dev/null; done
say "reliability (dev split)"; $CPY scripts/reliability.py "$KEV/runs/mc-v1-dev/rows.json" --censoring data/mc1_holdout.report.json --out reports/mc-v1 --title mc-v1 2>&1 | tail -12
say "drive eval"; scripts/drive_eval.sh mc-v1 20 1000 20; say "drive exit $?"
say "reliability (kev-driven runs, forecast labels from the runs kev drove)"
if [ -s data/drive_mc-v1_kev.jsonl ]; then
  ( cd "$KEV" && KEV_BENCH_MAX_STATE=512 KEV_DTYPE=bf16 .venv/bin/python "$(realpath scripts/bench_ctx.py)" --run runs/mc-v1 --data "$(realpath data/drive_mc-v1_kev.jsonl)" --out runs/mc-v1-drive > /dev/null 2>&1 )
  $CPY scripts/reliability.py "$KEV/runs/mc-v1-drive/rows.json" --censoring data/drive_mc-v1_kev.report.json --out reports/mc-v1/driven --title "mc-v1 driven" 2>&1 | tail -12
fi
touch data/mc1_pipeline.done; say "pipeline done"
