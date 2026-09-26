import test from 'node:test'
import assert from 'node:assert/strict'
import { expandItem, producerOf, isItem, tierHeld, MINE, SMELT, HUNT, TOOL_TIER } from '../agent/recipes.js'

const ids = r => r.steps.map(s => `${s.kind}(${s.arg}, ${s.count})`)
const TABLE = { placed: { crafting_table: true, furnace: false } }
const before = (list, a, b) => {
  assert.ok(list.includes(a), `${a} missing from ${list.join(' ')}`)
  assert.ok(list.includes(b), `${b} missing from ${list.join(' ')}`)
  assert.ok(list.indexOf(a) < list.indexOf(b), `${a} not before ${b}: ${list.join(' ')}`)
}

test('compass with an iron pickaxe and a table: ingots (legacy gather), redstone, craft', () => {
  const r = expandItem('compass', 1, { iron_pickaxe: 1, crafting_table: 1 })
  assert.deepEqual(ids(r), ['gather(iron_ingot, 4)', 'gather(redstone, 1)', 'craft_item(compass, 1)'])
  assert.deepEqual(r.missing, [])
  assert.match(r.tree, /compass/)
})

test('compass from nothing: the pickaxe tiers in order before redstone, one merged iron_ingot gather of 7', () => {
  const l = ids(expandItem('compass', 1, {}))
  before(l, 'craft_item(wooden_pickaxe, 1)', 'craft_item(stone_pickaxe, 1)')
  before(l, 'craft_item(stone_pickaxe, 1)', 'craft_item(iron_pickaxe, 1)')
  before(l, 'craft_item(iron_pickaxe, 1)', 'gather(redstone, 1)')
  assert.equal(l.at(-1), 'craft_item(compass, 1)')
  const ingots = l.filter(s => s.startsWith('gather(iron_ingot,'))
  assert.deepEqual(ingots, ['gather(iron_ingot, 7)'])
})

// The brief lists these two without a table in the inventory, which contradicts its own 3x3 rule (stairs and the bed
// need a crafting table); pinned with a placed table, and the no-table expansion pinned separately.
test('oak stairs from held planks with a placed table: one craft', () => {
  assert.deepEqual(ids(expandItem('oak_stairs', 4, { oak_planks: 6 }, TABLE)), ['craft_item(oak_stairs, 4)'])
})

test('oak stairs without a table: planks for the table, the table, then the stairs', () => {
  assert.deepEqual(ids(expandItem('oak_stairs', 4, { oak_planks: 6 })),
    ['gather(planks, 4)', 'craft_item(crafting_table, 1)', 'craft_item(oak_stairs, 4)'])
})

test('white bed: shears, two sheep sheared (3 wool at 2 each), craft', () => {
  assert.deepEqual(ids(expandItem('white_bed', 1, { oak_planks: 3, iron_ingot: 2 }, TABLE)),
    ['craft_item(shears, 1)', 'hunt(sheep, 2)', 'craft_item(white_bed, 1)'])
})

test('ender pearl: no producer, no recipe -> missing, no steps', () => {
  const r = expandItem('ender_pearl', 1, {})
  assert.deepEqual(r.missing, ['ender_pearl'])
  assert.deepEqual(r.steps, [])
})

test('an unproducible leaf deep in a recipe is reported as the leaf', () => {
  const r = expandItem('ender_eye', 1, {})   // ender_pearl + blaze_powder: the first unproducible ingredient
  assert.deepEqual(r.steps, [])
  assert.deepEqual(r.missing, ['ender_pearl'])
})

test('glass from held sand with a held furnace: one smelt', () => {
  assert.deepEqual(ids(expandItem('glass', 3, { sand: 3, furnace: 1 })), ['smelt_item(glass, 3)'])
})

test('smelting without a furnace crafts one first (with its table)', () => {
  const l = ids(expandItem('glass', 3, { sand: 3 }))
  before(l, 'craft_item(furnace, 1)', 'smelt_item(glass, 3)')
  assert.ok(!ids(expandItem('glass', 3, { sand: 3 }, { placed: { furnace: true } })).includes('craft_item(furnace, 1)'))
})

test('merging: iron door has exactly one gather(iron_ingot, 6)', () => {
  const l = ids(expandItem('iron_door', 1, {}))
  assert.deepEqual(l.filter(s => s.includes('iron_ingot')), ['gather(iron_ingot, 6)'])
  assert.equal(l.at(-1), 'craft_item(iron_door, 1)')
})

test('charcoal smelts from any log: gather(log, n)', () => {
  assert.deepEqual(ids(expandItem('charcoal', 2, { furnace: 1 })), ['gather(log, 2)', 'smelt_item(charcoal, 2)'])
  assert.deepEqual(ids(expandItem('charcoal', 2, { birch_log: 5, furnace: 1 })), ['smelt_item(charcoal, 2)'])
})

test('quantities are net of the inventory, count clamped to 64', () => {
  assert.deepEqual(expandItem('compass', 1, { compass: 1 }).steps, [])
  const r = expandItem('glass', 500, { furnace: 1 })
  assert.deepEqual(ids(r), ['gather(sand, 64)', 'smelt_item(glass, 64)'])
})

test('legacy items: gather for producers, craft_item for the legacy recipes (never minecraft-data)', () => {
  assert.deepEqual(producerOf('iron_ingot'), { kind: 'gather', item: 'iron_ingot' })
  assert.deepEqual(producerOf('sticks'), { kind: 'gather', item: 'stick' })
  assert.deepEqual(producerOf('log'), { kind: 'gather', item: 'log' })
  assert.deepEqual(producerOf('planks'), { kind: 'gather', item: 'planks' })
  assert.deepEqual(producerOf('spruce_log'), { kind: 'gather', item: 'spruce_log' })
  assert.deepEqual(producerOf('birch_planks'), { kind: 'gather', item: 'birch_planks' })
  assert.equal(producerOf('crimson_planks'), null)   // not a goals.WOODS species: gather_wood cannot reach it
  assert.equal(producerOf('iron_pickaxe').kind, 'craft_item')
  assert.equal(producerOf('redstone').kind, 'gather')
  assert.equal(producerOf('glass').kind, 'smelt_item')
  assert.equal(producerOf('leather').kind, 'hunt')
  assert.equal(producerOf('compass').kind, 'craft_item')
  assert.equal(producerOf('ender_pearl'), null)
  assert.deepEqual(ids(expandItem('stick', 3, {})), ['gather(stick, 3)'])
  assert.deepEqual(ids(expandItem('iron_pickaxe', 1, { stone_pickaxe: 1, crafting_table: 1, stick: 2 })), ['gather(iron_ingot, 3)', 'craft_item(iron_pickaxe, 1)'])
})

test('cycles: iron_nugget goes through the legacy iron_ingot producer', () => {
  assert.deepEqual(ids(expandItem('iron_nugget', 9, {})), ['gather(iron_ingot, 1)', 'craft_item(iron_nugget, 9)'])
})

test('tables and tiers', () => {
  assert.equal(tierHeld({}), 0)
  assert.equal(tierHeld({ wooden_pickaxe: 1, iron_pickaxe: 1 }), 3)
  assert.equal(tierHeld({ diamond_pickaxe: 1 }), TOOL_TIER.diamond)
  assert.equal(SMELT.glass, 'sand')
  assert.equal(MINE.redstone.tool, 'iron')
  assert.equal(HUNT.white_wool.per, 2)
  assert.equal(isItem('grass'), false)
  assert.equal(isItem('oak_log'), true)
  for (const item of [...Object.keys(MINE), ...Object.keys(SMELT), ...Object.values(SMELT), ...Object.keys(HUNT)])
    if (item !== 'log') assert.ok(isItem(item), item)
})

test('wood-specific recipes count planks by exact species; tag recipes take the held species', () => {
  const stairs = ids(expandItem('oak_stairs', 4, { birch_planks: 6 }, TABLE))
  assert.deepEqual(stairs, ['gather(oak_planks, 6)', 'craft_item(oak_stairs, 4)'])
  assert.deepEqual(ids(expandItem('oak_boat', 1, { spruce_planks: 5 }, TABLE)), ['gather(oak_planks, 5)', 'craft_item(oak_boat, 1)'])
  assert.deepEqual(ids(expandItem('chest', 1, { spruce_planks: 8 }, TABLE)), ['craft_item(chest, 1)'])
  assert.deepEqual(ids(expandItem('chest', 1, {}, TABLE)), ['gather(oak_planks, 8)', 'craft_item(chest, 1)'])
  // the legacy path still takes any wood: a crafting table from birch planks
  assert.deepEqual(ids(expandItem('crafting_table', 1, { birch_planks: 4 })), ['craft_item(crafting_table, 1)'])
})

test('count <= 0 or not a number: nothing to do; a bad item name is missing, never a throw', () => {
  for (const c of [0, -3, NaN, 'x', undefined]) assert.deepEqual(expandItem('compass', c, {}), { steps: [], missing: [], tree: '' })
  for (const it of [undefined, null, '', 42]) assert.deepEqual(expandItem(it, 1, {}), { steps: [], missing: [String(it)], tree: '' })
  assert.deepEqual(expandItem('not_a_thing', 1, {}).missing, ['not_a_thing'])
})
