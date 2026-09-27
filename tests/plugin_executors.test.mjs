// The shipped plugins' pure parts (options, preconditions, helpers) against fixture obs, and their options reaching
// the goal filters through the real registry. The executors themselves run in tests/integration/plugins/.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseObs } from './fixtures.mjs'
import mine, { entryFor } from '../agent/plugins/mine.mjs'
import smelt, { inputItem, MAX_PER_CALL } from '../agent/plugins/smelt_item.mjs'
import craft, { heldRecipe } from '../agent/plugins/craft_item.mjs'
import hunt, { huntDrop, huntable, isSheared, MOBS } from '../agent/plugins/hunt.mjs'
import goToPlayer, { playerEntity } from '../agent/plugins/go_to_player.mjs'
import receive, { droppedName, giverName } from '../agent/plugins/receive.mjs'
import { PluginRegistry } from '../agent/plugins.js'
import { GOAL_KINDS, registerOptionProvider } from '../agent/goals.js'
import { options } from '../agent/subtasks.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'plugins')
const gather = (arg, count = 1) => ({ kind: 'gather', arg, count })

test('mine options: the goal item\'s blocks seen within 32 m, else the primary block; nothing for other goals', () => {
  assert.deepEqual(mine.options(baseObs(), gather('redstone')).map(o => o.arg), ['redstone_ore'])
  assert.deepEqual(mine.options(baseObs({ blocks: [{ name: 'deepslate_lapis_ore', dist: 12 }] }), gather('lapis_lazuli')).map(o => o.arg), ['deepslate_lapis_ore'])
  assert.deepEqual(mine.options(baseObs({ blocks: [{ name: 'grass_block', dist: 40 }] }), gather('dirt')).map(o => o.arg), ['dirt'])
  assert.deepEqual(mine.options(baseObs({ blocks: [{ name: 'gravel', dist: 5 }] }), gather('gravel')).map(o => o.arg), ['gravel'])
  assert.deepEqual(mine.options(baseObs(), gather('clay_ball')).map(o => o.arg), ['clay'])
  assert.deepEqual(mine.options(baseObs(), gather('cobblestone')), [])   // legacy: mine_stone
  assert.deepEqual(mine.options(baseObs(), { kind: 'craft_item', arg: 'compass', count: 1 }), [])
  assert.deepEqual(mine.options(baseObs(), null), [])
})

test('mine preconditions: a MINE block and the pickaxe tier it needs', () => {
  assert.equal(mine.preconditions(baseObs(), 'sand'), true)
  assert.equal(mine.preconditions(baseObs(), 'clay'), true)
  assert.equal(mine.preconditions(baseObs({ inventory: { stone_pickaxe: 1 } }), 'redstone_ore'), false)
  assert.equal(mine.preconditions(baseObs({ inventory: { iron_pickaxe: 1 } }), 'redstone_ore'), true)
  assert.equal(mine.preconditions(baseObs({ inventory: { stone_pickaxe: 1 } }), 'deepslate_copper_ore'), true)
  assert.equal(mine.preconditions(baseObs({ inventory: { wooden_pickaxe: 1 } }), 'lapis_ore'), false)
  assert.equal(mine.preconditions(baseObs({ inventory: { diamond_pickaxe: 1 } }), 'stone'), false)
  assert.deepEqual(entryFor('grass_block')[0], 'dirt')
})

test('smelt_item options and preconditions: input, fuel and a furnace; iron_ingot is not a SMELT product', () => {
  assert.deepEqual(smelt.options(baseObs(), { kind: 'smelt_item', arg: 'glass', count: 3 }).map(o => o.arg), ['glass'])
  assert.deepEqual(smelt.options(baseObs(), { kind: 'smelt_item', arg: 'iron_ingot', count: 3 }), [])
  assert.deepEqual(smelt.options(baseObs(), gather('sand')), [])
  const ready = { sand: 3, coal: 1, furnace: 1 }
  assert.equal(smelt.preconditions(baseObs({ inventory: ready }), 'glass'), true)
  assert.equal(smelt.preconditions(baseObs({ inventory: { ...ready, sand: 0 } }), 'glass'), false)
  assert.equal(smelt.preconditions(baseObs({ inventory: { ...ready, coal: 0 } }), 'glass'), false)
  assert.equal(smelt.preconditions(baseObs({ inventory: { ...ready, furnace: 0 } }), 'glass'), false)
  assert.equal(smelt.preconditions(baseObs({ inventory: { sand: 3, coal: 1 }, base: { crafting_table: null, furnace: { dist: 5 } } }), 'glass'), true)
  assert.equal(smelt.preconditions(baseObs({ inventory: { birch_log: 3, furnace: 1 } }), 'charcoal'), true)   // logs are input and fuel
  assert.equal(smelt.preconditions(baseObs({ inventory: ready }), 'iron_ingot'), false)
  assert.equal(inputItem('log', { oak_log: 1, birch_log: 3 }), 'birch_log')
  assert.equal(inputItem('sand', {}), 'sand')
  assert.equal(MAX_PER_CALL, 8)
})

test('craft_item options and preconditions: held ingredients, a table for 3x3 recipes, never a legacy item', () => {
  assert.deepEqual(craft.options(baseObs(), { kind: 'craft_item', arg: 'compass', count: 1 }).map(o => o.arg), ['compass'])
  assert.deepEqual(craft.options(baseObs(), gather('redstone')), [])
  assert.deepEqual(heldRecipe('oak_stairs', { oak_planks: 6 }), { table: true })
  assert.equal(heldRecipe('oak_stairs', { oak_planks: 5 }), null)
  assert.deepEqual(heldRecipe('oak_button', { oak_planks: 1 }), { table: false })
  assert.equal(heldRecipe('no_such_item', {}), null)
  assert.equal(craft.preconditions(baseObs({ inventory: { oak_planks: 6 } }), 'oak_stairs'), false)   // no table
  assert.equal(craft.preconditions(baseObs({ inventory: { oak_planks: 6, crafting_table: 1 } }), 'oak_stairs'), true)
  assert.equal(craft.preconditions(baseObs({ inventory: { oak_planks: 6 }, base: { crafting_table: { dist: 4 }, furnace: null } }), 'oak_stairs'), true)
  assert.equal(craft.preconditions(baseObs({ inventory: { oak_planks: 1 } }), 'oak_button'), true)   // 2x2 grid
  assert.equal(craft.preconditions(baseObs({ inventory: { iron_ingot: 4, redstone: 1, crafting_table: 1 } }), 'compass'), true)
  assert.equal(craft.preconditions(baseObs({ inventory: { iron_ingot: 3, redstone: 1, crafting_table: 1 } }), 'compass'), false)
  for (const legacy of ['furnace', 'crafting_table', 'iron_pickaxe', 'bucket', 'diamond_sword', 'stick'])
    assert.equal(craft.preconditions(baseObs({ inventory: { iron_ingot: 9, diamond: 9, stick: 9, cobblestone: 9, oak_planks: 9, crafting_table: 1 } }), legacy), false, legacy)
})

test('the registry offers the shipped plugins\' options to the goal filters and teachers', async () => {
  const reg = new PluginRegistry({ dir: DIR })
  await reg.load()
  registerOptionProvider((obs, goal) => reg.optionsFor(obs, goal))
  try {
    const obs = baseObs({ inventory: { iron_pickaxe: 1 } })
    const g = GOAL_KINDS.gather
    assert.ok(g.filter(obs, 'redstone', options(obs), 2).some(o => o.id === 'mine(redstone_ore)'))
    assert.equal(g.teacher(obs, 'redstone', 2), 'mine(redstone_ore)')
    const noPick = baseObs()
    assert.ok(!g.filter(noPick, 'redstone', options(noPick), 2).some(o => o.id.startsWith('mine(')))
    const sandObs = baseObs({ inventory: { sand: 3, coal: 1, furnace: 1 } })
    assert.equal(GOAL_KINDS.smelt_item.teacher(sandObs, 'glass', 3), 'smelt_item(glass)')
    assert.ok(GOAL_KINDS.smelt_item.filter(sandObs, 'glass', options(sandObs), 3).some(o => o.id === 'smelt_item(glass)'))
    const plankObs = baseObs({ inventory: { oak_planks: 6, crafting_table: 1 } })
    assert.equal(GOAL_KINDS.craft_item.teacher(plankObs, 'oak_stairs', 4), 'craft_item(oak_stairs)')
    const cowObs = baseObs({ entities: [{ name: 'cow', kind: 'passive', dist: 9 }] })
    assert.equal(GOAL_KINDS.hunt.teacher(cowObs, 'leather', 2), 'hunt(cow)')
    assert.ok(GOAL_KINDS.hunt.filter(cowObs, 'leather', options(cowObs), 2).some(o => o.id === 'hunt(cow)'))
    const night = baseObs({ entities: [{ name: 'cow', kind: 'passive', dist: 9 }], phase: 'night', timeOfDay: 18000, secondsToDusk: null, secondsToMorning: 300 })
    assert.ok(!GOAL_KINDS.hunt.filter(night, 'leather', options(night), 2).some(o => o.id === 'hunt(cow)'))   // the night rule
    assert.equal(GOAL_KINDS.go_to.teacher(baseObs(), 'player:Steve'), 'go_to_player(Steve)')
    assert.ok(GOAL_KINDS.go_to.filter(baseObs(), 'player:Steve', options(baseObs()), 1).some(o => o.id === 'go_to_player(Steve)'))
    const rg = { kind: 'receive', arg: 'redstone', count: 4, from: 'Steve' }
    assert.ok(GOAL_KINDS.receive.filter(baseObs(), 'redstone', options(baseObs()), 4, rg).some(o => o.id === 'receive(redstone)'))
  } finally { registerOptionProvider(null) }
})
