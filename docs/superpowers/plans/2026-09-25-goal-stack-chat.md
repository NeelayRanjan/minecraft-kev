# Goal stack + chat + subgoal-cadence leader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** replace the fixed five-stage chain with a typed goal stack the LLM leader manages (default stack = the chain), let requests arrive through the Minecraft game chat and appear in the leader's prompt, and move the leader to subgoal cadence (goal done/failed, subtask failure, interrupt, death, audience request, slow periodic fallback) where it answers with a goal-level action instead of a per-subtask override. Roadmap items 2 and 3.

**Architecture:** `agent/goals.js` (pure) declares goal kinds with a completion predicate, an option filter, a step function for the forecast question and, where scriptable, a teacher; `GoalStack` holds the active goal on top of the default chain and exposes `describe()` for the state text (replacing `describeChain`) and `step()` (replacing `chainStep`) so kev's questions and labels keep working unchanged. `agent/leader.js` gains the `subgoals` trigger and a goal-level answer schema (`continue | push_goal | pop_goal | override`), the runner routes chat into `leader_requests`, and the leader's overrides keep the two guards. Experiment-1 mode (`--goal iron_pickaxe`) and the chain (`--goal nether`) keep their exact behaviour: the chain is the default stack and, with no chat and no leader, `GoalStack.step()` equals `chainStep()`.

**Tech Stack:** Node 22 ESM, Mineflayer (`bot.on('chat', (username, message) => ...)`, offline-mode Paper so the user can join `127.0.0.1:<port>` with any name), node:test, kev.serve, the desktop Ollama over Tailscale.

**Spec:** the user's goal statement of 2026-09-25 evening (CLAUDE.md "The goal") and roadmap items 2–3.

## Global Constraints

- With `--goal nether`, no chat and `--leader off|events`, every output (options, state text, questions, timeline step, records) is byte-identical to HEAD; with `--goal iron_pickaxe` likewise. `tests/serialize.test.mjs` goldens untouched.
- Goal kinds are declared; the leader's goal answers are validated against the declared kinds and argument vocabularies (items from minecraft-data names the option layer knows; blocks/structures from a declared list); nothing is parsed from free text; chat text reaches only the leader's prompt, never kev's state text.
- The two guards (threat response, recently failed id) apply to every override the leader makes; goal pushes never bypass the night protocol.
- Every goal kind has a completion predicate over `obs` and a `stuck` rule (no step progress for N s) that pops it with `failed`.

## Review Focus

1. **A chat request that names something outside the vocabulary** ("find a village" before the primitive exists): the leader must be able to answer `cannot` with a reason that is logged and shown (Task 3 test: `validateGoal` rejects `find(village)` when `village` is not declared; the schema still allows `cannot`).
2. **A pushed goal that can never complete** (gather 64 diamonds): the `stuck` rule pops it within N s and the default chain resumes (Task 1 test).
3. **Chat from the bot itself or from server messages** must not become requests (Task 4: filter `username === bot.username` and system messages).
4. **The timeline step under a pushed goal**: `GoalStack.step()` must stay monotone within a goal and reset visibly when the goal changes (labels: a goal change is not "step advanced"; Task 1 test + the labeler's existing rule).
5. **Cadence**: the `subgoals` trigger must not fire more than once per 20 s except on death/interrupt/request (Task 2 test).

---

### Task 1: `agent/goals.js` (pure) and the default chain as a stack

**Files:** Create `agent/goals.js`; Modify `agent/stages.js` (unchanged API, used by the chain goal); Test `tests/goals.test.mjs`.

**Interfaces:**
- `GOAL_KINDS = { chain, craft_item(item), gather(item, count), find(block), build(structure), go_to(place), survive_night, return_to_base }` each `{ done(obs, arg) , filter(obs, arg, options) -> options , step(obs, arg) -> {index, of, text} , teacher?(obs, arg) -> id|null , describe(arg) -> string , stuckS }`.
  - `chain`: `done = stageOf(obs).done`, `step = chainStep(obs)`, `describe = describeChain(obs)`, filter = identity, teacher = `teacherSubtask`.
  - `craft_item(item)`: done when `inventory[item] >= 1` (armor: worn counts); step: 1 "get the ingredients" / 2 "craft it"; filter keeps gathering/mining/crafting relevant to the recipe (use `needs`-style arithmetic from minecraft-data recipes via `bot.recipesFor` is impure, so declare ingredient tables for the items the option layer knows: those in `CRAFTABLE`/`CHAIN_CRAFTABLE`); teacher: the chain teacher's `craftNext`-style routine.
  - `gather(item, count)`: done when `inventory[item] >= count`; filter keeps the `mine_*`/`gather_wood` producing it plus movement; step: fraction owned in fifths.
  - `find(block)`: `block ∈ DECLARED_FINDABLE = ['diamond_ore','lava','water','cave','village']` (village = a `bell` or `hay_block` within 32 m; declared now, executor comes with roadmap item 5); done when the block is within 16 m; filter: exploration + threat + eat; step: 1 "search".
  - `go_to(place)`: `place ∈ ['base','surface','diamond_level']`; done by position; filter: movement.
  - `survive_night`: active from dusk; done at morning; filter: the night protocol's list; step 1 "wait out the night".
  - `return_to_base`: done within 6 m of the table.
  - `build(structure)`: `structure ∈ ['portal_frame']` now (`house` declared with `stuckS` and no executor until item 5; `validateGoal` rejects it until then).
- `class GoalStack { constructor({ goal: 'iron_pickaxe'|'nether' }) ; push({kind, arg, source, t}) ; pop(reason) ; top() ; update(obs, t) -> events [{kind:'goal_done'|'goal_failed', goal}] ; describe(obs) ; step(obs) ; filter(obs, options) ; teacher(obs) }` with the default entry `chain` (or `iron_pickaxe`, which uses `techStep` and the experiment-1 teacher). `step()` returns `{ index: base + local, of, text }` with `base` = 100 × depth so a pushed goal's steps sort above the chain's, and the timeline records `goal_id` so a goal change is visible.
- `validateGoal({kind, arg})` → `{ ok, reason }` against the declared vocabularies.

- [ ] Tests: default stack equals the chain (`step`, `describe`, `filter` identity, `teacher` = chain teacher) on the chain fixtures; `push(gather(cobblestone, 8))` → `describe` mentions it, `filter` drops crafts unrelated, `done` when 8 held, `update` emits `goal_done` and `top()` is the chain again; `stuck` pops after `stuckS` without step progress (Review Focus 2); `validateGoal` rejects `find(village_house)` and `build(house)` (until item 5) and accepts `gather(iron_ingot, 5)`.
- [ ] Implement; `npm test`; commit.

### Task 2: the `subgoals` trigger and goal-level answers in `agent/leader.js`

**Files:** Modify `agent/leader.js` (TRIGGERS += `subgoals`; `leaderSchema` gains `push_goal | pop_goal | cannot`; `buildLeaderMessages` gains `GOAL STACK` and `AUDIENCE REQUESTS` sections; `applyAnswer` handles goal actions through `validateGoal`), `agent/planner.js` (`askLeader` unchanged); Test `tests/leader.test.mjs`.

**Interfaces:**
- `subgoals` trigger: due on `event ∈ {goal_done, goal_failed, subtask_failed (a subtask_done with result !== 'ok'), interrupt, death, audience_request}` or `t - lastAsk >= 120`; never more often than every 20 s except for `death`, `interrupt`, `audience_request` (Review Focus 5).
- Answer schema: `{ action: 'continue' | 'push_goal' | 'pop_goal' | 'cannot' | <offered id>, goal?: { kind: enum GOAL_KINDS, arg?: string, count?: integer }, why }`.
- `applyAnswer` returns kinds `continue | override | blocked | stale | invalid | push_goal | pop_goal | cannot` with `validateGoal` deciding `push_goal` vs `invalid`.
- Prompt sections: `GOAL STACK` (top first, with each goal's source (chain / audience:<name> / leader) and progress), `AUDIENCE REQUESTS` (unanswered chat lines: `t, name, text`), and the rules: answer a request by pushing exactly one goal or `cannot` with a reason the audience will read; prefer goals to overrides; never push a goal that ignores the night protocol.

- [ ] Tests: trigger cases; schema enum; `applyAnswer` for `push_goal` valid/invalid and `cannot`; prompt contains the two sections.
- [ ] Implement; `npm test`; commit.

### Task 3: runner wiring: goal stack, chat, goal events, reply to chat

**Files:** Modify `agent/run_episode.mjs` (`GoalStack` replaces the direct `chainStep`/`describeChain`/`stageOf` uses in nether mode; `bot.on('chat')` → `leaderRequests.push({t, name, text})` unless from the bot or a system message; `applyAnswer` results `push_goal`/`pop_goal`/`cannot` → `goalStack.push/pop`, events `goal_pushed`/`goal_popped`/`leader_cannot`, and a chat reply from the bot (`bot.chat(...)`) with one short sentence: what it will do or why not); `agent/summary.js` (`obs.goalText` from `goalStack.describe`), `agent/serialize.js` (first line uses `obs.goalText` in nether mode; identical to today when the stack is just the chain), `agent/questions.js` (step from `goalStack.step` passed via obs), `agent/logger.js` (timeline `goal_id`), `agent/leader_report.js` (goal events and requests in the report), `scripts/leader_report.mjs`.
- [ ] Byte-identity check: a 3-minute `--goal nether --leader off` episode before and after the change with a fixed seed has identical `.jsonl` records (the run is not deterministic in time, so compare the first record's state text and the question set instead).
- [ ] Smoke: `--goal nether --leader subgoals --minutes 6` with kev.serve and the desktop leader; during the run join the server as a player (`server.properties` is offline mode; the port is printed) and type `gather 8 cobblestone`; the log must show `audience_request`, a `push_goal`, a chat reply, and `goal_done` or `goal_failed`.
- [ ] Commit.

### Task 4: `scripts/leader_live.sh` and the live view

**Files:** Create `scripts/leader_live.sh <seed> [minutes=120]` (kev.serve mc-v3, the leader with `subgoals`, `--goal nether`, video on, prints the join address); Modify `agent/run_episode.mjs` (`--live-view <port>`: `mineflayer.viewer(bot, { port, firstPerson: true })` from prismarine-viewer so the user can watch at `http://127.0.0.1:<port>` while it plays; optional, off by default).
- [ ] Smoke with `--live-view 3007`; document in CLAUDE.md ("How to run": join the server, type requests, watch the view); commit.
