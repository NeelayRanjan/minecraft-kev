"""kev.benchmark with a longer state context (copied from the parent project's aircombat/bench_ctx.py).
kev.benchmark --data scores external records in the default training context (384 state tokens) and silently skips
longer ones; this wrapper sets the context to training_context(KEV_BENCH_MAX_STATE) and runs kev.benchmark unchanged.
Run from the kev clone with its venv:

  KEV_BENCH_MAX_STATE=512 .venv/bin/python /path/to/minecraft-kev/scripts/bench_ctx.py --run runs/mc-v1 --data <jsonl> --out runs/<name>
"""
import os, sys
import kev.benchmark as b
from kev.model import training_context

b.CONTEXT = {**training_context(int(os.environ.get("KEV_BENCH_MAX_STATE", "512"))), "truncate": False}
sys.argv = ["kev.benchmark"] + sys.argv[1:]
b.main()
