#!/usr/bin/env bash
# Next step 2b: does kev's headline forecast carry information a planner can act on? Three arms of the same kev driver
# on the same unseen seeds: the scripted supervisor off, on (replan when p(step done in 60 s) < 0.25 for 15 s), and on
# but fed shuffled forecasts (a pool of kev's own values from the off arm, so it fires at the same rate but at random
# moments). The real arm must beat both on "iron pickaxe within 15 min" / time to goal, or a leader reading the same
# forecasts cannot gain from them. Serves $KEV/runs/<run> on 8009 and runs each arm through gen_data.mjs (5 servers).
# Usage: scripts/supervisor_eval.sh <run=mc-v1> [seeds=20] [seed0=1000] [minutes=22]      Log: data/supervisor_<run>.log
# Output: out/sup_{off,real,shuf}_s<seed>.json, data/supervisor_pool_<run>.json, reports/<run>/supervisor.txt
set -u
cd "$(dirname "$0")/.."
run=${1:-mc-v1}; seeds=${2:-20}; seed0=${3:-1000}; minutes=${4:-22}
KEV=${KEV:-../overcooked-kev/kev}
mkdir -p "reports/$run"
say() { echo "[$(date '+%F %T')] supervisor $run: $*"; }
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run "runs/$run" --port 8009 > ".serve-$run-supervisor.log" 2>&1 < /dev/null & )
for i in $(seq 1 150); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve did not come up"; exit 1; }
node scripts/warm_kev.mjs | tail -1
arm() {   # arm <prefix> [extra gen_data args]
  local prefix=$1; shift
  node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
    --out "data/${prefix}.jsonl" --prefix "$prefix" --port0 25660 "$@"
  say "$prefix done (exit $?)"
}
say "arm 1/3: supervisor off"
[ -s "out/sup_off_s$((seed0 + seeds - 1)).json" ] && say "off arm exists, skipping" || arm sup_off --supervisor off
pool="data/supervisor_pool_$run.json"
node -e '
import("./agent/supervisor.js").then(({ forecastPool }) => {
  const fs = require("node:fs"); const [seeds, seed0, out] = [Number(process.argv[1]), Number(process.argv[2]), process.argv[3]]
  const logs = []; for (let s = seed0; s < seed0 + seeds; s++) { const p = `out/sup_off_s${s}.json`; if (fs.existsSync(p)) logs.push(JSON.parse(fs.readFileSync(p, "utf8"))) }
  const pool = forecastPool(logs); fs.writeFileSync(out, JSON.stringify(pool.map(v => +v.toFixed(4))))
  const low = pool.filter(v => v < 0.25).length; console.log(`pool: ${pool.length} forecasts from ${logs.length} episodes, ${(100 * low / Math.max(1, pool.length)).toFixed(0)}% below 0.25`)
})' "$seeds" "$seed0" "$pool"
say "arm 2/3: supervisor on, real forecasts"
[ -s "out/sup_real_s$((seed0 + seeds - 1)).json" ] && say "real arm exists, skipping" || arm sup_real --supervisor real
say "arm 3/3: supervisor on, shuffled forecasts"
[ -s "out/sup_shuf_s$((seed0 + seeds - 1)).json" ] && say "shuffled arm exists, skipping" || arm sup_shuf --supervisor shuffled --supervisor-pool "$pool"
pkill -f "[k]ev.serve --run runs/$run"; sleep 2
{ echo "Scripted supervisor on $run (replan when p(step done in 60 s) < 0.25 for 15 s; shuffled arm draws from $pool)"
  python3 scripts/drive_summary.py --prefixes sup_off,sup_real,sup_shuf --seeds "$seeds" --seed0 "$seed0"; } | tee "reports/$run/supervisor.txt"
say "done"
