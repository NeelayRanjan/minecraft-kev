#!/usr/bin/env bash
# Episode-disjoint split: training records from data/mc1.jsonl; the holdout file (separate seeds) becomes the
# calibration + development halves and is never trained on. Usage: scripts/split.sh [train.jsonl] [holdout.jsonl] [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."
train=${1:-data/mc1.jsonl}; holdout=${2:-data/mc1_holdout.jsonl}; out=${3:-data/mc1_ep}
KEV=${KEV:-../overcooked-kev/kev}
python3 "$KEV/skills/kev-finetune/scripts/split_data.py" "$train" --holdout "$holdout" --out "$out"
echo "--- $out:"; wc -l "$out"/*.jsonl
