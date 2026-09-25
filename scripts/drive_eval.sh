#!/usr/bin/env bash
# Definition-of-done item 1: kev drives 20 unseen seeds (1000-1019) and the teacher (no noise) drives the same seeds.
# Serves $KEV/runs/<run> on port 8009, runs both policies through gen_data.mjs (5 servers), records kev's runs as video.
# Usage: scripts/drive_eval.sh <run> [seeds=20] [seed0=1000] [minutes=20]
set -u
cd "$(dirname "$0")/.."
run=${1:?run}; seeds=${2:-20}; seed0=${3:-1000}; minutes=${4:-22}
KEV=${KEV:-../overcooked-kev/kev}
mkdir -p "reports/$run"
say() { echo "[$(date '+%F %T')] drive_eval $run: $*"; }
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; sleep 2   # orphans from an earlier batch would hold ports and RAM
( cd "$KEV" && KEV_DTYPE=bf16 setsid .venv/bin/python -m kev.serve --run "runs/$run" --port 8009 > ".serve-$run.log" 2>&1 < /dev/null & )
for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve did not come up"; exit 1; }
node scripts/warm_kev.mjs | tail -1   # the first requests compile the fla kernels, past the runner's 10 s timeout
say "kev.serve up; kev drives $seeds seeds from $seed0"
node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/drive_${run}_kev.jsonl" --prefix "drive_${run}_kev" --port0 25620 --video --video-seeds 3
say "kev runs done (exit $?)"
pkill -f "[k]ev.serve --run runs/$run" ; sleep 3
if [ -n "${SKIP_TEACHER:-}" ]; then say "SKIP_TEACHER: reusing the teacher runs out/drive_teacher_s*.json"; else
say "teacher drives the same seeds (no noise)"
node agent/gen_data.mjs --policy teacher --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/drive_teacher.jsonl" --prefix "drive_teacher" --port0 25620
say "teacher runs done (exit $?)"
fi
python3 scripts/drive_summary.py "$run" "$seeds" "$seed0" | tee "reports/$run/drive.txt"
