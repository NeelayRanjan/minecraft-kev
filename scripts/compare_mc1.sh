#!/usr/bin/env bash
# Three drivers on the same unseen seeds (1000-1019): the LLM leader (local Ollama), kev alone, and the scripted
# teacher. On the 8 GB GPU the 4B planner and kev.serve do not both fit at speed (kev.serve grows to ~3.7 GB under
# five bots and the planner then runs mostly on CPU at ~30 s a call), so the planner batch runs without kev.serve and
# kev's forecasts on those states are scored offline afterwards. Records the first 3 seeds of each driver.
# Usage: scripts/compare_mc1.sh <run=mc-v1> [seeds=20] [seed0=1000] [minutes=22] [llm_model=qwen3:4b]
# Log: data/compare_<run>.log. Launch detached with setsid nohup systemd-inhibit ... as the other scripts.
set -u
cd "$(dirname "$0")/.."
run=${1:-mc-v1}; seeds=${2:-20}; seed0=${3:-1000}; minutes=${4:-22}; model=${5:-qwen3:4b}
KEV=${KEV:-../overcooked-kev/kev}; CPY=${CPY:-../overcooked-kev/client/.venv/bin/python}
mkdir -p "reports/$run"
say() { echo "[$(date '+%F %T')] compare $run: $*"; }
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; pkill -f '[k]ev.serve' 2>/dev/null; sleep 2
curl -s -m 5 http://127.0.0.1:11434/api/tags > /dev/null || { say "ollama is not reachable on 11434"; exit 1; }
ollama stop "$model" 2>/dev/null; sleep 3   # a model loaded while the GPU was crowded keeps its CPU split; reload it with the GPU free
curl -s -m 300 http://127.0.0.1:11434/api/generate -d "{\"model\":\"$model\",\"prompt\":\"ok\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":2048,\"num_predict\":4},\"keep_alive\":\"60m\"}" > /dev/null
say "LLM leader ($model): $(ollama ps | tail -1 | tr -s ' ')"
node agent/gen_data.mjs --policy llm --llm-url http://127.0.0.1:11434 --llm-model "$model" --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/compare_${run}_llm.jsonl" --prefix "cmp_llm" --port0 25620 --video --video-seeds 3
say "llm runs done (exit $?)"
ollama stop "$model" 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run "runs/$run" --port 8009 > ".serve-$run-compare.log" 2>&1 < /dev/null & )
for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve did not come up"; exit 1; }
say "kev alone"
node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/compare_${run}_kev.jsonl" --prefix "cmp_kev" --port0 25620 --video --video-seeds 3
say "kev runs done (exit $?)"
pkill -f "[k]ev.serve --run runs/$run"; sleep 3
say "teacher"
node agent/gen_data.mjs --policy teacher --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/compare_teacher.jsonl" --prefix "cmp_teacher" --port0 25620 --video --video-seeds 3
say "teacher runs done (exit $?)"
python3 scripts/drive_summary.py --prefixes cmp_llm,cmp_kev,cmp_teacher --seeds "$seeds" --seed0 "$seed0" | tee "reports/$run/compare.txt"
say "kev forecasts scored on the LLM-led states (offline)"
BENCH=$(realpath scripts/bench_ctx.py); DATA=$(realpath "data/compare_${run}_llm.jsonl")
( cd "$KEV" && KEV_BENCH_MAX_STATE=512 KEV_DTYPE=bf16 .venv/bin/python "$BENCH" --run "runs/$run" --data "$DATA" --out "runs/$run-llmled" > /dev/null 2>&1 )
$CPY scripts/reliability.py "$KEV/runs/$run-llmled/rows.json" --censoring "data/compare_${run}_llm.report.json" --out "reports/$run/llm-led" --title "$run on LLM-led runs" 2>&1 | tail -10
say "done"
