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
