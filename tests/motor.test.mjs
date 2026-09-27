import test from 'node:test'
import assert from 'node:assert/strict'
import mcDataFor from 'minecraft-data'
import { Motor } from '../agent/motor.js'
import { EpisodeMemory } from '../agent/summary.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
function fakeBot() {
  const handlers = {}
  return {
    version: '1.20.4', registry: mcDataFor('1.20.4'),
    entity: { position: { x: 0, y: 64, z: 0, floored() { return this }, offset() { return this }, distanceTo() { return 0 } }, yaw: 0, pitch: 0 },
    setMaxListeners() {}, on(n, f) { (handlers[n] ||= []).push(f) }, once() {}, removeListener() {}, waitForTicks: async () => {},
    pathfinder: { setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false, isMining: () => false, goto: async () => {} },
    _client: { on() {} }, clickWindow: async () => {}, inventory: { items: () => [] }, heldItem: null,
    collectBlock: { targets: { clear() {}, empty: true }, movements: null }, pvp: { stop() {} },
    stopDigging() {}, clearControlStates() {}, blockAt: () => null, findBlock: () => null, findBlocks: () => [],
  }
}

test('an executor abandoned by its timeout is aborted at its next check, even after a new run has started', async () => {
  const bot = fakeBot()
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory(), { timeouts: { wait: 0.05, slow: 0.05 } })
  let zombieOutcome = null
  motor.exec.slow = async function () {
    await sleep(120)            // outlives the 50 ms timeout
    try { this.check(); zombieOutcome = 'survived' } catch (e) { zombieOutcome = `aborted:${e.message}` }
    return { result: 'ok' }
  }
  const r1 = await motor.run('slow', {})
  assert.equal(r1.result, 'timeout')
  const r2 = motor.run('wait', {})   // a new run begins while the zombie is still sleeping
  await sleep(150)
  await r2
  assert.match(zombieOutcome, /^aborted/)
})

test('interrupt aborts the running executor and reports the reason', async () => {
  const bot = fakeBot()
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory(), { timeouts: { slow: 5 } })
  motor.exec.slow = async function () { for (let i = 0; i < 50; i++) { await sleep(20); this.check() } return { result: 'ok' } }
  const p = motor.run('slow', {})
  await sleep(50)
  motor.interrupt('threat')
  const r = await p
  assert.equal(r.result, 'interrupted'); assert.equal(r.detail, 'threat')
  assert.equal(motor.busy, false)
})

test('goto with its own Movements drops the goal before restoring the default Movements, however the walk settles', async () => {
  for (const outcome of ['resolve', 'NoPath', 'Timeout']) {
    const bot = fakeBot()
    const calls = []
    let goal = null, motor = null
    bot.pathfinder.setGoal = g => { goal = g; calls.push(`goal:${g ? 'set' : 'null'}`) }
    bot.pathfinder.setMovements = m => calls.push(`movements:${m === motor?.walkMovements ? 'walk' : m === motor?.movements ? 'default' : 'other'}`)
    // pathfinder.goto sets its goal and settles without clearing it (an empty path, NoPath, a think timeout)
    bot.pathfinder.goto = async g => {
      bot.pathfinder.setGoal(g)
      await sleep(5)
      if (outcome !== 'resolve') { const e = new Error(outcome); e.name = outcome; throw e }
    }
    motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory())
    motor.deadline = Date.now() + 60_000
    calls.length = 0
    await motor.walkTo({ x: 1, y: 64, z: 1 }).catch(() => {})
    const restore = calls.lastIndexOf('movements:default')
    assert.ok(restore > 0, `${outcome}: default Movements restored (${calls.join(' ')})`)
    assert.equal(calls[restore - 1], 'goal:null', `${outcome}: the goal is dropped right before (${calls.join(' ')})`)
    assert.equal(goal, null, `${outcome}: no goal left live`)
  }
})

import { Vec3 } from 'vec3'
import { liquidAround } from '../agent/motor.js'

// blockAt over a Map keyed "x,y,z"; anything unset is stone.
const world = cells => p => ({ name: cells.get(`${p.x},${p.y},${p.z}`) || 'stone', position: p })

test('liquidAround: dry step is safe', () => {
  assert.equal(liquidAround(world(new Map()), new Vec3(5, 20, 0)), null)
})

test('liquidAround: lava in any of the three dug cells or the cell below the step', () => {
  const ahead = new Vec3(5, 20, 0)
  for (const dy of [1, 0, -1, -2]) {
    const cells = new Map([[`5,${20 + dy},0`, 'lava']])
    assert.equal(liquidAround(world(cells), ahead), 'lava', `lava at dy ${dy}`)
  }
  assert.equal(liquidAround(world(new Map([['5,18,0', 'water']])), ahead), 'water')
})

test('liquidAround: liquid outside the checked column is ignored; unloaded cells are not liquid', () => {
  const ahead = new Vec3(5, 20, 0)
  assert.equal(liquidAround(world(new Map([['5,17,0', 'lava'], ['6,20,0', 'lava'], ['5,22,0', 'lava']])), ahead), null)
  assert.equal(liquidAround(() => null, ahead), null)
})

import { isLavaSource, portalLayout } from '../agent/motor.js'

test('isLavaSource: only a lava block at level 0 is a source', () => {
  assert.equal(isLavaSource({ name: 'lava', getProperties: () => ({ level: 0 }) }), true)
  assert.equal(isLavaSource({ name: 'lava', getProperties: () => ({ level: 2 }) }), false)
  assert.equal(isLavaSource({ name: 'water', getProperties: () => ({ level: 0 }) }), false)
  assert.equal(isLavaSource(null), false)
})

test('portalLayout: 10 obsidian, 4 corner fillers and the inside cell along x and z', () => {
  const key = p => `${p.x},${p.y},${p.z}`
  const L = portalLayout(new Vec3(0, 64, 0), 'x')
  assert.equal(L.obsidian.length, 10); assert.equal(L.filler.length, 4)
  const obs = new Set(L.obsidian.map(key)), fill = new Set(L.filler.map(key))
  for (const k of ['1,64,0', '2,64,0', '0,65,0', '0,66,0', '0,67,0', '3,65,0', '3,66,0', '3,67,0', '1,68,0', '2,68,0']) assert.ok(obs.has(k), `obsidian ${k}`)
  for (const k of ['0,64,0', '3,64,0', '0,68,0', '3,68,0']) assert.ok(fill.has(k), `filler ${k}`)
  assert.equal(key(L.inside), '1,65,0')
  const Z = portalLayout(new Vec3(10, 64, 5), 'z')
  assert.ok(new Set(Z.obsidian.map(key)).has('10,64,6')); assert.ok(new Set(Z.filler.map(key)).has('10,68,8'))
  assert.equal(key(Z.inside), '10,65,6')
})

import { rayClear } from '../agent/motor.js'

test('rayClear: reaches the target through air and fluids, stops at a solid block in the way', () => {
  const air = p => ({ name: 'air', boundingBox: 'empty', position: p })
  const cells = new Map([['2,64,0', { name: 'stone', boundingBox: 'block' }], ['1,64,5', { name: 'water', boundingBox: 'empty' }]])
  const at = p => cells.get(`${p.x},${p.y},${p.z}`) || air(p)
  const solid = b => b.boundingBox === 'block'
  assert.equal(rayClear(at, new Vec3(0.5, 64.5, 0.5), new Vec3(4.5, 64.5, 0.5), new Vec3(4, 64, 0), solid), false)
  assert.equal(rayClear(at, new Vec3(0.5, 65.5, 0.5), new Vec3(4.5, 65.5, 0.5), new Vec3(4, 65, 0), solid), true)
  assert.equal(rayClear(at, new Vec3(1.5, 64.5, 3.5), new Vec3(1.5, 64.5, 6.5), new Vec3(1, 64, 6), solid), true)
})

import { thriftyPickaxe } from '../agent/motor.js'
test('thriftyPickaxe: tunnelling spends the stone pickaxe, the iron one only where it is needed', () => {
  const md = mcDataFor('1.20.4')
  const inv = names => names.map(n => ({ name: n, type: md.itemsByName[n].id }))
  const blk = n => md.blocksByName[n]
  const all = inv(['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'oak_planks'])
  assert.equal(thriftyPickaxe(blk('stone'), all).name, 'stone_pickaxe')
  assert.equal(thriftyPickaxe(blk('granite'), inv(['iron_pickaxe', 'wooden_pickaxe'])).name, 'wooden_pickaxe')
  assert.equal(thriftyPickaxe(blk('iron_ore'), inv(['iron_pickaxe', 'wooden_pickaxe'])).name, 'iron_pickaxe')
  assert.equal(thriftyPickaxe(blk('iron_ore'), all).name, 'stone_pickaxe')
  assert.equal(thriftyPickaxe(blk('diamond_ore'), all).name, 'iron_pickaxe')
  assert.equal(thriftyPickaxe(blk('stone'), inv(['iron_pickaxe'])).name, 'iron_pickaxe')   // the only one that works
  assert.equal(thriftyPickaxe(blk('dirt'), all), null)          // not a pickaxe block: the default (fastest) choice
  assert.equal(thriftyPickaxe(blk('obsidian'), all), null)      // nothing held can harvest it: the default
})

import { fuelPlan } from '../agent/motor.js'
test('fuelPlan: fuel for every raw iron, counting what already sits in the slot', () => {
  const inv = o => Object.entries(o).map(([name, count]) => ({ name, count }))
  // one coal smelts 8
  assert.deepEqual(fuelPlan(3, inv({ coal: 2 }), null), { take: false, put: { name: 'coal', count: 1 }, smelt: 3 })
  // a leftover plank in the slot (1.5 items) is topped up, not trusted to cover 3 (the run-1 smelt timeouts)
  assert.deepEqual(fuelPlan(3, inv({ oak_planks: 4 }), { name: 'oak_planks', count: 1 }), { take: false, put: { name: 'oak_planks', count: 1 }, smelt: 3 })
  // enough in the slot already
  assert.deepEqual(fuelPlan(3, inv({ coal: 1 }), { name: 'coal', count: 1 }), { take: false, put: null, smelt: 3 })
  // a different fuel in the slot that cannot cover it: take it out, put coal
  assert.deepEqual(fuelPlan(4, inv({ coal: 1 }), { name: 'birch_planks', count: 1 }), { take: true, put: { name: 'coal', count: 1 }, smelt: 4 })
  // not enough fuel for all: smelt what it covers (one log = 1.5 items -> 1), never wait on the rest
  assert.deepEqual(fuelPlan(4, inv({ birch_log: 1 }), null), { take: false, put: { name: 'birch_log', count: 1 }, smelt: 1 })
  // no fuel at all
  assert.equal(fuelPlan(3, inv({ stick: 4 }), null).smelt, 0)
})

import { isShore, dropBelow, dropAhead, isGravityBlock, SHORE_BLOCKS } from '../agent/motor.js'
// blockAt with bounding boxes: anything unset is stone; air, water and lava are empty.
const EMPTY = new Set(['air', 'cave_air', 'water', 'lava', 'seagrass', 'short_grass'])
const world2 = cells => p => { const name = cells.get(`${p.x},${p.y},${p.z}`) || 'stone'; return { name, position: p, boundingBox: EMPTY.has(name) ? 'empty' : 'block' } }
const col = (x, z, from, names) => names.map((n, i) => [`${x},${from - i},${z}`, n])

test('isShore: a shore block with two passable cells above, not under water', () => {
  const at = world2(new Map([...col(0, 0, 62, ['air', 'air', 'sand']), ...col(1, 0, 62, ['water', 'water', 'sand']), ...col(2, 0, 62, ['air', 'short_grass', 'grass_block']),
    ...col(3, 0, 62, ['air', 'seagrass', 'sand']), ...col(4, 0, 62, ['air', 'air', 'glass'])]))
  assert.equal(isShore(at, new Vec3(0, 60, 0)), true)
  assert.equal(isShore(at, new Vec3(1, 60, 0)), false, 'sand under water')
  assert.equal(isShore(at, new Vec3(2, 60, 0)), true, 'grass with a plant above is standable')
  assert.equal(isShore(at, new Vec3(3, 60, 0)), false, 'seagrass above: under water')
  assert.equal(isShore(at, new Vec3(4, 60, 0)), false, 'not a shore block')
  assert.equal(isShore(() => null, new Vec3(0, 60, 0)), false)
  assert.ok(SHORE_BLOCKS.includes('sand') && SHORE_BLOCKS.includes('stone'))
})

test('dropBelow / dropAhead: floor present, a hole, a deep drop, liquid under the step', () => {
  const ahead = new Vec3(5, 20, 0)   // the down staircase stands on ahead-2 = (5, 18, 0)
  assert.deepEqual(dropAhead(world2(new Map()), ahead), { drop: 0, liquid: null })
  assert.deepEqual(dropAhead(world2(new Map([['5,18,0', 'air']])), ahead), { drop: 1, liquid: null })
  assert.deepEqual(dropAhead(world2(new Map(col(5, 0, 18, ['air', 'cave_air', 'air']))), ahead), { drop: 3, liquid: null })
  assert.deepEqual(dropAhead(world2(new Map(col(5, 0, 18, ['air', 'air', 'air', 'air', 'air']))), ahead), { drop: 4, liquid: null })
  assert.deepEqual(dropAhead(world2(new Map(col(5, 0, 18, ['air', 'water']))), ahead), { drop: 1, liquid: 'water' })
  assert.deepEqual(dropAhead(world2(new Map([['5,17,0', 'lava']])), ahead), { drop: 0, liquid: 'lava' }, 'solid floor over lava')
  assert.deepEqual(dropAhead(() => null, ahead), { drop: 4, liquid: null }, 'unloaded: treated as a drop')
  // the climb's step is the cell itself
  assert.deepEqual(dropBelow(world2(new Map(col(5, 0, 20, ['air', 'air']))), ahead), { drop: 2, liquid: null })
})

import { fleeHeading, fleeTargetPos } from '../agent/motor.js'
test('fleeHeading: the cardinal heading pointing away from the hostile', () => {
  assert.equal(fleeHeading({ x: 10, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }), 'west', 'hostile to the east: flee west')
  assert.equal(fleeHeading({ x: -10, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }), 'east', 'hostile to the west: flee east')
  assert.equal(fleeHeading({ x: 0, y: 64, z: 10 }, { x: 0, y: 64, z: 0 }), 'north', 'hostile to the south: flee north')
  assert.equal(fleeHeading({ x: 0, y: 64, z: -10 }, { x: 0, y: 64, z: 0 }), 'south', 'hostile to the north: flee south')
  assert.equal(fleeHeading({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }), 'east', 'coincident: a tie picks east/west')
})

// Fix round 1: flee() never fled a player-only attacker (nearestHostileEntity/obs.nearestHostile are mob-only).
test('fleeTargetPos: a hostile mob wins; else a live player entity; else the recorded attacker position; else null', () => {
  const hostilePos = { x: 1, y: 64, z: 1 }, livePlayerPos = { x: 5, y: 64, z: 0 }
  const attacker = { kind: 'player', name: 'x', pos: { x: 9, y: 64, z: 0 } }
  assert.deepEqual(fleeTargetPos({ hostilePos, attacker, livePlayerPos }), hostilePos, 'a hostile mob beats a player attacker')
  assert.deepEqual(fleeTargetPos({ hostilePos: null, attacker, livePlayerPos }), livePlayerPos, 'the live entity beats the recorded position')
  assert.deepEqual(fleeTargetPos({ hostilePos: null, attacker, livePlayerPos: null }), attacker.pos, 'no live entity: the recorded position')
  assert.equal(fleeTargetPos({ hostilePos: null, attacker: null, livePlayerPos: null }), null)
  assert.equal(fleeTargetPos(), null)
})

test('flee: with no hostile mob, flees from a player attacker\'s live bot.players entity, then its recorded position, else target_gone', async () => {
  const md = mcDataFor('1.20.4')
  const obs = { attacker: { kind: 'player', name: 'Spacers_Choice', dist: 2, sinceS: 0, pos: { x: 9, y: 64, z: 0 } } }

  const bot1 = { ...fakeBot(), entities: {}, players: { Spacers_Choice: { entity: { position: { x: 5, y: 64, z: 0 } } } } }
  const r1 = await new Motor(bot1, md, new EpisodeMemory()).run('flee', obs)
  assert.equal(r1.result, 'ok', JSON.stringify(r1))

  const bot2 = { ...fakeBot(), entities: {}, players: {} }   // no live entity: falls back to obs.attacker.pos
  const r2 = await new Motor(bot2, md, new EpisodeMemory()).run('flee', obs)
  assert.equal(r2.result, 'ok', JSON.stringify(r2))

  const bot3 = { ...fakeBot(), entities: {}, players: {} }   // nothing to flee from at all
  const r3 = await new Motor(bot3, md, new EpisodeMemory()).run('flee', {})
  assert.equal(r3.result, 'target_gone')
})

test('turnUntilDry: rotates through headings until dry, or reports every heading wet; commit false leaves mem.heading alone', () => {
  const bot = { ...fakeBot(), entities: {} }
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory())
  const goalAt = ([hx, hz]) => ({ x: hx * 8, y: 64, z: hz * 8 })

  motor.mem.heading = 'north'
  motor.wetNear = c => c.x === 0 && c.z === -8   // only the north goal cell is wet
  assert.deepEqual(motor.turnUntilDry(goalAt), { heading: 'east', turns: 1 })
  assert.equal(motor.mem.heading, 'east', 'commit (default) writes mem.heading')

  motor.mem.heading = 'north'
  motor.wetNear = () => true   // every heading wet
  assert.deepEqual(motor.turnUntilDry(goalAt), { heading: 'north', turns: 4 })

  motor.mem.heading = 'south'
  motor.wetNear = c => c.x === 0 && c.z === -8
  assert.deepEqual(motor.turnUntilDry(goalAt, { commit: false, startHeading: 'north' }), { heading: 'east', turns: 1 })
  assert.equal(motor.mem.heading, 'south', 'commit: false leaves mem.heading untouched')
})

test('isGravityBlock: sand, gravel, concrete powder', () => {
  for (const n of ['sand', 'red_sand', 'gravel', 'white_concrete_powder']) assert.equal(isGravityBlock({ name: n }), true, n)
  for (const n of ['stone', 'sandstone', 'dirt']) assert.equal(isGravityBlock({ name: n }), false, n)
  assert.equal(isGravityBlock(null), false)
})

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginRegistry } from '../agent/plugins.js'

test('Motor.run falls back to a registry plugin: echo(x) returns ok x; built-in executors win; unknown fails', async () => {
  const reg = new PluginRegistry({ dir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins') })
  await reg.load()
  const mem = new EpisodeMemory()
  const motor = new Motor(fakeBot(), mcDataFor('1.20.4'), mem)
  motor.plugins = reg
  assert.deepEqual(await motor.run('echo(x)', {}), { result: 'ok', detail: 'x' })
  assert.equal(mem.lastPath, 'ok')   // echo declares breaker: true, so its result feeds the livelock bookkeeping
  assert.deepEqual(await motor.run('nothing(x)', {}), { result: 'failed', detail: 'unknown subtask nothing' })
  motor.exec.echo = async function (arg) { return { result: 'ok', detail: `builtin ${arg}` } }
  assert.deepEqual(await motor.run('echo(y)', {}), { result: 'ok', detail: 'builtin y' })
})

test('Motor.run uses the plugin timeout and maps a plugin throw', async () => {
  const motor = new Motor(fakeBot(), mcDataFor('1.20.4'), new EpisodeMemory())
  const slow = { id: 'slow', timeout: 0.05, async run(m) { await sleep(300); return { result: 'ok' } } }
  const bad = { id: 'bad', timeout: 5, async run() { const e = new Error('no way'); e.name = 'NoPath'; throw e } }
  motor.plugins = { get: n => ({ slow, bad })[n] ?? null }
  const t0 = Date.now()
  assert.equal((await motor.run('slow', {})).result, 'timeout')
  assert.ok(Date.now() - t0 < 280)
  assert.equal((await motor.run('bad(a)', {})).result, 'no_path')
})

// Final review, Important 2: the wet check only changed mem.heading; the GoalInvert that followed ignored it and ran
// into the water. flee now walks ~14 m along the chosen dry heading (away from the threat, or +-90 degrees, never
// toward it) with dryMovements, falling back to GoalInvert with dryMovements when that path fails.
import { Vec3 as V3 } from 'vec3'
import { fleeHeadings } from '../agent/motor.js'
test('fleeHeadings: away first, then the two perpendiculars, never toward the threat', () => {
  assert.deepEqual(fleeHeadings('south'), ['south', 'west', 'east'])
  assert.deepEqual(fleeHeadings('north'), ['north', 'east', 'west'])
})
test('flee: walks along the dry heading with dryMovements; never toward the threat; GoalInvert (dry) as the fallback', async () => {
  const md = mcDataFor('1.20.4')
  const mk = () => {
    const bot = { ...fakeBot(), entities: {}, players: {} }
    bot.entity = { ...bot.entity, position: new V3(0, 64, 0) }
    const motor = new Motor(bot, md, new EpisodeMemory())
    motor.calls = []
    motor.goto = async function (goal, movements) { this.calls.push({ goal, movements }); if (this.failFirst && this.calls.length === 1) { const e = new Error('no path'); e.name = 'NoPath'; throw e } }
    return motor
  }
  const obs = { attacker: { kind: 'player', name: 'p', dist: 3, sinceS: 0, pos: { x: 0, y: 64, z: -10 } } }   // threat north: away is south
  let m = mk()
  m.wetNear = c => c.z > 0 && c.x === 0   // south is wet
  let r = await m.run('flee', obs)
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.equal(m.mem.heading, 'west')
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].movements, m.dryMovements)
  assert.equal(m.calls[0].goal.constructor.name, 'GoalNearXZ')
  assert.ok(m.calls[0].goal.x <= -12 && m.calls[0].goal.z === 0, `the goal lies west: ${m.calls[0].goal.x} ${m.calls[0].goal.z}`)

  m = mk()
  m.wetNear = c => !(c.z < 0 && c.x === 0)   // only north (toward the threat) is dry
  r = await m.run('flee', obs)
  assert.equal(r.result, 'no_path', 'never flees toward the threat')
  assert.equal(m.calls.length, 0)

  m = mk(); m.failFirst = true
  m.wetNear = () => false
  r = await m.run('flee', obs)
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.equal(m.calls.length, 2)
  assert.equal(m.calls[1].goal.constructor.name, 'GoalInvert')
  assert.equal(m.calls[1].movements, m.dryMovements)
})

// Final review, Important 4: craft(planks) under a gather(<wood>_planks) goal uses that species' logs.
import { planksLog } from '../agent/motor.js'
test('planksLog: the most-held log, unless the top goal wants one species and it is held', () => {
  assert.equal(planksLog({ birch_log: 5, oak_log: 1 }, null), 'birch_log')
  assert.equal(planksLog({ birch_log: 5, oak_log: 1 }, { kind: 'gather', arg: 'oak_planks' }), 'oak_log')
  assert.equal(planksLog({ birch_log: 5 }, { kind: 'gather', arg: 'oak_planks' }), 'birch_log')
  assert.equal(planksLog({ birch_log: 5, oak_log: 1 }, { kind: 'chain', arg: null }), 'birch_log')
  assert.equal(planksLog({}, null), undefined)
})


import { standsOn, supportCells } from '../agent/reach.js'

test('supportCells / standsOn: the cell under the feet, or the last solid cell under the footprint', () => {
  const solid = new Set(['0,63,0', '1,63,0'])
  const blockAt = p => ({ name: solid.has(`${p.x},${p.y},${p.z}`) ? 'stone' : 'air', boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' })
  assert.deepEqual(supportCells({ x: 0.5, y: 64, z: 0.5 }), [{ x: 0, y: 63, z: 0 }])
  assert.deepEqual(supportCells({ x: 0.9, y: 64.5, z: 0.5 }), [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }])   // on a slab
  assert.equal(standsOn({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 63, z: 0 }, blockAt), true)
  assert.equal(standsOn({ x: 0.5, y: 64, z: 0.5 }, { x: 1, y: 63, z: 0 }, blockAt), false)
  // straddling two blocks: either may go while the other holds; once one is gone the other is the last support
  assert.equal(standsOn({ x: 1.1, y: 64, z: 0.5 }, { x: 0, y: 63, z: 0 }, blockAt), false)
  solid.delete('1,63,0')
  assert.equal(standsOn({ x: 0.95, y: 64, z: 0.5 }, { x: 0, y: 63, z: 0 }, blockAt), true)
  solid.add('1,63,0'); solid.delete('0,63,0')
  assert.equal(standsOn({ x: 0.95, y: 64, z: 0.5 }, { x: 1, y: 63, z: 0 }, blockAt), true)   // centre over air, footprint on 1,63,0
})

// A motor over a fake world for digCell: digSafe turns the block to air; reachSpot moves the bot to `spot` (or fails).
function digMotor (spot) {
  const solid = new Set()
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 63; y++) solid.add(`${x},${y},${z}`)
  const blockAt = v => { const s = solid.has(`${v.x},${v.y},${v.z}`); return { name: s ? 'stone' : 'air', boundingBox: s ? 'block' : 'empty', hardness: 1.5, position: v } }
  const bot = { ...fakeBot(), blockAt, digTime: () => 400 }
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory())
  motor.deadline = Date.now() + 60_000
  motor.reached = []
  motor.reachSpot = async function (pos, opts) {
    this.reached.push(opts.mode)
    if (!spot) { this.lastReach = 'no_path'; return null }
    bot.entity.position = new Vec3(spot.x + 0.5, spot.y, spot.z + 0.5)
    return { feet: spot }
  }
  motor.digSafe = async b => { solid.delete(`${b.position.x},${b.position.y},${b.position.z}`) }
  return { motor, solid, bot }
}

test('digCell: never the block the bot stands on; it steps to a dig reach spot first, else underfoot', async () => {
  // in reach and in sight, but underfoot: walks off first, then digs
  let { motor, solid, bot } = digMotor({ x: 1, y: 64, z: 0 })
  assert.deepEqual(await motor.digCell({ x: 0, y: 63, z: 0 }), { ok: true })
  assert.deepEqual(motor.reached, ['dig']); assert.ok(!solid.has('0,63,0')); assert.equal(bot.entity.position.x, 1.5)
  // no spot reached: nothing dug
  ;({ motor, solid } = digMotor(null))
  assert.deepEqual(await motor.digCell({ x: 0, y: 63, z: 0 }), { ok: false, why: 'no_path' })
  assert.ok(solid.has('0,63,0'))
  // a spot that still leaves the bot on it (a stand-in reachSpot returning the bot's own cell): refused
  ;({ motor, solid } = digMotor({ x: 0, y: 64, z: 0 }))
  assert.deepEqual(await motor.digCell({ x: 0, y: 63, z: 0 }), { ok: false, why: 'underfoot' })
  assert.ok(solid.has('0,63,0'))
  // a neighbour in reach and in sight: dug from where the bot stands, no walk
  ;({ motor, solid } = digMotor(null))
  assert.deepEqual(await motor.digCell({ x: 1, y: 63, z: 0 }), { ok: true })
  assert.deepEqual(motor.reached, []); assert.ok(!solid.has('1,63,0'))
})

// Live stress session: at 1 hp the bot fled into lava ("kev_80 tried to swim in lava"). Lava counts as wet for the flee
// heading, the surface walk and the descent (wetNear), and the dry walk (dryMovements) never steps next to lava.
import { lavaAdjacent, LAVA_STEP_COST } from '../agent/motor.js'
test('wetNear: lava (source or flowing) counts like water', () => {
  const bot = { ...fakeBot(), entities: {} }
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory())
  const c = new V3(10, 64, 10)
  bot.blockAt = p => (p.x === 11 && p.y === 64 && p.z === 10 ? { name: 'lava', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' })
  assert.equal(motor.wetNear(c), true)
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  assert.equal(motor.wetNear(c), false)
})
test('lavaAdjacent / dryMovements: a cell next to (or over) lava costs LAVA_STEP_COST; lava stays in blocksToAvoid', () => {
  const lavaAt = new Set(['5,63,5'])
  const at = p => ({ name: lavaAt.has(`${p.x},${p.y},${p.z}`) ? 'lava' : 'air' })
  assert.equal(lavaAdjacent(at, new V3(6, 63, 5)), true, 'beside it')
  assert.equal(lavaAdjacent(at, new V3(5, 64, 5)), true, 'standing over it')
  assert.equal(lavaAdjacent(at, new V3(5, 63, 5)), true, 'in it')
  assert.equal(lavaAdjacent(at, new V3(8, 63, 5)), false, 'three cells away')
  const bot = { ...fakeBot(), entities: {} }
  bot.blockAt = at
  const md = mcDataFor('1.20.4')
  const motor = new Motor(bot, md, new EpisodeMemory())
  assert.ok(motor.dryMovements.blocksToAvoid.has(md.blocksByName.lava.id))
  assert.equal(motor.dryMovements.exclusionStep({ position: new V3(6, 63, 5) }), LAVA_STEP_COST)
  assert.equal(motor.dryMovements.exclusionStep({ position: new V3(9, 63, 5) }), 0)
  assert.ok(LAVA_STEP_COST > 100, 'more than the pathfinder\'s give-up cost')
  assert.equal(motor.movements.exclusionStep({ position: new V3(6, 63, 5) }), 0, 'the ordinary movements are unchanged')
})

// Live retry session (2026-09-27): build_shelter dug straight down into lava at 1 hp. The dig-down uses the staircase
// digger's liquid checks: lava or water in a cell it digs, beside one, or under the floor it ends on means not here.
import { shelterColumnLiquid, shelterPlan } from '../agent/motor.js'
test('shelterColumnLiquid / shelterPlan: the dig-down never opens into lava or water; an adjacent dry column, else pillar up', () => {
  const world = (liquids = {}, holes = new Set()) => p => {
    const k = `${p.x},${p.y},${p.z}`
    if (liquids[k]) return { name: liquids[k], boundingBox: 'empty' }
    if (p.y >= 64 || holes.has(k)) return { name: 'air', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const feet = new V3(0, 64, 0)
  assert.equal(shelterColumnLiquid(world(), feet), null, 'solid stone all the way down')
  assert.equal(shelterColumnLiquid(world({ '0,61,0': 'lava' }), feet), 'lava', 'lava 2 blocks under the flat spot')
  assert.equal(shelterColumnLiquid(world({ '0,60,0': 'water' }), feet), 'water', 'water under the floor the bot ends on')
  assert.equal(shelterColumnLiquid(world({ '1,62,0': 'lava' }), feet), 'lava', 'lava beside the second dug cell')
  assert.equal(shelterColumnLiquid(world({ '0,63,-1': 'water' }), feet), 'water', 'water beside the first dug cell')
  assert.equal(shelterColumnLiquid(world({ '0,63,0': 'lava' }), feet), 'lava', 'lava in the cell below')
  assert.equal(shelterColumnLiquid(world({ '3,62,0': 'lava' }), feet), null, 'three cells away is fine')
  assert.deepEqual(shelterPlan(world(), feet), { action: 'dig', at: feet })
  // lava under this spot's floor only: the east neighbour (x+1) is dry, stand there instead
  const one = shelterPlan(world({ '0,60,0': 'lava' }), feet)
  assert.equal(one.action, 'move')
  assert.ok(shelterColumnLiquid(world({ '0,60,0': 'lava' }), one.to) === null, 'the chosen neighbour is dry')
  assert.equal(Math.abs(one.to.x) + Math.abs(one.to.z), 1)
  // a lava lake 2 below everything: nothing is safe, pillar up instead
  const lake = {}
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) lake[`${x},62,${z}`] = 'lava'
  assert.deepEqual(shelterPlan(world(lake), feet), { action: 'pillar' })
  // a neighbour whose feet cell is solid (a wall) cannot be stood in
  const walled = world({ '0,60,0': 'lava', '-1,60,0': 'lava', '0,60,1': 'lava', '0,60,-1': 'lava' })
  const w = p => (p.x === 1 && p.y === 64 && p.z === 0 ? { name: 'stone', boundingBox: 'block' } : walled(p))
  assert.deepEqual(shelterPlan(w, feet), { action: 'pillar' })
})
