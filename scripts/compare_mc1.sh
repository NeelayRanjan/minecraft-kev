#!/usr/bin/env bash
# Three drivers on the same unseen seeds (1000-1019): the LLM leader (local Ollama) with kev forecasting, kev alone,
# and the scripted teacher. Serves $KEV/runs/<run> on 8009 for the first two. Records the first 3 seeds of each.
# Usage: scripts/compare_mc1.sh <run=mc-v1> [seeds=20] [seed0=1000] [minutes=22] [llm_model=qwen3:4b]
# Log: data/compare_<run>.log. Launch detached with setsid nohup systemd-inhibit ... as the other scripts.
set -u
cd "$(dirname "$0")/.."
run=${1:-mc-v1}; seeds=${2:-20}; seed0=${3:-1000}; minutes=${4:-22}; model=${5:-qwen3:4b}
KEV=${KEV:-../overcooked-kev/kev}
mkdir -p "reports/$run"
say() { echo "[$(date '+%F %T')] compare $run: $*"; }
pkill -f '[p]aper-1.20.4-499.jar' 2>/dev/null; sleep 2
curl -s -m 5 http://127.0.0.1:11434/api/tags > /dev/null || { say "ollama is not reachable on 11434"; exit 1; }
# GPU order matters on 8 GB: unload the LLM, let kev.serve take its ~2.2 GB first, then warm the LLM into what is left.
ollama stop "$model" 2>/dev/null; sleep 2
( cd "$KEV" && KEV_DTYPE=bf16 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True setsid .venv/bin/python -m kev.serve --run "runs/$run" --port 8009 > ".serve-$run-compare.log" 2>&1 < /dev/null & )
for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:8009/v1/models && break; sleep 2; done
curl -s -o /dev/null http://127.0.0.1:8009/v1/models || { say "kev.serve did not come up"; exit 1; }
curl -s -m 180 http://127.0.0.1:11434/api/generate -d "{\"model\":\"$model\",\"prompt\":\"ok\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":2048,\"num_predict\":4},\"keep_alive\":\"30m\"}" > /dev/null
say "GPU after loading both: $(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader); $(ollama ps | tail -1)"
say "LLM leader ($model) + kev forecasts"
node agent/gen_data.mjs --policy llm --llm-url http://127.0.0.1:11434 --llm-model "$model" --kev-url http://127.0.0.1:8009 --seeds "$seeds" --seed0 "$seed0" --procs 5 --minutes "$minutes" --thin 8 \
  --out "data/compare_${run}_llm.jsonl" --prefix "cmp_llm" --port0 25620 --video --video-seeds 3
say "llm runs done (exit $?)"
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
say "done"
