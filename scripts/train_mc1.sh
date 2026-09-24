#!/usr/bin/env bash
# Fine-tune kev-0.8b on the experiment 1 records (laptop, 8 GB): the air-v1/air-v2 recipe with --max_state 512.
# Usage: scripts/train_mc1.sh [run name=mc-v1] [train.jsonl=data/mc1_ep/train.jsonl] [init=jaredpalmer/kev-0.8b]
# Output: $KEV/runs/<run>; log $KEV/runs/<run>.log. Falls back to <= 4 questions per record on OOM (like air-v2).
set -u
cd "$(dirname "$0")/.."
run=${1:-mc-v1}; data=$(realpath "${2:-data/mc1_ep/train.jsonl}"); init=${3:-jaredpalmer/kev-0.8b}
KEV=${KEV:-../overcooked-kev/kev}
cd "$KEV"
train() {
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True .venv/bin/python -m kev.train --data "$1" \
    --init_from "$init" --base Qwen/Qwen3.5-0.8B-Base --base_revision dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68 \
    --suite evals/v7/decision-v7 --replay 1000 --epochs 1 --lr 2e-5 --batch 1 --accum 8 \
    --perm_kl 0.5 --dtype bf16 --checkpointing 1 --device cuda --seed 0 --max_state 512 --out "runs/$run" > "$2" 2>&1
}
date +%T > "runs/$run.log"
train "$data" "runs/$run.log"; rc=$?
echo "train exit $rc $(date +%T)" >> "runs/$run.log"
if [ ! -f "runs/$run/head.pt" ] && grep -qi "out of memory" "runs/$run.log"; then
  echo "OOM: splitting records into groups of <= 4 questions and retrying" >> "runs/$run.log"
  q4="${data%.jsonl}_q4.jsonl"
  python3 - "$data" "$q4" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(dst, "w") as f:
    for line in open(src):
        r = json.loads(line); items = list(r["questions"].items())
        for i in range(0, len(items), 4):
            f.write(json.dumps({"state": r["state"], "questions": dict(items[i:i + 4])}) + "\n")
PY
  mv "runs/$run.log" "runs/$run.oom.log"; rm -rf "runs/$run"
  train "$q4" "runs/$run.log"; echo "train (q4) exit $? $(date +%T)" >> "runs/$run.log"
fi
[ -f "runs/$run/head.pt" ] && echo "checkpoint runs/$run written" || { echo "no checkpoint"; exit 1; }
