#!/usr/bin/env bash
# DAgger round (lesson 11): kev (mc-v1) drives 24 fresh seeds while the teacher labels every state it visits; those
# records are merged with the first collection, re-split against the same holdout, mc-v2 is trained from mc-v1,
# evaluated, and driven on the 20 unseen seeds. Requires data/mc1_pipeline.done. Log: data/dagger_mc1.log.
# Launch detached: setsid nohup systemd-inhibit --what=sleep:idle --who=minecraft-kev --why=dagger --mode=block scripts/dagger_mc1.sh > data/dagger_mc1.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
KEV=${KEV:-../overcooked-kev/kev}; export KEV
CPY=${CPY:-../overcooked-kev/client/.venv/bin/python}
say() { echo "[$(date '+%F %T')] $*"; }
[ -f data/mc1_pipeline.done ] || { say "data/mc1_pipeline.done missing: run scripts/overnight_mc1.sh first"; exit 1; }
mkdir -p reports/mc-v2
say "serve mc-v1 and drive 24 DAgger seeds (2000-2023)"
( cd "$KEV" && KEV_DTYPE=bf16 setsid .venv/bin/python -m kev.serve --run runs/mc-v1 --port 8009 > .serve-mc-v1-dagger.log 2>&1 < /dev/null & )
for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds 24 --seed0 2000 --procs 5 --minutes 20 --eps-action 0.05 --thin 8 \
  --out data/mc1_dagger.jsonl --prefix dagger --port0 25640
say "dagger runs done (exit $?)"; pkill -f "[k]ev.serve --run runs/mc-v1"; sleep 3
cat data/mc1.jsonl data/mc1_dagger.jsonl > data/mc2.jsonl
python3 scripts/base_rates.py data/mc1_dagger.jsonl
say "split"; scripts/split.sh data/mc2.jsonl data/mc1_holdout.jsonl data/mc2_ep 2>&1 | tail -12
say "train mc-v2 from mc-v1"; scripts/train_mc1.sh mc-v2 data/mc2_ep/train.jsonl "runs/mc-v1"; say "train exit $?"
[ -f "$KEV/runs/mc-v2/head.pt" ] || { say "no checkpoint, stopping"; exit 1; }
cp "$KEV/runs/mc-v2.log" reports/mc-v2/train.log 2>/dev/null
say "eval mc-v2"; scripts/eval_mc1.sh mc-v2 data/mc2_ep jaredpalmer/kev-0.8b 2>&1 | tail -20
cp "$KEV/runs/mc-v2-dev/report.json" reports/mc-v2/dev-report.json 2>/dev/null
$CPY scripts/reliability.py "$KEV/runs/mc-v2-dev/rows.json" --censoring data/mc1_holdout.report.json --out reports/mc-v2 --title mc-v2 2>&1 | tail -10
say "drive eval mc-v2"; scripts/drive_eval.sh mc-v2 20 1000 20; say "drive exit $?"
touch data/mc2_pipeline.done; say "dagger pipeline done"
