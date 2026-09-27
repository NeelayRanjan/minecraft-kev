# Randomised starting states + DAgger with LLM labels (design, roadmap item 4)

**Status:** design fleshed out 2026-09-25 evening while leader round two runs; to be turned into a task plan after roadmap items 2–3 land (the goal stack decides what a "task" is).

## Why

kev's breadth is the bottleneck for the interactive bot: its choice head only knows the states the teacher visited on the iron-pickaxe tree from a fresh spawn (40 seeds) plus one DAgger round. Under audience goals it will meet inventories, times of day, depths and goals it has never seen. Two things fix that at once: **randomised starts** (the state space is covered by construction, not by luck) and **DAgger with LLM labels** (the states kev itself visits get labelled even where no script can). Both are supervised; both keep the calibration exhibit (outcome labels are free at any start).

## The start spec

A JSON object the runner applies right after spawn through server console commands (`/give`, `/time set`, `/tp`, `/setblock`, `/clear`, `/effect`), before the first tick:

```json
{ "seed": 4123, "time": 6000, "spawn_offset": [120, 0, -40], "y_target": null,
  "inventory": { "stone_pickaxe": 1, "cobblestone": 14, "oak_log": 3, "raw_iron": 2, "coal": 1 },
  "armor": { "iron_helmet": 1 }, "health": 14, "food": 9,
  "goal": { "kind": "craft_item", "arg": "iron_pickaxe" },
  "minutes": 12, "source": "drawn|hand:<name>" }
```

- `time`: ticks of day, drawn from `{1000 morning, 6000 midday, 11500 late afternoon, 13000 dusk, 16000 night}` with weights 3:3:2:1:1 (nights at 20 % so `survive_until_morning` and the night protocol get data without drowning the tech-tree states).
- `spawn_offset`: `/tp` to spawn + offset (uniform in a 200 m square), then `--y-target`: `surface` (default), `shallow` (dig the bot in at y 40 via `/tp` to the nearest air pocket found by scanning down, else stay) or `deep` (y -50) with 20 % / 10 % weights: caves and depth are where the pickaxe tree gets stuck.
- `inventory`: drawn from a **stage prior**: pick a chain stage 0–4 with weights 4:2:2:1:1, then a sub-state (for stage 0: one of the eight tech steps, uniform); fill the inventory with what that step implies (the `needs` arithmetic in reverse) plus noise: ±30 % on counts, a 20 % chance of one random extra item from a small list (bucket, bread, torch, sapling), a 10 % chance the pickaxe is worn 90 %. Armor worn according to the stage.
- `health`, `food`: 20/20 with 70 %, else uniform 6–19.
- `goal`: for the recollection phase, the chain from that stage (`goal: chain`); for the goal-stack phase, a drawn `GOAL_KINDS` goal consistent with the inventory (`craft_item` of the next chain item, `gather(item, n)` with n ≤ 16, `find(block)` for a declared block, `survive_night` when `time >= 12500`, `return_to_base` only with a placed table: the spec then also `/setblock`s a crafting table within 20 m and seeds the memory). Since the plans-crafting-plugins branch (2026-09-26): a plan step (`agent/plans.js`, from the recipe expander or the leader's `plan_steps`) and the six plugins (`mine`, `smelt_item`, `craft_item`, `hunt`, `go_to_player`, `receive`) are goal kinds too, so the spec can draw those the same way.
- `minutes`: 8–15, drawn; the forecast horizons (60 s, 3 min, night) stay observable.
- `source: hand:<name>`: **a state the user set up by hand.** `scripts/snapshot_state.mjs --port <p> --name <n>` connects to a running server the user is playing on, reads the user's player (position, inventory, armor, health, food, time) and writes `data/starts/<name>.json` in this format; `--start data/starts/<name>.json` replays it for the bot on a fresh server with the same seed. That is the "put the bot into weird situations" path the user asked for.

## Collection

`agent/gen_data.mjs --starts random --n 400 --procs 5 --minutes 12` (or `--starts data/starts/*.json`): each episode gets a fresh Paper instance (as today), applies the spec, logs `meta.start`. The teacher drives with epsilon 0.1 where a teacher exists (`chain`, `craft_item`, `gather`, `return_to_base`, `survive_night`); for `find` and `build` the driver is kev (mc-v3) and the labels come from the LLM (below). Throughput: 12-minute episodes at 5 procs ≈ 25 per hour ≈ 300 a night on the laptop, twice that on the desktop.

Base-rate gate before training (`scripts/base_rates.py`): every noul within 20–80 %; `subgoal_succeeds_60s` by stage; `survive_until_morning` no longer starved. If a label is rare, change the spec weights, not the horizon.

## DAgger with LLM labels

Round structure, each night:
1. **Drive**: kev (the latest checkpoint) drives 100 randomised starts with the leader off (`--policy kev`), eps 0.05, `--log-steer off`; every decision point is a state kev chose to visit.
2. **Label**: for each decision point: the scripted teacher's answer where `GoalStack.teacher(obs)` exists; otherwise `scripts/llm_label.mjs` asks the 27B **offline** k = 5 times (temperature 0.7, the leader's prompt minus the leader-specific sections, answer = one offered id) and writes the vote fraction as a soft label (`target` field in the kev record; kev's trainer already accepts `target` distributions). Cache by state hash (`prompt_hash`); log disagreement (entropy of the votes) per stage so we can see where the LLM is unsure. The forecast questions keep their outcome labels.
3. **Filter**: drop states where the LLM's vote entropy is above 1.2 bits (no consensus) unless the teacher labelled them; report the fraction dropped.
4. **Train**: `mc-v(n+1)` from `mc-v(n)` on the previous data plus the new records (episode-disjoint holdout by seed, as always); eval on a fixed randomised-start holdout of 60 specs (drawn once, committed as `data/starts/holdout/*.json`).
5. **Measure** on the holdout: `next_subtask` accuracy against the teacher where it exists and against the LLM's majority elsewhere; `subgoal_succeeds_60s` ECE and AUROC by stage; driving: goal completion rate by goal kind within the spec's minutes.

Two rounds should be enough to see whether breadth transfers: the second round's holdout numbers on goal kinds that had no scripted teacher (`find`, `build`) are the generalization test.

## What is not in scope

- Vision. The start spec is text-side only.
- RL. Expert iteration (keep the fastest kev trajectories) can be added as a filter in step 3 later without new training code.
- New primitives: item 5 owns those; the spec only draws goals whose primitives exist (`validateGoal`).

## Costs and risks

- Paper `/tp` to an offset can land in water or mid-air; the spec applies `/tp` then waits for `bot.entity.onGround` up to 5 s, else redraws the offset (log the redraw).
- `/give` of a worn pickaxe needs the `Damage` NBT tag: `/give kev_x stone_pickaxe{Damage:118} 1` (stone pickaxe max 131).
- The LLM labeller at 5 samples × 3 s = 15 s per state: 100 episodes × ~200 decision points = 20,000 states ≈ 80 h. Too slow. Label only decision points (not the 1 Hz forecasts, which have outcome labels), thin to every 3rd, and cache by state hash: ≈ 6,000 states ≈ 25 h on one 27B, or run on the 8B for the first round (agreement 0.37 with the teacher on day 3, so weight its votes lower). The leader's server (desktop) is free at night.
- Soft labels from a 2-bit model may be worse than no label on stages where the teacher exists; the filter in step 3 and the teacher-first rule keep that contained.
