| question | type | n | accuracy | base rate | mean conf | ECE | AUROC | Brier | resolution / uncertainty | censoring |
|---|---|---|---|---|---|---|---|---|---|---|
| damage_next_20s | score | 14223 | 0.987 | 0.984 | 0.857 | 0.130 | 0.901 | 0.034 | 0.002 / 0.013 | 2% |
| iron_found_3min | noul | 73 | 1.000 | 0.973 | 0.889 | 0.108 | 1.000 | 0.021 | 0.027 / 0.027 | 0% |
| next_subtask | choice | 13216 | 0.794 | 0.466 | 0.899 | 0.151 | 0.979 | 0.115 | 0.120 / 0.164 | - |
| subgoal_succeeds_60s | noul | 13401 | 0.652 | 0.047 | 0.450 | 0.404 | 0.897 | 0.227 | 0.018 / 0.045 | 4% |
| survive_until_morning | noul | 7287 | 0.769 | 0.880 | 0.681 | 0.199 | 0.545 | 0.171 | 0.007 / 0.105 | 0% |
| threat_response | choice | 1320 | 0.790 | 0.416 | 0.672 | 0.179 | 0.938 | 0.120 | 0.085 / 0.166 | - |

AUROC: noul questions rank p(true) against the outcome; choice/score questions rank confidence (max p) against correctness. 0.5 = no discrimination. Resolution is the Brier decomposition term (binned); a forecast stuck at the base rate scores 0, and it is bounded by the uncertainty term base*(1-base).
