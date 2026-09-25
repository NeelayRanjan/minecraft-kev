# Leader bench

Logged decision points from kev-driven DAgger episodes (out/dagger_s*.json) replayed through each candidate with the live prompt (agent/planner.js), think off. Scored before the goal only. Half the sample follows a failed subtask. Teacher agreement is a sanity filter, not the objective.

| model | n pre-goal | valid | agrees with teacher | with kev | threat decisions agree | re-picks a just-failed subtask | answers changed without forecasts | latency p50 | tok/s | VRAM in use (with kev + 5 bots) | kev p50 / p90 while it runs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen38-27b-iq2s | 91 | 0.99 | 0.49 | 0.50 | 0.53 (n 40) | 0.20 (teacher 0.50, kev 0.65) | 0.17 (n 36) | 3001 ms | 29 | 13381 MiB, 16376 MiB | 167 / 191 ms |
| qwen3:8b | 91 | 1.00 | 0.37 | 0.41 | 0.28 (n 36) | 0.31 (teacher 0.49, kev 0.66) | 0.18 (n 38) | 878 ms | 55 | 10250 MiB, 16376 MiB | 155 / 183 ms |
