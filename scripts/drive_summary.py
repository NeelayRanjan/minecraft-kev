#!/usr/bin/env python3
"""Driving results for several drivers on the same seeds, from out/<prefix>_s<seed>.json (written by run_episode.mjs).

    scripts/drive_summary.py <run> [seeds] [seed0]                       # kev (drive_<run>_kev) vs teacher (drive_teacher)
    scripts/drive_summary.py --prefixes cmp_llm,cmp_kev,cmp_teacher --seeds 20 --seed0 1000
"""
import json, os, sys
from collections import Counter
from statistics import median

SUCCESS_S = 15 * 60


def load(prefix, seeds, seed0):
    rows = []
    for s in range(seed0, seed0 + seeds):
        p = f"out/{prefix}_s{s}.json"
        if not os.path.exists(p):
            rows.append({"seed": s, "missing": True}); continue
        j = json.load(open(p)); m = j["meta"]
        res = Counter(e.get("result") for e in j.get("events", []) if e["kind"] == "subtask_done")
        src = Counter(d.get("source") for d in j.get("decisions", []) if d.get("decision"))
        rows.append({"seed": s, "goal_t": m.get("goal_done_t"), "deaths": m.get("deaths", 0), "end": m.get("end_reason"), "t": m.get("ended_t"),
                     "subtasks": sum(res.values()), "ok": res.get("ok", 0), "src": src})
    return rows


def summarize(name, rows):
    ok = [r for r in rows if not r.get("missing")]
    succ = [r for r in ok if r["goal_t"] is not None and r["goal_t"] <= SUCCESS_S]
    ever = [r for r in ok if r["goal_t"] is not None]
    times = [r["goal_t"] for r in succ]
    med = f"{median(times) / 60:.1f} min" if times else "-"
    fail_share = 1 - sum(r["ok"] for r in ok) / max(1, sum(r["subtasks"] for r in ok))
    print(f"{name:12s} episodes {len(ok):2d}/{len(rows)}  pickaxe within 15 min: {len(succ):2d}/{len(ok)} ({100 * len(succ) / max(1, len(ok)):3.0f}%)  ever {len(ever):2d}  median {med:8s}"
          f"  deaths {sum(r['deaths'] for r in ok):3d}  subtasks failing {100 * fail_share:.0f}%")
    print("             per seed: " + " ".join(f"{r['seed']}:{'-' if r.get('missing') else ('%.0fs' % r['goal_t'] if r['goal_t'] is not None else 'no')}" for r in rows))
    srcs = Counter()
    for r in ok: srcs.update(r["src"])
    if len(srcs) > 1 or "llm" in srcs: print(f"             decision sources: {dict(srcs)}")


def main():
    a = sys.argv[1:]
    if "--prefixes" in a:
        prefixes = a[a.index("--prefixes") + 1].split(",")
        seeds = int(a[a.index("--seeds") + 1]) if "--seeds" in a else 20
        seed0 = int(a[a.index("--seed0") + 1]) if "--seed0" in a else 1000
    else:
        run = a[0] if a else "mc-v1"
        seeds = int(a[1]) if len(a) > 1 else 20
        seed0 = int(a[2]) if len(a) > 2 else 1000
        prefixes = [f"drive_{run}_kev", "drive_teacher"]
    print(f"Driving evaluation on seeds {seed0}-{seed0 + seeds - 1} (unseen); success = iron pickaxe within {SUCCESS_S // 60} in-game minutes")
    for p in prefixes:
        summarize(p, load(p, seeds, seed0))


if __name__ == "__main__":
    main()
