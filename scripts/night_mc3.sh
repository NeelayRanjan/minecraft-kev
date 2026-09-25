#!/usr/bin/env bash
# Next steps 2 and 4 in one overnight run on the 16 GB machine (docker container, see docker/README.md):
#   A. DAgger: mc-v1 drives 24 fresh seeds (2000-2023, 22 min, eps 0.05); the teacher labels every state it visits.
#   B. mc-v2 = mc-v1 fine-tuned on mc1 + DAgger records (same holdout as mc-v1), evaluated on the dev split.
#      Meanwhile on the CPU: the 22-minute teacher recollection (step 4) with survive_until_morning labelled:
#      train seeds 0-39 and a 20-seed holdout (1000-1019, the drive seeds, never trained on).
#   C. mc-v2 drives the 20 unseen seeds against the teacher; reliability on the states mc-v2 visited.
#   D. mc-v3 = mc-v2 fine-tuned on the recollection + DAgger records (the old 20-minute mc1 data, collected with the
#      earlier motor layer, is left out), evaluated on the new holdout; mc-v3 drives the same seeds (teacher reused).
# Needs data/mc1_pipeline.done. Log: data/night_mc3.log. Markers: data/mc3_collect.done, data/night_mc3.done.
# Launch: docker exec -d mckev bash -c 'setsid nohup scripts/night_mc3.sh > data/night_mc3.log 2>&1'
set -u
cd "$(dirname "$0")/.."
KEV=${KEV:-../overcooked-kev/kev}; export KEV
CPY=${CPY:-../overcooked-kev/client/.venv/bin/python}
PROCS=${PROCS:-6}   # teacher collection alongside training: 6 bot/server pairs (~2.2 GB each) fit a 24 GB VM
say() { echo "[$(date '+%F %T')] $*"; }
serve() { ( cd "$KEV" && KEV_DTYPE=bf16 setsid .venv/bin/python -m kev.serve --run "runs/$1" --port 8009 > ".serve-$1-night.log" 2>&1 < /dev/null & )
  for i in $(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && { node scripts/warm_kev.mjs | tail -1; return 0; }; sleep 2; done
  say "kev.serve $1 did not come up"; exit 1; }
driven() {   # reliability on the states a run drove itself: reports/<run>/driven
  local run=$1
  [ -s "data/drive_${run}_kev.jsonl" ] || return 0
  ( cd "$KEV" && KEV_BENCH_MAX_STATE=512 KEV_DTYPE=bf16 .venv/bin/python "$(realpath scripts/bench_ctx.py)" --run "runs/$run" --data "$(realpath "data/drive_${run}_kev.jsonl")" --out "runs/$run-drive" > /dev/null 2>&1 )
  $CPY scripts/reliability.py "$KEV/runs/$run-drive/rows.json" --censoring "data/drive_${run}_kev.report.json" --out "reports/$run/driven" --title "$run driven" 2>&1 | tail -12
}
[ -f data/mc1_pipeline.done ] || { say "data/mc1_pipeline.done missing"; exit 1; }
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
mkdir -p reports/mc-v2 reports/mc-v3

# ---- A. DAgger ----------------------------------------------------------------------------------------------------
if [ ! -s data/mc1_dagger.jsonl ]; then
  say "A. serve mc-v1; kev drives 24 DAgger seeds (2000-2023)"
  serve mc-v1
  node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds 24 --seed0 2000 --procs 5 --minutes 22 --eps-action 0.05 --thin 8 \
    --out data/mc1_dagger.jsonl --prefix dagger --port0 25640
  say "dagger runs done (exit $?)"; pkill -f "[k]ev.serve --run runs/mc-v1"; sleep 3
fi
python3 scripts/base_rates.py data/mc1_dagger.jsonl | tee reports/mc-v2/base_rates_dagger.txt

# ---- B. recollection (background, CPU) + mc-v2 (GPU) --------------------------------------------------------------
if [ ! -f data/mc3_collect.done ]; then
  say "B. teacher recollection in the background: 40 train seeds + 20 holdout seeds, 22 min, $PROCS at a time"
  ( node agent/gen_data.mjs --seeds 40 --seed0 0 --procs "$PROCS" --minutes 22 --eps-action 0.1 --thin 8 --out data/mc3_teacher.jsonl --prefix gen3 --port0 25600 --video --video-seeds 2
    echo "[$(date '+%F %T')] recollection: train seeds done (exit $?)"
    node agent/gen_data.mjs --seeds 20 --seed0 1000 --procs "$PROCS" --minutes 22 --eps-action 0.1 --thin 8 --out data/mc3_holdout.jsonl --prefix hold3 --port0 25600
    echo "[$(date '+%F %T')] recollection: holdout seeds done (exit $?)"
    touch data/mc3_collect.done ) > data/mc3_collect.log 2>&1 &
fi
if [ ! -f "$KEV/runs/mc-v2/head.pt" ]; then
  cat data/mc1.jsonl data/mc1_dagger.jsonl > data/mc2.jsonl
  say "split mc2"; scripts/split.sh data/mc2.jsonl data/mc1_holdout.jsonl data/mc2_ep 2>&1 | tail -6
  say "train mc-v2 from mc-v1"; scripts/train_mc1.sh mc-v2 data/mc2_ep/train.jsonl runs/mc-v1; say "train exit $?"
  [ -f "$KEV/runs/mc-v2/head.pt" ] || { say "no mc-v2 checkpoint, stopping"; exit 1; }
  cp "$KEV/runs/mc-v2.log" reports/mc-v2/train.log 2>/dev/null
  say "eval mc-v2"; scripts/eval_mc1.sh mc-v2 data/mc2_ep jaredpalmer/kev-0.8b 2>&1 | tail -8
  cp "$KEV/runs/mc-v2-dev/report.json" reports/mc-v2/dev-report.json 2>/dev/null
  $CPY scripts/reliability.py "$KEV/runs/mc-v2-dev/rows.json" --censoring data/mc1_holdout.report.json --out reports/mc-v2 --title mc-v2 2>&1 | tail -12
fi
say "waiting for the recollection"; until [ -f data/mc3_collect.done ]; do sleep 60; done; tail -4 data/mc3_collect.log

# ---- C. mc-v2 drives ----------------------------------------------------------------------------------------------
say "C. drive eval mc-v2 (kev and teacher, seeds 1000-1019)"; scripts/drive_eval.sh mc-v2 20 1000 22; say "drive exit $?"
driven mc-v2

# ---- D. mc-v3 with survive_until_morning --------------------------------------------------------------------------
cat data/mc3_teacher.jsonl data/mc1_dagger.jsonl > data/mc3.jsonl
python3 scripts/base_rates.py data/mc3.jsonl | tee reports/mc-v3/base_rates.txt
python3 scripts/base_rates.py data/mc3_holdout.jsonl | tee reports/mc-v3/base_rates_holdout.txt
say "D. split mc3"; scripts/split.sh data/mc3.jsonl data/mc3_holdout.jsonl data/mc3_ep 2>&1 | tail -6
say "train mc-v3 from mc-v2"; scripts/train_mc1.sh mc-v3 data/mc3_ep/train.jsonl runs/mc-v2; say "train exit $?"
[ -f "$KEV/runs/mc-v3/head.pt" ] || { say "no mc-v3 checkpoint, stopping"; exit 1; }
cp "$KEV/runs/mc-v3.log" reports/mc-v3/train.log 2>/dev/null
say "eval mc-v3"; scripts/eval_mc1.sh mc-v3 data/mc3_ep jaredpalmer/kev-0.8b 2>&1 | tail -8
cp "$KEV/runs/mc-v3-dev/report.json" reports/mc-v3/dev-report.json 2>/dev/null
cp "$KEV/runs/mc-v3-base-dev/report.json" reports/mc-v3/dev-report-baseline-0.8b.json 2>/dev/null
$CPY scripts/reliability.py "$KEV/runs/mc-v3-dev/rows.json" --censoring data/mc3_holdout.report.json --out reports/mc-v3 --title mc-v3 2>&1 | tail -12
say "drive eval mc-v3 (teacher runs reused from mc-v2's)"; SKIP_TEACHER=1 scripts/drive_eval.sh mc-v3 20 1000 22; say "drive exit $?"
driven mc-v3
touch data/night_mc3.done; say "night pipeline done"
