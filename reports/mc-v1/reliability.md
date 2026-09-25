| question | type | n | accuracy | base rate | mean conf | ECE | AUROC | Brier | resolution / uncertainty | censoring |
|---|---|---|---|---|---|---|---|---|---|---|
| damage_next_20s | score | 1668 | 0.891 | 0.879 | 0.855 | 0.048 | 0.887 | 0.070 | 0.028 / 0.097 | 1% |
| iron_found_3min | noul | 76 | 0.921 | 1.000 | 0.784 | 0.216 | - | 0.077 | 0.000 / 0.000 | 8% |
| next_subtask | choice | 1002 | 0.945 | 0.417 | 0.864 | 0.082 | 0.950 | 0.050 | 0.016 / 0.052 | - |
| subgoal_succeeds_60s | noul | 1220 | 0.564 | 0.370 | 0.625 | 0.276 | 0.628 | 0.327 | 0.048 / 0.233 | 4% |
| threat_response | choice | 134 | 0.769 | 0.463 | 0.599 | 0.169 | 0.796 | 0.176 | 0.032 / 0.178 | - |

AUROC: noul questions rank p(true) against the outcome; choice/score questions rank confidence (max p) against correctness. 0.5 = no discrimination. Resolution is the Brier decomposition term (binned); a forecast stuck at the base rate scores 0, and it is bounded by the uncertainty term base*(1-base).
