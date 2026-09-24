import test from 'node:test'
import assert from 'node:assert/strict'
import { options, parseOption, optionId, counts } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

const ids = o => options(o).map(x => x.id)

test('optionId round-trips', () => {
  assert.equal(optionId('craft', 'wooden_pickaxe'), 'craft(wooden_pickaxe)')
  assert.deepEqual(parseOption('craft(wooden_pickaxe)'), { name: 'craft', arg: 'wooden_pickaxe' })
  assert.deepEqual(parseOption('wait'), { name: 'wait', arg: null })
})

test('wait and surface exploration are always offered; nothing else on an empty world with an empty inventory', () => {
  const o = ids(baseObs())
  assert.ok(o.includes('wait'))
  assert.ok(o.includes('explore_toward(surface)'))
  assert.ok(!o.includes('gather_wood'))
  assert.ok(!o.includes('mine_stone'))
  assert.ok(!o.includes('explore_toward(down)'))
})

test('gather_wood needs a log in view; craft(planks) needs a log in inventory', () => {
  assert.ok(ids(baseObs({ blocks: [{ name: 'oak_log', dist: 12, dir: 'north', dy: 0, reachable: true }] })).includes('gather_wood'))
  const o2 = ids(baseObs({ inventory: { oak_log: 2 } }))
  assert.ok(o2.includes('craft(planks)'))
  assert.ok(!o2.includes('craft(crafting_table)'))
})

test('table recipes need a table nearby or in inventory', () => {
  const inv = { oak_planks: 3, stick: 2 }
  assert.ok(!ids(baseObs({ inventory: inv })).includes('craft(wooden_pickaxe)'))
  assert.ok(ids(baseObs({ inventory: { ...inv, crafting_table: 1 } })).includes('craft(wooden_pickaxe)'))
  assert.ok(ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 3, dir: 'east', dy: 0 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
  assert.ok(!ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 30, dir: 'east', dy: 0 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
})

test('mining needs a pickaxe and the block in range; iron also accepts memory', () => {
  const stone = { name: 'stone', dist: 5, dir: 'south', dy: 0, reachable: true }
  assert.ok(!ids(baseObs({ blocks: [stone] })).includes('mine_stone'))
  assert.ok(ids(baseObs({ blocks: [stone], inventory: { wooden_pickaxe: 1 } })).includes('mine_stone'))
  assert.ok(!ids(baseObs({ inventory: { wooden_pickaxe: 1 }, memory: { ironSeen: { dist: 20, dir: 'west', dy: -5, agoS: 10 }, lastPath: null, deaths: 0, heading: 'north' } })).includes('mine_iron'))
  assert.ok(ids(baseObs({ inventory: { stone_pickaxe: 1 }, memory: { ironSeen: { dist: 20, dir: 'west', dy: -5, agoS: 10 }, lastPath: null, deaths: 0, heading: 'north' } })).includes('mine_iron'))
})

test('smelt needs raw iron, fuel and a furnace', () => {
  assert.ok(!ids(baseObs({ inventory: { raw_iron: 3, coal: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(ids(baseObs({ inventory: { raw_iron: 3, coal: 1, furnace: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(!ids(baseObs({ inventory: { raw_iron: 3, furnace: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(ids(baseObs({ inventory: { raw_iron: 3, oak_planks: 2, furnace: 1 } })).includes('smelt(iron_ingot)'))
})

test('threat options appear only with a hostile within 16 m; pillar_up needs blocks and a close threat', () => {
  const o = ids(baseObs({ nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 }, inventory: { cobblestone: 5 } }))
  assert.ok(o.includes('fight(threat)') && o.includes('flee(threat)') && o.includes('pillar_up'))
  assert.ok(!ids(baseObs({ nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 } })).includes('pillar_up'))
  assert.ok(!ids(baseObs({ nearestHostile: { name: 'zombie', dist: 20, dir: 'west', dy: 0 } })).includes('flee(threat)'))
  assert.ok(!ids(baseObs()).includes('flee(threat)'))
})

test('counts merges logs and planks of every wood', () => {
  const c = counts(baseObs({ inventory: { oak_log: 1, birch_log: 2, spruce_planks: 4, stick: 1 } }))
  assert.equal(c.logs, 3)
  assert.equal(c.planks, 4)
  assert.equal(c.sticks, 1)
})

test('every option carries a description', () => {
  const o = baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 1, coal: 1, furnace: 1, oak_log: 1, oak_planks: 4, stick: 2, cobblestone: 8, crafting_table: 1 },
    blocks: [{ name: 'oak_log', dist: 3, dir: 'north', dy: 0, reachable: true }, { name: 'cave', dist: 10, dir: 'west', dy: 0, reachable: false }],
    nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 }, phase: 'night', food: 10 })
  for (const x of options(o)) assert.ok(typeof x.desc === 'string' && x.desc.length > 5, `${x.id} has no description`)
})
