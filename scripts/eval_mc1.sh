#!/usr/bin/env bash
# Score a fine-tuned run and the released baseline on the development split, fit the run's temperature on the
# calibration split, and print the comparison (the parent project's eval_run_v2.sh with a 512-token context).
# Usage: scripts/eval_mc1.sh <run name under $KEV/runs> [data dir=data/mc1_ep] [baseline=jaredpalmer/kev-0.8b]
set -euo pipefail
cd "$(dirname "$0")/.."
run=${1:?run}; data=$(realpath "${2:-data/mc1_ep}"); base=${3:-jaredpalmer/kev-0.8b}
KEV=${KEV:-../overcooked-kev/kev}; BENCH=$(realpath scripts/bench_ctx.py)
cd "$KEV"
export KEV_BENCH_MAX_STATE=${KEV_BENCH_MAX_STATE:-512} KEV_DTYPE=bf16
PY=.venv/bin/python
$PY "$BENCH" --run "runs/$run" --data "$data/calibration.jsonl" --out "runs/$run-cal" > /dev/null
$PY scripts/calibrate_checkpoint.py --run "runs/$run" --rows "runs/$run-cal/rows.json" 2>&1 | tail -3   # writes the fitted temperature into head.pt
$PY "$BENCH" --run "runs/$run" --data "$data/development.jsonl" --out "runs/$run-dev" > /dev/null
$PY "$BENCH" --run "$base"     --data "$data/development.jsonl" --out "runs/$run-base-dev" > /dev/null
$PY "$BENCH" --run "$base"     --data "$data/calibration.jsonl" --out "runs/$run-base-cal" > /dev/null
$PY -m kev.calibrate --rows "runs/$run-base-cal/rows.json" 2>&1 | tail -4 || true
$PY -m kev.compare --candidate "runs/$run-dev" --reference "runs/$run-base-dev" --out "runs/$run-compare" 2>&1 | tail -15 || echo "(kev.compare failed; see the report lines below)"
python3 - "runs/$run-dev/report.json" "runs/$run-base-dev/report.json" <<'PY'
import json, sys
for label, path in (("fine-tuned", sys.argv[1]), ("baseline", sys.argv[2])):
    r = json.load(open(path)); c = r["clean"]; cov = r.get("coverage", {})
    print(f"{label}: coverage {cov.get('evaluated_records')}/{cov.get('requested_records')} records ({cov.get('rejected_records')} rejected as over-long)")
    print(f"{label:11s} n={c['n']} acc={c['acc']:.3f} ece={c['ece']:.3f} brier={c['brier']:.3f} conf_err={c['confident_error_rate']:.3f}  " +
          "  ".join(f"{t}: acc={m['acc']:.2f} ece={m['ece']:.2f} n={m['n']}" for t, m in r["tasks"].items()))
PY
