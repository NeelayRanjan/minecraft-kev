# Plans, full crafting menu, generic primitives, hot-reloadable executors: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a player's chat request become a remembered, visible, editable multi-step plan that the bot executes step by step, for any item whose materials it can mine, smelt, hunt or receive from the player; add the six generic primitives as hot-reloadable plugins; fix the water-edge motor failures seen in the live session.

**Architecture:** a pure recipe expander (`agent/recipes.js`) turns an item request into ordered typed goals from three declared producer tables plus minecraft-data recipes; a pure plan book (`agent/plans.js`) holds ordered plans and feeds the front plan's current step to the existing `GoalStack` as a pushed goal; the leader gains four answer kinds (`plan_item`, `plan_steps`, `edit`, `say`) and two triggers (`plan_blocked`, `idle_wait`); a plugin registry (`agent/plugins.js`) loads executors from `agent/plugins/*.mjs`, watches the folder and swaps them live; the runner wires it together and serves a status page. Code decides everything it can (the expander); the LLM composes only for requests that are not an item, and edits.

**Tech Stack:** Node 22 ESM, Mineflayer + pathfinder + collectblock + pvp, minecraft-data 1.20.4 (`recipes`, `blocks[].harvestTools`, `blocks[].drops`), node:test, node:http (status page), the desktop Ollama 27B over Tailscale, kev.serve mc-v3.

**Spec:** `docs/superpowers/specs/2026-09-26-plans-crafting-plugins-design.md`

## Global Constraints

- With no plans and no chat, every output (options, state text, questions, timeline step, records) is byte-identical to HEAD in both `--goal iron_pickaxe` and `--goal nether`; `tests/serialize.test.mjs` goldens untouched. Generic options are offered **only under a goal that needs them** (the goal's option filter adds them).
- Nothing is parsed from free text: the leader's plan, edit and say answers are JSON under `leaderSchema`; every step goes through `validateGoal`; an item name must be a minecraft-data 1.20.4 item name.
- No model-generated code at runtime; plugins are files written and arena-tested offline. Every plugin ships `tests/integration/plugins/<id>_check.mjs`.
- The two override guards (threat response, recently failed id) and the night rule apply unchanged; plan steps that the night rule blocks wait (the goal's night pause), they are not dropped.
- The response offered against a player who damaged the bot is `flee(threat)` only, never `fight(threat)`.
- Chat lines: at most 200 characters per line from the leader's text, split at word boundaries into lines of at most 256 through `ChatQueue`; all bot chat goes through `sanitizeChat`.
- `pkill -f` only with bracketed patterns, never with the bare pattern elsewhere in the same command (see CLAUDE.md).

## Review Focus

1. **"make a bed" with nothing in hand**: the expander must nest shears (2 iron) before shearing sheep, and the plan must read in dependency order; a person expects "iron, shears, wool, planks, bed", not "bed" then failures (Task 2 test).
2. **A plan whose step keeps failing** (no redstone ore anywhere): the plan goes `blocked`, the leader is asked once with the reason, the chain resumes, and the player is told which material blocked it; the bot must not loop on the step (Task 3 + Task 8 tests).
3. **A player who hits the bot once as a test**: the bot flees for 30 s and never swings back; the player must not become a permanent threat (Task 1 test).
4. **A plugin file saved with a syntax error while the bot runs**: the registry logs it, withholds that plugin's options, keeps every other plugin, and reloads on the next save; the episode never dies (Task 5 test).
5. **"come here" while the player is 200 m away or in spectator mode**: `go_to_player` fails with `no_path` or `player_gone` within its timeout and the plan step goes blocked with that reason; the bot must not walk forever (Task 7 check).

---

### Task 1: Motor fixes from the live session (bounded)

**Files:** Modify `agent/motor.js` (`flee`, `explore_toward` surface walk, `leaveWater`, `placeFloor`), `agent/summary.js` (attacker), `agent/policy.js`, `agent/subtasks.js`, `agent/goals.js` (`go_to(y:<n>)`), `agent/run_episode.mjs` (live-view guard, `idle_wait` note), `agent/leader.js` (`idle_wait` in `EVENT_TRIGGERS.subgoals` and `BYPASS.subgoals`); Test `tests/motor.test.mjs`, `tests/summary.test.mjs`, `tests/goals.test.mjs`, `tests/leader.test.mjs`, `tests/integration/safety_check.mjs`.

**Interfaces produced:**
- `Motor.leaveWater(maxDistance = 48)`; when `shoreBlock(maxDistance)` is null: `swimToward(target)` for up to 30 s where `target = this.mem.base?.table ?? this.mem.spawn`, then one more `shoreBlock` search; returns `'left' | 'no_shore' | 'stuck' | 'dry'`.
- `flee(_, obs)`: before the `GoalInvert` goto, compute the flee direction (away from the hostile) and, if `this.wetNear(goalCell)` for the cell 8 m along it, rotate the heading up to 4 times; when every heading is wet return `fail('no_path', 'water all around')` so the breaker withholds `flee` and `build_shelter`/`pillar_up`/`fight` remain offered.
- Surface walk in `explore_toward('surface')` (the `GoalXZ` 24 m walk): same wet check on the goal cell, rotate heading, `fail('no_path', 'water ahead')` after 4 turns.
- `summary.js`: `obs.attacker = { kind: 'player' | 'hostile' | 'other', name, dist, sinceS }` for 30 s after a health drop with an entity within 4 m (players included); `obs.nearestHostile` is unchanged. `subtasks.options()`: when `obs.attacker?.kind === 'player'` and no hostile is near, offer `flee(threat)` (never `fight(threat)`); `policy.interruptFor` fires `'threat'` on a new attacker as it does on a hostile crossing 16 m.
- `goals.js`: `go_to` accepts `arg = 'y:<int>'` (`validateGoal` parses -64..320); done when `|pos.y - n| <= 2`; filter keeps `explore_toward(down|deep)` when above, `explore_toward(surface)` when below; teacher accordingly.
- `run_episode.mjs`: wrap the live viewer's `updateEntity` like the recorder does (try/catch per entity); when kev picks `wait` while `goalStack.depth() > 0`, `leaderNote('idle_wait')` at most once per 30 s.
- `placeFloor(cell)`: log one line per neighbour tried with the reason (`no filler`, `no solid neighbour`, `placeBlock: <message>`); `climb_check` prints those lines; fix what the check shows (the likely cause: `placeBlock` against a neighbour the bot is standing in the way of; try the neighbour below first after stepping back one block).

- [ ] Tests: `tests/summary.test.mjs` attacker from a fixture health drop with a player 2 m away -> `obs.attacker.kind === 'player'`, gone after 30 s; `tests/subtasks.test.mjs` with `attacker.kind === 'player'`: `flee(threat)` offered, `fight(threat)` not; `tests/goals.test.mjs` `go_to(y:12)` validate/done/filter; `tests/leader.test.mjs` `idle_wait` fires immediately under `subgoals`; `tests/motor.test.mjs` pure helper `fleeHeading(hostilePos, botPos)` (extract the direction arithmetic as a pure function so it is testable).
- [ ] `node tests/integration/safety_check.mjs`: two new cases in the arena: the bot in a 3-wide pool with shore 20 m away (must leave), and a hostile placed so the flee direction is into water (must turn). PASS.
- [ ] `node tests/integration/climb_check.mjs` with the placeFloor logging; record the cause in the commit message.
- [ ] `npm test`; commit `fix(motor): flee and the surface walk turn from water; leave-water to 48 m then swim home; attackers are threats; go_to y; live-view entity guard`.

### Task 2: `agent/recipes.js` (pure): producer tables and the expander

**Files:** Create `agent/recipes.js`; Test `tests/recipes.test.mjs`.

**Interfaces produced:**
```js
export const MINE = {   // drop item -> how to get it (items already produced by a legacy option are NOT here: see goals.PRODUCERS)
  raw_copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], tool: 'stone', where: 'ore' },
  raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], tool: 'iron', where: 'ore' },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], tool: 'iron', where: 'ore' },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], tool: 'stone', where: 'ore' },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], tool: 'iron', where: 'ore' },
  sand: { blocks: ['sand'], tool: 'none', where: 'surface' }, gravel: { blocks: ['gravel'], tool: 'none', where: 'surface' },
  dirt: { blocks: ['dirt', 'grass_block'], tool: 'none', where: 'surface' }, clay_ball: { blocks: ['clay'], tool: 'none', where: 'surface' },
  cobblestone: null, coal: null, raw_iron: null, diamond: null, flint: null, obsidian: null,   // legacy: goals.PRODUCERS
}
export const SMELT = { copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', glass: 'sand', stone: 'cobblestone', charcoal: 'log', brick: 'clay_ball',
  smooth_stone: 'stone', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton' }   // iron_ingot stays legacy smelt(iron_ingot)
export const HUNT = { white_wool: { mobs: ['sheep'], via: 'shear', tool: 'shears', per: 2 }, mutton: { mobs: ['sheep'], via: 'kill', per: 1 },
  leather: { mobs: ['cow'], via: 'kill', per: 1 }, beef: { mobs: ['cow'], via: 'kill', per: 2 }, porkchop: { mobs: ['pig'], via: 'kill', per: 2 },
  feather: { mobs: ['chicken'], via: 'kill', per: 1 }, chicken: { mobs: ['chicken'], via: 'kill', per: 1 }, string: { mobs: ['spider'], via: 'kill', per: 1 },
  ink_sac: { mobs: ['squid'], via: 'kill', per: 2 } }
export const TOOL_TIER = { none: 0, wood: 1, stone: 2, iron: 3, diamond: 4 }
export function tierHeld(inventory) -> 0..4          // best pickaxe held
export function producerOf(item) -> { kind: 'gather' | 'smelt_item' | 'hunt' | 'craft_item', ... } | null   // legacy PRODUCERS first, then MINE/SMELT/HUNT, then a minecraft-data recipe
export function isItem(name) -> bool                 // minecraft-data 1.20.4 item name
export function expandItem(item, count, inventory, { placed = { crafting_table: false, furnace: false } } = {})
  -> { steps: [{ kind, arg, count }], missing: [string], tree: string }
```
Rules: quantities are **net of the inventory** (an inventory copy is consumed as the walk allocates); a `MINE` step whose `tool` tier exceeds `tierHeld` first adds `craft_item(<tier>_pickaxe, 1)` (expanded in turn); `SMELT` adds `craft_item(furnace, 1)` unless `placed.furnace` or held; a recipe needing a 3x3 grid adds `craft_item(crafting_table, 1)` unless placed or held; `HUNT` with `tool` adds `craft_item(shears, 1)` unless held; for an item with several minecraft-data recipes the first recipe whose ingredients are all producible wins, preferring one whose ingredients are held; `charcoal`'s input `log` means any `*_log` (`gather(log, n)`); a visited set breaks cycles (iron_nugget <-> iron_ingot: producers win over recipes); steps with the same `(kind, arg)` merge their counts keeping the earliest position; a leaf with no producer and no recipe ends the walk with `missing: [leaf]` and `steps: []`; `count` is clamped to 64. `tree` is a short indented text of the walk for the log and the status page.

- [ ] Tests (fixed inventories): `expandItem('compass', 1, { iron_pickaxe: 1, crafting_table: 1 })` -> steps exactly `[gather(iron_ingot, 4), gather(redstone, 1), craft_item(compass, 1)]` (iron_ingot's producer is the legacy `smelt(iron_ingot)`, so it is a `gather` step; ingredients in recipe order); `expandItem('compass', 1, {})` -> an ordered-contains assertion: `craft_item(wooden_pickaxe, 1)` before `craft_item(stone_pickaxe, 1)` before `craft_item(iron_pickaxe, 1)` before `gather(redstone, 1)`, and `craft_item(compass, 1)` last, with exactly one `gather(iron_ingot, n)` step whose `n` is 7 (4 for the compass + 3 for the pickaxe); `expandItem('oak_stairs', 4, { oak_planks: 6 })` -> `[craft_item(oak_stairs, 4)]`; `expandItem('white_bed', 1, { oak_planks: 3, iron_ingot: 2 })` -> `[craft_item(shears, 1), hunt(sheep, 2), craft_item(white_bed, 1)]` (wool 3 at 2 per shear -> 2 sheep); `expandItem('ender_pearl', 1, {})` -> `missing: ['ender_pearl']`, `steps: []`; `expandItem('glass', 3, { sand: 3, furnace: 1 })` -> `[smelt_item(glass, 3)]`; merging: `expandItem('iron_door', 1, {})` has one `gather(iron_ingot, 6)`; `isItem('grass')` false, `isItem('oak_log')` true.
- [ ] Implement; `npm test`; commit `feat(recipes): producer tables and the recipe expander`.

### Task 3: `agent/plans.js` (pure), new goal kinds, GoalStack plan fields

**Files:** Create `agent/plans.js`; Modify `agent/goals.js` (`GOAL_KINDS` += `hunt`, `smelt_item`, `receive`; `go_to(player:<name>)`; `craft_item` and `gather` vocabularies via `recipes.js`; `GoalStack.push` keeps `plan_id`, `step_index`); Test `tests/plans.test.mjs`, `tests/goals.test.mjs`.

**Interfaces produced:**
```js
// plans.js
export class PlanBook {
  constructor()
  add({ title, steps, source, t }) -> plan        // plan = { id, title, source, steps: [{kind,arg,count}], cursor: 0, status: 'pending'|'running'|'blocked'|'done'|'dropped', t, end_t: null, reason: null }
  front() -> plan | null                          // first plan with status pending|running (becomes running)
  currentGoal() -> { kind, arg, count, plan_id, step_index } | null
  advance(ev, t) -> [{ kind: 'plan_step_done'|'plan_done'|'plan_blocked', plan_id, step_index, reason? }]   // ev = { kind: 'goal_done'|'goal_failed', plan_id, step_index, reason }
  skip(t) -> string | null                        // drops the front plan's current step; text for chat
  drop(id, t) -> string | null ; moveFront(id) -> string | null ; clear(t) -> string
  render() -> string[]                            // chat lines: "Plan #3 compass: ✓ mine 4 raw iron ▶ smelt 4 iron · mine 1 redstone · craft compass", then "then: #4 ..."
  toJSON() -> { plans: [...] }
  list() -> plan[]
}
export function planTitle(item, count) -> string   // "compass" / "4 oak stairs"
```
- `goals.js`: `hunt(mob, count)`: done when the drop count rose by `count` since push (store `startCount` on the goal via `obs` at push) or, simpler and chosen: `arg = <drop item>` (`hunt(white_wool, 3)`: done when `have(obs, white_wool) >= count`), filter adds `hunt(<mob>)` for `HUNT[item].mobs` + moves + threat/eat; step fifths; teacher `hunt(<mob>)`; `stuckS` 300. `smelt_item(item, count)`: done `have >= count`; filter adds `smelt_item(<item>)`, `craft_item(furnace)` when none, fuel gathering (`gather_wood`, `mine_coal`) + moves; teacher: furnace first, fuel, then smelt. `receive(item, from)`: `arg = item`, `count`, `from = player name` (stored in the goal); done `have >= count`; filter: `receive(<item>)` only (+ threat/eat); teacher `receive(<item>)`; `stuckS` 90. `go_to(player:<name>)`: done when the player entity is within 3 m; filter `go_to_player(<name>)` + threat/eat; `stuckS` 120. `craft_item(arg)`: any `recipes.isItem(arg)` with a recipe; done `have >= count` (count default 1; armor worn counts); filter adds `craft_item(<arg>)` + the legacy crafting options; `gather(arg)`: any `recipes.producerOf(arg)` of kind `gather` (legacy or `MINE`); filter adds `mine(<block>)` for `MINE` items.
- `validateGoal` learns the new kinds and `receive`'s `from` (a `\w{1,16}` name).
- `GoalStack.push({ ..., plan_id = null, step_index = null })` keeps both on the entry; `pub(g)` includes them, so `goal_done`/`goal_failed` events carry them to the plan book.

- [ ] Tests: `PlanBook` add/front/currentGoal; `advance(goal_done)` moves the cursor and emits `plan_step_done`, the last step emits `plan_done` and `front()` moves to the next plan; `advance(goal_failed, reason 'stuck')` -> `blocked` with the reason and `front()` skips it; `skip` on a 1-step plan finishes it; `moveFront` reorders; `render()` exact strings for a 2-plan book; `toJSON` round-trips. Goals: `validateGoal` accepts `hunt(white_wool, 3)`, `smelt_item(glass, 3)`, `receive(redstone, 4, from Spacers_Choice)`, `go_to(player:Spacers_Choice)`, `craft_item(compass)`, `gather(redstone, 2)`; rejects `hunt(diamond)`, `craft_item(grass)`; the default stack is byte-identical (existing golden tests pass unchanged); a pushed goal with `plan_id` shows it in `pub`.
- [ ] Implement; `npm test`; commit `feat(plans): plan book, new goal kinds, plan ids on the goal stack`.

### Task 4: Leader answers `plan_item | plan_steps | edit | say`, triggers `plan_blocked`

**Files:** Modify `agent/leader.js` (`leaderSchema`, `applyAnswer`, `GOAL_ACTIONS`, `LEADER_SYSTEM_GOALS`, `buildLeaderMessages` PLANS section, `EVENT_TRIGGERS.subgoals` += `plan_blocked` (bypass), `REQUEST_ANSWERS` += the four); Test `tests/leader.test.mjs`.

**Interfaces produced:**
- Schema (goals mode): `action ∈ continue | plan_item | plan_steps | edit | say | push_goal | pop_goal | cannot | <offered id>`; `item: { name: string, count: integer }` (plan_item); `title: string`, `steps: [{ kind: enum PUSHABLE_KINDS, arg: string, count: integer, from: string }]` (plan_steps, 1..8 steps); `edit: { op: enum skip | drop | move_front | clear, plan_id: integer }`; `text: string` (say); `why`.
- `applyAnswer` returns `{ kind: 'plan_item', item, count, why }` when `recipes.isItem(item)` (else `invalid` with reason `unknown item <name>`), `{ kind: 'plan_steps', title, steps, why }` when every step validates (else `invalid` naming the step), `{ kind: 'edit', op, plan_id, why }`, `{ kind: 'say', text }`. These are goal-level: never `stale`.
- Prompt: a `PLANS` section (`planBook.render()` lines or `(none)`), and rules: "For a request that names an item, answer plan_item with the item's minecraft-data name and a count (default 1; 'some' = 8); the code expands it into steps and announces them, so never list the steps yourself. plan_steps only for requests that are not an item (a trip, a sequence of goals). edit changes the plans on request ('skip that', 'forget the compass', 'do the stairs first', 'stop everything'). say answers a question or acknowledges; it is not an action. cannot only for things outside every list." Keep push_goal for single goals.
- `plan_blocked` is passed with `{ plan_id, step, reason }` in the prompt's event list (`renderEvent`).

- [ ] Tests: schema enum contains the four; `applyAnswer` for each kind valid and invalid (`plan_item` grass -> invalid `unknown item grass`; `plan_steps` with a `build(house)` step -> invalid naming step 2); prompt contains `PLANS` with a rendered plan; `plan_blocked` fires immediately in `subgoals`; `REQUEST_ANSWERS` settles requests on `say`.
- [ ] Implement; `npm test`; commit `feat(leader): plan, edit and say answers; plan_blocked trigger`.

### Task 5: `agent/plugins.js`: the executor registry with hot reload

**Files:** Create `agent/plugins.js`, `agent/plugins/README.md` (the contract), `tests/fixtures/plugins/` (a fixture plugin and a broken one); Modify `agent/motor.js` (`Motor.run` falls back to `this.plugins?.get(name)`; `timeouts` from the plugin; the breaker list from `plugin.breaker`), `agent/subtasks.js` (`registerOptionProvider(fn)`: `options(obs)` is unchanged; `goals.js` filters call `pluginOptions(obs, goal)` which the runner wires to the registry), `agent/goals.js` (use it in the filters of Task 3's kinds); Test `tests/plugins.test.mjs`.

**Interfaces produced:**
```js
// a plugin file: agent/plugins/<id>.mjs
export default {
  id: 'mine', timeout: 60, breaker: true,
  options(obs, goal) -> [{ arg, desc }],            // which arguments to offer under this goal (goal = {kind,arg,count} or null)
  preconditions(obs, arg) -> bool,
  async run(motor, arg, obs) -> { result, detail }   // motor is the Motor ctx (check(), goto(), mineKind(), log(), bot, mem, ...)
}
// agent/plugins.js
export class PluginRegistry {
  constructor({ dir, log = () => {} })
  async load() -> { loaded: [id], failed: [{ file, error }] }
  get(name) -> plugin | null                          // null when unknown or disabled
  list() -> [{ id, timeout, enabled, error }]
  watch() / unwatch()                                 // fs.watch on dir, 500 ms debounce, re-import with `?v=<mtime>`
  disable(id, error) ; enabled(id) -> bool
  optionsFor(obs, goal) -> [{ id, name, arg, desc }]  // id = `${plugin.id}(${arg})`, enabled plugins whose preconditions hold
}
```
- `Motor.run(id, obs)`: `const plugin = this.exec[name] ? null : this.plugins?.get(name)`; a plugin runs as `plugin.run(ctx, arg, obs)` with the plugin's `timeout`; a throw inside `run` -> `mapError` as today, and the registry counts it: 3 throws in a row disable the plugin until its file changes. The running subtask keeps the code it started with (the registry swaps the entry; the in-flight call holds the old function).
- Runner (Task 8) creates the registry with `dir = agent/plugins`, calls `load()` then `watch()`, sets `motor.plugins = registry` and `registerOptionProvider((obs, goal) => registry.optionsFor(obs, goal))`; `leader.js` lists plugin ids in the vocabulary line from `registry.list()`.
- The **motor backlog**: `agent/plugins.js` also exports `appendRequestLog(path, { t, name, text, missing })` (JSONL append) used by the runner for every `cannot` and every expander `missing`.

- [ ] Tests (fixture dir under `tests/fixtures/plugins/`): `load()` loads `echo.mjs` and reports `broken.mjs` failed with its error; `get('echo')` runs; `optionsFor` returns `echo(a)` only when preconditions hold; editing the fixture file (write, then `watch()` event) swaps the function (`get('echo').run` returns the new value) using a temp copy of the fixture dir; three throws disable, a file change re-enables; `Motor.run` unit: a stub bot with a registry plugin `echo(x)` returns `{ result: 'ok', detail: 'x' }` (extend the stub used in `tests/motor.test.mjs`).
- [ ] Implement; `npm test`; commit `feat(plugins): executor registry with hot reload and the request log`.

### Task 6: Plugins `mine`, `smelt_item`, `craft_item`

**Files:** Create `agent/plugins/mine.mjs`, `agent/plugins/smelt_item.mjs`, `agent/plugins/craft_item.mjs`, `tests/integration/plugins/mine_check.mjs`, `smelt_item_check.mjs`, `craft_item_check.mjs`; Modify `agent/motor.js` only to export helpers the plugins need (`mineKind`, `findStation`, `fuelPlan`, the `clickWindow`/`settleInventory` machinery via a `craftAny(item, count)` method extracted from `exec.craft`).

- `mine(<block>)`: `MINE` entry by block name (reverse lookup) -> tool tier check (`fail('needs_tool', '<tier> pickaxe')`), `where: 'ore'`: `motor.mineKind(ids, 32, n, gainedPred, block)` with the drop as `gainedPred`; `where: 'surface'`: nearest block within 32 m via `bot.findBlock`, dig with the right tool (shovel if held, else hand for HAND_DIGGABLE), collect; `options(obs, goal)`: the blocks whose drop the goal needs (`gather` of a `MINE` item) and that are remembered or within 32 m (`obs.blocks` names), else the primary block so the option exists and fails `not_found` once (the breaker withholds it after 3).
- `smelt_item(<item>)`: `SMELT[item]` input; furnace via `findStation('furnace', 'furnace')`; fuel via `fuelPlan`; smelts up to 8 per call; `fail('no_furnace')`, `fail('no_fuel')`, `fail('no_materials')`.
- `craft_item(<item>)`: `bot.recipesFor(id, null, 1, table)` where `table = findStation('crafting_table', ...)` when the recipe needs 3x3 (`recipe.requiresTable`); `motor.craftAny(item, 1)`; `fail('no_materials')`, `fail('no_table')`; legacy `CRAFTABLE`/`CHAIN_CRAFTABLE` items keep going through `craft(<item>)` (the plugin refuses them in `preconditions` so kev's lists never show both).

- [ ] Arena checks (each starts its own server on 25571-25573, `/fill` an arena, `/give` the tools/materials, PASS/FAIL): `mine_check`: redstone ore 6 m away with an iron pickaxe -> `+1 redstone`; without the pickaxe -> `needs_tool`; sand patch -> `+n sand` by hand. `smelt_item_check`: 3 sand + 1 coal + a furnace -> `glass 3`. `craft_item_check`: 6 oak planks -> `oak_stairs 4` at a placed table; 4 iron + 1 redstone -> `compass`.
- [ ] `npm test` (plugin files load in the registry test via `load()` on the real dir: add a test that loads `agent/plugins` and expects the ids `mine`, `smelt_item`, `craft_item` enabled); commit `feat(plugins): mine, smelt_item and craft_item executors with arena checks`.

### Task 7: Plugins `hunt`, `go_to_player`, `receive`

**Files:** Create `agent/plugins/hunt.mjs`, `agent/plugins/go_to_player.mjs`, `agent/plugins/receive.mjs`, `tests/integration/plugins/hunt_check.mjs`, `player_check.mjs` (covers both player plugins with a second Mineflayer bot as the player).

- `hunt(<mob>)`: nearest entity of that mob name within 32 m (`bot.nearestEntity`), `via: 'shear'`: equip shears, `bot.activateEntity` within 2 m, collect the wool drops (walk over item entities within 6 m for 5 s); `via: 'kill'`: `bot.pvp.attack`, wait for the entity to die (timeout 30 s), collect drops; result `ok (+n <drop>)` when the drop count rose, `not_found`, `took_damage` as the motor already maps; `options(obs, goal)`: the goal's `HUNT[item].mobs` when one is in `obs.entities`, else the first mob so it can fail `not_found`.
- `go_to_player(<name>)`: `bot.players[name]?.entity`; missing or spectator (no entity) -> `fail('player_gone')`; `goto(GoalFollow(entity, 2))` until within 3 m for 5 s (re-set the goal when the player moves); `no_path` mapped by the motor; timeout 60.
- `receive(<item>)`: the `from` name from the goal (`obs.goalTop.from`: Task 3 puts the top goal's public fields on `obs.goalTop`); `go_to_player` first; then for up to 60 s: walk over item entities of `item` within 6 m (`entity.name === 'item'`, metadata item id), `ok (+n)` when the count rose, else `timeout`; says nothing itself (the runner announces "waiting for your redstone" from the goal start).

- [ ] `player_check.mjs`: a second bot `player_1` joins, walks 12 m away; the kev bot runs `go_to_player(player_1)` -> `ok`; `player_1` drops 4 redstone (`bot.toss`) -> `receive(redstone)` -> `ok (+4)`; `player_1` quits -> `go_to_player` -> `player_gone`. `hunt_check`: `/summon sheep` 6 m away, shears given -> `+2 white_wool` (shearing yields 1-3); `/summon cow` -> kill -> `leather` or `beef` rose.
- [ ] `npm test` (registry loads all six); commit `feat(plugins): hunt, go_to_player and receive executors with arena checks`.

### Task 8: Runner wiring: plan book, chat words, announcements, request log, status page

**Files:** Create `agent/status_page.js` (`startStatusServer({ port, getState }) -> { close }`; `GET /state.json`, `GET /` static HTML polling 1 Hz, `node:http` only); Modify `agent/run_episode.mjs` (`--status-port <n>`; `PlanBook`; the plan-to-stack sync each tick; `goal_done`/`goal_failed` with `plan_id` -> `planBook.advance`; leader results `plan_item` (expand with `recipes.expandItem(item, count, obs.inventory, { placed })`; `missing` -> `cannot` reply naming it + request log), `plan_steps`, `edit`, `say`; chat words `plan|stack|plans` answered by code; announcements: new plan (numbered steps, one or two lines), step start ("step 2/4: smelt 4 glass"), plan done/blocked; `PluginRegistry` load + watch + `motor.plugins` + option provider; `obs.goalTop`; `elog` events `plan_added | plan_step | plan_done | plan_blocked | plan_edit | leader_say`), `agent/leader.js` (`renderEvent` for the new events), `agent/summary.js` (`obs.goalTop`), `scripts/leader_live.sh` (`--status-port 3008`, print the URL).

- Plan-to-stack sync (each tick after `goalStack.update`): `const want = planBook.currentGoal(); const top = goalStack.top(); if (want && (top.plan_id !== want.plan_id || top.step_index !== want.step_index)) { if (top.plan_id != null) goalStack.pop('plan_changed'); goalStack.push({ ...want, source: plan.source, t, obs, plan_id, step_index }) } else if (!want && top.plan_id != null) goalStack.pop('plan_changed')`. A push that `validateGoal` rejects at run time (night rule is a pause, not a rejection) blocks the plan with that reason.
- `getState()` for the page: `{ t, plans: planBook.toJSON(), stack: goalStackView(...), current: { id, elapsedS, progress }, forecasts, chat: last 10 {t, name, text} (requests and the bot's lines), leader: last 10 elog.leader entries (t, action, kind, why), plugins: registry.list() }`.
- Chat splitting: `say()` splits at word boundaries into ≤200-character lines (each through `sanitizeChat(_, 256)`); `whyTail` no longer cuts at 80 (cap 200).

- [ ] Tests: `tests/status_page.test.mjs` (start on an ephemeral port, GET `/state.json` returns the getState object, `/` returns HTML containing `state.json`); `tests/leader.test.mjs` `renderEvent` for `plan_*`; a pure `splitChat(text, 200)` in `leader.js` with tests (word boundary, never empty, ≤200).
- [ ] Smoke (kev.serve mc-v3 + the desktop leader, 8 minutes, `--live-view 3007 --status-port 3008`): join as a player, type `make a compass`: the log shows `plan_added` with steps, the chat announces them, the page shows the stack; type `plan`: the code answers without a leader call; type `skip that`: `plan_edit skip`; type `what can you craft`: a `leader_say` reply. Save the log as `out/plans_smoke.*` and `node scripts/leader_report.mjs plans_smoke`.
- [ ] Commit `feat(runner): plan book wiring, chat plan commands, announcements, request log, status page`.

### Task 9: Report, docs, live script

**Files:** Modify `agent/leader_report.js` + `scripts/leader_report.mjs` (Plans section: each plan, its steps with outcomes, edits; Requests table gains `plan_item`/`plan_steps`/`edit`/`say`; a "Motor backlog" section from `out/<run>.requests.jsonl`; fix the `deaths` field on a crash end: count `death` events, not `meta.deaths`), `CLAUDE.md` (status for 2026-09-26, repo layout lines for `recipes.js`, `plans.js`, `plugins.js`, `plugins/`, `status_page.js`, how-to-run for `--status-port`, the plugin contract in one paragraph, lessons: Paper's `<%s> %s` chat key; the 2-bit leader answers "cannot" with boilerplate unless the prompt maps requests to goals; kev picks `wait` under unseen pushed goals), `docs/superpowers/plans/2026-09-25-randomised-starts.md` (one line: plan steps and the six plugins are goal kinds the start spec can draw); Test `tests/leader_report.test.mjs`.

- [ ] Tests: a fixture log with one plan (3 steps, one blocked) renders the Plans section with the expected rows; a crash-ended fixture with two `death` events reports `deaths 2`.
- [ ] `node scripts/leader_report.mjs live_s3000_1422` still renders (no plans: section says `(none)`); `npm test`; commit `docs+report: plans section, motor backlog, day-6 status`.
