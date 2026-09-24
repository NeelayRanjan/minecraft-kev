# Experiment 1: iron pickaxe from spawn (text) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mineflayer bot reaches an iron pickaxe from spawn, driven by kev-0.8b's typed `next_subtask` choice, while kev emits calibrated forecasts (`subgoal_succeeds_60s`, `iron_found_3min`, `damage_next_20s`, `survive_until_morning`) that are logged, labelled post hoc from game truth, and scored with reliability diagrams.

**Architecture:** One Node process per episode: a scripted motor layer (Mineflayer + pathfinder + collectblock + pvp) executes one typed subtask at a time and returns a typed result; once per second a pure `summarize(bot)` produces a plain `obs` object; pure modules (`teacher`, `serialize`, `questions`, `subtasks`) turn `obs` into state text, option lists, and labels; a 1 Hz loop asks kev (or uses one-hot teacher answers) and logs every distribution. Each episode runs on its own Paper server instance (own port, own seed) started by `server_ctl`. Python (the parent project's kev venv) splits, trains, evaluates and plots.

**Tech Stack:** Node 24 (ESM, `node:test`), mineflayer 4.39, mineflayer-pathfinder 2.4.5, mineflayer-collectblock 1.6, mineflayer-pvp 1.3, prismarine-viewer 1.33 headless, Paper 1.20.4-499 on Temurin 21, kev (`../overcooked-kev/kev`, `.venv`), `split_data.py` from kev's fine-tune skill.

**Spec:** `MC_Claude.md` (design of record; sections "Lessons", "Architecture", "Labels", "State serializer", "Question schema", "Infrastructure", "Experiment 1", "Conventions").

## Global Constraints

- Minecraft 1.20.4 everywhere: `createBot({version: '1.20.4'})`, `minecraft-data('1.20.4')`, Paper 1.20.4-499, Java from `tools/jdk-21*`.
- Motor layer scripted, decision layer typed, no LLM in the per-tick loop. Never parse model output text.
- One serializer and one question module shared by data generation and play (`agent/serialize.js`, `agent/questions.js`), byte-identical text at train and serve time.
- Every option list includes an escape (`wait` always; `flee(threat)` whenever a hostile is near) and only offers options whose preconditions hold.
- Motor layer returns typed results only: `ok | no_path | timeout | target_gone | took_damage | interrupted | not_found | no_table | no_furnace | no_materials | failed | died`.
- State text budget: under 1400 characters (≈384 tokens); serializer caps lists. Never emit `<|` or `|>`.
- Labels: choice = option name string; noul = `true`/`false`; score = level index from 0. Censored post-hoc labels are dropped from the training record, and the censoring rate is reported.
- Splits are episode-disjoint by seed (`--holdout` file of separate seeds); temperature is fitted on `calibration.jsonl`, never on `development.jsonl`.
- Training recipe: `--init_from jaredpalmer/kev-0.8b --base Qwen/Qwen3.5-0.8B-Base --base_revision dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68 --replay 1000 --epochs 1 --lr 2e-5 --batch 1 --accum 8 --perm_kl 0.5 --dtype bf16 --checkpointing 1 --max_state 512`.
- Report accuracy, base rate, ECE and censoring rate together for every question.
- Shell: stop servers with `pkill -f '[p]aper-1.20.4'` (bracket pattern), long jobs via `setsid nohup`.

## Review Focus

1. **Spawn with no tree in sight.** `options(obs)` must still offer `explore_toward(surface)` and the teacher must pick it, never `wait` forever. (Test in Task 3: obs with empty `blocks` → teacher returns `explore_toward(surface)`.)
2. **Death mid-step.** The bot respawns at world spawn with an empty inventory; the tech step index drops back, the current subtask is aborted with `died`, and post-hoc labels for the seconds before death must still be computed (damage → `death`, step → `false` unless completed). (Tests in Task 5 and Task 9.)
3. **Hostile arrives during a craft.** The runner must interrupt the motor with `threat`, the next decision must include `threat_response`, and the teacher's `fight`/`flee` must map to an option that exists. (Tests in Task 3 and Task 10.)
4. **kev returns a choice outside the option list.** Impossible by construction (kev picks among the criteria we sent) but the runner must validate `choice in options` and fall back to `wait` with an event logged. (Test in Task 10.)
5. **State text over budget.** Ten entities and twenty blocks in view must serialize under 1400 characters. (Test in Task 4 with a crowded obs.)

---

## File structure

```
agent/
  subtasks.js      declared subtasks, option ids, preconditions, descriptions            (pure)
  teacher.js       techStep(obs), teacherSubtask(obs), teacherThreat(obs)                (pure)
  serialize.js     serialize(obs) -> state text                                          (pure)
  questions.js     buildQuestions(obs, {decision}), post-hoc labelers over a timeline     (pure)
  summary.js       summarize(bot, mem, ctx) -> obs; EpisodeMemory; direction/word helpers (mostly pure helpers + one bot reader)
  motor.js         Motor: run(subtask, arg) -> typed result, interrupt()                  (Mineflayer)
  kev_client.js    ask(state, questions) -> /v1/systemone response                        (HTTP)
  logger.js        EpisodeLog: frames, decisions, events, timeline; toRecords()           (pure)
  server_ctl.js    startServer({port, seed}) / stop: per-port Paper instance from server/  (child_process)
  run_episode.mjs  one episode CLI
  gen_data.mjs     many episodes in parallel -> data/<name>.jsonl (+ base-rate report)
tests/*.test.mjs   node:test unit tests for every pure module
scripts/
  split.sh, train_mc1.sh, eval_mc1.sh, bench_ctx.py, base_rates.py, reliability.py, drive_summary.py
viewer/index.html, viewer/serve.py
data/, out/, media/   (gitignored)
```

---

### Task 1: Server control (one Paper instance per port and seed)

**Files:**
- Create: `agent/server_ctl.js`
- Create: `tests/server_ctl.test.mjs`
- Modify: `.gitignore` (add `servers/`)

**Interfaces:**
- Produces: `startServer({port, seed, dir?, javaArgs?}) -> Promise<{port, seed, dir, proc, stop(): Promise<void>}>`; `renderProperties(template, {port, seed}) -> string`.

- [ ] **Step 1: Write the failing test for property rendering**

```js
// tests/server_ctl.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderProperties } from '../agent/server_ctl.js'

test('renderProperties overrides port and seed and keeps the rest', () => {
  const tpl = 'online-mode=false\nserver-port=25565\nlevel-seed=kev-smoke-1\nview-distance=8\n'
  const out = renderProperties(tpl, { port: 25570, seed: 'abc' })
  assert.match(out, /^server-port=25570$/m)
  assert.match(out, /^level-seed=abc$/m)
  assert.match(out, /^view-distance=8$/m)
  assert.match(out, /^online-mode=false$/m)
})
```

- [ ] **Step 2: Run it, expect failure** — `node --test tests/server_ctl.test.mjs` → "Cannot find module".

- [ ] **Step 3: Implement**

```js
// agent/server_ctl.js
// One Paper instance per (port, seed): servers/<port>/ is created from server/ (jar, eula, ops.json), the world is
// deleted, server.properties is rendered with the port and seed, the server is started and awaited until "Done".
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_DIR = path.join(ROOT, 'server')
export const JAR = 'paper-1.20.4-499.jar'

export function renderProperties(template, { port, seed }) {
  const set = (txt, key, val) => txt.match(new RegExp(`^${key}=.*$`, 'm')) ? txt.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${val}`) : txt + `${key}=${val}\n`
  return set(set(template, 'server-port', port), 'level-seed', seed)
}

export function javaBin() {
  const jdk = fs.readdirSync(path.join(ROOT, 'tools')).find(d => d.startsWith('jdk-21'))
  return jdk ? path.join(ROOT, 'tools', jdk, 'bin', 'java') : 'java'
}

export async function startServer({ port, seed, dir = path.join(ROOT, 'servers', String(port)), javaArgs = ['-Xms1G', '-Xmx2G'], timeoutMs = 120_000, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of [JAR, 'eula.txt', 'ops.json']) fs.copyFileSync(path.join(TEMPLATE_DIR, f), path.join(dir, f))
  for (const w of fs.readdirSync(dir).filter(d => d.startsWith('world'))) fs.rmSync(path.join(dir, w), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), renderProperties(fs.readFileSync(path.join(TEMPLATE_DIR, 'server.properties'), 'utf8'), { port, seed }))
  const out = fs.openSync(path.join(dir, 'server.out'), 'w')
  const proc = spawn(javaBin(), [...javaArgs, '-jar', JAR, '--nogui'], { cwd: dir, stdio: ['pipe', out, out], detached: true })
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      let txt = ''
      try { txt = fs.readFileSync(path.join(dir, 'server.out'), 'utf8') } catch {}
      if (/Done \(/.test(txt)) { clearInterval(timer); resolve() }
      else if (proc.exitCode !== null) { clearInterval(timer); reject(new Error(`server exited ${proc.exitCode}: ${txt.slice(-500)}`)) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); proc.kill('SIGKILL'); reject(new Error('server start timeout')) }
    }, 500)
  })
  await ready
  log(`server ${port} seed ${seed} ready`)
  const stop = () => new Promise(resolve => {
    if (proc.exitCode !== null) return resolve()
    proc.once('exit', () => resolve())
    try { proc.stdin.write('stop\n') } catch { proc.kill('SIGTERM') }
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL') }, 15_000)
  })
  return { port, seed, dir, proc, stop }
}
```

- [ ] **Step 4: Run the unit test, expect pass.** `node --test tests/server_ctl.test.mjs`
- [ ] **Step 5: Integration check** — `node -e "import('./agent/server_ctl.js').then(async m=>{const s=await m.startServer({port:25570,seed:'t1',log:console.log});await s.stop();console.log('stopped')})"` → prints ready then stopped in under 60 s. Add `servers/` to `.gitignore`.

---

### Task 2: Subtask catalogue and precondition-filtered options

**Files:**
- Create: `agent/subtasks.js`, `tests/subtasks.test.mjs`

**Interfaces:**
- Consumes: `obs` (schema in Task 6).
- Produces: `parseOption(id) -> {name, arg}`; `optionId(name, arg) -> string`; `options(obs) -> [{id, name, arg, desc}]`; `counts(obs)` helper `{logs, planks, sticks, cobble, rawIron, ingots, coal, food}`; `TABLE_ITEMS`, `RECIPE_NEEDS`.

- [ ] **Step 1: Failing tests**

```js
// tests/subtasks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { options, parseOption, optionId, counts } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

test('optionId round-trips', () => {
  assert.equal(optionId('craft', 'wooden_pickaxe'), 'craft(wooden_pickaxe)')
  assert.deepEqual(parseOption('craft(wooden_pickaxe)'), { name: 'craft', arg: 'wooden_pickaxe' })
  assert.deepEqual(parseOption('wait'), { name: 'wait', arg: null })
})

test('wait is always offered; nothing else on an empty world with an empty inventory', () => {
  const ids = options(baseObs()).map(o => o.id)
  assert.ok(ids.includes('wait'))
  assert.ok(ids.includes('explore_toward(surface)'))
  assert.ok(!ids.includes('gather_wood'))
  assert.ok(!ids.includes('mine_stone'))
})

test('gather_wood needs a log in view; craft(planks) needs a log in inventory', () => {
  const o = baseObs({ blocks: [{ name: 'oak_log', dist: 12, dir: 'north', dy: 0, reachable: true }] })
  assert.ok(options(o).map(x => x.id).includes('gather_wood'))
  const o2 = baseObs({ inventory: { oak_log: 2 } })
  const ids = options(o2).map(x => x.id)
  assert.ok(ids.includes('craft(planks)'))
  assert.ok(!ids.includes('craft(crafting_table)'))
})

test('table recipes need a table nearby or in inventory', () => {
  const inv = { oak_planks: 3, stick: 2 }
  assert.ok(!options(baseObs({ inventory: inv })).map(x => x.id).includes('craft(wooden_pickaxe)'))
  assert.ok(options(baseObs({ inventory: { ...inv, crafting_table: 1 } })).map(x => x.id).includes('craft(wooden_pickaxe)'))
  assert.ok(options(baseObs({ inventory: inv, base: { crafting_table: { dist: 3, dir: 'east', dy: 0 }, furnace: null } })).map(x => x.id).includes('craft(wooden_pickaxe)'))
})

test('threat options appear only with a hostile within 16 m', () => {
  const o = baseObs({ nearestHostile: { name: 'zombie', dist: 9, dir: 'west', dy: 0 }, inventory: { cobblestone: 5 } })
  const ids = options(o).map(x => x.id)
  assert.ok(ids.includes('fight(threat)') && ids.includes('flee(threat)') && ids.includes('pillar_up'))
  assert.ok(!options(baseObs()).map(x => x.id).includes('flee(threat)'))
})

test('counts merges logs and planks of every wood', () => {
  assert.deepEqual(counts(baseObs({ inventory: { oak_log: 1, birch_log: 2, spruce_planks: 4, stick: 1 } })).logs, 3)
})
```

- [ ] **Step 2: Fixture** — `tests/fixtures.mjs`:

```js
export function baseObs(over = {}) {
  return {
    t: 0, day: 0, timeOfDay: 1000, phase: 'morning', secondsToDusk: 550, weather: 'clear', biome: 'forest',
    pos: { x: 40, y: 72, z: -37 }, standingOn: 'grass_block', skyLight: 15, blockLight: 0, underground: false, inWater: false,
    health: 20, food: 20, inventory: {}, holding: null, toolWear: {},
    base: { crafting_table: null, furnace: null },
    memory: { ironSeen: null, lastPath: null, deaths: 0, heading: 'north' },
    blocks: [], entities: [], nearestHostile: null,
    current: null, last: null, goal: 'iron_pickaxe', done: false,
    ...over,
  }
}
```

- [ ] **Step 3: Run, expect failure.** `node --test tests/subtasks.test.mjs`

- [ ] **Step 4: Implement**

```js
// agent/subtasks.js
// The declared subtask list (lesson 6: every list has an escape; only options whose preconditions hold are offered).
export const HOSTILE_RANGE = 16
export const TABLE_ITEMS = new Set(['wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe'])
export const CRAFTABLE = ['planks', 'sticks', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe']

export function counts(obs) {
  const inv = obs.inventory || {}
  const sum = pred => Object.entries(inv).filter(([k]) => pred(k)).reduce((n, [, v]) => n + v, 0)
  return {
    logs: sum(k => k.endsWith('_log')), planks: sum(k => k.endsWith('_planks')), sticks: inv.stick || 0,
    cobble: (inv.cobblestone || 0) + (inv.cobbled_deepslate || 0), rawIron: inv.raw_iron || 0, ingots: inv.iron_ingot || 0,
    coal: (inv.coal || 0) + (inv.charcoal || 0), food: sum(k => FOOD.has(k)), table: inv.crafting_table || 0, furnace: inv.furnace || 0,
    blocks: (inv.cobblestone || 0) + (inv.dirt || 0) + (inv.cobbled_deepslate || 0),
    hasPickaxe: ['wooden', 'stone', 'iron', 'diamond'].some(m => inv[`${m}_pickaxe`]),
    hasStonePickaxe: ['stone', 'iron', 'diamond'].some(m => inv[`${m}_pickaxe`]),
  }
}
export const FOOD = new Set(['bread', 'apple', 'cooked_beef', 'beef', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton', 'chicken', 'cooked_chicken', 'carrot', 'potato', 'baked_potato', 'sweet_berries', 'cod', 'cooked_cod', 'rotten_flesh'])

export function canCraft(item, c) {
  switch (item) {
    case 'planks': return c.logs >= 1
    case 'sticks': return c.planks >= 2
    case 'crafting_table': return c.planks >= 4
    case 'wooden_pickaxe': return c.planks >= 3 && c.sticks >= 2
    case 'stone_pickaxe': return c.cobble >= 3 && c.sticks >= 2
    case 'furnace': return c.cobble >= 8
    case 'iron_pickaxe': return c.ingots >= 3 && c.sticks >= 2
    default: return false
  }
}
export const hasFuel = c => c.coal >= 1 || c.planks >= 2 || c.logs >= 1
export const tableNear = obs => !!(obs.base?.crafting_table && obs.base.crafting_table.dist <= 8)
export const furnaceNear = obs => !!(obs.base?.furnace && obs.base.furnace.dist <= 8)
const seen = (obs, pred, maxDist = 64) => (obs.blocks || []).find(b => pred(b.name) && b.dist <= maxDist)

export const DESC = {
  gather_wood: 'walk to the nearest tree and mine logs',
  mine_stone: 'mine cobblestone from nearby stone with a pickaxe',
  mine_coal: 'walk to the nearest coal ore and mine it',
  mine_iron: 'walk to the nearest known iron ore and mine it',
  'craft(planks)': 'craft planks from logs (no table needed)',
  'craft(sticks)': 'craft sticks from planks (no table needed)',
  'craft(crafting_table)': 'craft a crafting table from 4 planks',
  'craft(wooden_pickaxe)': 'craft a wooden pickaxe at a crafting table (3 planks, 2 sticks)',
  'craft(stone_pickaxe)': 'craft a stone pickaxe at a crafting table (3 cobblestone, 2 sticks)',
  'craft(furnace)': 'craft a furnace at a crafting table (8 cobblestone)',
  'craft(iron_pickaxe)': 'craft an iron pickaxe at a crafting table (3 iron ingots, 2 sticks)',
  'smelt(iron_ingot)': 'put raw iron and fuel in a furnace and wait for ingots',
  'explore_toward(cave)': 'walk to the nearby cave opening and go in',
  'explore_toward(down)': 'dig a staircase down toward iron level and tunnel there',
  'explore_toward(surface)': 'walk across the surface looking for trees, stone or caves',
  return_to_base: 'walk back to the crafting table',
  eat: 'eat something from the inventory',
  build_shelter: 'dig down two blocks and seal the top to hide until morning',
  'fight(threat)': 'attack the nearest hostile mob with the best tool in hand',
  'flee(threat)': 'run away from the nearest hostile mob',
  pillar_up: 'jump and place blocks underneath to get out of reach',
  wait: 'stand still for a few seconds',
}

export const optionId = (name, arg) => arg ? `${name}(${arg})` : name
export function parseOption(id) {
  const m = /^(\w+)(?:\((\w+)\))?$/.exec(id)
  if (!m) throw new Error(`bad option id ${id}`)
  return { name: m[1], arg: m[2] ?? null }
}

export function options(obs) {
  const c = counts(obs)
  const out = []
  const add = (name, arg = null) => { const id = optionId(name, arg); out.push({ id, name, arg, desc: DESC[id] }) }
  const h = obs.nearestHostile
  if (h && h.dist <= HOSTILE_RANGE) { add('fight', 'threat'); add('flee', 'threat'); if (c.blocks >= 3 && h.dist <= 8) add('pillar_up') }
  if (seen(obs, n => n.endsWith('_log'), 48)) add('gather_wood')
  if (c.hasPickaxe && seen(obs, n => n === 'stone' || n === 'deepslate' || n === 'cobblestone', 16)) add('mine_stone')
  if (c.hasPickaxe && seen(obs, n => n === 'coal_ore' || n === 'deepslate_coal_ore', 32)) add('mine_coal')
  if (c.hasStonePickaxe && (seen(obs, n => n === 'iron_ore' || n === 'deepslate_iron_ore', 32) || obs.memory?.ironSeen)) add('mine_iron')
  for (const item of CRAFTABLE) {
    if (!canCraft(item, c)) continue
    if (TABLE_ITEMS.has(item) && !tableNear(obs) && c.table === 0) continue
    add('craft', item)
  }
  if (c.rawIron >= 1 && hasFuel(c) && (furnaceNear(obs) || c.furnace >= 1)) add('smelt', 'iron_ingot')
  if (seen(obs, n => n === 'cave', 32)) add('explore_toward', 'cave')
  if (c.hasPickaxe && obs.pos.y > 14) add('explore_toward', 'down')
  add('explore_toward', 'surface')
  if (obs.base?.crafting_table && obs.base.crafting_table.dist > 8) add('return_to_base')
  if (c.food >= 1 && obs.food < 16) add('eat')
  if (c.blocks >= 1 && c.hasPickaxe && (obs.phase === 'dusk' || obs.phase === 'night')) add('build_shelter')
  add('wait')
  return out
}
```

- [ ] **Step 5: Run tests, expect pass.** `node --test tests/subtasks.test.mjs`

---

### Task 3: Tech-tree teacher and threat teacher

**Files:**
- Create: `agent/teacher.js`, `tests/teacher.test.mjs`

**Interfaces:**
- Produces: `techStep(obs) -> {index: 1..8, of: 7, text}` (8 = goal done, "survive until morning"); `teacherSubtask(obs) -> optionId` (always an id in `options(obs)`); `teacherThreat(obs) -> 'fight'|'flee'|'pillar_up'|'ignore'`; `THREAT_OPTIONS` `{fight, flee, pillar_up, ignore}` with descriptions.

- [ ] **Step 1: Failing tests**

```js
// tests/teacher.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { techStep, teacherSubtask, teacherThreat } from '../agent/teacher.js'
import { options } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

const log = { name: 'oak_log', dist: 10, dir: 'north', dy: 0, reachable: true }
const stone = { name: 'stone', dist: 5, dir: 'south', dy: -1, reachable: true }
const table = { crafting_table: { dist: 2, dir: 'east', dy: 0 }, furnace: null }

test('steps follow the tech tree', () => {
  assert.equal(techStep(baseObs()).index, 1)
  assert.equal(techStep(baseObs({ inventory: { oak_log: 5 } })).index, 2)
  assert.equal(techStep(baseObs({ inventory: { oak_log: 3, crafting_table: 1 } })).index, 3)
  assert.equal(techStep(baseObs({ inventory: { wooden_pickaxe: 1 } })).index, 4)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1 } })).index, 5)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3 } })).index, 6)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1, iron_ingot: 3 } })).index, 7)
  assert.equal(techStep(baseObs({ inventory: { iron_pickaxe: 1 } })).index, 8)
})

test('no tree in sight: explore the surface, never wait', () => {
  assert.equal(teacherSubtask(baseObs()), 'explore_toward(surface)')
})

test('step 1 gathers wood when a log is visible', () => {
  assert.equal(teacherSubtask(baseObs({ blocks: [log] })), 'gather_wood')
})

test('step 2-3 crafts planks, table, sticks, wooden pickaxe in order', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 5 } })), 'craft(planks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 4, oak_planks: 4 } })), 'craft(crafting_table)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 4, crafting_table: 1 } })), 'craft(planks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 3, oak_planks: 4, crafting_table: 1 } })), 'craft(sticks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 3, oak_planks: 4, stick: 4, crafting_table: 1 } })), 'craft(wooden_pickaxe)')
})

test('step 4 mines stone then crafts the stone pickaxe', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2 }, blocks: [stone] })), 'mine_stone')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2 } })), 'explore_toward(down)')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2, cobblestone: 11 }, base: table })), 'craft(stone_pickaxe)')
})

test('step 5 prefers visible iron, then coal, then furnace stone, then digging down', () => {
  const iron = { name: 'iron_ore', dist: 8, dir: 'west', dy: -2, reachable: true }
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1 }, blocks: [iron, stone] })), 'mine_iron')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1 }, blocks: [{ name: 'coal_ore', dist: 6, dir: 'west', dy: 0, reachable: true }, stone] })), 'mine_coal')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, cobblestone: 2 }, blocks: [stone] })), 'mine_stone')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, cobblestone: 9, coal: 1 }, blocks: [stone] })), 'explore_toward(down)')
})

test('step 6-7 furnace, smelt, iron pickaxe', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, cobblestone: 9, coal: 1, crafting_table: 1 } })), 'craft(furnace)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, coal: 1, furnace: 1 } })), 'smelt(iron_ingot)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, iron_ingot: 3, stick: 2, crafting_table: 1 } })), 'craft(iron_pickaxe)')
})

test('threat rules', () => {
  const z = d => baseObs({ nearestHostile: { name: 'zombie', dist: d, dir: 'west', dy: 0 }, inventory: { cobblestone: 5 } })
  assert.equal(teacherThreat(z(6)), 'fight')
  assert.equal(teacherThreat(z(14)), 'ignore')
  assert.equal(teacherThreat(baseObs({ nearestHostile: { name: 'creeper', dist: 6, dir: 'west', dy: 0 } })), 'flee')
  assert.equal(teacherThreat(baseObs({ health: 6, nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 } })), 'flee')
  assert.equal(teacherThreat(baseObs({ nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 }, entities: [1, 2, 3].map(i => ({ name: 'zombie', kind: 'hostile', dist: 4 + i, dir: 'west', dy: 0 })), inventory: { cobblestone: 5 } })), 'pillar_up')
  assert.equal(teacherSubtask(z(6)), 'fight(threat)')
})

test('teacher pick is always an offered option', () => {
  const cases = [baseObs(), baseObs({ blocks: [log] }), baseObs({ inventory: { oak_log: 5 } }), baseObs({ inventory: { wooden_pickaxe: 1 } }),
    baseObs({ inventory: { stone_pickaxe: 1 }, pos: { x: 0, y: 12, z: 0 } }), baseObs({ inventory: { iron_pickaxe: 1 }, phase: 'night' })]
  for (const o of cases) assert.ok(options(o).some(x => x.id === teacherSubtask(o)), `${teacherSubtask(o)} not offered`)
})
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```js
// agent/teacher.js
// The scripted tech-tree teacher. Labels for next_subtask and threat_response; drives the bot during data collection.
import { counts, options, optionId, tableNear, furnaceNear, hasFuel, canCraft } from './subtasks.js'

export const WOOD_NEEDED = 5   // logs (or planks/4): table 1, wooden pickaxe 1.25, sticks, spare fuel and a spare table
export const STEPS = ['gather wood', 'craft a crafting table', 'craft a wooden pickaxe', 'craft a stone pickaxe',
  'find and mine 3 iron ore', 'smelt the iron', 'craft the iron pickaxe']

export function techStep(obs) {
  const c = counts(obs)
  const woodEq = c.logs + Math.floor(c.planks / 4)
  let index
  if (obs.inventory?.iron_pickaxe) index = 8
  else if (c.ingots >= 3) index = 7
  else if (c.rawIron + c.ingots >= 3) index = 6
  else if (c.hasStonePickaxe) index = 5
  else if (c.hasPickaxe) index = 4
  else if (c.table >= 1 || tableNear(obs)) index = 3
  else if (woodEq >= WOOD_NEEDED) index = 2
  else index = 1
  const text = index === 8 ? 'goal done: survive until morning' : STEPS[index - 1]
  return { index, of: 7, text }
}

export const THREAT_OPTIONS = {
  fight: 'attack the mob with the best tool in hand',
  flee: 'run away from the mob',
  pillar_up: 'jump and place blocks underneath to get out of reach',
  ignore: 'carry on with the current subtask',
}
const MELEE = new Set(['zombie', 'skeleton', 'spider', 'cave_spider', 'husk', 'drowned', 'zombie_villager', 'stray', 'silverfish', 'slime', 'witch', 'pillager'])

export function teacherThreat(obs) {
  const h = obs.nearestHostile
  if (!h || h.dist > 16) return 'ignore'
  const c = counts(obs)
  const close = (obs.entities || []).filter(e => e.kind === 'hostile' && e.dist <= 8).length
  if (h.name === 'creeper') return 'flee'
  if (obs.health < 8) return 'flee'
  if (close >= 3) return c.blocks >= 3 ? 'pillar_up' : 'flee'
  if (h.dist <= 10 && MELEE.has(h.name)) return 'fight'
  if (h.dist <= 10) return 'flee'
  return 'ignore'
}

const has = (obs, pred, d = 64) => (obs.blocks || []).some(b => pred(b.name) && b.dist <= d)
const LOG = n => n.endsWith('_log'), STONE = n => n === 'stone' || n === 'deepslate' || n === 'cobblestone'
const COAL = n => n === 'coal_ore' || n === 'deepslate_coal_ore', IRON = n => n === 'iron_ore' || n === 'deepslate_iron_ore'

function pick(obs) {
  const c = counts(obs)
  const step = techStep(obs).index
  const wood = () => has(obs, LOG, 48) ? 'gather_wood' : 'explore_toward(surface)'
  const craft = item => optionId('craft', item)
  const needTable = item => (tableNear(obs) || c.table >= 1) ? craft(item) : (c.planks >= 4 ? craft('crafting_table') : c.logs >= 1 ? craft('planks') : wood())
  const sticks = () => c.planks >= 2 ? craft('sticks') : c.logs >= 1 ? craft('planks') : wood()
  const dig = () => c.hasPickaxe && obs.pos.y > 14 ? 'explore_toward(down)' : 'explore_toward(surface)'
  const stone = () => has(obs, STONE, 16) ? 'mine_stone' : dig()
  const ironSeen = has(obs, IRON, 32) || !!obs.memory?.ironSeen
  const th = obs.nearestHostile && obs.nearestHostile.dist <= 16 ? teacherThreat(obs) : 'ignore'
  if (th === 'fight') return 'fight(threat)'
  if (th === 'flee') return 'flee(threat)'
  if (th === 'pillar_up') return 'pillar_up'
  if (obs.food < 8 && c.food >= 1) return 'eat'
  switch (step) {
    case 1: return wood()
    case 2: return c.planks >= 4 ? craft('crafting_table') : craft('planks')
    case 3: {
      if (c.sticks < 2) return sticks()
      if (c.planks < 3) return c.logs >= 1 ? craft('planks') : wood()
      return needTable('wooden_pickaxe')
    }
    case 4: {
      if (c.cobble < 3) return stone()
      if (c.sticks < 2) return sticks()
      return needTable('stone_pickaxe')
    }
    case 5: {
      if (ironSeen) return 'mine_iron'
      if (c.coal === 0 && has(obs, COAL, 16)) return 'mine_coal'
      if (c.cobble < 8 && has(obs, STONE, 16)) return 'mine_stone'
      if (has(obs, n => n === 'cave', 16) && obs.pos.y > 30) return 'explore_toward(cave)'
      return dig()
    }
    case 6: {
      if (!furnaceNear(obs) && c.furnace === 0) return c.cobble >= 8 ? needTable('furnace') : stone()
      if (!hasFuel(c)) return c.logs >= 1 ? craft('planks') : has(obs, COAL, 32) ? 'mine_coal' : wood()
      return 'smelt(iron_ingot)'
    }
    case 7: {
      if (c.sticks < 2) return sticks()
      return needTable('iron_pickaxe')
    }
    default: {
      if ((obs.phase === 'dusk' || obs.phase === 'night') && !obs.underground && c.blocks >= 1 && c.hasPickaxe) return 'build_shelter'
      return 'wait'
    }
  }
}

export function teacherSubtask(obs) {
  const id = pick(obs)
  const offered = options(obs).map(o => o.id)
  if (offered.includes(id)) return id
  if (offered.includes('explore_toward(surface)') && id !== 'wait') return 'explore_toward(surface)'
  return 'wait'
}
```

- [ ] **Step 4: Run tests, expect pass.** Fix rule order until every case passes; the last test (pick always offered) is the invariant that matters.

---

### Task 4: State serializer

**Files:**
- Create: `agent/serialize.js`, `tests/serialize.test.mjs`

**Interfaces:**
- Produces: `serialize(obs) -> string`; `describeTime(obs)`, `describeInventory(obs)`, helper words.

- [ ] **Step 1: Failing tests**

```js
// tests/serialize.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { serialize } from '../agent/serialize.js'
import { baseObs } from './fixtures.mjs'

test('golden state text for the spec example', () => {
  const o = baseObs({
    day: 0, timeOfDay: 8800, phase: 'afternoon', secondsToDusk: 160, biome: 'forest', pos: { x: 40, y: 71, z: -37 }, skyLight: 15,
    health: 16, food: 13, inventory: { stone_pickaxe: 1, wooden_pickaxe: 1, cobblestone: 14, oak_planks: 9, coal: 3, bread: 2, crafting_table: 1 },
    holding: 'stone_pickaxe', toolWear: { stone_pickaxe: 40 },
    base: { crafting_table: { dist: 38, dir: 'east', dy: -2 }, furnace: { dist: 38, dir: 'east', dy: -2 } },
    memory: { ironSeen: { dist: 55, dir: 'west', dy: -12, agoS: 180, where: 'a cave mouth' }, lastPath: 'ok', deaths: 0, heading: 'west' },
    blocks: [{ name: 'cave', dist: 22, dir: 'west', dy: 0, reachable: true }, { name: 'coal_ore', dist: 6, dir: 'north', dy: 0, reachable: true }, { name: 'stone', dist: 4, dir: 'south', dy: 0, reachable: true }],
    entities: [{ name: 'cow', kind: 'passive', dist: 12, dir: 'north-east', dy: 0 }],
    current: { name: 'explore_toward', arg: 'cave', elapsedS: 14, progress: 0.6 }, last: { id: 'mine_coal', result: 'ok' },
  })
  const text = serialize(o)
  assert.equal(text, [
    'Minecraft survival, day 1. Goal: get an iron pickaxe (step 5 of 7: find and mine 3 iron ore).',
    'time: afternoon, dusk in 2 min 40 s. weather clear. biome: forest.',
    'you: health 16/20, food 13/20, standing on grass at y 71, in the open, light 15.',
    'inventory: stone pickaxe (worn 40%), wooden pickaxe, 14 cobblestone, 9 planks, 3 coal, 2 bread, crafting table. no iron yet.',
    'holding: stone pickaxe.',
    'base: crafting table and furnace 38 m east, 2 m below you. bed: none.',
    'memory: iron ore seen 3 min ago in a cave mouth 55 m west, 12 m below; path last tried: ok. died: never.',
    'nearby blocks: cave entrance 22 m west (dark inside); coal ore 6 m north, reachable; exposed stone 4 m south, reachable.',
    'nearby creatures: cow 12 m north-east (passive); nearest hostile: none within 32 m.',
    'current subtask: explore toward cave, 14 s so far, 60% of the way. last subtask result: mine coal ok.',
  ].join('\n'))
})

test('empty world and inventory still serializes every line', () => {
  const text = serialize(baseObs())
  assert.match(text, /inventory: nothing\./)
  assert.match(text, /nearby blocks: none of note\./)
  assert.match(text, /current subtask: none\./)
  assert.ok(!text.includes('<|') && !text.includes('|>'))
})

test('crowded scene stays under 1400 characters', () => {
  const blocks = Array.from({ length: 20 }, (_, i) => ({ name: i % 2 ? 'stone' : 'oak_log', dist: 3 + i, dir: 'north', dy: 0, reachable: true }))
  const entities = Array.from({ length: 10 }, (_, i) => ({ name: i % 3 ? 'zombie' : 'cow', kind: i % 3 ? 'hostile' : 'passive', dist: 5 + i, dir: 'south', dy: 0 }))
  const text = serialize(baseObs({ blocks, entities, nearestHostile: { name: 'zombie', dist: 6, dir: 'south', dy: 0 } }))
  assert.ok(text.length < 1400, `${text.length} chars`)
})
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```js
// agent/serialize.js
// obs -> state text. Relational, rounded, most static first, most volatile last (lesson 8: words, short numbers).
import { techStep } from './teacher.js'
import { counts } from './subtasks.js'

const pretty = s => String(s).replace(/_/g, ' ')
const NAME = { grass_block: 'grass', oak_planks: 'planks', spruce_planks: 'planks', birch_planks: 'planks', crafting_table: 'crafting table' }
const item = n => NAME[n] || pretty(n).replace(/^(oak|birch|spruce|jungle|acacia|dark oak|mangrove|cherry) (log|planks)$/, '$2').replace(/^log$/, 'oak log')
const mins = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s` }
const rel = (b, withDy = true) => {
  let s = `${Math.round(b.dist)} m ${b.dir}`
  if (withDy && Math.abs(b.dy) >= 2) s += `, ${Math.abs(Math.round(b.dy))} m ${b.dy < 0 ? 'below' : 'above'} you`
  return s
}
const BLOCK_WORD = { cave: 'cave entrance', stone: 'exposed stone', deepslate: 'exposed stone', coal_ore: 'coal ore', deepslate_coal_ore: 'coal ore', iron_ore: 'iron ore', deepslate_iron_ore: 'iron ore', water: 'water', lava: 'lava' }

export function describeTime(obs) {
  const dusk = obs.secondsToDusk != null && (obs.phase === 'morning' || obs.phase === 'midday' || obs.phase === 'afternoon')
  const when = dusk ? `${obs.phase}, dusk in ${mins(obs.secondsToDusk)}` : obs.phase === 'night' ? `night, morning in ${mins(obs.secondsToMorning ?? 0)}` : obs.phase
  return `time: ${when}. weather ${obs.weather}. biome: ${pretty(obs.biome)}.`
}

export function describeInventory(obs) {
  const inv = obs.inventory || {}
  const order = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
  const keys = [...order.filter(k => inv[k]), ...Object.keys(inv).filter(k => !order.includes(k))]
  const parts = keys.map(k => {
    const wear = obs.toolWear?.[k]
    if (k.endsWith('_pickaxe')) return `${item(k)}${wear ? ` (worn ${wear}%)` : ''}`
    return inv[k] > 1 ? `${inv[k]} ${item(k)}` : item(k)
  })
  const c = counts(obs)
  const iron = c.ingots ? '' : c.rawIron ? ` ${c.rawIron} raw iron, no ingots yet.` : ' no iron yet.'
  return `inventory: ${parts.length ? parts.join(', ') : 'nothing'}.${inv.iron_pickaxe ? '' : iron}`
}

function describeBase(obs) {
  const t = obs.base?.crafting_table, f = obs.base?.furnace
  let s
  if (!t && !f) s = 'base: none yet'
  else if (t && f && Math.abs(t.dist - f.dist) <= 3) s = `base: crafting table and furnace ${rel(t)}`
  else s = 'base: ' + [t && `crafting table ${rel(t)}`, f && `furnace ${rel(f)}`].filter(Boolean).join('; ')
  return `${s}. bed: none.`
}

function describeMemory(obs) {
  const m = obs.memory || {}
  const iron = m.ironSeen ? `iron ore seen ${mins(m.ironSeen.agoS)} ago${m.ironSeen.where ? ` in ${m.ironSeen.where}` : ''} ${rel(m.ironSeen)}` : 'no iron seen yet'
  const path = m.lastPath ? `; path last tried: ${pretty(m.lastPath)}` : ''
  const died = m.deaths ? `died: ${m.deaths} time${m.deaths > 1 ? 's' : ''}` : 'died: never'
  return `memory: ${iron}${path}. ${died}.`
}

function describeBlocks(obs) {
  const seenKind = new Set()
  const rows = []
  for (const b of obs.blocks || []) {
    const kind = b.name.endsWith('_log') ? 'log' : (BLOCK_WORD[b.name] ? b.name : null)
    if (!kind || seenKind.has(BLOCK_WORD[kind] || kind)) continue
    seenKind.add(BLOCK_WORD[kind] || kind)
    if (kind === 'log') rows.push(`tree ${rel(b, false)}${b.reachable ? ', reachable' : ''}`)
    else if (kind === 'cave') rows.push(`cave entrance ${rel(b)} (dark inside)`)
    else rows.push(`${BLOCK_WORD[kind]} ${rel(b)}${b.reachable ? ', reachable' : ''}`)
    if (rows.length >= 5) break
  }
  return `nearby blocks: ${rows.length ? rows.join('; ') : 'none of note'}.`
}

function describeEntities(obs) {
  const rows = (obs.entities || []).slice(0, 4).map(e => `${pretty(e.name)} ${rel(e, false)} (${e.kind})`)
  const h = obs.nearestHostile
  const hostile = h ? `nearest hostile: ${pretty(h.name)} ${rel(h, false)}` : 'nearest hostile: none within 32 m'
  return `nearby creatures: ${rows.length ? rows.join('; ') + '; ' : ''}${hostile}.`
}

function describeSubtask(obs) {
  const c = obs.current
  const cur = c ? `${pretty(c.name)}${c.arg ? ` ${pretty(c.arg)}` : ''}, ${Math.round(c.elapsedS)} s so far${c.progress != null ? `, ${Math.round(c.progress * 100)}% of the way` : ''}` : 'none'
  const last = obs.last ? ` last subtask result: ${pretty(obs.last.id)} ${pretty(obs.last.result)}.` : ''
  return `current subtask: ${cur}.${last}`
}

export function serialize(obs) {
  const step = techStep(obs)
  const goal = step.index === 8 ? 'iron pickaxe done; survive until morning' : `get an iron pickaxe (step ${step.index} of 7: ${step.text})`
  const where = obs.underground ? 'underground' : obs.inWater ? 'in water' : 'in the open'
  const lines = [
    `Minecraft survival, day ${(obs.day ?? 0) + 1}. Goal: ${goal}.`,
    describeTime(obs),
    `you: health ${Math.round(obs.health)}/20, food ${Math.round(obs.food)}/20, standing on ${item(obs.standingOn || 'air')} at y ${Math.round(obs.pos.y)}, ${where}, light ${Math.max(obs.skyLight ?? 0, obs.blockLight ?? 0)}.`,
    describeInventory(obs),
    `holding: ${obs.holding ? item(obs.holding) : 'nothing'}.`,
    describeBase(obs),
    describeMemory(obs),
    describeBlocks(obs),
    describeEntities(obs),
    describeSubtask(obs),
  ]
  return lines.join('\n').replace(/<\|/g, '< |').replace(/\|>/g, '| >')
}
```

- [ ] **Step 4: Run tests; adjust wording in the golden test or the code until they agree.** The golden text is the contract; once green, freeze it.

---

### Task 5: Question schema and post-hoc labelers

**Files:**
- Create: `agent/questions.js`, `tests/questions.test.mjs`

**Interfaces:**
- Produces: `HORIZONS = {step: 60, iron: 180, damage: 20}`; `DAMAGE_LEVELS` (4 strings); `buildQuestions(obs, {decision}) -> {qs, labels}` where `qs` is the System One `questions` object and `labels[qid]` is the teacher label or `null` for post-hoc; `labelDecisions(decisions, timeline) -> void` fills `decision.labels[qid]` (value or `null` = censored) from `timeline` samples `{t, step, rawIron, ingots, health, dead, timeOfDay, day, done}`; `questionMeta()`.

- [ ] **Step 1: Failing tests**

```js
// tests/questions.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestions, labelDecisions, HORIZONS, DAMAGE_LEVELS } from '../agent/questions.js'
import { baseObs } from './fixtures.mjs'

test('forecasts always, choice only at a decision point, threat only with a hostile near', () => {
  const { qs, labels } = buildQuestions(baseObs(), { decision: false })
  assert.deepEqual(Object.keys(qs).sort(), ['damage_next_20s', 'subgoal_succeeds_60s'])
  const d = buildQuestions(baseObs({ blocks: [{ name: 'oak_log', dist: 5, dir: 'north', dy: 0, reachable: true }] }), { decision: true })
  assert.ok(d.qs.next_subtask && d.qs.next_subtask.type === 'choice')
  assert.equal(d.labels.next_subtask, 'gather_wood')
  assert.ok(Object.keys(d.qs.next_subtask.criteria).includes('wait'))
  const t = buildQuestions(baseObs({ nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 } }), { decision: true })
  assert.equal(t.labels.threat_response, 'fight')
  assert.deepEqual(Object.keys(t.qs.threat_response.criteria), ['fight', 'flee', 'pillar_up', 'ignore'])
})

test('iron_found_3min only while looking for iron; survive_until_morning only from dusk', () => {
  assert.ok(buildQuestions(baseObs({ inventory: { stone_pickaxe: 1 } }), { decision: false }).qs.iron_found_3min)
  assert.ok(!buildQuestions(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 1 } }), { decision: false }).qs.iron_found_3min)
  assert.ok(buildQuestions(baseObs({ phase: 'night', timeOfDay: 15000 }), { decision: false }).qs.survive_until_morning)
  assert.ok(!buildQuestions(baseObs(), { decision: false }).qs.survive_until_morning)
})

const sample = (t, over = {}) => ({ t, step: 1, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 1000 + t * 20, day: 0, done: false, ...over })
const dec = (t, qids) => ({ t, qids, labels: {} })

test('subgoal_succeeds_60s: true when the step index rises within 60 s, false when not, censored at the end', () => {
  const tl = [sample(0), sample(30), sample(50, { step: 2 }), sample(100, { step: 2 }), sample(130, { step: 2 })]
  const ds = [dec(0, ['subgoal_succeeds_60s']), dec(50, ['subgoal_succeeds_60s']), dec(100, ['subgoal_succeeds_60s'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.subgoal_succeeds_60s, true)
  assert.equal(ds[1].labels.subgoal_succeeds_60s, false)
  assert.equal(ds[2].labels.subgoal_succeeds_60s, null)
})

test('iron_found_3min: raw iron count rises within 180 s', () => {
  const tl = [sample(0), sample(100), sample(170, { rawIron: 1 }), sample(400, { rawIron: 1 })]
  const ds = [dec(0, ['iron_found_3min']), dec(170, ['iron_found_3min']), dec(400, ['iron_found_3min'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.iron_found_3min, true)
  assert.equal(ds[1].labels.iron_found_3min, false)
  assert.equal(ds[2].labels.iron_found_3min, null)
})

test('damage_next_20s: none / minor / major / death from the health trace; death overrides', () => {
  const tl = [sample(0), sample(5, { health: 18 }), sample(10, { health: 17 }), sample(25, { health: 17 }), sample(30, { health: 10 }), sample(40, { dead: true, health: 0 }), sample(70, { health: 20 })]
  const ds = [dec(0, ['damage_next_20s']), dec(10, ['damage_next_20s']), dec(25, ['damage_next_20s']), dec(60, ['damage_next_20s'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.damage_next_20s, 1)  // 3 hp over 20 s
  assert.equal(ds[1].labels.damage_next_20s, 2)  // 7 hp at t=30
  assert.equal(ds[2].labels.damage_next_20s, 3)  // dies at 40
  assert.equal(ds[3].labels.damage_next_20s, null) // window runs past the end with no damage
})

test('survive_until_morning: true past sunrise with no death; false on death; censored before sunrise', () => {
  const night = t => sample(t, { timeOfDay: 13000 + t * 20, day: 0 })
  const tl = [night(0), night(100), { ...sample(600), timeOfDay: 500, day: 1 }]
  const ds = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds, tl); assert.equal(ds[0].labels.survive_until_morning, true)
  const tl2 = [night(0), night(100, { dead: true }), { ...sample(600), timeOfDay: 500, day: 1 }]
  const ds2 = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds2, tl2); assert.equal(ds2[0].labels.survive_until_morning, false)
  const ds3 = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds3, [night(0), night(100)]); assert.equal(ds3[0].labels.survive_until_morning, null)
})
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```js
// agent/questions.js
// The question schema (the game <-> kev interface) and the post-hoc labelers. Every option is declared; nothing is parsed.
import { options } from './subtasks.js'
import { techStep, teacherSubtask, teacherThreat, THREAT_OPTIONS } from './teacher.js'
import { counts } from './subtasks.js'

export const HORIZONS = { step: 60, iron: 180, damage: 20 }
export const DAMAGE_LEVELS = ['none: no damage taken', 'minor: less than 4 hp lost', 'major: 4 hp or more lost', 'death']
export const HOSTILE_RANGE = 16

export function buildQuestions(obs, { decision }) {
  const qs = {}, labels = {}
  const step = techStep(obs)
  const c = counts(obs)
  if (decision) {
    const opts = options(obs)
    qs.next_subtask = { type: 'choice', instructions: 'Which subtask should the player do next to make progress on the goal without dying?',
      criteria: Object.fromEntries(opts.map(o => [o.id, o.desc])) }
    labels.next_subtask = teacherSubtask(obs)
    if (obs.nearestHostile && obs.nearestHostile.dist <= HOSTILE_RANGE) {
      qs.threat_response = { type: 'choice', instructions: `How should the player respond to the ${obs.nearestHostile.name.replace(/_/g, ' ')} nearby?`, criteria: { ...THREAT_OPTIONS } }
      labels.threat_response = teacherThreat(obs)
    }
  }
  if (step.index <= 7) {
    qs.subgoal_succeeds_60s = { type: 'noul', instructions: `Will the current step (${step.text}) be completed within the next ${HORIZONS.step} seconds?` }
    labels.subgoal_succeeds_60s = null
  }
  if (step.index === 5 && c.rawIron === 0) {
    qs.iron_found_3min = { type: 'noul', instructions: `Will the player mine at least one iron ore within the next ${HORIZONS.iron / 60} minutes?` }
    labels.iron_found_3min = null
  }
  qs.damage_next_20s = { type: 'score', instructions: `How much damage will the player take in the next ${HORIZONS.damage} seconds?`, criteria: [...DAMAGE_LEVELS] }
  labels.damage_next_20s = null
  if (obs.phase === 'dusk' || obs.phase === 'night') {
    qs.survive_until_morning = { type: 'noul', instructions: 'Will the player survive until sunrise without dying?' }
    labels.survive_until_morning = null
  }
  return { qs, labels }
}

export function questionMeta() {
  return {
    next_subtask: { type: 'choice', instructions: 'Which subtask should the player do next?', options: 'dynamic' },
    threat_response: { type: 'choice', instructions: 'How should the player respond to the hostile mob nearby?', options: Object.keys(THREAT_OPTIONS) },
    subgoal_succeeds_60s: { type: 'noul', instructions: `Current tech step completed within ${HORIZONS.step} s?`, options: ['false', 'true'] },
    iron_found_3min: { type: 'noul', instructions: `At least one iron ore mined within ${HORIZONS.iron / 60} min?`, options: ['false', 'true'] },
    damage_next_20s: { type: 'score', instructions: `Damage taken in the next ${HORIZONS.damage} s`, options: DAMAGE_LEVELS },
    survive_until_morning: { type: 'noul', instructions: 'Survive until sunrise?', options: ['false', 'true'] },
  }
}

// ---- post-hoc labels over the per-second timeline -------------------------------------------------------------
const after = (tl, t) => tl.filter(s => s.t > t)
const at = (tl, t) => { let cur = tl[0]; for (const s of tl) { if (s.t <= t) cur = s; else break }; return cur }

export function labelDecisions(decisions, timeline) {
  const tl = [...timeline].sort((a, b) => a.t - b.t)
  const end = tl.length ? tl[tl.length - 1].t : -Infinity
  for (const d of decisions) {
    const now = at(tl, d.t)
    for (const qid of d.qids) {
      let v = null
      if (qid === 'subgoal_succeeds_60s') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.step)
        if (win.some(s => s.step > now.step || s.done)) v = true
        else if (end >= d.t + HORIZONS.step) v = false
      } else if (qid === 'iron_found_3min') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.iron)
        if (win.some(s => s.rawIron > now.rawIron || s.ingots > now.ingots)) v = true
        else if (end >= d.t + HORIZONS.iron) v = false
      } else if (qid === 'damage_next_20s') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.damage)
        let lost = 0, prev = now.health, dead = false
        for (const s of win) { if (s.dead) { dead = true; break } if (s.health < prev) lost += prev - s.health; prev = s.health }
        if (dead) v = 3
        else if (lost >= 4) v = 2
        else if (lost > 0) v = 1
        else if (end >= d.t + HORIZONS.damage) v = 0
      } else if (qid === 'survive_until_morning') {
        let died = false, morning = false
        for (const s of after(tl, d.t)) { if (s.dead) { died = true; break } if (s.day > now.day || (s.timeOfDay < now.timeOfDay && s.timeOfDay < 12000 && now.timeOfDay >= 12000)) { morning = true; break } }
        v = died ? false : morning ? true : null
      } else continue
      d.labels[qid] = v
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

---

### Task 6: Summary (bot → obs) and episode memory

**Files:**
- Create: `agent/summary.js`, `tests/summary.test.mjs`

**Interfaces:**
- Produces: `class EpisodeMemory { ironSeen, lastPath, deaths, heading, base: {table: Vec3|null, furnace: Vec3|null}, note(obsLike) }`; `dirWord(dx, dz) -> 'north'|'north-east'|...`; `phaseOf(timeOfDay) -> {phase, secondsToDusk, secondsToMorning}`; `classifyEntity(entity, mcData) -> 'hostile'|'passive'|'player'|null`; `summarize(bot, mcData, mem, ctx) -> obs` where `ctx = {t, current, last, goal}`.

Scan rules (in `summarize`): blocks of interest within 32 m via `bot.findBlocks({matching: ids, maxDistance: 32, count: 64})` for logs, stone/deepslate, coal ore, iron ore, water, lava; "cave" = an air block at y ≤ bot.y+1 with skyLight 0 and blockLight 0 within 24 m whose neighbour is air too (search via `findBlocks` on air ids limited to count 200, filter by `bot.world.getSkyLight`); keep the nearest of each kind; `reachable` = dist ≤ 6 or `bot.canSeeBlock(block)`. Entities: `Object.values(bot.entities)` with `entity.type === 'mob'` classified by `mcData.entitiesByName[name].category` (`Hostile mobs` → hostile, `Passive mobs` → passive) within 32 m, nearest 6. `underground` = skyLight at head < 4. `base` = `mem.base` positions turned into `{dist, dir, dy}`. `toolWear` = `Math.round(100 * item.durabilityUsed / maxDurability)` for pickaxes (`mcData.itemsByName[name].maxDurability`).

- [ ] **Step 1: Failing tests** for the pure helpers:

```js
// tests/summary.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirWord, phaseOf, EpisodeMemory, classifyEntity } from '../agent/summary.js'

test('compass words', () => {
  assert.equal(dirWord(0, -10), 'north'); assert.equal(dirWord(10, 0), 'east'); assert.equal(dirWord(7, -7), 'north-east'); assert.equal(dirWord(-7, 7), 'south-west')
})
test('day phases and seconds to dusk', () => {
  assert.deepEqual(phaseOf(1000), { phase: 'morning', secondsToDusk: 550, secondsToMorning: null })
  assert.equal(phaseOf(6000).phase, 'midday'); assert.equal(phaseOf(9000).phase, 'afternoon')
  assert.equal(phaseOf(12500).phase, 'dusk'); assert.equal(phaseOf(15000).phase, 'night'); assert.equal(phaseOf(23500).phase, 'dawn')
  assert.equal(phaseOf(18000).secondsToMorning, 300)
})
test('memory remembers iron and base positions', () => {
  const m = new EpisodeMemory()
  m.sawIron({ x: 1, y: 2, z: 3 }, 10)
  assert.deepEqual(m.ironSeen.pos, { x: 1, y: 2, z: 3 })
  m.setBase('table', { x: 0, y: 0, z: 0 })
  assert.deepEqual(m.base.table, { x: 0, y: 0, z: 0 })
})
test('entity classes', () => {
  const md = { entitiesByName: { zombie: { category: 'Hostile mobs' }, cow: { category: 'Passive mobs' } } }
  assert.equal(classifyEntity({ type: 'mob', name: 'zombie' }, md), 'hostile')
  assert.equal(classifyEntity({ type: 'mob', name: 'cow' }, md), 'passive')
  assert.equal(classifyEntity({ type: 'player', name: 'x', username: 'y' }, md), 'player')
  assert.equal(classifyEntity({ type: 'object', name: 'item' }, md), null)
})
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```js
// agent/summary.js
// bot -> obs (the one place that reads Mineflayer state for the decision layer), plus the episode memory.
export function dirWord(dx, dz) {
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360   // 0 = north (-z), 90 = east (+x)
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8]
}
export function phaseOf(timeOfDay) {
  const t = ((timeOfDay % 24000) + 24000) % 24000
  const phase = t < 3000 ? 'morning' : t < 7000 ? 'midday' : t < 12000 ? 'afternoon' : t < 13500 ? 'dusk' : t < 23000 ? 'night' : 'dawn'
  const secondsToDusk = t < 12000 ? Math.round((12000 - t) / 20) : null
  const secondsToMorning = t >= 12000 ? Math.round((24000 - t) / 20) : null
  return { phase, secondsToDusk, secondsToMorning }
}
export function classifyEntity(e, mcData) {
  if (e.type === 'player') return 'player'
  if (e.type !== 'mob' || !e.name) return null
  const cat = mcData.entitiesByName[e.name]?.category
  return cat === 'Hostile mobs' ? 'hostile' : cat === 'Passive mobs' ? 'passive' : null
}
export class EpisodeMemory {
  constructor() { this.ironSeen = null; this.lastPath = null; this.deaths = 0; this.heading = 'north'; this.base = { table: null, furnace: null } }
  sawIron(pos, t, where = null) { this.ironSeen = { pos: { x: pos.x, y: pos.y, z: pos.z }, t, where } }
  setBase(kind, pos) { this.base[kind] = pos ? { x: pos.x, y: pos.y, z: pos.z } : null }
}
const relTo = (from, p) => { const dx = p.x - from.x, dz = p.z - from.z; return { dist: Math.hypot(dx, p.y - from.y, dz), dir: dirWord(dx, dz), dy: p.y - from.y } }

export function summarize(bot, mcData, mem, ctx) {
  const me = bot.entity.position
  const ids = names => names.map(n => mcData.blocksByName[n]?.id).filter(x => x != null)
  const KINDS = [
    ['log', mcData.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id), 48],
    ['stone', ids(['stone', 'deepslate', 'cobblestone']), 16], ['coal_ore', ids(['coal_ore', 'deepslate_coal_ore']), 32],
    ['iron_ore', ids(['iron_ore', 'deepslate_iron_ore']), 32], ['water', ids(['water']), 12], ['lava', ids(['lava']), 12],
  ]
  const blocks = []
  for (const [kind, matching, maxDistance] of KINDS) {
    if (!matching.length) continue
    const pos = bot.findBlocks({ matching, maxDistance, count: 1 })[0]
    if (!pos) continue
    const b = bot.blockAt(pos)
    blocks.push({ name: kind === 'log' ? b.name : kind === 'stone' ? 'stone' : b.name.replace('deepslate_', ''), pos: { x: pos.x, y: pos.y, z: pos.z }, ...relTo(me, pos), reachable: relTo(me, pos).dist <= 6 || bot.canSeeBlock(b) })
    if (kind === 'iron_ore') mem.sawIron(pos, ctx.t, null)
  }
  const airId = mcData.blocksByName.air.id
  const cave = bot.findBlocks({ matching: airId, maxDistance: 24, count: 400 }).find(p => p.y <= me.y + 1 && p.y > me.y - 12 && bot.world.getSkyLight(p) === 0 && bot.world.getBlockLight(p) === 0 && bot.blockAt(p.offset(0, 1, 0))?.type === airId)
  if (cave) blocks.push({ name: 'cave', pos: { x: cave.x, y: cave.y, z: cave.z }, ...relTo(me, cave), reachable: false })
  blocks.sort((a, b) => a.dist - b.dist)
  const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position).map(e => ({ name: e.name || e.username || 'unknown', kind: classifyEntity(e, mcData), ...relTo(me, e.position), id: e.id }))
    .filter(e => e.kind && e.dist <= 32).sort((a, b) => a.dist - b.dist).slice(0, 6)
  const hostiles = entities.filter(e => e.kind === 'hostile')
  const inv = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
  const toolWear = {}
  for (const it of bot.inventory.items()) if (it.name.endsWith('_pickaxe') && it.durabilityUsed) toolWear[it.name] = Math.round(100 * it.durabilityUsed / mcData.itemsByName[it.name].maxDurability)
  const head = me.offset(0, 1, 0).floored()
  const skyLight = bot.world.getSkyLight(head) ?? 15, blockLight = bot.world.getBlockLight(head) ?? 0
  const below = bot.blockAt(me.offset(0, -1, 0))
  const { phase, secondsToDusk, secondsToMorning } = phaseOf(bot.time.timeOfDay)
  const weather = bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear'
  const base = { crafting_table: mem.base.table && relTo(me, mem.base.table), furnace: mem.base.furnace && relTo(me, mem.base.furnace) }
  const ironSeen = mem.ironSeen && { ...relTo(me, mem.ironSeen.pos), agoS: ctx.t - mem.ironSeen.t, where: mem.ironSeen.where, pos: mem.ironSeen.pos }
  return {
    t: ctx.t, day: Number(bot.time.day), timeOfDay: bot.time.timeOfDay, phase, secondsToDusk, secondsToMorning, weather,
    biome: bot.blockAt(me)?.biome?.name || 'unknown', pos: { x: me.x, y: me.y, z: me.z }, standingOn: below?.name || 'air',
    skyLight, blockLight, underground: skyLight < 4, inWater: bot.entity.isInWater || false,
    health: bot.health ?? 20, food: bot.food ?? 20, inventory: inv, holding: bot.heldItem?.name || null, toolWear,
    base, memory: { ironSeen, lastPath: mem.lastPath, deaths: mem.deaths, heading: mem.heading },
    blocks, entities, nearestHostile: hostiles[0] || null,
    current: ctx.current, last: ctx.last, goal: ctx.goal || 'iron_pickaxe', done: !!inv.iron_pickaxe,
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

---

### Task 7: Motor layer

**Files:**
- Create: `agent/motor.js`, `tests/integration/motor_check.mjs`

**Interfaces:**
- Consumes: `parseOption`, `EpisodeMemory`.
- Produces: `class Motor { constructor(bot, mcData, mem, {log}) ; run(id, obs) -> Promise<{result, detail?}> ; interrupt(reason) ; progress() -> number|null ; busy }`. `TIMEOUTS` per subtask name.

Executor rules (each wrapped by `run` with the timeout, the interrupt flag and the typed-result mapping; pathfinder errors: `NoPath`→`no_path`, `Timeout`/`PathStopped`/`GoalChanged`→`timeout` unless interrupted):
- `gather_wood`: up to 3 times: nearest `*_log` within 48 → `bot.collectBlock.collect(block)`; stop early on interrupt; `ok` if ≥1 collected else `not_found`/`no_path`.
- `mine_stone`: equip best pickaxe; up to 4 `stone|deepslate` blocks within 16 with `collect`; `ok` when cobble count rose.
- `mine_coal` / `mine_iron`: equip best pickaxe; `mine_iron` walks to `mem.ironSeen.pos` (GoalNear 3) when no ore is in `findBlock` range; collect up to 3 ores; `target_gone` if none found at the remembered spot (and clear memory).
- `craft(item)`: item id map `{planks: <bot's log type>_planks, sticks: stick}`; `recipesFor(id, null, 1, null)`; if empty and item needs a table: table = `findBlock crafting_table within 8` or `placeNear('crafting_table')`; `recipesFor(id, null, 1, table)`; empty → `no_materials`; `bot.craft(recipe, count, table)`; count: planks `min(logs, 2)`, sticks 1, others 1. After placing a table or furnace, `mem.setBase`.
- `smelt(iron_ingot)`: furnace = findBlock within 8 or `placeNear('furnace')` (`no_furnace`); `openFurnace`; fuel: coal `ceil(raw/8)` else planks `ceil(raw/1.5)`; `putFuel`, `putInput(raw_iron, null, raw)`; poll every 1 s until `outputItem()?.count >= raw` or timeout; `takeOutput()`; close; `ok`.
- `explore_toward(down)`: if `y > 16`: goal `GoalBlock(x + 6·fx, y − 4, z + 6·fz)` with `fx, fz` from `mem.heading`; else `GoalXZ(x + 12·fx, z + 12·fz)`; Movements with `canDig = true`, `scafoldingBlocks` includes cobblestone; `ok` on arrival; progress = `(y0 − y)/(y0 − 16)` clamped.
- `explore_toward(cave)`: `GoalNear(cavePos, 2)`.
- `explore_toward(surface)`: rotate `mem.heading` by 45° when the last path failed; `GoalXZ(x + 24·fx, z + 24·fz)`.
- `return_to_base`: `GoalNear(table, 3)`.
- `eat`: equip a food item, `bot.consume()`.
- `build_shelter`: `bot.dig(below)` twice (stepping down between), then place a block over the head using `placeAt(head + 1)`; `ok`.
- `fight(threat)`: equip sword or best pickaxe; `bot.pvp.attack(entity)`; resolve on `stoppedAttacking` or when the entity is gone → `ok`/`target_gone`.
- `flee(threat)`: `GoalInvert(new GoalNear(h.x, h.y, h.z, 20))` for ≤ 15 s → `ok`.
- `pillar_up`: 3 × (look down, jump, place block below with `placeBlock(refBelow2, (0,1,0))`) → `ok`/`failed`.
- `wait`: 3 s.

`placeNear(itemName)`: find a solid block with air above within 3 m (try the block under the bot's feet neighbours), equip the item, `bot.placeBlock(ref, Vec3(0,1,0))`, return the placed block.

- [ ] **Step 1: Write the integration check** `tests/integration/motor_check.mjs`: starts a server (port 25571, seed `motor-1`), connects, runs in order `gather_wood` ×2, `craft(planks)`, `craft(crafting_table)`, `craft(sticks)`, `craft(wooden_pickaxe)`, `explore_toward(down)`, `mine_stone` ×3, `craft(stone_pickaxe)`, `craft(furnace)`, `explore_toward(down)` ×3, `wait`, `pillar_up`, `flee(threat)` (with a fake hostile position), printing `[t] subtask -> result` per line and a final `PASS` when every result is `ok`, then stops the server. Time budget 6 min.
- [ ] **Step 2: Implement `agent/motor.js`** as specified above (full code written at execution time; the contract is the result vocabulary and timeouts):

```js
export const TIMEOUTS = { gather_wood: 45, mine_stone: 45, mine_coal: 60, mine_iron: 90, craft: 20, smelt: 90, explore_toward: 40, return_to_base: 60, eat: 10, build_shelter: 20, fight: 25, flee: 20, pillar_up: 10, wait: 3 }
export const RESULTS = ['ok', 'no_path', 'timeout', 'target_gone', 'took_damage', 'interrupted', 'not_found', 'no_table', 'no_furnace', 'no_materials', 'failed', 'died']
```

- [ ] **Step 3: Run the check on a live server until every step is `ok`.** Expect pathfinder debugging here; keep each fix inside the executor it belongs to.

---

### Task 8: kev client and episode log

**Files:**
- Create: `agent/kev_client.js`, `agent/logger.js`, `tests/logger.test.mjs`

**Interfaces:**
- `ask(url, state, questions) -> Promise<{answers, latency_ms}>` (fetch, `Authorization: Bearer local`, body `{state, model: 'kev-latest', questions}`).
- `oneHot(qs, labels) -> answers` shaped like the parent's `_answers_one_hot`; `fromKev(resp, qs, labels) -> answers` like `_answers_from_kev`.
- `class EpisodeLog { constructor(meta); frame(f); decision(d); event(e); sample(s); finish({end_reason}); toJSON(); toRecords() -> [{state, questions}] }` where `toRecords` fills labels via `labelDecisions` and drops censored questions and empty records; records carry `_meta: {seed, t, decision: bool}` for thinning (stripped by gen_data before writing).

- [ ] **Step 1: Failing tests**

```js
// tests/logger.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EpisodeLog, oneHot, fromKev } from '../agent/logger.js'

test('oneHot shapes every question type', () => {
  const qs = { a: { type: 'choice', criteria: { x: '', y: '' } }, b: { type: 'noul' }, c: { type: 'score', criteria: ['l', 'm', 'h'] } }
  const a = oneHot(qs, { a: 'y', b: null, c: null })
  assert.deepEqual(a.a.probabilities, { x: 0, y: 1 }); assert.equal(a.a.choice, 'y')
  assert.equal(a.b.probabilities, null); assert.equal(a.c.probabilities, null)
})

test('fromKev keeps the full distribution and the label', () => {
  const qs = { a: { type: 'choice', criteria: { x: '', y: '' } }, b: { type: 'noul' } }
  const resp = { answers: { a: { choice: 'x', probabilities: { x: 0.7, y: 0.3 }, confidence: 0.7 }, b: { noul: 0.2 } } }
  const a = fromKev(resp, qs, { a: 'y', b: null })
  assert.equal(a.a.label, 'y'); assert.equal(a.b.probabilities.true, 0.2)
})

test('toRecords drops censored questions and empty records', () => {
  const log = new EpisodeLog({ seed: 1 })
  log.sample({ t: 0, step: 1, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 1000, day: 0, done: false })
  log.sample({ t: 70, step: 2, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 2400, day: 0, done: false })
  log.decision({ t: 0, state_text: 's0', qs: { subgoal_succeeds_60s: { type: 'noul', instructions: 'q' }, damage_next_20s: { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c', 'd'] } }, labels: {}, answers: {}, decision: false })
  log.decision({ t: 65, state_text: 's1', qs: { subgoal_succeeds_60s: { type: 'noul', instructions: 'q' } }, labels: {}, answers: {}, decision: false })
  const recs = log.toRecords()
  assert.equal(recs.length, 1)
  assert.equal(recs[0].questions.subgoal_succeeds_60s.label, true)
  assert.equal(recs[0].questions.damage_next_20s.label, 0)
  assert.equal(log.censoring().subgoal_succeeds_60s.censored, 1)
})
```

- [ ] **Step 2: Run, expect failure.** **Step 3: Implement** (`fromKev`/`oneHot` mirror the parent's Python; `toRecords` calls `labelDecisions(decisions, samples)` then builds `{state, questions: {qid: {type, instructions, criteria?, label}}}`; `censoring()` counts labelled vs censored per qid). **Step 4: Run tests, expect pass.**

---

### Task 9: Episode runner

**Files:**
- Create: `agent/run_episode.mjs`, `tests/runner.test.mjs` (pure `chooseAction` helper)

**Interfaces:**
- CLI: `node agent/run_episode.mjs --seed 7 --port 25580 --policy teacher|kev --kev-url http://127.0.0.1:8009 --eps-action 0.1 --minutes 20 --out name [--video] [--no-server]`.
- Exports `chooseAction({policy, answers, labels, qs, rng, epsAction}) -> {id, source: 'teacher'|'kev'|'random'|'fallback'}` validating `id ∈ Object.keys(qs.next_subtask.criteria)`.
- Loop (1 Hz, `setInterval` 1000 ms, skipping a tick if the previous is still running): `obs = summarize(...)`; `log.sample(...)`; `decision = !motor.busy`; `{qs, labels} = buildQuestions(obs, {decision})`; answers from kev or one-hot; `log.decision(...)`; if `decision`: `chooseAction` → `motor.run(id, obs)` (async; on settle store `last`, `mem.lastPath`, log event); interrupts: a hostile within 16 m that was not within 16 m last tick and the current subtask is not `fight/flee/pillar_up` → `motor.interrupt('threat')`; `health` fell ≥ 4 since the subtask started → `interrupt('took_damage')`; `bot.on('death')` → `mem.deaths++`, `motor.interrupt('died')`, event; end when `t ≥ minutes·60` or (`obs.done` and morning reached) → `log.finish`, write `out/<name>.json` and `out/<name>.jsonl`, stop the server, exit 0.
- Episode start: `/time set 0`, `/difficulty normal`, `/gamerule doDaylightCycle true`, `/gamerule keepInventory false`, wait for chunks, `t0`.
- `--video`: `headless(bot, {output: out/<name>.mp4, frames: -1, width: 448, height: 448})` and an event `{kind: 'video_start', t}` so the viewer can align.

- [ ] **Step 1: Failing test for `chooseAction`** (teacher label; kev argmax; eps random within options; fallback to `wait` when the choice is not offered).
- [ ] **Step 2: Implement** the helper and the runner. **Step 3:** unit test passes. **Step 4:** `node agent/run_episode.mjs --seed 1 --port 25581 --policy teacher --minutes 3 --out t_s1` writes `out/t_s1.json` with ≥ 150 decisions and ≥ 1 event `subtask_done`; `node -e` prints the censoring table.

---

### Task 10: Parallel data generation and base rates

**Files:**
- Create: `agent/gen_data.mjs`, `scripts/base_rates.py`

- `gen_data.mjs --seeds 40 --seed0 0 --procs 4 --minutes 20 --eps-action 0.1 --out data/mc1.jsonl [--thin 5]`: runs `run_episode.mjs` as child processes, `procs` at a time, port `25600 + slot`, name `gen_s<seed>`; after each, appends its records: all records with `_meta.decision` plus every `thin`-th forecast-only record; strips `_meta`; prints per-seed lines (records, success time, deaths, end reason) and, at the end, per-question label counts and censoring rates.
- `scripts/base_rates.py data/mc1.jsonl`: label distribution per question (must show every noul between 20% and 80%; otherwise change a horizon in `questions.js` before training and regenerate).

- [ ] **Steps:** write both; run `--seeds 2 --procs 2 --minutes 3` as a smoke; then the real collection: `--seeds 48 --seed0 0 --procs 4 --minutes 20 --out data/mc1.jsonl` and `--seeds 12 --seed0 1000 --procs 4 --minutes 20 --out data/mc1_holdout.jsonl` (detached with `setsid nohup`, log `data/gen.log`). Check base rates; if `subgoal_succeeds_60s` is above 80% overall, keep it (per-step rates are the point) but report per-step rates in `base_rates.py`.

---

### Task 11: Split, train, evaluate

**Files:**
- Create: `scripts/split.sh`, `scripts/train_mc1.sh`, `scripts/eval_mc1.sh`, `scripts/bench_ctx.py` (copy of `../overcooked-kev/aircombat/bench_ctx.py`)

```bash
# scripts/split.sh
python3 ../overcooked-kev/kev/skills/kev-finetune/scripts/split_data.py data/mc1.jsonl --holdout data/mc1_holdout.jsonl --out data/mc1_ep
```
```bash
# scripts/train_mc1.sh  (run detached; log kev/runs/mc-v1.log)
cd ../overcooked-kev/kev && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True .venv/bin/python -m kev.train --data ../../minecraft-kev/data/mc1_ep/train.jsonl \
  --init_from jaredpalmer/kev-0.8b --base Qwen/Qwen3.5-0.8B-Base --base_revision dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68 \
  --suite evals/v7/decision-v7 --replay 1000 --epochs 1 --lr 2e-5 --batch 1 --accum 8 --perm_kl 0.5 --dtype bf16 --checkpointing 1 \
  --device cuda --seed 0 --max_state 512 --out runs/mc-v1
```
`eval_mc1.sh mc-v1 data/mc1_ep` = the parent's `eval_run_v2.sh` with `KEV_BENCH_MAX_STATE=512` and paths adjusted.

- [ ] **Steps:** split; read `summary.json`; train overnight; evaluate; paste the table into `MC_Claude.md` status.

---

### Task 12: Drive evaluation, DAgger round, reliability diagrams, clip

**Files:**
- Create: `scripts/drive_summary.py`, `scripts/reliability.py`, `scripts/drive_eval.sh`, `viewer/index.html`, `viewer/serve.py`

- `drive_eval.sh <run>`: serve `runs/<run>` on 8009; for seeds 1000–1019 run `run_episode.mjs --policy kev` and `--policy teacher` (procs 4); `drive_summary.py out/` prints success within 15 min (kev vs teacher), median time to pickaxe, deaths.
- DAgger: `gen_data.mjs --policy kev --kev-url ... --seeds 24 --seed0 2000 --out data/mc1_dagger.jsonl`; concatenate with `data/mc1.jsonl`, re-split (same holdout), train `mc-v2` with `--init_from runs/mc-v1`; re-evaluate and re-drive.
- `reliability.py runs/<run>-dev/rows.json data/mc1_ep/summary.json --out reports/<run>/`: per question a 10-bin reliability diagram PNG plus a table row `question, n, accuracy, base rate, ECE, censoring rate` (censoring from `gen_data`'s report saved as `data/mc1.censoring.json`).
- Viewer: `viewer/index.html` plays `out/<name>.mp4` and, on `timeupdate`, shows the decision with the largest `t ≤ video.currentTime + video_start` as probability bars (copy the bar CSS from the parent `viewer/index.html`); `viewer/serve.py 8080` serves `viewer/` and `out/`. Record one kev-driven episode with `--video`.

- [ ] **Steps:** run the drive eval on mc-v1; DAgger; drive eval on mc-v2; reliability diagrams for `subgoal_succeeds_60s` and `iron_found_3min` (≥ 200 subgoal attempts: count decision points with the step question in dev); one clip; update `MC_Claude.md` with a Status section holding the DoD table.

---

## Self-review

- **Spec coverage:** motor layer (T7), teacher (T3), serializer (T4), schema with all six questions and when each is asked (T5), labels from game outcomes with censoring (T5, T8), epsilon noise and thinning (T9, T10), episode-disjoint holdout (T11), recipe (T11), DAgger (T12), DoD items 1–4 (T12), logging contract with full distributions (T8). Planner-kev interface: out of scope for experiment 1 by design (fixed subgoal); `abandon_subgoal` and `sleep` are not offered because no planner and no bed exist, noted in `subtasks.js`.
- **Type consistency:** option ids are strings `name(arg)` everywhere (`subtasks.optionId`, teacher return, `qs.next_subtask.criteria` keys, `motor.run(id)`); timeline sample fields `{t, step, rawIron, ingots, health, dead, timeOfDay, day, done}` are shared by `logger.sample`, `labelDecisions` and the runner; `obs.last` is `{id, result}`.
- **Review focus tests:** no-tree spawn (T3 test 2), death (T5 damage test, T9 death event), hostile during craft (T3 threat test, T9 interrupt), choice outside options (T9 `chooseAction` fallback), text budget (T4 crowded test).
