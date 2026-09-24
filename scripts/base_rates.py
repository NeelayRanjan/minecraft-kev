#!/usr/bin/env python3
"""Label distribution per question in a kev JSONL file, with subgoal_succeeds_60s broken down by tech step.

    python3 scripts/base_rates.py data/mc1.jsonl [more.jsonl ...]

Lesson 2/3 from the parent project: every noul should sit roughly between 20% and 80% true, and a rare label teaches
nothing. Read this before training; change a horizon in agent/questions.js and regenerate if a question is out of band.
"""
import json, re, sys
from collections import Counter, defaultdict

STEP_RE = re.compile(r"step (\d) of 7")


def main(paths):
    labels = defaultdict(Counter)
    by_step = defaultdict(Counter)
    iron_by_step = defaultdict(Counter)
    n = 0
    lengths = []
    for p in paths:
        for line in open(p):
            if not line.strip():
                continue
            r = json.loads(line)
            n += 1
            lengths.append(len(r["state"]))
            m = STEP_RE.search(r["state"])
            step = int(m.group(1)) if m else 8
            for qid, q in r["questions"].items():
                labels[qid][str(q["label"])] += 1
                if qid == "subgoal_succeeds_60s":
                    by_step[step][str(q["label"])] += 1
                if qid == "iron_found_3min":
                    iron_by_step[step][str(q["label"])] += 1
    print(f"{n} records; state chars mean {sum(lengths) / max(1, len(lengths)):.0f} max {max(lengths) if lengths else 0}")
    for qid, c in sorted(labels.items()):
        tot = sum(c.values())
        flag = ""
        if qid in ("subgoal_succeeds_60s", "iron_found_3min", "survive_until_morning"):
            p_true = c.get("True", 0) / tot
            flag = "  <-- out of the 20-80% band" if not (0.2 <= p_true <= 0.8) else ""
        print(f"  {qid}: n={tot} " + ", ".join(f"{k}={v} ({100 * v / tot:.0f}%)" for k, v in c.most_common()) + flag)
    print("  subgoal_succeeds_60s by step:")
    for step in sorted(by_step):
        c = by_step[step]; tot = sum(c.values())
        print(f"    step {step}: n={tot} true={c.get('True', 0)} ({100 * c.get('True', 0) / tot:.0f}%)")


if __name__ == "__main__":
    main(sys.argv[1:] or ["data/mc1.jsonl"])
