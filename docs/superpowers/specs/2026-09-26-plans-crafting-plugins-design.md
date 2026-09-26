# Plans, the full crafting menu, generic primitives, hot-reloadable executors (design)

**Status:** approved in conversation on 2026-09-26 after the first live chat session (`reports/leader/live_s3000_1422.md`); this document is the spec the implementation plan argues from.

## Why

The live session showed the shape of the interactive bot working: a player types in the game chat, the LLM leader turns the request into a typed goal, kev and the motor carry it out, the bot replies. It also showed the four gaps that stopped most requests:

1. The leader can only push **one goal per request**. "Make a compass" needs a plan (iron, redstone, craft) that is remembered, executed step by step, shown to the player, and editable ("skip that", "do the logs first").
2. The craft vocabulary is the **eighteen tech-tree items**. Stairs, a stone hoe and a compass were refused although the motor's craft executor is generic. The bot should be able to craft anything whose materials it can produce, and say which material stops it when it cannot.
3. **Motor failures at the water's edge**: flee and the surface walk wade into the sea, the leave-water routine gives up beyond 12 m and the bot floats; players who hit the bot are not threats; the climb's floor placement failed with cobblestone in hand.
4. Questions ("what can you craft") are forced through `cannot`, and chat replies are trimmed to 80 characters.

A fifth item keeps the avenue for quick experiments open: **executors as hot-reloadable plugins**, so a new primitive can be added while a session runs (written and arena-tested offline; never generated at runtime by a model: the motor is the safety layer and its rules are code).

Decision rule from the conversation: **code handles everything it can (deterministic, correct arithmetic); the LLM composes only where no scripted expansion exists**, and edits.

## 1. Plans and the plan book (`agent/plans.js`, pure)

- **Plan** `{ id, title, source, steps: [goal, ...], cursor, status }` where `goal` is a validated `{ kind, arg, count }` from `GOAL_KINDS`, `source` is `audience:<name>` or `leader`, `cursor` the index of the running step, `status ∈ pending | running | blocked | done | dropped`.
- **PlanBook** holds plans in order. `front()` is the running plan. `advance(event)` moves the cursor on `goal_done`, marks the plan `blocked` on `goal_failed` (the leader is triggered with `plan_blocked` and the failure reason), `done` after the last step. Edits: `skip()` (drop the current step, continue), `drop(id)`, `moveFront(id)`, `clear()`. Each edit returns a short chat line.
- **GoalStack integration**: the stack pushes exactly the front plan's current step as a goal with `plan_id` and `step_index`; when the plan changes, the pushed goal is popped and the new step pushed. With no plans the stack is the chain, byte-identical to today (golden tests unchanged).
- **The recipe expander** `expandItem(item, count, inventory) -> { steps, missing }`: walks minecraft-data 1.20.4 recipes (shaped and shapeless; the first recipe whose ingredients are all producible wins; tag ingredients such as any plank resolve to the variant held or oak) **net of the inventory**, into leaf materials, and emits steps in dependency order from three declared tables:
  - `MINE`: block -> drop, with the tool tier needed (from `harvestTools`) and where to look (ore search underground, surface blocks like sand/gravel/dirt/clay by nearest);
  - `SMELT`: item -> product (raw_iron/raw_copper/raw_gold -> ingot, sand -> glass, cobblestone -> stone, log -> charcoal, clay_ball -> brick, ...; minecraft-data has no smelting recipes);
  - `HUNT`: mob -> drops (sheep -> wool (shears: 1-3, no kill), cow -> leather/beef, chicken -> feather, spider -> string, pig -> porkchop, squid -> ink_sac).
  A leaf with no producer ends the expansion with `missing: [leaf]` and no steps; the reply names it ("a bed needs wool; I can shear sheep, but I have no shears yet" is produced by expanding shears in turn). Steps are `gather(item, n)` (n net), `smelt_item(item, n)`, `hunt(mob, n)`, `craft_item(item, n)` and a preceding `craft_item(tool)` when a mine step's tool tier is missing. The chain's crafting table and furnace are requirements handled by the existing `needs` arithmetic.
- **Where plans come from**: (a) the leader answers `plan_item { item, count }` and code expands it; (b) the leader answers `plan_steps { title, steps: [goal...] }`, validated by `validateGoal` per step (invalid step -> the whole answer is `invalid` and the reply says which step); (c) the runner answers `plan`/`stack` chat words itself.
- **Announcements**: a new plan is announced as numbered steps in one or two chat lines; each step is announced when it starts ("step 2/4: smelt 4 iron ingots"); the plan's end is announced ("compass done" / "compass blocked: no redstone ore found").

## 2. Viewing the stack

- **Chat**: `plan`, `stack` and `plans` (a whole message equal to one of these words) are answered by code, no LLM call: front plan with step states (`✓`, `▶`, `·`), then the titles of the plans behind it.
- **Status page** `--status-port 3008` (started with `--live-view`): `GET /state.json` returns `{ t, plans, stack, current_subtask, forecasts, chat: last 10, leader: last 10 decisions }`; `GET /` is one static HTML page polling it every second. No framework; `node:http`.

## 3. Generic production primitives (motor + options + goals)

Six executors, each a typed result like the existing ones, each with a timeout and a livelock-breaker entry:

| id | does | done / fails |
|---|---|---|
| `mine(<block>)` | nearest block of that name: remembered, then within 32 m, ores via the existing ore search; digs with the best tool, refuses without the tier `harvestTools` needs | `ok (+n)`, `no_path`, `not_found`, `needs_tool` |
| `smelt_item(<item>)` | the furnace routine on `SMELT[item]` with the existing fuel plan | `ok`, `no_furnace`, `no_fuel`, `no_materials` |
| `craft_item(<item>)` | `bot.recipesFor` at the table when needed; any recipe with the ingredients in hand | `ok`, `no_materials`, `no_table` |
| `hunt(<mob>)` | nearest passive mob of that type within 32 m; shears for sheep, else pvp attack; collects the drops (walks over them) | `ok (+drops)`, `not_found`, `took_damage` |
| `go_to_player(<name>)` | pathfinds to the player entity and follows until within 3 m for 5 s | `ok`, `no_path`, `player_gone` |
| `receive(<item>, <name>)` | goes to the player, stands within 3 m, walks over item entities within 6 m for up to 60 s | `ok (+n)` when the count rises, `timeout`, `player_gone` |

Goal kinds gain `hunt(mob, count)`, `smelt_item(item, count)`, `go_to(player:<name>)` and `receive(item, from)`; `craft_item` accepts any item with a minecraft-data recipe and `gather` any item with a `MINE` producer. The generic options are **offered only under a goal that needs them** (the goal's option filter adds them), so the chain's option list and kev's training distribution are byte-identical; the leader's vocabulary lists them.

## 4. Hot-reloadable executors (`agent/plugins/`)

- One file per executor: `export default { id, timeout, breaker: true, preconditions(obs, arg) -> bool, run(motor, arg, obs) -> {result, detail} }`. The six primitives above are the first plugins; the existing executors stay where they are (moving them is a refactor for another day).
- The runner watches the folder (`fs.watch`, debounced 500 ms), imports a changed file with a cache-busting query string, and swaps the entry in the registry; the option vocabulary and the leader prompt pick it up at the next decision. A plugin whose import or `run` throws is disabled (logged, its options withheld) until its file changes again. A running subtask keeps the code it started with.
- Every plugin ships `tests/integration/plugins/<id>_check.mjs` (a `/fill` arena on its own server, PASS/FAIL) and the loader has unit tests with a fixture plugin.
- **The motor backlog**: every `cannot` whose reason names a missing primitive, and every `missing` leaf from the expander, is appended to `out/<run>.requests.jsonl` as `{ t, name, text, missing }`; `scripts/leader_report.mjs` lists them.

## 5. Motor fixes

- `flee` and the surface walk check the goal cell for water within 2 blocks (`wetNear`, as the descent does) and rotate the heading instead of wading in.
- `leaveWater` searches for shore to 48 m; without one it swims toward the remembered base, else spawn, for up to 30 s, then re-searches.
- Any entity that damages the bot (`entityHurt`/health drop with the nearest entity within 4 m as the attacker) is a threat for 30 s; players included; the response offered for a player is `flee` only (never `fight`).
- `placeFloor` in the climb: log the reason per neighbour (no filler, no solid neighbour, `placeBlock` error) so `climb_check` can show why "nothing to step on" fired with cobblestone in hand; fix what it shows.
- The live-view entity mesh error is caught per entity (as the recorder does) and the entity skipped.
- `go_to(y:<n>)`: descend (or climb) until `|y - n| <= 2`, using the existing descent and climb.
- Under a pushed goal, a `wait` pick by kev triggers the leader immediately (bypass the 20 s cadence, like `interrupt`).

## 6. Replies

- Leader answer `say { text }`: a reply with no goal; used for questions and acknowledgements; counts as answering the request.
- Chat lines up to 200 characters; longer texts are split at word boundaries into lines of at most 256 through the existing `ChatQueue`; the `why` tail is no longer cut at 80.

## 7. Out of scope

- Runtime code generation by a model (decided against: untested code in the safety layer).
- Moving the existing executors into plugins.
- Vision, randomised starts, DAgger (roadmap item 4 follows this round).
- Structures other than `portal_frame` (`build(house)` stays declared and refused).

## 8. Testing and acceptance

- Unit (`npm test`): expander on fixed inventories (compass -> exact steps; oak stairs with 6 planks held -> one craft step; red bed -> hunt sheep + shears sub-plan; an item whose leaf has no producer -> `missing`), PlanBook advance/block/edit rules, GoalStack with a plan (push/pop on plan change; chain byte-identical without plans), leader schema and `applyAnswer` for `plan_item | plan_steps | edit | say`, plugin loader with a fixture (load, reload on change, disable on throw), chat splitting, attacker threat rule, `wetNear` gate for flee.
- Integration: `plugins/*_check.mjs` for the six primitives; `receive` and `go_to_player` use a second Mineflayer bot as the player (it drops items); `safety_check` gains the flee-into-water and the floating cases.
- Acceptance: a live session with the user: "make a compass" produces and announces a plan and either finishes it or names the blocking material; "come here" and "I have redstone for you" work; the status page shows the stack; a flee near water turns.
