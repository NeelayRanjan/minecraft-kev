#!/usr/bin/env python3
"""Driving results: kev vs teacher on the same seeds. Usage: scripts/drive_summary.py <run> [seeds=20] [seed0=1000]
Reads out/drive_<run>_kev_s<seed>.json and out/drive_teacher_s<seed>.json (written by run_episode.mjs)."""
import json, os, sys
from statistics import median

run = sys.argv[1] if len(sys.argv) > 1 else "mc-v1"
seeds = int(sys.argv[2]) if len(sys.argv) > 2 else 20
seed0 = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
SUCCESS_S = 15 * 60


def load(prefix):
    rows = []
    for s in range(seed0, seed0 + seeds):
        p = f"out/{prefix}_s{s}.json"
        if not os.path.exists(p):
            rows.append({"seed": s, "missing": True}); continue
        m = json.load(open(p))["meta"]
        rows.append({"seed": s, "goal_t": m.get("goal_done_t"), "deaths": m.get("deaths", 0), "end": m.get("end_reason"), "t": m.get("ended_t")})
    return rows


def summarize(name, rows):
    ok = [r for r in rows if not r.get("missing")]
    succ = [r for r in ok if r["goal_t"] is not None and r["goal_t"] <= SUCCESS_S]
    any_goal = [r for r in ok if r["goal_t"] is not None]
    times = [r["goal_t"] for r in succ]
    print(f"{name:8s} episodes {len(ok)}/{len(rows)}  iron pickaxe within 15 min: {len(succ)}/{len(ok)} ({100 * len(succ) / max(1, len(ok)):.0f}%)"
          f"  ever: {len(any_goal)}/{len(ok)}  median time {median(times) / 60:.1f} min" if times else
          f"{name:8s} episodes {len(ok)}/{len(rows)}  iron pickaxe within 15 min: 0/{len(ok)}  ever: {len(any_goal)}/{len(ok)}")
    print(f"         deaths total {sum(r['deaths'] for r in ok)}; per seed: " + " ".join(
        f"{r['seed']}:{'-' if r.get('missing') else ('%.0fs' % r['goal_t'] if r['goal_t'] is not None else 'no')}" for r in rows))


kev, teacher = load(f"drive_{run}_kev"), load("drive_teacher")
print(f"Driving evaluation, run {run}, seeds {seed0}-{seed0 + seeds - 1} (unseen), success = iron pickaxe within {SUCCESS_S // 60} in-game minutes")
summarize("kev", kev)
summarize("teacher", teacher)
