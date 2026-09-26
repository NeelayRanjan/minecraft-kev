# kev steers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** inside the walking subtasks (`explore_toward(*)`, `return_to_base`), let kev steer at 2 Hz by choosing among eight headings, jump, dig-ahead and stop, with the pathfinder's own next move as the teacher label and a 30-second "reach the target" forecast; measure four arms (pathfinder, teacher-follow, kev zero-shot, kev fine-tuned) on distance gained, time to target, damage and deaths.

**Architecture:** a pure `agent/steer.js` turns the pathfinder's computed path into a heading label and renders a one-line steering description; the motor gains a `steerTo(goal)` primitive that, when a steering policy is active, drives the bot itself with control states for 500 ms per decision while the pathfinder only computes the path for labels; steering decisions are a second record stream (`out/<name>.steer.jsonl`) with their own two questions, so experiment-1 records are untouched; the runner's 1 Hz loop is unchanged (the 2 Hz steering loop lives inside the motor's walk).

**Tech Stack:** Node 22 ESM, Mineflayer 1.20.4 + mineflayer-pathfinder (`bot.pathfinder.getPathTo(movements, goal)` → `{status, path: Move[]}`, `Move` has `x,y,z,toBreak,toPlace`), kev.serve (mc-v3 as the init checkpoint), node:test, the existing split/train/eval scripts.

**Spec:** the conversation of 2026-09-25 evening (user): "the contained version": kev steers instead of the pathfinder inside explore_toward, eight headings plus jump and dig-ahead at 2 Hz, the pathfinder's choice as teacher label, success measured on distance gained, falls and time to reach a known block against the pathfinder; keep the calibration story (a forecast with a natural horizon).

## Global Constraints

- Experiment-1 and chain-mode behaviour with `--steer off` (the default) is byte-identical: no new lines in the state text, no new questions in the 1 Hz records, `tests/serialize.test.mjs` golden untouched, all 151 tests keep passing.
- Steering options are a declared list; kev's steering answer is validated against it; the fallback on an invalid or late answer is the teacher label (logged as such).
- Words over numbers in the steering line (lesson 8); never emit `<|` or `|>`.
- The motor keeps its typed results and timeouts; a steering walk that makes no progress for 15 s ends with `no_path` (the pathfinder's equivalent).
- Never `pkill -f` a pattern present in the calling command line (bracket trick).

## Review Focus

1. **A steering decision arriving after the walk ended** (kev's 100 ms answer versus a subtask that finishes or is interrupted): the late answer must be dropped, never applied to the next walk. Test: `SteerLoop.apply` ignores answers whose `walkId` differs (Task 3 pure part).
2. **Water and lava ahead** while kev steers: the executor must refuse to step into lava (reuse `liquidAround`) and treat water as walkable-with-jump, regardless of kev's heading. Test in `steer_check` with a lava strip beside the corridor (Task 3).
3. **The teacher label when the path is empty or partial**: `steerLabel` must return `stop` at the goal and the heading toward the goal itself when the pathfinder has no path (Task 1 test).
4. **The forecast label near the end of an episode**: `reach_target_30s` is censored (null) when fewer than 30 s remain, never false (Task 2 test).
5. **Two record streams in gen_data**: `--log-steer` must write `data/<out>.steer.jsonl` beside the normal file and the normal file must be unchanged in content (Task 4: a diff test on a 1-minute episode with and without the flag).

---

### Task 1: `agent/steer.js` (pure)

**Files:** Create `agent/steer.js`; Test `tests/steer.test.mjs`.

**Interfaces:**
- `STEER_OPTIONS = ['north','north-east','east','south-east','south','south-west','west','north-west','jump','dig_ahead','stop']`, `STEER_DESC` (one line each: "walk north", "jump forward over the block ahead", "dig the block(s) ahead and step in", "stop: the target is reached").
- `headingWord(dx, dz)` → one of the eight words (reuse `dirWord` from `agent/summary.js`).
- `steerLabel({ pos, path, goalPos, reached })` → option id: `stop` if `reached`; else with `path.length`: the first node farther than 0.4 m from `pos` → if `node.toBreak.length` → `dig_ahead`; else if `node.y > Math.floor(pos.y)` → `jump`; else `headingWord(node.x + 0.5 - pos.x, node.z + 0.5 - pos.z)`; with no path → `headingWord` toward `goalPos`.
- `steerLine({ targetName, target: {dist, dir, dy}, ahead: {feet, head, below}, lastMove: {dist, dir} })` → e.g. `steering: toward cave entrance 14 m north-east, 3 m below you; ahead: stone at your feet, air at head height, grass below; last half second: moved 1 m north-east.` (numbers rounded, "did not move" when dist < 0.2).
- `reachLabel({ frames, t, targetPos, horizonS = 30, endT })` → true if any frame with `t < f.t <= t + horizonS` is within 3 m of `targetPos`; false if `endT >= t + horizonS` and none was; null otherwise (censored).
- `steerQuestions()` → `{ steer: { type:'choice', instructions:'Which way should the player move in the next half second to reach the steering target?', criteria: STEER_DESC }, reach_target_30s: { type:'noul', instructions:'Will the player be within 3 m of the steering target within the next 30 seconds?' } }`.

- [ ] Tests: label cases (reached → stop; toBreak → dig_ahead; higher node → jump; flat node east → 'east'; empty path → heading toward goal); `steerLine` exact string for one fixture; `reachLabel` true / false / censored (Review Focus 4); `headingWord(0,-1) === 'north'`.
- [ ] Implement; `node --test tests/steer.test.mjs`; `npm test`; commit `feat: steer.js ...`.

### Task 2: steering records in the logger and the labeler

**Files:** Modify `agent/logger.js` (`steer` array, `steerDecision(d)`, `toSteerRecords()`, `labelSteer()`), `agent/questions.js` (export the `reach_target_30s` labeler hook or have `logger.labelSteer` call `reachLabel`); Test `tests/logger.test.mjs` (append).

**Interfaces:**
- `EpisodeLog.steerDecision({ t, walkId, state_text, target: {name, pos}, qs, answers, label, chosen, source, latency_ms })`; `toJSON()` gains `steer: [...]` (without state_text duplication: keep `state_text` in the entry; the file is only written with `--log-steer`, see Task 4).
- `toSteerRecords()` → kev records `{ state, questions: { steer: {type, instructions, criteria, label}, reach_target_30s: {type, instructions, label} }, _meta: { seed, t, walkId } }` after `labelSteer()` fills `reach_target_30s` from `this.frames` via `reachLabel` (frames have `t,x,y,z`).
- [ ] Tests: a synthetic log with 3 steer decisions and frames → 2 labelled true/false, 1 censored (dropped from records); the normal `toRecords()` output is unchanged by the presence of steer decisions.
- [ ] Implement; `npm test`; commit.

### Task 3: the motor's `steerTo` primitive and `steer_check`

**Files:** Modify `agent/motor.js` (`steerTo(goal, { targetName, targetPos })`, `SteerLoop` pure helper exported, `explore_toward` and `return_to_base` use `steerTo` when `this.steer` is set); Create `tests/integration/steer_check.mjs`; Test `tests/motor.test.mjs` (append, pure `SteerLoop`).

**Interfaces:**
- `new Motor(bot, mcData, mem, { steer: { policy: 'pathfinder'|'teacher'|'kev', ask: async (stateText, qs) => answers|null, log: (steerDecision) => void, serialize: obs => text, obs: () => obs } })`. With `policy: 'pathfinder'` the walk is the normal `goto` and the loop only *labels* every 500 ms (records with the teacher label, `chosen` = label, `source` = 'pathfinder'). With `teacher` the loop executes the label. With `kev` it asks (`ask` returns within the 500 ms tick or the label is used, `source: 'kev_late'`), validates against `STEER_OPTIONS`, executes.
- `SteerLoop` (pure): `{ walkId, apply(answer) }`, decides `execute(option)` → control-state plan `{ yaw, forward, jump, dig: Vec3[] , stop }` and `progress(pos, target)`; the no-progress rule: `no_path` after 15 s without gaining 1 m toward the target (Global Constraints).
- Execution of an option for 500 ms: `bot.look(yaw, 0, true)`, `setControlState('forward', option !== 'stop')`, `setControlState('jump', option === 'jump')`, `dig_ahead` digs the block at feet and head level one cell ahead (`digSafe`, with `liquidAround` refusing lava; Review Focus 2) then walks; `stop` clears controls and ends the walk with `ok` when within 3 m of the target, else continues.
- Label each tick from `bot.pathfinder.getPathTo(this.movements, goal)` (computed at most every 500 ms; on timeout keep the last path).
- `steer_check.mjs`: an arena (`/fill`) with a 30 m corridor containing a 1-block step, a 2-block wall to dig through, a lava strip beside the corridor, and a target block; runs `explore_toward`-style walks to the target with `pathfinder`, then `teacher`; prints per arm: reached (bool), seconds, took_damage count; PASS when both arms reach it without damage and the labelled records (from the `log` callback) contain `jump` and `dig_ahead` at least once each.
- [ ] Pure tests: `SteerLoop.apply` drops a stale `walkId` (Review Focus 1); `execute('north')` yaw = Math.PI (Mineflayer yaw: north is π); no-progress rule fires at 15 s.
- [ ] Implement; `npm test`; `node tests/integration/steer_check.mjs --seed steer-1` → PASS; `node tests/integration/motor_check.mjs --seed motor-1 --port 25575` → PASS (steer off); commit.

### Task 4: runner and gen_data flags, kev arm

**Files:** Modify `agent/run_episode.mjs` (`--steer off|pathfinder|teacher|kev`, `--log-steer`), `agent/gen_data.mjs` (pass-through; write `data/<out>.steer.jsonl` from the children's `out/<name>.steer.jsonl`), `scripts/drive_summary.py` (a `--steer` summary: per prefix, walks with a target: reached fraction, median seconds per 24 m, progress m/s, took_damage per walk, deaths).

**Interfaces:**
- The kev arm's `ask`: `ask(kevUrl, stateText + '\n' + steerLine, steerQuestions(), { timeoutMs: 450 })` with `fromKev` mapping; the steering state text is the normal `serialize(obs)` plus the steering line as the last line (so kev's state stays in-distribution up to one added line).
- `--log-steer` writes `out/<name>.steer.jsonl` (kev records) and adds `steer` to `out/<name>.json`; without it the outputs are byte-identical to today (Review Focus 5: a 1-minute episode with and without the flag, `diff` of the `.jsonl`).
- `meta.steer = { policy, logged: bool }`.
- [ ] Tests: `drive_summary.py --steer` on a synthetic log (python, run as a small self-test in the script under `--selftest`); the diff check as a documented manual step in the report.
- [ ] Implement; smoke: `node agent/run_episode.mjs --seed 7 --port 25580 --policy teacher --steer pathfinder --log-steer --minutes 3 --out steer_smoke` → `out/steer_smoke.steer.jsonl` non-empty with both questions; then `--steer teacher` 3 min → the bot still reaches step 4; commit.

### Task 5: collection, training and evaluation scripts

**Files:** Create `scripts/steer_collect.sh` (teacher-driven experiment-1 episodes, `--steer pathfinder --log-steer`, N seeds, 5 procs, 22 min → `data/steer1.jsonl`; `base_rates.py` on it: `reach_target_30s` should sit between 20 % and 80 %, else adjust the horizon and note it), `scripts/train_steer.sh <run> <train.jsonl> [init=runs/mc-v3]` (the mc1 recipe with `--max_state` sized to the data), `scripts/steer_eval.sh <run> [seeds=10] [seed0=4000] [minutes=12]` (four arms on the same seeds: `pathfinder`, `teacher`, `kev` with mc-v3 (zero-shot on the steering question), `kev` with `<run>`; kev.serve restarted per checkpoint; `drive_summary.py --steer` table → `reports/<run>/steer.txt`; reliability of `reach_target_30s` on the driven records → `reports/<run>/steer-driven/`).
- [ ] `bash -n` all; a 2-seed, 3-minute dry run of `steer_collect.sh`; commit.

### Task 6: run it and report

- [ ] Collect overnight on the laptop (40 seeds) or the desktop (SSH into the container, faster); split; train `steer-v1` from mc-v3; eval on the dev split (accuracy of `steer` versus the pathfinder label, ECE/AUROC of `reach_target_30s`).
- [ ] `scripts/steer_eval.sh steer-v1 10 4000 12`; read `reports/steer-v1/steer.txt`; record at least one clip per arm (`--video` on the first seed).
- [ ] Update CLAUDE.md (layout, how to run, status with the four-arm table) and ask the user (AskUserQuestion) with the table and clip paths.
