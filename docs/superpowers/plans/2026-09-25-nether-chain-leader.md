# Nether chain + LLM leader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** extend the motor/option layer to a four-stage goal chain (iron tools, full iron armor, diamond tools, a lit nether portal) and run six one-seed, 60-minute episodes where a Qwen3.8-27B leader (thinking on/off × three trigger policies) supervises kev mc-v3, with a per-run decision log for review.

**Architecture:** the chain is a pure `stages.js` module (stage detection, requirement arithmetic, a monotone "chain step" that replaces `techStep` for the forecast question); the option list, teacher, summariser, serializer and motor gain chain-mode branches gated on `obs.goal === 'nether'` so experiment-1 behaviour and the golden serializer text are untouched. The leader is a pure `leader.js` (trigger policy, prompt builder, answer schema with `continue`) plus a runner hook that interrupts the current subtask and starts the leader's pick; kev keeps choosing at 1 Hz between leader calls. New executors reuse the existing primitives (`mineKind`, `goto`, `placeNear`, `digStaircase`, `craft`).

**Tech Stack:** Node 22 ESM, Mineflayer 1.20.4 + pathfinder/collectblock/pvp, Paper 1.20.4 (server console commands for scenario tests), kev.serve (mc-v3), Ollama on the desktop over Tailscale (`qwen38-27b-iq3xxs`, text-only, `think` supported), node:test.

**Spec:** this conversation, 2026-09-25 (user): stages iron tools → full iron armor → diamond tools → nether portal lit; six runs: {no thinking, thinking} × {every 15 s, on subtask end, every 30 s or on interrupt}; one seed each; most promising first; after the first run, ask the user (push notification) and review the clip together. Defaults agreed: tools = pickaxe, sword, axe; 60-minute episodes; runs one at a time; the motor gets the whole chain first.

## Global Constraints

- Experiment-1 behaviour is unchanged when `obs.goal !== 'nether'`: `tests/serialize.test.mjs` golden text and all 84 existing tests keep passing.
- Every option is a declared id `name` or `name(arg)` (`parseOption`), offered only when its preconditions hold, with a `DESC` entry; `wait` is always offered.
- The motor returns only ids from `RESULTS`; every executor has a timeout in `TIMEOUTS`; executors call `this.check()` inside loops.
- The leader's answer is JSON validated against `{continue} ∪ offered ids`; nothing is parsed from free text. `why` and thinking are logged, never read by code.
- kev's state text stays in-distribution: chain mode adds lines only in the goal line and the blocks/inventory lines; no leader text enters kev's state.
- Never `pkill -f` a pattern that appears in the calling shell's command line (use `[k]ev.serve`, `[p]aper-1.20.4-499.jar`).
- Long jobs run detached (`setsid nohup systemd-inhibit ...`), logs under `data/`, episode logs under `out/`.

## Review Focus

1. **Lava under the next staircase step** at diamond depth: `explore_toward(deep)` must stop before the bot walks into lava (test: `digStaircase` refuses when the block below `ahead` is lava). Owner: Task 6.
2. **A leader answer arriving after the subtask it judged has ended**: the override must apply only if the current subtask id still equals the one the leader saw, else be dropped as `stale` (test in Task 8's `leader.test.mjs`: `applyAnswer` returns `stale`). Owner: Task 8.
3. **Armor crafted but not worn**: `craft(iron_helmet)` must equip it (integration check asserts the armor slot). Owner: Task 5.
4. **Water bucket poured on flowing lava** makes cobblestone, not obsidian: `cast_obsidian` targets a lava *source* block (level 0) and reports `target_gone` when none is within range (unit test on the pure `pickLavaSource`). Owner: Task 6.
5. **The chain step going backwards** when the bot dies and loses items: `chainStep` must be monotone in the timeline for the forecast label to make sense; the labeler already uses `step > now.step`, and a drop is simply "not advanced". Test: `chainStep` with a full inventory returns a higher index than with a partial one (Task 1), and `labelDecisions` on a timeline that drops still labels false (Task 7).

---

### Task 1: `agent/stages.js` (pure chain model)

**Files:**
- Create: `agent/stages.js`
- Test: `tests/stages.test.mjs`

**Interfaces:**
- Consumes: `counts(obs)` from `agent/subtasks.js`; `techStep(obs)` from `agent/teacher.js`.
- Produces:
  - `STAGES = ['iron_pickaxe', 'iron_tools', 'iron_armor', 'diamond_tools', 'nether_portal']`
  - `IRON_TOOLS = ['iron_pickaxe','iron_sword','iron_axe']`, `ARMOR = ['iron_helmet','iron_chestplate','iron_leggings','iron_boots']`, `DIAMOND_TOOLS = ['diamond_pickaxe','diamond_sword','diamond_axe']`
  - `INGOTS = {iron_sword:2, iron_axe:3, iron_helmet:5, iron_chestplate:8, iron_leggings:7, iron_boots:4, bucket:3, flint_and_steel:1}`, `DIAMONDS = {diamond_pickaxe:3, diamond_sword:2, diamond_axe:3}`, `STICKS = {iron_sword:1, iron_axe:2, diamond_pickaxe:2, diamond_sword:1, diamond_axe:2}`
  - `stageOf(obs) -> { index: 0..4, id, done: bool }` (index 4 done when `obs.portalLit`)
  - `needs(obs) -> { ingots, diamonds, sticks, obsidian, flint, missing: [item ids still to craft in the current stage] }` (ingots counts only the current and earlier stages' missing items; `owns(item)` counts inventory **and** worn armor `obs.armor`)
  - `chainStep(obs) -> { index, of: 47, text, stage }` monotone: stage 0 = `techStep(obs).index` (1..8), then `10 + k` for stage 1 substeps, `20 + k` stage 2, `30 + k` stage 3, `40 + k` stage 4; `of` is always 47 (the last real step); substeps: iron tools: 11 "get N iron ingots", 12 "craft iron sword", 13 "craft iron axe"; armor: 21 ingots, 22..25 pieces; diamond: 31 "reach diamond level (y -58)" (until y <= -50 or diamond seen), 32 "mine N diamonds", 33..35 tools; portal: 41 "craft a bucket", 42 "fill the bucket with water", 43 "make 10 obsidian from lava", 44 "mine 10 obsidian", 45 "get flint and craft flint and steel", 46 "build the frame", 47 "light the portal"; index 48 = "chain done".
  - `describeChain(obs) -> string` e.g. `Goal chain: iron tools (done), iron armor (2 of 4 pieces), diamond tools, lit nether portal. Current stage: iron armor, step 23 of 47: craft iron leggings (needs 7 ingots, have 3).`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stageOf, needs, chainStep, describeChain, STAGES } from '../agent/stages.js'
import { baseObs } from './fixtures.mjs'

const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const ironKit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
const armorKit = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
const diamondKit = { diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }

test('stages advance with the inventory and worn armor', () => {
  assert.equal(stageOf(chain()).index, 0)
  assert.equal(stageOf(chain({ inventory: { iron_pickaxe: 1 } })).index, 1)
  assert.equal(stageOf(chain({ inventory: ironKit })).index, 2)
  assert.equal(stageOf(chain({ inventory: { ...ironKit, iron_helmet: 1 }, armor: { iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 } })).index, 3)   // worn pieces count
  assert.equal(stageOf(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit })).index, 4)
  assert.equal(stageOf(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit, portalLit: true })).done, true)
})

test('needs counts ingots for the missing items of the current stage only', () => {
  const n = needs(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 1, stick: 1 } }))
  assert.deepEqual(n.missing, ['iron_sword', 'iron_axe'])
  assert.equal(n.ingots, 5 - 1)
  assert.equal(n.sticks, 3 - 1)
  const a = needs(chain({ inventory: ironKit, armor: { iron_helmet: 1 } }))
  assert.equal(a.ingots, 8 + 7 + 4)
  const d = needs(chain({ inventory: { ...ironKit, diamond: 2 }, armor: armorKit }))
  assert.equal(d.diamonds, 8 - 2)
  const p = needs(chain({ inventory: { ...ironKit, ...diamondKit, obsidian: 4, bucket: 1 }, armor: armorKit }))
  assert.equal(p.obsidian, 6); assert.equal(p.ingots, 1); assert.equal(p.flint, 1)
})

test('chainStep is monotone across the chain and reuses the tech tree in stage 0', () => {
  assert.equal(chainStep(chain()).index, 1)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1 } })).index, 11)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 5, stick: 3 } })).index, 12)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 3, stick: 2 } })).index, 13)
  assert.equal(chainStep(chain({ inventory: ironKit })).index, 21)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: 70, z: 0 } })).index, 31)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: -58, z: 0 } })).index, 32)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit })).index, 41)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, water_bucket: 1 }, armor: armorKit })).index, 43)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, obsidian: 10, flint_and_steel: 1 }, armor: armorKit })).index, 46)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit, portalLit: true })).index, 48)
  // losing items drops the step; the labeler treats that as "not advanced"
  assert.ok(chainStep(chain({ inventory: ironKit })).index > chainStep(chain({ inventory: { iron_pickaxe: 1 } })).index)
})

test('describeChain reads as one line', () => {
  const s = describeChain(chain({ inventory: { ...ironKit, iron_ingot: 3 }, armor: { iron_helmet: 1, iron_chestplate: 1 } }))
  assert.match(s, /^Goal chain: iron tools \(done\), iron armor \(2 of 4 pieces\), diamond tools, lit nether portal\. Current stage: iron armor, step 2[0-9] of 47: /)
  assert.equal(STAGES.length, 5)
})
```

- [ ] **Step 2: Run to verify they fail**: `node --test tests/stages.test.mjs` → fails, module not found.
- [ ] **Step 3: Implement `agent/stages.js`** per the interface. `owns(obs, item) = (obs.inventory?.[item] || 0) + (obs.armor?.[item] || 0)`. Stage 4 substep from inventory: 41 unless `bucket || water_bucket`; 42 if `bucket` and no `water_bucket`, unless obsidian >= 10; 43 if `water_bucket` and obsidian in range (`obs.blocks` has `obsidian`) < 10 and inventory obsidian < 10; 44 if obsidian seen nearby and inventory obsidian < 10; 45 if obsidian >= 10 and no `flint_and_steel`; 46 if obsidian >= 10 and flint_and_steel and no `obs.portalFrame`; 47 if `obs.portalFrame` and not lit. Keep the substep resolution tolerant: when neither obsidian is seen nor a water bucket held, but obsidian >= 10, skip to 45.
- [ ] **Step 4: Run**: `node --test tests/stages.test.mjs` → PASS.
- [ ] **Step 5: Stage for commit** (`git add agent/stages.js tests/stages.test.mjs`; commits happen at the user's checkpoint).

### Task 2: chain-mode options in `agent/subtasks.js`

**Files:**
- Modify: `agent/subtasks.js` (`CRAFTABLE`, `TABLE_ITEMS`, `canCraft`, `counts`, `DESC`, `options`)
- Test: `tests/subtasks.test.mjs` (append)

**Interfaces:**
- Consumes: `needs`, `stageOf` from Task 1.
- Produces: in chain mode (`obs.goal === 'nether'`) the ids `craft(iron_sword|iron_axe|iron_helmet|iron_chestplate|iron_leggings|iron_boots|diamond_pickaxe|diamond_sword|diamond_axe|bucket|flint_and_steel)`, `mine_diamond`, `mine_gravel`, `mine_obsidian`, `explore_toward(deep)`, `fill_bucket(water)`, `cast_obsidian`, `build_portal`, `light_portal`. `counts(obs)` gains `diamonds, obsidian, flint, bucket, waterBucket, flintAndSteel, hasIronPickaxe, hasDiamondPickaxe`. Existing experiment-1 caps are replaced in chain mode by `needs()` (mine_iron offered while `rawIron + ingots < needs.ingots`; never more than 40 total).

- [ ] **Step 1: Failing tests** (append to `tests/subtasks.test.mjs`):

```js
const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
test('chain mode: iron tool and armor recipes are offered when the ingots are there and a table is near', () => {
  const o = chain({ inventory: { iron_pickaxe: 1, iron_ingot: 8, stick: 4, crafting_table: 1 } })
  const ids_ = ids(o)
  for (const id of ['craft(iron_sword)', 'craft(iron_axe)', 'craft(iron_helmet)']) assert.ok(ids_.includes(id), id)
  assert.ok(ids_.includes('craft(iron_chestplate)'), 'affordable with 8 ingots')
})
test('chain mode: diamond, gravel, obsidian and the portal steps follow their preconditions', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
  const armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  assert.ok(ids(chain({ inventory: kit, armor, pos: { x: 0, y: 40, z: 0 } })).includes('explore_toward(deep)'))
  assert.ok(ids(chain({ inventory: kit, armor, blocks: [{ name: 'diamond_ore', dist: 9, dir: 'north', dy: 0, reachable: true }] })).includes('mine_diamond'))
  assert.ok(!ids(chain({ inventory: { stone_pickaxe: 1 }, blocks: [{ name: 'diamond_ore', dist: 9, dir: 'north', dy: 0, reachable: true }] })).includes('mine_diamond'), 'diamond needs an iron pickaxe')
  const d = { ...kit, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
  assert.ok(ids(chain({ inventory: { ...d, bucket: 1 }, armor, blocks: [{ name: 'water', dist: 6, dir: 'east', dy: 0, reachable: true }] })).includes('fill_bucket(water)'))
  assert.ok(ids(chain({ inventory: { ...d, water_bucket: 1 }, armor, blocks: [{ name: 'lava', dist: 6, dir: 'east', dy: 0, reachable: true }] })).includes('cast_obsidian'))
  assert.ok(ids(chain({ inventory: d, armor, blocks: [{ name: 'obsidian', dist: 3, dir: 'east', dy: 0, reachable: true }] })).includes('mine_obsidian'))
  assert.ok(ids(chain({ inventory: { ...d, obsidian: 4 }, armor, blocks: [{ name: 'gravel', dist: 5, dir: 'east', dy: 0, reachable: true }] })).includes('mine_gravel'))
  assert.ok(ids(chain({ inventory: { ...d, obsidian: 10, cobblestone: 4, flint_and_steel: 1 }, armor })).includes('build_portal'))
  assert.ok(ids(chain({ inventory: { ...d, flint_and_steel: 1 }, armor, portalFrame: { dist: 2, dir: 'north', dy: 0 } })).includes('light_portal'))
})
test('experiment-1 mode never offers chain options', () => {
  const o = baseObs({ inventory: { iron_pickaxe: 1, iron_ingot: 8, stick: 4, crafting_table: 1 } })
  assert.ok(!ids(o).some(id => id.includes('iron_sword') || id === 'mine_diamond'))
})
```

- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.** In `options(obs)`: after the existing list, `if (obs.goal === 'nether') addChain(obs, out, c)`. `addChain`: iron recipes via `canCraft` (extend the switch: `iron_sword: ingots>=2 && sticks>=1`, `iron_axe: 3 && 2`, armor by `INGOTS`, `diamond_*` by `DIAMONDS`/`STICKS`, `bucket: ingots>=3`, `flint_and_steel: ingots>=1 && flint>=1`), all `TABLE_ITEMS` except bucket? (bucket is a 3x3 recipe: table needed; add all to `TABLE_ITEMS`). `mine_iron` in chain mode: offered when iron seen/remembered and `rawIron + ingots < needs.ingots`. `mine_diamond` when `hasIronPickaxe` and a `diamond_ore` block within 32 (or `obs.memory.diamondSeen`) and `diamonds < needs.diamonds`. `explore_toward(deep)` when `hasIronPickaxe`, stage >= 3, `pos.y > -50`. `mine_gravel` when stage 4, `flint === 0`, no flint_and_steel, gravel within 16. `fill_bucket(water)` when `bucket >= 1` and water within 24 (or `memory.waterSeen`). `cast_obsidian` when `waterBucket` and lava within 24 (or `memory.lavaSeen`) and `obsidian < 10`. `mine_obsidian` when `hasDiamondPickaxe`, obsidian block within 16, `obsidian < 10`. `build_portal` when `obsidian >= 10 && blocks >= 4 && flintAndSteel && !obs.portalFrame`. `light_portal` when `obs.portalFrame && !obs.portalLit && flintAndSteel`. `DESC` entries for each (one line each, imperative, with the recipe quantities). The gathering caps in stage 0 stay as they are.
- [ ] **Step 4: Run all** `npm test` → PASS (golden serializer untouched).

### Task 3: observation and state text in chain mode

**Files:**
- Modify: `agent/summary.js` (`KIND_SCAN`, `EpisodeMemory`, `summarize`), `agent/serialize.js` (goal line, `describeInventory` order, `BLOCK_WORD`), `agent/questions.js` (`buildQuestions` uses `chainStep` in chain mode), `agent/run_episode.mjs` (`--goal`), `tests/fixtures.mjs` (add `armor: {}, portalLit: false, portalFrame: null`)
- Test: `tests/serialize.test.mjs` (append a chain-mode golden), `tests/summary.test.mjs` (append), `tests/questions.test.mjs` (append)

**Interfaces:**
- Produces on `obs`: `armor: {iron_helmet:1,...}` (worn), `portalLit: bool` (a `nether_portal` block within 16 m), `portalFrame: {dist,dir,dy,pos} | null` (an `obsidian` block within 16 m whose neighbourhood matches a frame column: 3 obsidian stacked vertically), `memory.diamondSeen | lavaSeen | waterSeen` like `ironSeen`; block scan adds `diamond_ore/deepslate_diamond_ore` 32, `gravel` 16, `obsidian` 16, `nether_portal` 16, water/lava widened to 24. `EpisodeMemory` gains `seen = { diamond, lava, water }` with `saw(kind, pos, t)`.
- Serializer: when `obs.goal === 'nether'` the first line is `Minecraft survival, day N. ${describeChain(obs)}` and `describeInventory` lists armor worn as `wearing: iron helmet, iron boots.` after `holding:`; `BLOCK_WORD` gains `diamond_ore: 'diamond ore'`, `gravel`, `obsidian`, `nether_portal: 'nether portal'`.
- Questions: `const step = obs.goal === 'nether' ? chainStep(obs) : techStep(obs)`; `subgoal_succeeds_60s` asked while `step.index < 48`; `iron_found_3min` unchanged (stage 0 step 5 only).
- Runner: `--goal iron_pickaxe|nether` (default `iron_pickaxe`), passed into `summarize` ctx; timeline `step` = the same step function; `done` = chain done in nether mode; the `morning` end condition is skipped in nether mode; `goal_done` event when the chain completes; `stage_done` events `{t, kind:'stage_done', stage}` when `stageOf(obs).index` increases.

- [ ] **Step 1: Failing tests.** Chain golden (append to `tests/serialize.test.mjs`): build `chainObs = baseObs({ goal:'nether', inventory:{ iron_pickaxe:1, iron_sword:1, iron_ingot:3, stick:2 }, armor:{ iron_helmet:1 }, blocks:[{ name:'diamond_ore', dist:12, dir:'west', dy:-3, reachable:false }] })` and assert `serialize(chainObs).split('\n')[0] === 'Minecraft survival, day 1. Goal chain: iron tools (done), iron armor (1 of 4 pieces), diamond tools, lit nether portal. Current stage: iron armor, step 21 of 47: get 19 iron ingots (have 3).'` and that the text contains `wearing: iron helmet.` and `diamond ore 12 m west, 3 m below you`. Questions test: `buildQuestions(chainObs, {decision:true}).qs.subgoal_succeeds_60s.instructions` mentions `get 19 iron ingots`. Summary test: `describe`-level unit for `portalFrameNear(blocks)` (pure helper exported from summary.js: given a list of obsidian positions, returns the frame anchor when three are stacked).
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** as specified. In `summarize`, worn armor: `bot.inventory.slots[5..8]` (head, torso, legs, feet) by name. `portalLit`: `bot.findBlock({ matching: nether_portal id, maxDistance: 16 })`. `portalFrame`: `findBlocks obsidian maxDistance 16 count 16` → `portalFrameNear`.
- [ ] **Step 4: Run `npm test`** → PASS including the original golden.

### Task 4: chain teacher (`agent/teacher.js`)

**Files:**
- Modify: `agent/teacher.js` (`pick` delegates to `pickChain` when `obs.goal === 'nether'` and `stageOf(obs).index >= 1`)
- Test: `tests/teacher.test.mjs` (append)

**Interfaces:** `teacherSubtask(obs)` unchanged signature; in chain mode returns the scripted next subtask for stages 1–4 (threat/eat rules first, as now).

- [ ] **Step 1: Failing tests:**

```js
const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }, armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
test('chain teacher: crafts when it can, otherwise gets iron the same way as step 5-6', () => {
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 2, stick: 1, crafting_table: 1 } })), 'craft(iron_sword)')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1, raw_iron: 3, coal: 2, furnace: 1 } })), 'smelt(iron_ingot)')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1 }, blocks: [{ name: 'iron_ore', dist: 10, dir: 'north', dy: 0, reachable: true }] })), 'mine_iron')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1 }, pos: { x: 0, y: 60, z: 0 } })), 'explore_toward(down)')
})
test('chain teacher: diamonds', () => {
  assert.equal(teacherSubtask(chain({ inventory: kit, armor, pos: { x: 0, y: 30, z: 0 } })), 'explore_toward(deep)')
  assert.equal(teacherSubtask(chain({ inventory: kit, armor, pos: { x: 0, y: -58, z: 0 }, blocks: [{ name: 'diamond_ore', dist: 8, dir: 'east', dy: 0, reachable: true }] })), 'mine_diamond')
  assert.equal(teacherSubtask(chain({ inventory: { ...kit, diamond: 3, stick: 2, crafting_table: 1 }, armor })), 'craft(diamond_pickaxe)')
})
test('chain teacher: portal', () => {
  const d = { ...kit, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
  assert.equal(teacherSubtask(chain({ inventory: { ...d, iron_ingot: 3, crafting_table: 1 }, armor })), 'craft(bucket)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, bucket: 1 }, armor, blocks: [{ name: 'water', dist: 6, dir: 'east', dy: 0, reachable: true }] })), 'fill_bucket(water)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, water_bucket: 1 }, armor, blocks: [{ name: 'lava', dist: 6, dir: 'east', dy: 0, reachable: true }] })), 'cast_obsidian')
  assert.equal(teacherSubtask(chain({ inventory: d, armor, blocks: [{ name: 'obsidian', dist: 3, dir: 'east', dy: 0, reachable: true }] })), 'mine_obsidian')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, iron_ingot: 1 }, armor, blocks: [{ name: 'gravel', dist: 5, dir: 'east', dy: 0, reachable: true }] })), 'mine_gravel')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, iron_ingot: 1, flint: 1, crafting_table: 1 }, armor })), 'craft(flint_and_steel)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, cobblestone: 4, flint_and_steel: 1 }, armor })), 'build_portal')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, flint_and_steel: 1 }, armor, portalFrame: { dist: 2, dir: 'north', dy: 0 } })), 'light_portal')
})
```

- [ ] **Step 2: Run** → fail. **Step 3: Implement `pickChain`** with helpers `getIron()` (smelt if raw iron + fuel + furnace/carried; else mine_iron if seen; else coal if none; else `explore_toward(down)` above IRON_Y, else `explore_toward(surface)` when `lastPath` failed twice), `craftNext(items)` = first affordable via `needTable`, `sticks()` as in `pick`. Stage 3: `craftNext(DIAMOND_TOOLS)` if diamonds allow, else `mine_diamond` if seen, else `explore_toward(deep)` when `y > -50`, else `explore_toward(deep)` (it tunnels at depth). Stage 4 follows the test order. Unreachable states return `wait`.
- [ ] **Step 4: `npm test`** → PASS.

### Task 5: motor, part 1: recipes, armor, diamonds, gravel, obsidian, deep exploration

**Files:**
- Modify: `agent/motor.js` (`TIMEOUTS`, `craft` (equip armor), new executors `mine_diamond`, `mine_gravel`, `mine_obsidian`, `explore_toward('deep')`, `digStaircase` lava-below check), `agent/subtasks.js` (nothing new)
- Create: `tests/integration/chain_check.mjs`
- Test: `tests/motor.test.mjs` (pure helpers only)

**Interfaces:**
- `TIMEOUTS` adds `mine_diamond: 120, mine_gravel: 60, mine_obsidian: 150, fill_bucket: 40, cast_obsidian: 60, build_portal: 90, light_portal: 20`; `explore_toward` stays 40 (deep runs are chained by the driver).
- `DIAMOND_Y = -58`; `explore_toward('deep')`: above `IRON_Y` behaves like `down`; between, `digStaircase(6)` toward `DIAMOND_Y` with lava/water checks on the three dug cells **and** the cell below the step; at `y <= DIAMOND_Y + 4` tunnels 12 m horizontally (as `down` does at iron level).
- `craft(item)`: after a successful armor craft, `bot.equip(item, slot)` with slot from `{iron_helmet:'head', iron_chestplate:'torso', iron_leggings:'legs', iron_boots:'feet'}`.
- `mine_diamond`: `mineKind(diamondIds, 32, needed, n => n === 'diamond', 'diamond ore')` with a remembered-position fallback like `mine_iron`; `mine_gravel`: dig up to 12 gravel within 16 m, stop when `flint` count rose, result `ok('+1 flint')` / `not_found` / `failed('no flint from N gravel')`; `mine_obsidian`: `mineKind(obsidianIds, 16, 10, n => n === 'obsidian', 'obsidian')` and requires `diamond_pickaxe` (`canHarvest` check already fails with `no_materials` otherwise).
- `chain_check.mjs`: like `motor_check.mjs`, but builds scenarios with server console commands (`/give`, `/setblock`, `/fill`) and asserts results; prints PASS/FAIL. Scenarios: (a) give 32 iron ingots, 8 sticks, a table → craft sword, axe, four armor pieces → assert `bot.inventory.slots[5..8]` worn; (b) give 8 diamonds → craft diamond pickaxe, sword, axe; (c) `/setblock` a diamond ore 5 m away → `mine_diamond` ok, +1 diamond; (d) `/fill` a 3x1x3 gravel patch → `mine_gravel` (ok or `failed` with flint chance; assert the gravel is gone); (e) `/setblock` obsidian ×3 → `mine_obsidian` ok (with the diamond pickaxe); (f) `explore_toward(deep)` twice from the surface → y decreased, result ok or timeout only.

- [ ] **Step 1: Write `chain_check.mjs`** (scenarios a–f) and a pure test for the lava check: extract `unsafeToStep(bot, ahead)` as a method that returns the liquid block name or null; test with a fake `bot.blockAt` map in `tests/motor.test.mjs` (the file already fakes a bot for the click serialiser).
- [ ] **Step 2: Run `node tests/integration/chain_check.mjs --seed chain-1`** → FAIL (unknown subtask).
- [ ] **Step 3: Implement** the executors and the lava-below check.
- [ ] **Step 4: Run the check** → PASS; run `node tests/integration/motor_check.mjs --seed motor-1` → still PASS; `npm test` → PASS.

### Task 6: motor, part 2: buckets, obsidian casting, portal frame, lighting

**Files:**
- Modify: `agent/motor.js` (`fill_bucket`, `cast_obsidian`, `build_portal`, `light_portal`, helpers `pickLavaSource`, `placeAt`, `standNear`), `agent/summary.js` (`portalFrameNear` already from Task 3)
- Modify: `tests/integration/chain_check.mjs` (scenarios g–j)
- Test: `tests/motor.test.mjs` (pure `pickLavaSource`, `portalLayout`)

**Interfaces:**
- `pickLavaSource(bot, maxDistance)`: nearest `lava` block whose state is a source (`block.getProperties().level === 0` or `block.metadata === 0`), else null. **Pure variant** `isLavaSource(block)` exported for the test.
- `portalLayout(origin, axis)` (pure, exported): returns `{ obsidian: [Vec3...10], filler: [Vec3...4], inside: Vec3 }` for a frame standing on `origin` (the bottom-left filler position) along `axis` `'x'|'z'`: bottom row obsidian at (1,0),(2,0); columns at (0,1..3),(3,1..3); top row (1,4),(2,4); fillers at the four corners; `inside` = (1,1).
- `fill_bucket(fluid)`: requires `bucket`; target = nearest source of `fluid` within 24 (water: any `water` block with level 0); `standNear(target, 2)`; `bot.equip(bucket,'hand')`; `bot.lookAt(target.position.offset(0.5,0.5,0.5), true)`; `bot.activateItem()`; `settleInventory`; result ok if `water_bucket|lava_bucket` count rose, else `failed`.
- `cast_obsidian`: requires `water_bucket`; `src = pickLavaSource(24)` else `target_gone`; go to a standing cell **above or level with** the source, at distance 2–3 (GoalNear with `maxDropDown` respected); look at the source's top face; `activateItem()` (pours water); wait 40 ticks; count obsidian within 6 m before/after; then pick the water back: find the placed `water` source within 4 m, look at it, `activateItem()` (needs the empty bucket equipped: it is, since the water bucket became a bucket); result `ok('+N obsidian cast')` when N > 0 else `failed`.
- `build_portal`: requires `obsidian >= 10`, `cobblestone|cobbled_deepslate|dirt >= 4`, `flint_and_steel` not required to build; choose `origin` = a solid block 3 m ahead along the current heading whose 4x1 row and 4x5 plane above are air (probe with `blockAt`; try the four headings; else dig/fill not attempted: `failed('no flat spot')`); place bottom fillers and obsidian on the ground row via `placeAt(pos, item)` (reference = block below, face up), then columns bottom-up, then the top row referenced from the column tops sideways (face ±axis) — `placeAt` chooses any adjacent solid reference automatically. Remember `mem.portal = { origin, axis }`. Result ok when all 10 obsidian positions hold obsidian.
- `light_portal`: requires `flint_and_steel` and `obs.portalFrame` (or `mem.portal`); stand 2 m in front of `inside`; equip flint_and_steel; `bot.activateBlock(bot.blockAt(inside.offset(0,-1,0)))` (the bottom obsidian, top face); wait 20 ticks; ok when a `nether_portal` block exists within 6 m.
- `placeAt(pos, itemName)`: if `blockAt(pos)` is already `itemName` return true; find a reference among the six neighbours that is a solid block; move within 4 m with line of sight (`GoalNear(pos, 3)`); equip; `bot.placeBlock(ref, pos.minus(ref.position))`; verify.

- [ ] **Step 1: Failing pure tests**: `isLavaSource({ name:'lava', getProperties: () => ({ level: 0 }) }) === true`, level 2 → false; `portalLayout(new Vec3(0,64,0),'x')` returns 10 obsidian positions incl. `(1,64,0)` and `(0,66,0)`, 4 fillers incl. `(0,64,0)` and `(3,68,0)`, inside `(1,65,0)`. Integration scenarios (g) `/setblock` a 3x3 water pool, give bucket → `fill_bucket(water)` ok; (h) `/fill` a 2x1x2 lava source pool 6 m away (at the same level, with a stone rim) → `cast_obsidian` ok with ≥ 2 obsidian; (i) give 10 obsidian + 4 cobblestone → `build_portal` ok, then `summarize().portalFrame` non-null; (j) give flint_and_steel → `light_portal` ok and `summarize().portalLit === true`.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: `chain_check` PASS, `npm test` PASS.** Record the check with `--video` once and keep `out/chain_check.mp4` for the review.

### Task 7: runner in chain mode end-to-end (teacher driver)

**Files:**
- Modify: `agent/run_episode.mjs` (`--goal nether` wiring from Task 3, stage events, end conditions), `agent/gen_data.mjs` (pass `--goal`), `agent/logger.js` (`toRecords` unchanged), `scripts/drive_summary.py` (print `stage` reached and per-stage times when `meta.goal === 'nether'`)
- Test: `tests/questions.test.mjs` (labeler on a dropping timeline), manual: one 20-minute teacher episode.

- [ ] **Step 1: Failing test**: `labelDecisions([{t:0, qids:['subgoal_succeeds_60s'], labels:{}}], [{t:0, step:21}, {t:30, step:11}, {t:61, step:11}])` → label `false` (a drop is not an advance).
- [ ] **Step 2: Run** → it already passes or fails; keep it as the pin.
- [ ] **Step 3: Wire the runner**: `goal` option; `stepFn`; `stage_done` events; `done` from `stageOf(obs).done`; no morning end in nether mode; `meta.goal`, `meta.stage_reached`, `meta.stage_times` in `finish`.
- [ ] **Step 4: Run** `node agent/run_episode.mjs --seed 3000 --port 25580 --policy teacher --goal nether --minutes 25 --out chain_teacher_s3000 --video` → reaches at least stage 2 (armor) and prints stage events; `scripts/drive_summary.py --prefixes chain_teacher --seeds 1 --seed0 3000` shows the stage line. Fix whatever the live run shows before moving on (this is the motor-layer shakedown the user asked for).

### Task 8: `agent/leader.js` (pure) + runner hook + `askLeader`

**Files:**
- Create: `agent/leader.js`
- Modify: `agent/planner.js` (`askLeader` beside `askPlanner`: same transport, `think` option, `num_predict` 1500 when thinking, `num_ctx` 8192, returns `thinking` text), `agent/run_episode.mjs` (`--leader off|periodic15|events|periodic30_interrupts`, `--leader-think`, `--leader-model`, `--leader-url`), `agent/logger.js` (decision record gains `leader: {t_asked, t_applied, action, why, thinking_chars, latency_ms, stale}`)
- Test: `tests/leader.test.mjs`

**Interfaces:**
- `TRIGGERS = ['periodic15', 'events', 'periodic30_interrupts']`
- `class LeaderTrigger { constructor(mode); due({ t, event, inFlight }) -> bool }`: `periodic15`: `t - lastAsk >= 15`; `events`: `event ∈ {subtask_done, subtask_error, death}`; `periodic30_interrupts`: `t - lastAsk >= 30 || event ∈ {interrupt, death}`; never while `inFlight`; `asked(t)` records.
- `buildLeaderMessages({ stateText, chainText, options, current, history, forecasts, forecastTrend, subtaskStats, ownHistory, minutesLeft, deaths })` → `[system, user]`. System prompt: role, the chain with recipes and quantities per stage, the rules (continue when the bot is making progress; override only with a reason; never repeat an override that just failed; safety rules), answer format `{"action": "continue" | "<subtask id>", "why": "..."}`.
- `leaderSchema(options)` = `{ action: enum ['continue', ...ids], why: string }`.
- `applyAnswer({ answer, currentId, askedCurrentId, offered })` → `{ kind: 'continue' | 'override' | 'stale' | 'invalid', id }`: `stale` when `currentId !== askedCurrentId`; `invalid` when the id is not in `offered` or equals `currentId` (treated as continue).
- Runner hook: on `due`, snapshot `{ obs, text, options, currentId }`, call `askLeader` (async, not awaited by the tick); on resolve → `applyAnswer`; `override`: `elog.event({kind:'leader_override', ...})`, `motor.interrupt('leader')`, then `startSubtask(id, 'leader', obs)` as soon as the motor is free (the next tick's `decide` sees `pendingLeader` and uses it instead of kev's choice, source `leader`); `continue`/`stale`/`invalid` are logged as events. Every leader call is appended to `elog.leader` (new array in the log JSON) with prompt hash, answer, why, thinking (≤ 4000 chars), latency, tokens.

- [ ] **Step 1: Failing tests** for `LeaderTrigger` (each mode's due/not-due cases, in-flight suppression), `applyAnswer` (four kinds), `buildLeaderMessages` (contains the chain text, the option ids, the forecast trend line, the own-history lines; system prompt under 2,500 characters of rules is not required, but assert it mentions `"continue"`), `leaderSchema` enum includes `continue`.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: `npm test` PASS.**
- [ ] **Step 5: Smoke**: `node agent/run_episode.mjs --seed 3000 --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --goal nether --leader events --leader-model qwen38-27b-iq3xxs --leader-url http://100.109.91.95:11434 --minutes 5 --out leader_smoke` with kev.serve (mc-v3) up → the log has ≥ 3 leader calls with parsed actions and no `invalid`.

### Task 9: reports, the run script, mc-v3 on the laptop, run 1 and the checkpoint

**Files:**
- Create: `scripts/leader_report.mjs` (per run: stage reached and times, deaths, leader calls, latency p50/p90, action mix, override outcomes (did the overridden subtask's replacement end ok?), agreement with kev's choice at decision points, thinking chars; writes `reports/leader/<run>.md` with the full decision log: `t | stage | current subtask | kev choice | leader action | why`), `scripts/leader_runs.sh` (serves mc-v3 on 8009, runs the six configs in order on seed 3000, 60 min, `--video`, one at a time, report after each; order: `events`, `events+think`, `periodic30_interrupts`, `periodic30_interrupts+think`, `periodic15`, `periodic15+think`)
- Modify: `CLAUDE.md` (repo layout, how to run, status)

- [ ] **Step 1: Fetch mc-v3**: `ssh homepc 'docker exec mckev tar czf /work/minecraft-kev/data/mc-v3.tgz -C /work/overcooked-kev/kev/runs mc-v3'` then `scp homepc:C:/Users/rneel/Neelay/Coding/minecraft-kev/data/mc-v3.tgz /tmp/...` and extract into `../overcooked-kev/kev/runs/`. Verify `kev.serve --run runs/mc-v3` answers `scripts/warm_kev.mjs`.
- [ ] **Step 2: Write `leader_report.mjs`** and test it on `out/leader_smoke.json` (Task 8).
- [ ] **Step 3: Write `leader_runs.sh`**; launch it detached; wait for run 1 (`out/leader_events_s3000.json`); build its report.
- [ ] **Step 4: AskUserQuestion** with the run-1 summary (stage reached, deaths, leader call count, one or two notable decisions), the clip path (`out/leader_events_s3000.mp4`, viewer `python3 viewer/serve.py 8085` → `?run=leader_events_s3000`), and the options: continue the remaining five as planned / change the order / stop and revise the prompt. Also ask whether to commit the branch.
- [ ] **Step 5: Update CLAUDE.md** with the chain, the leader flags, the run script and the day's status.
