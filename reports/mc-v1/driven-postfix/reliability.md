| question | type | n | accuracy | base rate | mean conf | ECE | AUROC | Brier | resolution / uncertainty | censoring |
|---|---|---|---|---|---|---|---|---|---|---|
| damage_next_20s | score | 5103 | 0.906 | 0.899 | 0.840 | 0.066 | 0.894 | 0.066 | 0.024 / 0.085 | 1% |
| iron_found_3min | noul | 300 | 0.670 | 0.470 | 0.690 | 0.220 | 0.830 | 0.225 | 0.079 / 0.249 | 10% |
| next_subtask | choice | 2789 | 0.810 | 0.540 | 0.838 | 0.040 | 0.913 | 0.092 | 0.067 / 0.154 | - |
| subgoal_succeeds_60s | noul | 3800 | 0.543 | 0.264 | 0.582 | 0.330 | 0.678 | 0.329 | 0.020 / 0.194 | 6% |
| survive_until_morning | noul | 2469 | 0.578 | 0.626 | 0.597 | 0.281 | 0.506 | 0.299 | 0.036 / 0.234 | 0% |
| threat_response | choice | 479 | 0.570 | 0.468 | 0.567 | 0.075 | 0.723 | 0.208 | 0.041 / 0.245 | - |

AUROC: noul questions rank p(true) against the outcome; choice/score questions rank confidence (max p) against correctness. 0.5 = no discrimination. Resolution is the Brier decomposition term (binned); a forecast stuck at the base rate scores 0, and it is bounded by the uncertainty term base*(1-base).
