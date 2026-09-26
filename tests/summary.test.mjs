import test from 'node:test'
import assert from 'node:assert/strict'
import { dirWord, phaseOf, EpisodeMemory, classifyEntity, relTo } from '../agent/summary.js'

test('compass words (x east, z south; north is -z)', () => {
  assert.equal(dirWord(0, -10), 'north')
  assert.equal(dirWord(10, 0), 'east')
  assert.equal(dirWord(0, 10), 'south')
  assert.equal(dirWord(-10, 0), 'west')
  assert.equal(dirWord(7, -7), 'north-east')
  assert.equal(dirWord(-7, 7), 'south-west')
})

test('relTo gives distance, direction and height difference', () => {
  const r = relTo({ x: 0, y: 64, z: 0 }, { x: 3, y: 60, z: -4 })
  assert.equal(Math.round(r.dist * 100) / 100, Math.round(Math.hypot(3, 4, 4) * 100) / 100)
  assert.equal(r.dir, 'north-east')
  assert.equal(r.dy, -4)
})

test('day phases and seconds to dusk / morning', () => {
  assert.deepEqual(phaseOf(1000), { phase: 'morning', secondsToDusk: 550, secondsToMorning: null })
  assert.equal(phaseOf(6000).phase, 'midday')
  assert.equal(phaseOf(9000).phase, 'afternoon')
  assert.equal(phaseOf(12500).phase, 'dusk')
  assert.equal(phaseOf(15000).phase, 'night')
  assert.equal(phaseOf(23500).phase, 'dawn')
  assert.equal(phaseOf(18000).secondsToMorning, 300)
  assert.equal(phaseOf(18000).secondsToDusk, null)
  assert.equal(phaseOf(24000 + 500).phase, 'morning')
})

test('memory remembers iron and base positions', () => {
  const m = new EpisodeMemory()
  assert.equal(m.ironSeen, null)
  m.sawIron({ x: 1, y: 2, z: 3 }, 10)
  assert.deepEqual(m.ironSeen.pos, { x: 1, y: 2, z: 3 })
  assert.equal(m.ironSeen.t, 10)
  m.setBase('table', { x: 0, y: 0, z: 0 })
  assert.deepEqual(m.base.table, { x: 0, y: 0, z: 0 })
  m.setBase('table', null)
  assert.equal(m.base.table, null)
  assert.equal(m.deaths, 0)
})

test('entity classes', () => {
  const md = { entitiesByName: { zombie: { category: 'Hostile mobs' }, cow: { category: 'Passive mobs' }, item: { category: 'UNKNOWN' } } }
  assert.equal(classifyEntity({ type: 'mob', name: 'zombie' }, md), 'hostile')
  assert.equal(classifyEntity({ type: 'hostile', name: 'zombie' }, md), 'hostile')
  assert.equal(classifyEntity({ type: 'mob', name: 'cow' }, md), 'passive')
  assert.equal(classifyEntity({ type: 'animal', name: 'cow' }, md), 'passive')
  assert.equal(classifyEntity({ type: 'player', name: 'x', username: 'y' }, md), 'player')
  assert.equal(classifyEntity({ type: 'object', name: 'item' }, md), null)
  assert.equal(classifyEntity({ type: 'mob', name: 'unknown_thing' }, md), null)
})

import { portalFrameNear } from '../agent/summary.js'

const posSet = ps => new Set(ps.map(p => `${p.x},${p.y},${p.z}`))
// The 10 obsidian of a frame whose bottom-left corner is (ox, oy, oz), along x or z.
const frame = (ox, oy, oz, axis) => [[1, 0], [2, 0], [0, 1], [0, 2], [0, 3], [3, 1], [3, 2], [3, 3], [1, 4], [2, 4]]
  .map(([u, v]) => axis === 'x' ? { x: ox + u, y: oy + v, z: oz } : { x: ox, y: oy + v, z: oz + u })

test('portalFrameNear: a column alone, broken columns and a partial frame are not a frame', () => {
  assert.equal(portalFrameNear(posSet([])), null)
  assert.equal(portalFrameNear(posSet([{ x: 0, y: 60, z: 0 }, { x: 0, y: 61, z: 0 }])), null)
  assert.equal(portalFrameNear(posSet([{ x: 0, y: 60, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }])), null)
  assert.equal(portalFrameNear(posSet([{ x: 3, y: 62, z: 4 }, { x: 3, y: 60, z: 4 }, { x: 3, y: 61, z: 4 }])), null, 'a 3-high column alone')
  // the bottom row plus one column (5 of 10), as an interrupted build leaves it
  assert.equal(portalFrameNear(posSet(frame(0, 64, 0, 'x').slice(0, 5))), null)
  assert.equal(portalFrameNear(posSet(frame(0, 64, 0, 'x').slice(0, 9))), null, '9 of 10')
})

test('portalFrameNear: the full 10 obsidian give the anchor (lowest block of a side column), along x and z', () => {
  assert.deepEqual(portalFrameNear(posSet([...frame(0, 64, 0, 'x'), { x: 5, y: 12, z: 1 }])), { x: 0, y: 65, z: 0 })
  const a = portalFrameNear(posSet(frame(10, 30, 5, 'z')))
  assert.ok(a && a.x === 10 && a.y === 31 && [5, 8].includes(a.z), JSON.stringify(a))
})

import mcDataFor from 'minecraft-data'
import { Vec3 } from 'vec3'
import { summarize } from '../agent/summary.js'

// A minimal bot for summarize(): every method summarize() touches returns an empty/neutral default, so a test can
// override just health and entities.
function fakeBot({ health = 20, entities = {} } = {}) {
  return {
    version: '1.20.4', entity: { position: new Vec3(0, 64, 0), isInWater: false, onGround: true }, entities,
    health, food: 20, oxygenLevel: 20, heldItem: null, thunderState: 0, isRaining: false,
    time: { timeOfDay: 1000, day: 0 },
    inventory: { items: () => [], slots: [] },
    world: { getSkyLight: () => 15, getBlockLight: () => 0 },
    blockAt: () => null, findBlock: () => null, findBlocks: () => [], canSeeBlock: () => false,
  }
}

test('obs.attacker: a health drop with a player 2 m away is a player attacker for 30 s, then gone; obs.nearestHostile untouched', () => {
  const mcData = mcDataFor('1.20.4')
  const mem = new EpisodeMemory()
  const player = { id: 9, type: 'player', username: 'Spacers_Choice', position: new Vec3(2, 64, 0), isValid: true }
  const bot = fakeBot({ health: 20, entities: { 9: player } })
  // first tick: establishes the health baseline, no drop yet
  let obs = summarize(bot, mcData, mem, { t: 0, current: null, last: null, goal: 'iron_pickaxe' })
  assert.equal(obs.attacker, null)
  assert.equal(obs.nearestHostile, null)
  // the player hits the bot
  bot.health = 18
  obs = summarize(bot, mcData, mem, { t: 5, current: null, last: null, goal: 'iron_pickaxe' })
  assert.deepEqual(obs.attacker, { kind: 'player', name: 'Spacers_Choice', dist: 2, sinceS: 0, pos: { x: 2, y: 64, z: 0 } })
  assert.equal(obs.nearestHostile, null, 'a player is never obs.nearestHostile')
  // remembered (sinceS grows) while health stays flat
  obs = summarize(bot, mcData, mem, { t: 20, current: null, last: null, goal: 'iron_pickaxe' })
  assert.deepEqual(obs.attacker, { kind: 'player', name: 'Spacers_Choice', dist: 2, sinceS: 15, pos: { x: 2, y: 64, z: 0 } })
  // gone after 30 s
  obs = summarize(bot, mcData, mem, { t: 36, current: null, last: null, goal: 'iron_pickaxe' })
  assert.equal(obs.attacker, null)
})

test('obs.attacker: only an entity within 4 m counts, and a hostile mob attacker classifies as hostile, not player', () => {
  const mcData = mcDataFor('1.20.4')
  const mem = new EpisodeMemory()
  const far = { id: 1, type: 'player', username: 'Far_Away', position: new Vec3(10, 64, 0), isValid: true }
  const bot = fakeBot({ health: 20, entities: { 1: far } })
  summarize(bot, mcData, mem, { t: 0, current: null, last: null, goal: 'iron_pickaxe' })
  bot.health = 15
  let obs = summarize(bot, mcData, mem, { t: 1, current: null, last: null, goal: 'iron_pickaxe' })
  assert.equal(obs.attacker, null, 'nothing within 4 m')

  const zombie = { id: 2, type: 'hostile', name: 'zombie', position: new Vec3(1, 64, 0), isValid: true }
  const mem2 = new EpisodeMemory()
  const bot2 = fakeBot({ health: 20, entities: { 2: zombie } })
  summarize(bot2, mcData, mem2, { t: 0, current: null, last: null, goal: 'iron_pickaxe' })
  bot2.health = 15
  obs = summarize(bot2, mcData, mem2, { t: 1, current: null, last: null, goal: 'iron_pickaxe' })
  assert.equal(obs.attacker.kind, 'hostile')
})

test('memory remembers diamond, lava and water sightings', () => {
  const m = new EpisodeMemory()
  assert.deepEqual(m.seen, { diamond: null, lava: null, water: null })
  m.saw('diamond', { x: 1, y: 2, z: 3 }, 7)
  assert.deepEqual(m.seen.diamond, { pos: { x: 1, y: 2, z: 3 }, t: 7 })
  assert.equal(m.seen.lava, null)
})
