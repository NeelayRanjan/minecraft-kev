#!/usr/bin/env python3
"""Reliability diagrams per question from a kev.benchmark rows.json, with accuracy, base rate, ECE, n and the
censoring rate (from gen_data's report) beside each. Definition-of-done item 3.

    ../overcooked-kev/client/.venv/bin/python scripts/reliability.py ../overcooked-kev/kev/runs/mc-v1-dev/rows.json \
        --censoring data/mc1_holdout.report.json --out reports/mc-v1
"""
import argparse, json, os
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

BINS = 10


def ece_of(confs, hits):
    n = len(confs)
    if not n:
        return 0.0
    tot = 0.0
    for b in range(BINS):
        lo, hi = b / BINS, (b + 1) / BINS
        idx = [i for i, c in enumerate(confs) if (lo <= c < hi) or (b == BINS - 1 and c == 1.0)]
        if not idx:
            continue
        acc = sum(hits[i] for i in idx) / len(idx)
        conf = sum(confs[i] for i in idx) / len(idx)
        tot += len(idx) / n * abs(acc - conf)
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows")
    ap.add_argument("--censoring", default=None, help="gen_data report json with a 'censoring' field")
    ap.add_argument("--out", default="reports/run")
    ap.add_argument("--title", default="")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rows = json.load(open(a.rows))
    cens = {}
    if a.censoring and os.path.exists(a.censoring):
        cens = json.load(open(a.censoring)).get("censoring", {})
    byq = defaultdict(list)
    for r in rows:
        if r.get("variant", "clean") != "clean":
            continue
        byq[r["question"]].append(r)
    table = []
    for q, rs in sorted(byq.items()):
        t = rs[0]["type"]
        if t == "noul":
            keys = rs[0]["keys"]
            ti = keys.index("true") if "true" in keys else (keys.index("yes") if "yes" in keys else 1)
            probs = [r["p"][ti] for r in rs]                        # p(true)
            truths = [1 if r["label"] == ti else 0 for r in rs]
            confs, hits = probs, truths                             # reliability of p(true) against the true rate
            acc = sum(1 for p, y in zip(probs, truths) if (p >= 0.5) == bool(y)) / len(rs)
            base = sum(truths) / len(rs)
            xlabel, ylabel = "forecast p(true)", "observed rate of true"
        else:
            confs = [max(r["p"]) for r in rs]
            hits = [1 if r["p"].index(max(r["p"])) == r["label"] else 0 for r in rs]
            acc = sum(hits) / len(rs)
            counts = defaultdict(int)
            for r in rs: counts[r["label"]] += 1
            base = max(counts.values()) / len(rs)                   # majority-class rate
            xlabel, ylabel = "confidence (max p)", "accuracy"
        e = ece_of(confs, hits)
        c = cens.get(q)
        crate = (c["censored"] / max(1, c["asked"])) if c else None
        table.append((q, t, len(rs), acc, base, e, crate, sum(confs) / len(confs)))
        # diagram
        xs, ys, ns = [], [], []
        for b in range(BINS):
            lo, hi = b / BINS, (b + 1) / BINS
            idx = [i for i, cf in enumerate(confs) if (lo <= cf < hi) or (b == BINS - 1 and cf == 1.0)]
            if not idx: continue
            xs.append(sum(confs[i] for i in idx) / len(idx)); ys.append(sum(hits[i] for i in idx) / len(idx)); ns.append(len(idx))
        fig, ax = plt.subplots(figsize=(4.2, 4.2))
        ax.plot([0, 1], [0, 1], "--", color="#999", lw=1)
        ax.scatter(xs, ys, s=[20 + 200 * n / len(rs) for n in ns], color="#2a6f97", zorder=3)
        ax.plot(xs, ys, color="#2a6f97", lw=1)
        for x, y, n in zip(xs, ys, ns): ax.annotate(str(n), (x, y), textcoords="offset points", xytext=(4, 4), fontsize=7, color="#555")
        ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
        sub = f"n={len(rs)}  acc={acc:.2f}  base={base:.2f}  ECE={e:.3f}" + (f"  censored={crate:.0%}" if crate is not None else "")
        ax.set_title(f"{a.title + ' ' if a.title else ''}{q}\n{sub}", fontsize=9)
        fig.tight_layout(); fig.savefig(os.path.join(a.out, f"reliability_{q}.png"), dpi=140); plt.close(fig)
    lines = ["| question | type | n | accuracy | base rate | mean conf | ECE | censoring |", "|---|---|---|---|---|---|---|---|"]
    for q, t, n, acc, base, e, crate, mc in table:
        lines.append(f"| {q} | {t} | {n} | {acc:.3f} | {base:.3f} | {mc:.3f} | {e:.3f} | {'-' if crate is None else f'{crate:.0%}'} |")
    md = "\n".join(lines)
    open(os.path.join(a.out, "reliability.md"), "w").write(md + "\n")
    json.dump([dict(zip(["question", "type", "n", "accuracy", "base_rate", "ece", "censoring", "mean_conf"], (q, t, n, acc, base, e, crate, mc))) for q, t, n, acc, base, e, crate, mc in table],
              open(os.path.join(a.out, "reliability.json"), "w"), indent=1)
    print(md)


if __name__ == "__main__":
    main()
