# MC_Claude.md

Design of record for **minecraft-kev**: a Minecraft agent where an LLM planner sets typed goals, kev decides and forecasts with calibrated probabilities, and a scripted Mineflayer motor layer acts. Nothing here is built yet. This file is what a new session reads before writing code. When the project gets its own repo, this becomes that repo's CLAUDE.md.

The acceptance criterion carries over unchanged from the Overcooked/air combat project: **every decision comes with a calibrated probability that can be displayed and checked.** Playing well is secondary. If a change makes the agent stronger but the probabilities less legible or less calibrated, it is the wrong change. What is new in Minecraft is that the probabilities are also *used*: the planner replans when kev forecasts failure. That is the thesis this project adds.

## Why this project, and when

In every earlier domain the probabilities were shown and scored, never acted on. Minecraft has goals that take minutes, uncertainty kev can't see past (unexplored terrain, night, mobs), and a natural place for a slow planner. A forecast like "p(subgoal succeeds in 60 s) = 0.2" that triggers an early replan is the first time calibration changes behaviour.

Recommended order (not a blocker): finish the air combat track's reliability diagrams first (air-v2 `missile_will_hit_me` ~56% base rate, dogfight maneuver 0.58 acc / 0.59 conf, Overcooked soup-out). The parent project's definition of done asks for a reliability diagram over ≥200 episodes and none exists yet; having one makes this project's pitch credible.

## Lessons from the earlier domains

Numbers are from `overcooked-kev` (see its CLAUDE.md and `reports/`). Each lesson is a design rule below.

1. **Imitating a deterministic teacher saturates.** Overcooked `oc-v1` reached 1.00 on subtask choice and pot urgency on held-out seeds (ECE 0.001). Useful for driving, useless as a calibration exhibit: the reliability diagram is one point at 1.0. *Rule: choice questions labelled by a script are for driving; calibration claims come from outcome questions.*
2. **Outcome labels with sane base rates are where calibration lives.** air-v2's "will this missile hit me" (56% true) and the dogfight maneuver question (teacher uses lookahead the text does not show; 0.58 acc at 0.59 confidence, ECE 0.02) are the good exhibits. *Rule: pick horizons so every noul sits roughly between 20% and 80%.*
3. **Rare labels teach nothing.** Dogfight/airsim "guns first within 20 s" was 2-4% true; the tuned model's 0.98 equals always-no. *Rule: check base rates before training; thin or reframe.*
4. **ECE without accuracy misleads.** Zero-shot dogfight choice ECE was 0.005 at 37% accuracy (a near-uniform prior). *Rule: always report accuracy, base rate and ECE together.*
5. **Zero-shot kev commits to the first or safest option.** Overcooked cooks waited forever at 0.52; the 2D dogfight circled left for 400 ticks; kev-4b was no better at choosing, only more confident. *Rule: plan to fine-tune from the start; zero-shot is a baseline row, not a milestone.*
6. **Schema dead ends kill episodes.** A cook holding an onion with no pot room had only `wait`; one wrong choice deadlocked 380 ticks. *Rule: every option list includes an escape (abandon, return, wait) and only offers options whose preconditions hold.*
7. **The motor layer needs a livelock breaker and a yield rule.** Overcooked's teacher scored 0 on two layouts until cycles of up to 10 ticks triggered a random step, and a waiting cook blocked the dish dispenser until it learned to step aside. *Rule: motor layer returns typed failures, has timeouts, and breaks cycles.*
8. **Words beat numbers for a 0.8b model.** Zero-shot kev could not turn "37 deg right of nose" into a turn; after the serializer said "blue is behind you, to the left", the fine-tune learned the maneuver question. *Rule: the serializer states relations in words ("reachable", "12 m north-east, below you") and keeps numbers short; Qwen tokenizes digits one per token.*
9. **Training cost is state length × questions.** On hybrid Qwen3.5 each question is its own row that re-reads the whole state. The 3v3 dogfight (~640 tokens, 14 questions) OOM'd on 8 GB and ran ~2 h/epoch with 6 questions per record; air-v2 at 576 tokens needed questions split into groups of 4. Laptop rates: 0.8-2.2 s/record. *Rule: budget tokens × questions per record before designing the schema.*
10. **Consecutive ticks are near-duplicates.** Subsampling every 3rd tick cost nothing measurable in Overcooked; splits must be episode-disjoint (by seed), not by state, or dev leaks.
11. **DAgger is needed once the model drives.** Teacher rollouts never contain the states a bad driver wanders into (the dogfight's mutual circle). *Rule: after the first fine-tune, label the states kev visits and retrain.*
12. **Operational.** kev's `split_data.py` checks labels and splits; `calibrate_checkpoint.py` fits temperature; `kev.benchmark` scores; `kev.compare` crashes on a NaN for these runs (read `report.json` directly); `kev.calibrate --rows` refuses remote rows; `pkill -f` from a shell containing the pattern kills that shell; long jobs run detached with `setsid nohup` and a sleep inhibitor.

## Architecture

```
LLM planner (low cadence, async)          kev 0.8b (event-driven choice + 1-2 Hz forecasts)          Mineflayer motor layer (20 Hz)
  typed subgoal from a declared list  -->   state text (+ image in experiment 2)                -->   pathfinder, collectblock, pvp, auto-eat
  <-- forecast history, events              choice: next subtask   noul/score: forecasts        <--   typed result: ok | no_path | timeout | target_gone | took_damage
```

- **Motor layer (scripted).** Mineflayer plus mineflayer-pathfinder, mineflayer-collectblock, mineflayer-pvp, mineflayer-auto-eat. Executes one subtask at a time, returns a typed result, enforces timeouts, breaks livelocks. Never learned.
- **Decision layer (kev).** Picks the next subtask from a declared, precondition-filtered option list when the motor layer finishes, fails, or hits an interrupt (hostile within 16 m, health drop, subgoal change). Emits forecasts at 1-2 Hz. Never waits on the planner.
- **Planner (LLM).** Sets mid- and long-term goals as typed subgoals. Out of the tick loop.

Decision cadence: not "several times a second" for subtask choice. Subtasks last seconds to minutes; re-picking at 3 Hz invites thrashing. Choice is event-driven with the current subtask in the state; forecasts run at 1-2 Hz. Serving budget on the laptop: ~200 ms per request for 5-6 questions on a ~400-token state, one request at a time.

## Labels

| Source | Use it for | Notes |
|---|---|---|
| Game outcomes | Every forecast (noul, outcome score) | Free and honest. Beware the feedback loop below. |
| Scripted teacher | `next_subtask` and `threat_response` in milestone 1 | The iron-pickaxe tech tree is scriptable (Mineflayer bots already do it). Exact labels, saturates, drives well. |
| LLM teacher, distilled offline | `next_subtask` for goals no script covers (milestone 2+), and DAgger labels | Sample k times per state, use vote fractions as soft labels (kev's `target` field). Measures teacher disagreement and avoids saturation. Log prompts, cache by state hash. |
| Human data (MineRL/VPT) | Deferred; maybe a "what will the human do next" headline later | Keyboard/mouse level, Minecraft 1.16. Converting to subtasks needs inventory/block events (verify which the files record). Ore distribution changed in 1.18, so location knowledge does not transfer. |

**The feedback-loop trap (new in this project).** The planner reacts to kev's forecasts, which changes the outcomes kev is scored on: if kev says 0.2 and the planner abandons the subgoal, "succeeds in 60 s" is never observed. Collect forecast training data with replanning frozen, or label only windows where the plan ran for the full horizon; report the censoring rate beside every forecast metric.

## State serializer (text, experiment 1 and arm A)

Summarised and relational, never a voxel dump. Most static first, most volatile last. Relative, rounded numbers. Facts computable by rule go in the state, not in a question. Budget ~300-400 tokens on the laptop; up to ~800 on the 16 GB machine (candidate additions: an ASCII top-down map of the 9×9 area around the player, more entities, longer memory). One serializer, the same code at data generation and play.

```
Minecraft survival, day 1. Goal from planner: get iron pickaxe (step 5 of 7: find and mine 3 iron ore). Deadline: before dusk.
time: afternoon, dusk in 2 min 40 s. weather clear. biome: forest, hills to the west.
you: health 16/20, food 13/20, standing on grass at y 71, in the open, light 15.
inventory: stone pickaxe (worn 40%), wooden pickaxe, 14 cobblestone, 9 oak planks, 3 coal, 2 bread, crafting table. no iron yet.
holding: stone pickaxe.
base: crafting table and furnace 38 m east, 2 m below you. bed: none.
memory: iron ore seen 3 min ago in a cave mouth 55 m west, 12 m below; path last tried: ok. died: never.
nearby blocks: cave entrance 22 m west (dark inside); coal ore 6 m north, reachable; exposed stone 4 m south.
nearby creatures: cow 12 m north-east (passive); nearest hostile: none within 32 m.
current subtask: explore_toward(cave west), 14 s so far, 60% of the way. last subtask result: mine coal ok.
```

Never emit `<|` or `|>` (kev rewrites them).

## Question schema (first set)

All asked in one request; each asked only when meaningful.

| id | type | options / levels | label | asked when | saturates? |
|---|---|---|---|---|---|
| `next_subtask` | choice | precondition-filtered: gather_wood, mine_stone, mine_coal, mine_iron, craft(item), smelt(item), explore_toward(target), return_to_base, eat, build_shelter, sleep, fight(threat), flee(threat), abandon_subgoal, wait | teacher | on motor-layer finish, failure or interrupt | yes with a scripted teacher; for driving |
| `threat_response` | choice | fight / flee / pillar_up / ignore | teacher | a hostile within 16 m | partly |
| `subgoal_succeeds_60s` | noul | | outcome | 1-2 Hz while a subgoal is active | no: the headline forecast |
| `iron_found_3min` | noul | | outcome | while exploring for iron | no |
| `damage_next_20s` | score | none / minor (<4 hp) / major / death | outcome | 1-2 Hz | no; ordered, use `--ord_w` |
| `survive_until_morning` | noul | | outcome | from dusk | no; few samples per episode |

Tune horizons until each noul sits between ~20% and ~80% true in the teacher data. Report accuracy, base rate, ECE and censoring rate per question.

## Planner-kev interface

- **Planner output:** one typed subgoal from a declared list, generated through a JSON schema or tool call, validated before use. Nothing is parsed from free text; the `why` field is logged, never read by code.
  ```json
  {"subgoal": "craft_item", "item": "iron_pickaxe", "deadline_s": 400, "stay_within_m": 64, "why": "..."}
  ```
  Initial list: craft_item(item), gather(item, count), find(block), return_to_base, build_shelter, sleep_through_night, flee_to_safety.
- **Planner input:** the current state text, the last N forecasts per question, and recent events (subgoal done/failed, damage, death).
- **Planner triggers:** every 3-5 minutes; subgoal done or failed; `subgoal_succeeds_60s` < 0.25 for 15 s; `survive_until_morning` < 0.5 at dusk; `damage_next_20s` major-or-death > 0.4; death.
- **Isolation:** the planner runs asynchronously; kev and the motor layer keep executing the current subgoal until a new one arrives. The subgoal is part of kev's state, so forecasts are conditioned on the current plan, and kev's option list is filtered by it.

## Infrastructure

- **Server:** local Paper or vanilla server, offline mode, pinned to a version Mineflayer and minecraft-data support well (1.20.4 is the likely pick; **verify** against minecraft-data's support list before committing). Many seeds, several bots/servers in parallel on the CPU for data collection. `/tick sprint` (1.20.3+) might speed collection if the pathfinder keeps up; treat as an experiment.
- **Language:** Node for the whole agent process (Mineflayer, plugins, serializer, kev HTTP client, planner client). Python for data splitting, training, evaluation and plots, as in the parent project.
- **kev:** same fine-tune recipe as air-v1/air-v2 (`--init_from jaredpalmer/kev-0.8b`, base Qwen3.5-0.8B-Base with its pinned revision, batch 1, accum 8, gradient checkpointing, lr 2e-5, `--perm_kl 0.5`, replay 1000, bf16, `--max_state` sized to the data). Served with `kev.serve` on port 8009.
- **Logging:** the air combat trajectory contract, adapted: `meta`; `frames` at 2-5 Hz (position, look direction, vitals, inventory deltas, entities); `decisions` (state text, image path in experiment 2, full distribution per question, labels filled post hoc); `events` (subgoal set/done/failed, damage, death, planner calls with prompt hash). The kev-format JSONL for training is written from the same run.
- **Viewer:** prismarine-viewer for the bot's view. Record video during the run (**verify** its headless mode), then a small HTML page that plays the video and drives the probability panels from the log by timestamp, in the style of `viewer/index.html` and `airviewer/`.

## Infrastructure status (smoke test, 2026-09-23)

Everything below was run on the 8 GB laptop and passed unless marked otherwise. Scripts live in `smoke/`.

- **Versions, pinned.** Paper 1.20.4 build 499 (`server/paper-1.20.4-499.jar`, sha256 verified), Temurin JDK 21.0.12.1 unpacked at `tools/jdk-21*` (Java 25 is the system default; the server has only been run on 21). mineflayer 4.39.0 lists 1.20.4 in `testedVersions`; minecraft-data 3.117.0 includes it. Plugins: pathfinder 2.4.5, collectblock 1.6.0, pvp 1.3.2, auto-eat 5.0.3, prismarine-viewer 1.33.0, node-canvas-webgl (github, native build; needed `dnf install libXi-devel mesa-libGL-devel pango-devel libjpeg-turbo-devel giflib-devel`).
- **Server.** `server/run.sh` starts it detached-friendly (offline mode, seed `kev-smoke-1`, survival, normal difficulty, view distance 8, `allow-flight=true`). First start 11 s, restarts 6 s. `server/ops.json` ops `kev_smoke`, `kev_render`, `kev_0..3` by offline UUID so bots can run `/time set` etc. from chat. Stop with `pkill -f '[p]aper-1.20.4-499.jar'` (the bracket keeps pkill from matching its own shell).
- **Motor layer.** `smoke/bot_smoke.mjs`: spawn, `waitForChunksToLoad`, `findBlock` for any `*_log` within 64 m, `collectBlock.collect`. Result: oak log 28.7 m away mined in 14 s wall clock from spawn, inventory 0 -> 1. Pathfinder and collectblock work out of the box on 1.20.4.
- **Headless render.** `smoke/render_smoke.mjs day|midnight [frames] [size]` records first-person frames through prismarine-viewer's `headless()` into `out/render_<mode>.mp4`; `smoke/frame_stats.sh` extracts the last frame and prints mean luma. 30 frames at 448x448: 5.4 fps cold (world-mesh warmup), 8.8 fps warm. Rendering caps vision-arm collection at roughly 5-9 decisions/s per bot, fine for 1-2 Hz forecasts.
- **Night does not render dark.** Mean luma 138 at day vs 139 at midnight; the frames are identical apart from grass. prismarine-viewer has no sky or block lighting. Consequence for experiment 2: arms B and C cannot see night or cave darkness unless we add it ourselves. Options, in order of honesty: (1) post-process darkening from `bot.time.timeOfDay` and the block light at the camera (a curve, applied identically at data generation and play); (2) skip `survive_until_morning` from the pixel arms and say so. The HUD overlay for arm C is also ours to draw, as expected.
- **Not yet tested.** `/tick sprint`, several bots on one server, mineflayer-pvp and auto-eat, kev-format logging. `bot.health` is undefined at the `spawn` event and fills in a tick later; read vitals after `waitForChunksToLoad`.

## Status (2026-09-23 evening): experiment 1 built, data collection and training running overnight

Everything in the "Experiment 1" section below is implemented (plan: `docs/superpowers/plans/2026-09-23-experiment-1.md`). Layout:

```
agent/   subtasks.js (option list + preconditions)  teacher.js (tech-tree teacher, threat teacher)  serialize.js (state text)
         questions.js (schema + post-hoc labelers)   summary.js (bot -> obs, memory)   motor.js (Mineflayer executors)
         policy.js (choose/interrupt)  logger.js (log + kev records)  kev_client.js  recorder.js (5 fps video)
         server_ctl.js (Paper per port/seed)  run_episode.mjs (one episode)  gen_data.mjs (parallel episodes)
tests/   node --test tests/*.test.mjs (51 unit tests); tests/integration/motor_check.mjs and mem_probe.mjs need no GPU, start their own server
scripts/ collect_mc1.sh -> overnight_mc1.sh (split, train mc-v1, eval, drive 20 unseen seeds kev vs teacher, reliability) -> dagger_mc1.sh (mc-v2)
viewer/  python3 viewer/serve.py 8085 ; http://127.0.0.1:8085/?run=<name> plays out/<name>.mp4 with the probability bars from out/<name>.json
```

- **Motor layer findings (all fixed in `agent/motor.js`, keep them):** mineflayer-collectblock + mineflayer-tool recurse forever (4 GB heap in a minute) when asked to collect a block the held item cannot harvest; pathfinder `searchRadius` must be bounded (64) or A* with digging allocates without limit on a buried goal; never call `bot.pathfinder.stop()` when no path exists (the flag survives and kills the next goto); collectblock replaces the pathfinder Movements on every call and its `cancelTask` sets that flag; Paper answers every window click with a full inventory resync and mineflayer shares one state id across windows, so 3x3 crafts failed ~60% until clicks were serialised behind the server's reply (`clickWindow` wrapper); `bot.craft` also needs an inventory-settle wait before reading counts.
- **First episode (seed 1, teacher, 3 min):** iron pickaxe at 164 s; 178 decisions logged at 1 Hz, 166 records; states ~265 tokens median (337 max) so `--max_state 512` is safe. Video recorded with `agent/recorder.js` (5 fps default, --fps) (the stock `headless()` loop renders as fast as it can).
- **Data collection (running, `data/gen.log`):** 40 training seeds (0-39) + 12 holdout seeds (1000-1011), 20 in-game minutes, eps 0.1, thin 8, 5 servers in parallel (server tick lag of several seconds under load; the bots' physics tolerate it). Marker `data/mc1.done`, then `scripts/overnight_mc1.sh` (log `data/pipeline_mc1.log`) trains `mc-v1`, evaluates, drives seeds 1000-1019 with kev (video on) and the teacher, and writes `reports/mc-v1/` (reliability diagrams with accuracy, base rate, ECE and censoring). Smoke base rates on 2 short seeds: `subgoal_succeeds_60s` 51% true overall (step 1 19%, steps 3-5 80-100%).
- **Next morning:** read `reports/mc-v1/reliability.md`, `reports/mc-v1/drive.txt`, then launch `scripts/dagger_mc1.sh` for the DAgger round (`mc-v2`), and pick a kev-driven run for the clip (`out/drive_mc-v1_kev_s*.mp4`).

### Results (2026-09-24)

**mc-v1** (kev-0.8b fine-tuned on 7,948 records from 40 teacher-driven seeds; `reports/mc-v1/`): held-out dev (12 unseen seeds) overall acc 0.80 / ECE 0.09 vs baseline 0.68 / 0.21. Per question: `next_subtask` 0.95 (majority 0.42); `damage_next_20s` 0.89 vs 0.88 none-rate (rare-label problem, as predicted); `subgoal_succeeds_60s` 0.56, ECE 0.28 with one overconfident bin (states where the bot was stuck in a livelock: text says the ingredients are present, so it forecasts success). `survive_until_morning` was dropped from this round: 20-minute episodes never reach sunrise, so survivors were all censored.

**The first drive evaluation (night of 09-23) found the motor bug that dominated everything:** three instantly-failing subtasks repeated ~1,000 times per episode (smelt with no furnace in a 1-wide tunnel, craft at a table remembered at 8 m but searched within 8 blocks, gather wood with no path). Teacher 7/20, kev 2/20 on seeds 1000-1019. Fixed in `agent/subtasks.js` (livelock breaker: an option that failed the same way 3 times in a row is withheld, and the count is in the state text; gathering caps) and `agent/motor.js` (make-room placement, walk to a remembered station within 32 m).

**Three drivers on the same 20 unseen seeds (1000-1019), 22-minute episodes, after the fixes (`reports/mc-v1/compare.txt`):**

| driver | iron pickaxe within 15 min | ever | median time | deaths | subtasks failing |
|---|---|---|---|---|---|
| LLM leader (local Qwen3 4B via Ollama, `--policy llm`) | 0/20 | 1 | - | 69 | 36% |
| kev mc-v1 alone (`--policy kev`) | **13/20 (65%)** | 13 | 3.1 min | 40 | 29% |
| scripted teacher, no noise | 14/20 (70%) | 15 | 3.2 min | 47 | 15% |

Definition-of-done item 1 is met: kev drives at the teacher's level on unseen seeds (same checkpoint that scored 2/20 before the motor fixes). The 4B leader never loops but plays badly (chases unreachable coal, gathers wood on the surface at night, agrees with the teacher on ~20% of decisions); its only advantage, breaking loops, is now provided by the option layer for every driver. Its records (`data/compare_mc-v1_llm.jsonl`, next_subtask labelled by the LLM; the scripted teacher's label is kept as `teacher_label` in the log) are LLM-teacher data of poor quality. kev scored offline on the leader's states: `subgoal_succeeds_60s` ECE 0.35 with a 0.19 true rate (off-distribution overconfidence; `reports/mc-v1/llm-led/`).

**Next:** DAgger round on the kev-driven records with the fixed motor layer (`data/compare_mc-v1_kev.jsonl`, 5,148 records, teacher labels) -> `mc-v2` from `mc-v1`; recollect with 22-minute episodes so `survive_until_morning` gets labels; the breaker's window should count identical failures among the last few attempts, not only consecutive ones (the leader chased coal 51 times in one episode with other attempts in between).

## Experiment 1: iron pickaxe from spawn (text)

- **Scope:** fixed subgoal, no LLM planner. Scripted tech-tree teacher (wood, planks, crafting table, wooden pickaxe, cobblestone, stone pickaxe, find iron, furnace and fuel, smelt, iron pickaxe). kev drives `next_subtask` and emits the forecasts.
- **Data:** teacher rollouts on many seeds with epsilon noise (random actions and random valid subtasks; labels are always the teacher's choice or the true outcome), thinned consecutive ticks, episode-disjoint holdout by seed; then one DAgger round.
- **Definition of done:**
  1. kev drives to an iron pickaxe on ≥60% of 20 unseen seeds within 15 in-game minutes; the teacher's success rate is reported beside it.
  2. Every decision logged with its full distribution.
  3. Reliability diagram for `subgoal_succeeds_60s` and `iron_found_3min` over ≥200 subgoal attempts, with accuracy, base rate and censoring rate beside ECE.
  4. One replay clip with the probability bars.
- **Estimate:** infrastructure 1 day; motor layer and teacher 2-3 days (mostly pathfinder debugging); serializer, schema and data 1 day; training overnight; evaluation and viewer 1 day. About a week of agent-built work; plan for 1.5-2 weeks.

## Experiment 2: vision replaces the location report

**Question:** can kev decide and forecast from what the player sees, or only from what the game engine reports?

**What changes and what doesn't.** Only kev's input. The motor layer still uses Mineflayer's world state (pathfinding needs coordinates: kev chooses `gather_wood`, the motor layer finds the log). Labels still come from full game truth: a privileged teacher, a pixel-only student. The write-up states both.

**Arms** (same schema, same labels, same held-out seeds, same training recipe and data volume):

| Arm | kev input |
|---|---|
| A. Text | The full serializer (experiment 1's model), the control |
| B. Image + self | Front-view frame plus 3-4 text lines: vitals, inventory, goal, time. No positions, memory, nearby-block or entity lists. |
| C. Image only | Front-view frame with a drawn HUD (hearts, food, hotbar). No text except the questions. |

B is the fair test of "pixels instead of the location report". The gap between B and C shows whether the image carries the HUD information or only the scene.

**Decision rule, written before the result:**
- Vision earns a place if B is within ~2 points of A on accuracy and ECE for the in-view questions: `damage_next_20s`, `threat_response`, and `next_subtask` when the target is in view.
- It is a clear loss if B is worse even on those.
- Out-of-view questions (`iron_found_3min`, anything needing the base or memory) are expected to lose; report the size of the loss as the cost of dropping the location report.
- Also compare driving success rate and the forecast reliability diagrams across arms.

**Parameters:**
- Resolution: try 224×224 (~50 image tokens) and 448×448 (~200). Iron ore at 10 m is a few pixels at 224.
- Field of view: a single front view (~70°) sees nothing behind. Optional variant: 2-3 past frames for motion and short memory (~200 tokens each).
- Cost: each question row carries the full image in training, so 5 questions × 200 image tokens ≈ 1,000 extra tokens per record. Fine on 16 GB, slower than text runs. Serving is cheaper: the state, image included, is computed once and shared across questions.
- Storage: one JPEG per decision, ~300 MB per 10k records. Rendering speed may cap collection speed.

**kev changes needed** (the base already supports images: Qwen3.5-0.8B-Base's config is `Qwen3_5ForConditionalGeneration` with a `vision_config`; kev currently loads only the text stack via `AutoModelForCausalLM(...).model` and encodes with the tokenizer):
1. Use Qwen's processor instead of the tokenizer; place image tokens in the state prefix ahead of the text.
2. Load the vision-capable model and pass `pixel_values` through the forward call, in both the row form (training) and the prefix-cache path (serving).
3. Freeze the vision encoder; LoRA on the language layers learns to read image tokens. The pointer head is unchanged: it reads hidden states at option boundaries.
4. Extend the request format with an image field; keep text-only requests working.
5. The released adapter never saw images, so the fine-tune starts cold on the vision side. Keep the same recipe otherwise so arms are comparable.

**Things to verify before building:**
- prismarine-viewer renders darkness at night (if night renders bright, `survive_until_morning` cannot be tested from pixels).
- prismarine-viewer draws no HUD (expected); arm C then needs our own HUD overlay drawn onto the frame.
- Headless frame rendering speed per decision.
- The Qwen3.5 processor's image-token count at each resolution (the numbers above are estimates).

## Milestones after the experiments

- **Milestone 2: survive the first night + iron pickaxe, with the LLM planner.** Replanning on forecasts is the point; the feedback-loop protocol above applies. LLM teacher and DAgger for subtask labels.
- **Later:** human next-subtask prediction from converted VPT data; kev-4b on the 16 GB machine only if 0.8b plateaus; multi-bot scenarios.

## Risks

- **Pathfinding and motor failures** are the biggest time sink: stalls, dig loops, falls, water. Typed failure reasons, hard timeouts, livelock breaker. Failures double as labels for `subgoal_succeeds_60s`.
- **Partial observability.** Memory lines carry what cannot be seen in arm A; arms B and C lose them by design.
- **Compute.** On the 8 GB laptop a ~400-token state with 6 questions is near the question-splitting fallback; expect 1.5-2.2 s/record (~5 h overnight for 8k records). Vision runs belong on the 16 GB machine.
- **Version lag.** Mineflayer and minecraft-data trail releases; pin everything. VPT is 1.16.
- **Planner cost and non-determinism.** Low call rate; log and cache.
- **The feedback loop** biasing forecast labels (see Labels).

## Conventions

- Motor layer scripted, decision layer typed, no LLM in the per-tick loop.
- Every question declares its options; never parse model output text.
- Log the full distribution for every decision; the distributions are the deliverable.
- One question-schema module and one serializer, shared by data generation and play.
- Episode-disjoint splits by seed; temperature fitted on a calibration split disjoint from dev.
- Report accuracy, base rate, ECE and censoring rate together.
