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

test('oak stairs without a table: the table first (from held planks), then the oak planks it used, then the stairs', () => {
  assert.deepEqual(ids(expandItem('oak_stairs', 4, { oak_planks: 6 })),
    ['craft_item(crafting_table, 1)', 'gather(oak_planks, 4)', 'craft_item(oak_stairs, 4)'])
})

test('white bed: shears, 3 white wool hunted (the goal kind names the drop), craft', () => {
  assert.deepEqual(ids(expandItem('white_bed', 1, { oak_planks: 3, iron_ingot: 2 }, TABLE)),
    ['craft_item(shears, 1)', 'hunt(white_wool, 3)', 'craft_item(white_bed, 1)'])
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
  // (final review, Important 5: with no pickaxe held the stone pickaxe tier is hoisted first)
  const l = ids(expandItem('iron_nugget', 9, {}))
  assert.deepEqual(l.slice(-2), ['gather(iron_ingot, 1)', 'craft_item(iron_nugget, 9)'])
  before(l, 'craft_item(stone_pickaxe, 1)', 'gather(iron_ingot, 1)')
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
  // final review, Important 4: a recipe with one variant per wood takes any planks (was pinned to oak_planks)
  assert.deepEqual(ids(expandItem('chest', 1, {}, TABLE)), ['gather(planks, 8)', 'craft_item(chest, 1)'])
  // the legacy path still takes any wood: a crafting table from birch planks
  assert.deepEqual(ids(expandItem('crafting_table', 1, { birch_planks: 4 })), ['craft_item(crafting_table, 1)'])
})

test('count <= 0 or not a number: nothing to do; a bad item name is missing, never a throw', () => {
  for (const c of [0, -3, NaN, 'x', undefined]) assert.deepEqual(expandItem('compass', c, {}), { steps: [], missing: [], tree: '' })
  for (const it of [undefined, null, '', 42]) assert.deepEqual(expandItem(it, 1, {}), { steps: [], missing: [String(it)], tree: '' })
  assert.deepEqual(expandItem('not_a_thing', 1, {}).missing, ['not_a_thing'])
})

// ---- tools first (Task 8 ruling) ---------------------------------------------------------------------------------------
test('compass from nothing, tools first: wooden chain, stone chain, the ingots, iron pickaxe, redstone, compass', () => {
  assert.deepEqual(ids(expandItem('compass', 1, {})), [
    'gather(planks, 7)', 'gather(stick, 6)', 'craft_item(crafting_table, 1)', 'craft_item(wooden_pickaxe, 1)',
    'gather(cobblestone, 3)', 'craft_item(stone_pickaxe, 1)',
    'gather(iron_ingot, 7)', 'craft_item(iron_pickaxe, 1)', 'gather(redstone, 1)', 'craft_item(compass, 1)'])
})

test('the station and the shears come before the materials: glass (furnace), white bed (shears)', () => {
  const g = ids(expandItem('glass', 3, {}))
  before(g, 'craft_item(furnace, 1)', 'gather(sand, 3)')
  const b = ids(expandItem('white_bed', 1, {}))
  before(b, 'craft_item(shears, 1)', 'hunt(white_wool, 3)')
  before(b, 'craft_item(crafting_table, 1)', 'craft_item(shears, 1)')
})

// What each step's item needs directly (legacy gathers produce their own inputs, so only crafts and smelts are checked).
import { RECIPES } from '../agent/goals.js'
import mcDataFor from 'minecraft-data'
const md = mcDataFor('1.20.4')
const groupOf = n => n === 'sticks' ? 'stick' : n.endsWith('_log') || n === 'log' ? 'log' : n
const inputsOf = step => {
  if (step.kind === 'smelt_item') return [SMELT[step.arg]]
  if (step.kind !== 'craft_item') return []
  if (RECIPES[step.arg]) return Object.keys(RECIPES[step.arg]).map(groupOf)
  const r = (md.recipes[md.itemsByName[step.arg].id] || [])
  return [...new Set(r.flatMap(x => (x.inShape ? x.inShape.flat() : x.ingredients || []).filter(c => c != null).map(c => md.items[c].name)))]
}
const produces = step => step.kind === 'hunt' || step.kind === 'smelt_item' || step.kind === 'craft_item' || step.kind === 'gather' ? step.arg : null
test('no craft or smelt precedes a step producing one of its ingredients: compass, clock, white_bed, bucket, iron_door', () => {
  for (const item of ['compass', 'clock', 'white_bed', 'bucket', 'iron_door']) {
    const steps = expandItem(item, 1, {}).steps
    assert.ok(steps.length, item)
    steps.forEach((s, i) => {
      const ins = new Set(inputsOf(s))
      const later = steps.slice(i + 1).filter(t => ins.has(produces(t)) || (ins.has('oak_planks') && produces(t) === 'planks'))
      assert.deepEqual(later.map(t => `${t.kind}(${t.arg})`), [], `${item}: ${s.kind}(${s.arg}) comes before a producer of its input`)
    })
  }
})

// Final review, Important 4: recipes whose minecraft-data variants differ only in the wood species take generic planks
// (logs); a recipe specific to one wood (oak_stairs, oak_boat: one variant) keeps the exact name.
test('any-wood recipes: chest from birch logs is gather(planks, 8) and one craft; oak_stairs still needs oak', () => {
  assert.deepEqual(ids(expandItem('chest', 1, { birch_log: 5 }, TABLE)), ['gather(planks, 8)', 'craft_item(chest, 1)'])
  assert.deepEqual(ids(expandItem('oak_stairs', 4, { birch_planks: 6 }, TABLE)), ['gather(oak_planks, 6)', 'craft_item(oak_stairs, 4)'])
  assert.ok(ids(expandItem('barrel', 1, {}, TABLE)).includes('gather(planks, 6)'), 'the planks of a barrel are any wood')
})

// Final review, Important 5: legacy ore gathers hoist their pickaxe tier too (raw_iron/iron_ingot stone, diamond iron,
// obsidian diamond, flint none), so the plan gets the tool before the ore.
test('legacy ore gathers hoist the pickaxe: diamond_sword from nothing crafts the iron pickaxe before gather(diamond)', () => {
  const l = ids(expandItem('diamond_sword', 1, {}))
  before(l, 'craft_item(iron_pickaxe, 1)', 'gather(diamond, 2)')
  const door = ids(expandItem('iron_door', 1, {}))
  before(door, 'craft_item(stone_pickaxe, 1)', 'gather(iron_ingot, 6)')
  const obs = ids(expandItem('obsidian', 2, {}))
  before(obs, 'craft_item(diamond_pickaxe, 1)', 'gather(obsidian, 2)')
  assert.ok(!ids(expandItem('flint', 1, {})).some(s => s.includes('pickaxe')), 'flint needs no pickaxe')
  assert.deepEqual(ids(expandItem('iron_nugget', 9, { stone_pickaxe: 1 })), ['gather(iron_ingot, 1)', 'craft_item(iron_nugget, 9)'])
})

// ---- Blueprints Task 3: pricing a blueprint ------------------------------------------------------------------------
import { expandBlueprint } from '../agent/recipes.js'
import { makeBlueprint, templateMaterials } from '../agent/templates.js'

const at = { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }
const bsteps = r => r.steps.map(s => `${s.kind}(${s.arg}, ${s.count})`)

test('expandBlueprint: a 5x5x3 cobblestone hut with 10 held is 61 cobblestone then the build', () => {
  const hut = makeBlueprint('hut', { w: 5, d: 5, h: 3 }, 'cobblestone', at)
  const r = expandBlueprint(hut, { cobblestone: 10 }, { id: 'bp4' })
  assert.deepEqual(bsteps(r), ['gather(cobblestone, 61)', 'build(bp4, null)'])
  assert.deepEqual(r.missing, [])
  assert.deepEqual(bsteps(expandBlueprint(hut, { cobblestone: 10 }, { id: 'bp4', foundationCount: 3 })), ['gather(cobblestone, 64)', 'build(bp4, null)'])
  assert.deepEqual(bsteps(expandBlueprint(hut, { cobblestone: 80 }, { id: 'bp4' })), ['build(bp4, null)'])
})

test('expandBlueprint: a streamed staircase is priced over all its segments', () => {
  assert.deepEqual(templateMaterials('staircase_up', { height: 12, width: 1 }, 'cobblestone'), { cobblestone: 23 })
  assert.deepEqual(templateMaterials('room', { w: 3, d: 3, h: 2 }, null), {})
  const st = makeBlueprint('staircase_up', { height: 12 }, 'cobblestone', at)
  assert.deepEqual(bsteps(expandBlueprint(st, {}, { id: 'bp2' })), ['gather(cobblestone, 23)', 'build(bp2, null)'])
})

test('expandBlueprint: a glass material goes through the same walk (tools first, smelt, then the build)', () => {
  const bp = { kind: 'build', legend: { g: 'glass' }, layers: [['gggg']], title: 'glass strip', source: 'leader' }
  const l = bsteps(expandBlueprint(bp, {}, { id: 'bp3', placed: { crafting_table: true, furnace: true } }))
  assert.deepEqual(l, ['gather(sand, 4)', 'smelt_item(glass, 4)', 'build(bp3, null)'])
})

test('expandBlueprint: a dig needs only a stone pickaxe', () => {
  const room = makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, at)
  assert.deepEqual(bsteps(expandBlueprint(room, { stone_pickaxe: 1 }, { id: 'bp5' })), ['dig(bp5, null)'])
  assert.deepEqual(bsteps(expandBlueprint(room, { iron_pickaxe: 1 }, { id: 'bp5' })), ['dig(bp5, null)'])
  const l = bsteps(expandBlueprint(room, {}, { id: 'bp5' }))
  before(l, 'craft_item(wooden_pickaxe, 1)', 'craft_item(stone_pickaxe, 1)')
  assert.equal(l.at(-1), 'dig(bp5, null)')
  assert.ok(!l.some(s => s.startsWith('build(')), l.join(' '))
})

test('expandBlueprint: the 150-block cap applies to free-form blueprints only', () => {
  const big = { kind: 'build', legend: { '#': 'cobblestone' }, layers: [Array(9).fill('#########'), Array(9).fill('#########')], title: 'slab', source: 'leader' }
  const r = expandBlueprint(big, {}, { id: 'bp6' })
  assert.deepEqual(r, { steps: [], missing: [], reason: 'too many blocks: 162 (max 150)' })
  const hut = makeBlueprint('hut', { w: 9, d: 9, h: 5 }, 'cobblestone', at)
  assert.deepEqual(bsteps(expandBlueprint(hut, {}, { id: 'bp7' })), ['gather(cobblestone, 239)', 'build(bp7, null)'])
})

// Live stress session: the player offered redstone blocks for a compass and the expander only mined redstone. A held
// item that one 2x2 recipe turns into the needed item (a storage block) is crafted first, before any mining/smelting.
test('expandItem: a held storage block is unpacked before mining or smelting', () => {
  const c = expandItem('compass', 1, { redstone_block: 2, iron_ingot: 4, crafting_table: 1 })
  assert.deepEqual(c.missing, [])
  assert.ok(c.steps.some(s => s.kind === 'craft_item' && s.arg === 'redstone' && s.count === 1), JSON.stringify(c.steps))
  assert.ok(!c.steps.some(s => s.kind === 'gather' && s.arg === 'redstone'), 'no mining when a block is held')
  const r = expandItem('redstone', 12, { redstone_block: 1 })
  assert.deepEqual(r.steps.filter(s => s.arg === 'redstone').map(s => [s.kind, s.count]), [['craft_item', 9], ['gather', 3]], JSON.stringify(r.steps))
  const i = expandItem('iron_ingot', 5, { iron_block: 1 })
  assert.deepEqual(i.steps, [{ kind: 'craft_item', arg: 'iron_ingot', count: 5 }])
  const coal = expandItem('coal', 3, { coal_block: 1 })
  assert.deepEqual(coal.steps, [{ kind: 'craft_item', arg: 'coal', count: 3 }])
  const plain = expandItem('redstone', 2, {}).steps
  assert.ok(!plain.some(s => s.kind === 'craft_item' && s.arg === 'redstone') && plain.some(s => s.kind === 'gather' && s.arg === 'redstone'), 'nothing held: mined as before')
  // wood keeps the legacy path (logs are not unpacked into planks here)
  assert.deepEqual(expandItem('planks', 4, { oak_log: 1 }).steps, [{ kind: 'gather', arg: 'planks', count: 4 }])
})
