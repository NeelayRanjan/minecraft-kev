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
import build, { buildWork, MAX_PLACEMENTS } from '../agent/plugins/build_blueprint.mjs'
import dig, { digWork, digOrder, liquidExposure, harvestable, veinTargets, isOre, dropUnder, MAX_DIGS, MAX_DROP, TURNABLE } from '../agent/plugins/dig_blueprint.mjs'
import { loadBlueprint, inventoryOf } from '../agent/blueprint_exec.js'
import { turnSegment } from '../agent/templates.js'
import { Vec3 } from 'vec3'
import { BlueprintBook, bookAccessor } from '../agent/blueprint_book.js'
import { makeBlueprint } from '../agent/templates.js'
import { registerBlueprintAccessor } from '../agent/goals.js'
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

// A fake world for the build tests: ground below y 64 (stone), air above, explicit blocks by position.
const wk = p => `${p.x},${p.y},${p.z}`
function buildWorld () {
  const m = new Map()
  const blockAt = p => {
    const n = m.has(wk(p)) ? m.get(wk(p)) : (p.y < 64 ? 'stone' : 'air')
    return n == null ? null : { name: n, boundingBox: ['air', 'water', 'lava'].includes(n) ? 'empty' : 'block' }
  }
  return { blockAt, set: (p, n) => m.set(wk(p), n) }
}
const hutAt = () => makeBlueprint('hut', {}, 'cobblestone', { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })

test('build_blueprint options: its blueprint under a build(bp<n>) goal only; 30 placements per call', () => {
  assert.deepEqual(build.options(baseObs(), { kind: 'build', arg: 'bp3', count: 1 }).map(o => o.arg), ['bp3'])
  assert.deepEqual(build.options(baseObs(), { kind: 'build', arg: 'portal_frame' }), [])
  assert.deepEqual(build.options(baseObs(), { kind: 'dig', arg: 'bp3' }), [])
  assert.deepEqual(build.options(baseObs(), null), [])
  assert.equal(build.preconditions(baseObs(), 'bp3'), true)
  assert.equal(MAX_PLACEMENTS, 30)
})

test('buildWork: missing cells to place, solid cells to dig, foundation under a hole, liquids blocked unless displaceable', () => {
  const w = buildWorld(), bp = hutAt()
  let r = buildWork(bp, w.blockAt)
  assert.equal(r.work.length, 71); assert.ok(r.work.every(c => c.op === 'place')); assert.equal(r.blocked.length, 0)
  assert.deepEqual(r.needs, { cobblestone: 71 })
  assert.ok(r.allKeys.size >= 100)
  const wall = r.work.find(c => c.layer === 0 && c.row === 0 && c.col === 0).pos
  const inside = { x: 0, y: 64, z: -4 }   // col 2, row 2, layer 0: interior air
  w.set(inside, 'stone'); w.set(wall, 'dirt')
  r = buildWork(bp, w.blockAt)
  assert.equal(r.work.find(c => wk(c.pos) === wk(inside)).op, 'dig')
  assert.equal(r.work.find(c => wk(c.pos) === wk(wall)).op, 'dig')
  // water in an interior air cell: blocked, not work
  w.set(inside, 'water')
  r = buildWork(bp, w.blockAt)
  assert.ok(!r.work.some(c => wk(c.pos) === wk(inside))); assert.ok(r.blocked.some(c => wk(c.pos) === wk(inside)))
  // water in a wall cell with the ground below it: displaced by placing (work); with nothing around: blocked
  w.set(wall, 'water')
  assert.equal(buildWork(bp, w.blockAt).work.find(c => wk(c.pos) === wk(wall)).op, 'place')
  const pillar = makeBlueprint('pillar', { h: 3 }, 'cobblestone', { anchor: { x: 0, y: 70, z: 0 }, facing: 'north', })
  const w2 = buildWorld()
  const cell = buildWork(pillar, w2.blockAt).work.find(c => c.op === 'place' && c.layer === 1).pos
  w2.set(cell, 'water')
  // the pillar floats at y 70 (baseLayer 0 -> a foundation cell at 69 over air); its layer-1 cell has no solid neighbour
  r = buildWork(pillar, w2.blockAt)
  assert.ok(r.blocked.some(c => wk(c.pos) === wk(cell)))
  assert.ok(r.work.some(c => c.op === 'foundation' && c.pos.y === 69))
})

test('build(bp<n>) offers build_blueprint(bp<n>) through the registry and the accessor', async () => {
  const reg = new PluginRegistry({ dir: DIR })
  await reg.load()
  const book = new BlueprintBook(), w = buildWorld()
  const id = book.add(hutAt())
  registerOptionProvider((obs, goal) => reg.optionsFor(obs, goal))
  registerBlueprintAccessor(bookAccessor(book, { blockAt: w.blockAt }))
  try {
    const obs = baseObs({ inventory: { cobblestone: 80 } })
    assert.ok(GOAL_KINDS.build.filter(obs, id, options(obs), 1).some(o => o.id === `build_blueprint(${id})`))
    assert.equal(GOAL_KINDS.build.teacher(obs, id, 1), `build_blueprint(${id})`)
  } finally { registerOptionProvider(null); registerBlueprintAccessor(null) }
})

test('a build goal whose blocks are all placed stays active while its scaffold stands, offering build_blueprint', async () => {
  const reg = new PluginRegistry({ dir: DIR })
  await reg.load()
  const book = new BlueprintBook(), w = buildWorld()
  const id = book.add(makeBlueprint('pillar', { h: 2 }, 'cobblestone', { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }))
  for (const c of buildWork(book.get(id), w.blockAt).work) w.set(c.pos, 'cobblestone')
  const s1 = { x: 1, y: 64, z: -2, item: 'dirt', layer: 1, segment: 0 }
  book.scaffold(id).push(s1); w.set(s1, 'dirt')
  registerOptionProvider((obs, goal) => reg.optionsFor(obs, goal))
  registerBlueprintAccessor(bookAccessor(book, { blockAt: w.blockAt }))
  try {
    const obs = baseObs()
    assert.equal(GOAL_KINDS.build.done(obs, id, 1), false)
    assert.ok(GOAL_KINDS.build.filter(obs, id, options(obs), 1).some(o => o.id === `build_blueprint(${id})`))
    assert.equal(GOAL_KINDS.build.teacher(obs, id, 1), `build_blueprint(${id})`)
    w.set(s1, 'air')
    assert.equal(GOAL_KINDS.build.done(obs, id, 1), true)
    // a stub accessor: the goal follows progress().finished, whatever keeps it false
    registerBlueprintAccessor({ get: () => book.get(id), progress: () => ({ ...book.progress(id, w.blockAt), finished: false, scaffoldLeft: 1 }), advance: () => null })
    assert.equal(GOAL_KINDS.build.done(obs, id, 1), false)
    assert.equal(GOAL_KINDS.build.teacher(obs, id, 1), `build_blueprint(${id})`)
  } finally { registerOptionProvider(null); registerBlueprintAccessor(null) }
})

// ---- dig_blueprint

test('dig_blueprint options: its blueprint under a dig(bp<n>) goal only; 40 digs per call', () => {
  assert.deepEqual(dig.options(baseObs(), { kind: 'dig', arg: 'bp5', count: 1 }).map(o => o.arg), ['bp5'])
  assert.deepEqual(dig.options(baseObs(), { kind: 'build', arg: 'bp5' }), [])
  assert.deepEqual(dig.options(baseObs(), { kind: 'dig', arg: 'cave' }), [])
  assert.deepEqual(dig.options(baseObs(), null), [])
  assert.equal(dig.preconditions(baseObs(), 'bp5'), true)
  assert.equal(MAX_DIGS, 40)
  assert.deepEqual([...TURNABLE].sort(), ['shaft_down', 'stairs_down_to', 'stairs_up_to', 'strip_mine', 'tunnel'])
})

test('loadBlueprint: the accessor, the id and the kind are checked', () => {
  const book = new BlueprintBook()
  const b = book.add(hutAt())
  const d = book.add(makeBlueprint('room', {}, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }))
  assert.equal(loadBlueprint({}, d, 'dig').error.detail, 'no blueprint book')
  assert.equal(loadBlueprint({ blueprints: book }, 'bp9', 'dig').error.detail, 'no blueprint bp9')
  assert.equal(loadBlueprint({ blueprints: book }, b, 'dig').error.detail, `${b} is not a dig blueprint`)
  assert.equal(loadBlueprint({ blueprints: book }, d, 'dig').bp.template, 'room')
  assert.deepEqual(inventoryOf({ inventory: { items: () => [{ name: 'dirt', count: 3 }, { name: 'dirt', count: 2 }] } }), { dirt: 5 })
})

// A dig world: stone below y 70, air above; cells set by name.
function digWorld () {
  const m = new Map()
  const blockAt = p => {
    const n = m.has(wk(p)) ? m.get(wk(p)) : (p.y < 70 ? 'stone' : 'air')
    if (n == null) return null
    if (n === 'waterlogged_glow_lichen') return { name: 'glow_lichen', boundingBox: 'empty', getProperties: () => ({ waterlogged: true }) }
    if (n === 'dry_glow_lichen') return { name: 'glow_lichen', boundingBox: 'empty', getProperties: () => ({ waterlogged: false }) }
    return { name: n, boundingBox: ['air', 'cave_air', 'water', 'lava', 'kelp', 'seagrass'].includes(n) ? 'empty' : 'block' }
  }
  return { blockAt, set: (p, n) => m.set(wk(p), n) }
}
const roomAt = (anchor = { x: 0, y: 64, z: 0 }, params = { w: 3, d: 3, h: 2 }) => makeBlueprint('room', params, null, { anchor, facing: 'north' })

test('digWork: solid cells are work, liquid cells are left out, unloaded cells kept apart', () => {
  const w = digWorld(), bp = roomAt()
  let r = digWork(bp, w.blockAt)
  assert.equal(r.work.length, 18); assert.equal(r.liquid.length, 0); assert.equal(r.unloaded.length, 0)
  w.set({ x: 0, y: 64, z: 0 }, 'air'); w.set({ x: 1, y: 65, z: -1 }, 'water'); w.set({ x: -1, y: 64, z: -2 }, null)
  r = digWork(bp, w.blockAt)
  assert.equal(r.work.length, 15); assert.equal(r.liquid.length, 1); assert.equal(r.unloaded.length, 1)
})

test('digOrder: near rows first; in a row the centre column, then each side outward; top layer first in a column', () => {
  const w = digWorld(), bp = roomAt()
  const order = digOrder(digWork(bp, w.blockAt).work, bp)
  // row 0 (z 0): centre x 0 top then bottom, then x -1, then x 1; then row 1 (z -1) ...
  assert.deepEqual(order.slice(0, 6).map(c => wk(c.pos)), ['0,65,0', '0,64,0', '-1,65,0', '-1,64,0', '1,65,0', '1,64,0'])
  assert.deepEqual(order.slice(6, 8).map(c => wk(c.pos)), ['0,65,-1', '0,64,-1'])
  assert.equal(order.length, 18)
  // a dug staircase down: step k's three cells top down, step by step
  const st = makeBlueprint('stairs_down_to', { y: 60 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  const so = digOrder(digWork(st, w.blockAt).work, st)
  assert.deepEqual(so.slice(0, 6).map(c => wk(c.pos)), ['0,65,-1', '0,64,-1', '0,63,-1', '0,64,-2', '0,63,-2', '0,62,-2'])
  // a strip mine's branch is dug from the main tunnel outward, left side first
  const sm = makeBlueprint('strip_mine', { len: 8, branch_every: 3, branch_len: 2 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  const branch = digOrder(digWork(sm, w.blockAt).work, sm).filter(c => c.row === 3).map(c => `${c.pos.x},${c.pos.y}`)
  assert.deepEqual(branch, ['0,65', '0,64', '-1,65', '-1,64', '-2,65', '-2,64', '1,65', '1,64', '2,65', '2,64'])
})

test('liquidExposure: the cell itself, a face neighbour (source or flowing), or a liquid over a falling-block column', () => {
  const w = digWorld(), c = { x: 0, y: 64, z: 0 }
  assert.equal(liquidExposure(c, w.blockAt), null)
  w.set({ x: 1, y: 65, z: 0 }, 'lava')   // diagonal: never flows into the cell
  assert.equal(liquidExposure(c, w.blockAt), null)
  w.set({ x: 1, y: 64, z: 0 }, 'lava')
  assert.deepEqual(liquidExposure(c, w.blockAt), { x: 1, y: 64, z: 0 })
  const w2 = digWorld()
  w2.set({ x: 0, y: 63, z: 0 }, 'water')   // below
  assert.deepEqual(liquidExposure(c, w2.blockAt), { x: 0, y: 63, z: 0 })
  const w3 = digWorld()
  w3.set(c, 'water')
  assert.deepEqual(liquidExposure(c, w3.blockAt), c)
  const w4 = digWorld()   // gravel then sand over the cell, water on top: digging the cell brings the water down
  w4.set({ x: 0, y: 65, z: 0 }, 'gravel'); w4.set({ x: 0, y: 66, z: 0 }, 'sand'); w4.set({ x: 0, y: 67, z: 0 }, 'water')
  assert.deepEqual(liquidExposure(c, w4.blockAt), { x: 0, y: 67, z: 0 })
  w4.set({ x: 0, y: 66, z: 0 }, 'stone')   // a solid block in between holds it
  assert.equal(liquidExposure(c, w4.blockAt), null)
})

test('harvestable: no tool needed, the right tier held, never bedrock or unbreakable blocks', () => {
  const items = [{ name: 'stone_pickaxe', type: 7 }]
  assert.equal(harvestable({ name: 'dirt', hardness: 0.5 }, items), true)
  assert.equal(harvestable({ name: 'stone', hardness: 1.5, harvestTools: { 7: true } }, items), true)
  assert.equal(harvestable({ name: 'stone', hardness: 1.5, harvestTools: { 7: true } }, []), false)
  assert.equal(harvestable({ name: 'obsidian', hardness: 50, harvestTools: { 9: true } }, items), false)
  assert.equal(harvestable({ name: 'bedrock', hardness: null }, items), false)
  assert.equal(harvestable(null, items), false)
})

test('veinTargets and isOre: face-adjacent ores outside the plan, skipping ores next to a liquid', () => {
  for (const n of ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'diamond_ore', 'redstone_ore', 'deepslate_lapis_ore', 'copper_ore', 'emerald_ore', 'gold_ore']) assert.equal(isOre(n), true, n)
  for (const n of ['stone', 'iron_block', 'raw_iron_block', 'ancient_debris']) assert.equal(isOre(n), false, n)
  const w = digWorld(), c = { x: 0, y: 64, z: 0 }
  w.set(c, 'air')
  w.set({ x: -1, y: 64, z: 0 }, 'iron_ore')     // wall
  w.set({ x: 0, y: 65, z: 0 }, 'coal_ore')      // ceiling, but a plan cell
  w.set({ x: 1, y: 64, z: 0 }, 'diamond_ore')   // next to water
  w.set({ x: 2, y: 64, z: 0 }, 'water')
  w.set({ x: 0, y: 64, z: 1 }, 'gold_ore')
  const plan = new Set(['0,65,0'])
  const t = veinTargets(c, w.blockAt, { plan }).map(wk).sort()
  assert.deepEqual(t, ['-1,64,0', '0,64,1'])
})

test('turnSegment on a tunnel segment: the turned copy digs to the right of the old facing from the same anchor', () => {
  const bp = makeBlueprint('tunnel', { len: 12 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  const t = turnSegment(bp, 'right')
  const w = digWorld()
  const cells = digOrder(digWork(t, w.blockAt).work, t)
  assert.equal(t.facing, 'east')
  assert.ok(cells.every(c => c.pos.z === 0 && c.pos.x >= 0))
})

test('dig(bp<n>) offers dig_blueprint(bp<n>) through the registry and the accessor; the accessor can replace a segment', async () => {
  const reg = new PluginRegistry({ dir: DIR })
  await reg.load()
  const book = new BlueprintBook(), w = digWorld()
  const id = book.add(roomAt())
  const acc = bookAccessor(book, { blockAt: w.blockAt })
  registerOptionProvider((obs, goal) => reg.optionsFor(obs, goal))
  registerBlueprintAccessor(acc)
  try {
    const obs = baseObs({ inventory: { stone_pickaxe: 1 }, underground: true, skyLight: 0 })
    assert.ok(GOAL_KINDS.dig.filter(obs, id, options(obs), 1).some(o => o.id === `dig_blueprint(${id})`))
    assert.equal(GOAL_KINDS.dig.teacher(obs, id, 1), `dig_blueprint(${id})`)
  } finally { registerOptionProvider(null); registerBlueprintAccessor(null) }
  acc.update(id, { ...book.get(id), facing: 'east' })
  assert.equal(book.get(id).facing, 'east')
})

// A motor stand-in over a fake world: digCell turns the cell to air (no walking), everything else is a no-op.
function fakeMotor (book, w, items = [{ name: 'stone_pickaxe', type: 1 }]) {
  const withProps = b => b && { ...b, hardness: b.name === 'bedrock' ? -1 : 1.5, harvestTools: { obsidian: { 99: true }, stone: { 1: true } }[b.name] }
  const bot = { blockAt: v => withProps(w.blockAt({ x: v.x, y: v.y, z: v.z })), inventory: { items: () => items }, entity: { position: new Vec3(0.5, 64, 1.5) }, waitForTicks: async () => {}, entities: {} }
  const dug = []
  return {
    bot, blueprints: book, current: null, reserveMs: 0, dug,
    count: () => 0, check () {}, timeLeft: () => 60_000, log () {}, digOut: async () => {}, walkWithin: async () => {},
    async digCell (pos) { w.set(pos, 'air'); dug.push(wk(pos)); return { ok: true } },
  }
}
const tunnelBook = () => {
  const book = new BlueprintBook()
  const id = book.add(makeBlueprint('tunnel', { len: 8, w: 1, h: 2 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }))
  return { book, id }
}

test('dig_blueprint run: water beside a tunnel cell turns the segment right once and digs on; that cell is never dug', async () => {
  const w = digWorld(), { book, id } = tunnelBook()
  w.set({ x: 1, y: 64, z: -3 }, 'water')
  const m = fakeMotor(book, w)
  const r = await dig.run(m, id)
  assert.equal(r.result, 'ok'); assert.match(r.detail, /turned right/); assert.match(r.detail, /complete/)
  assert.equal(book.get(id).facing, 'east'); assert.equal(book.get(id).turned, 0)
  assert.ok(!m.dug.includes('0,64,-3'))
  assert.ok(m.dug.includes('0,65,-3'))   // the head-level cell of that row had no liquid beside it
  assert.ok(m.dug.includes('7,64,0') && m.dug.includes('7,65,0'))
})

test('dig_blueprint run: a turned segment that is wet too, or a room, stops with hit_liquid naming the liquid', async () => {
  const w = digWorld(), { book, id } = tunnelBook()
  w.set({ x: 1, y: 64, z: -3 }, 'water'); w.set({ x: 1, y: 66, z: 0 }, 'lava')   // over the turned segment's first cell
  const r = await dig.run(fakeMotor(book, w), id)
  assert.equal(r.result, 'hit_liquid'); assert.match(r.detail, /^1, 66, 0: lava/)
  assert.equal(book.get(id).facing, 'north')
  // a second liquid after the turn: no second turn
  const w2 = digWorld(), t = tunnelBook()
  w2.set({ x: 1, y: 64, z: -3 }, 'water'); w2.set({ x: 4, y: 64, z: 1 }, 'water')
  const r2 = await dig.run(fakeMotor(t.book, w2), t.id)
  assert.equal(r2.result, 'hit_liquid'); assert.match(r2.detail, /^4, 64, 1: water/)
  assert.equal(t.book.get(t.id).facing, 'east')
  // a room: never turned
  const w3 = digWorld(), book3 = new BlueprintBook()
  const rid = book3.add(roomAt())
  w3.set({ x: 2, y: 64, z: -1 }, 'lava')
  const m3 = fakeMotor(book3, w3)
  const r3 = await dig.run(m3, rid)
  assert.equal(r3.result, 'hit_liquid'); assert.match(r3.detail, /^2, 64, -1: lava/)
  assert.ok(!m3.dug.includes('1,64,-1'))
  assert.equal(book3.get(rid).facing, 'north')
})

test('dig_blueprint run: cells no held tool harvests are skipped (needs_tool), the rest dug; all of them -> needs_tool', async () => {
  const w = digWorld(), book = new BlueprintBook()
  const id = book.add(roomAt())
  w.set({ x: 0, y: 64, z: -2 }, 'obsidian')
  let r = await dig.run(fakeMotor(book, w), id)
  assert.equal(r.result, 'ok'); assert.match(r.detail, /\+17 dug.*1 needs_tool/)
  r = await dig.run(fakeMotor(book, w), id)
  assert.deepEqual(r, { result: 'needs_tool', detail: 'obsidian' })
  const w2 = digWorld(), book2 = new BlueprintBook()
  const id2 = book2.add(roomAt())
  r = await dig.run(fakeMotor(book2, w2, []), id2)   // no pickaxe: stone needs one
  assert.deepEqual(r, { result: 'needs_tool', detail: 'stone' })
})

test('dig_blueprint run: a streamed tunnel advances segments within one call, at most 40 digs', async () => {
  const w = digWorld(), book = new BlueprintBook()
  const id = book.add(makeBlueprint('tunnel', { len: 32, w: 1, h: 2 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }))
  const m = fakeMotor(book, w)
  const r = await dig.run(m, id)
  assert.equal(r.result, 'ok'); assert.equal(m.dug.length, 40)
  assert.match(r.detail, /^\+40 dug, segment 3\/4$/)
})

test('liquidExposure: underwater plants and waterlogged blocks count as water; a waterlogged neighbour stops the dig', async () => {
  const c = { x: 0, y: 64, z: -1 }
  for (const n of ['kelp', 'seagrass', 'waterlogged_glow_lichen']) {
    const w = digWorld(); w.set({ x: -1, y: 64, z: -1 }, n)
    assert.deepEqual(liquidExposure(c, w.blockAt), { x: -1, y: 64, z: -1 }, n)
  }
  const dry = digWorld(); dry.set({ x: -1, y: 64, z: -1 }, 'dry_glow_lichen')
  assert.equal(liquidExposure(c, dry.blockAt), null)
  // a room with waterlogged glow lichen beside its middle row: that cell is never dug, hit_liquid names the lichen
  const w = digWorld(), book = new BlueprintBook()
  const id = book.add(roomAt())
  w.set({ x: -2, y: 64, z: -1 }, 'waterlogged_glow_lichen')
  const m = fakeMotor(book, w)
  const r = await dig.run(m, id)
  assert.equal(r.result, 'hit_liquid'); assert.match(r.detail, /^-2, 64, -1: glow_lichen/)
  assert.ok(!m.dug.includes('-1,64,-1'))
  // the book agrees: a waterlogged block in a dig cell is liquid, never work
  const w2 = digWorld()
  w2.set({ x: 0, y: 64, z: 0 }, 'waterlogged_glow_lichen')
  assert.equal(digWork(roomAt(), w2.blockAt).liquid.length, 1)
})

test('dropUnder: a dig cell over a void deeper than MAX_DROP is never dug; the result says so', async () => {
  const w0 = digWorld()
  assert.equal(dropUnder({ x: 0, y: 64, z: 0 }, w0.blockAt), 0)
  for (let y = 61; y <= 63; y++) w0.set({ x: 0, y, z: 0 }, 'air')
  assert.equal(dropUnder({ x: 0, y: 64, z: 0 }, w0.blockAt), MAX_DROP)
  w0.set({ x: 0, y: 60, z: 0 }, 'air')
  assert.equal(dropUnder({ x: 0, y: 64, z: 0 }, w0.blockAt), MAX_DROP + 1)
  // a room cell over a cave 4 deep: skipped (the cell above it is dug: its drop is 0 while the lower one stays)
  const w = digWorld(), book = new BlueprintBook(), id = book.add(roomAt())
  for (let y = 60; y <= 63; y++) w.set({ x: 1, y, z: -2 }, 'air')
  const m = fakeMotor(book, w)
  let r = await dig.run(m, id)
  assert.ok(!m.dug.includes('1,64,-2')); assert.ok(m.dug.includes('1,65,-2'))
  assert.equal(r.result, 'ok'); assert.match(r.detail, /\+17 dug, 1 over a drop/)
  r = await dig.run(fakeMotor(book, w), id)
  assert.deepEqual(r, { result: 'unreachable', detail: '1 cells over a drop' })
})

test('dig_blueprint run: a cell motor.digCell refuses as underfoot waits and ends as no_path', async () => {
  const pit = makeBlueprint('pit', { w: 1, d: 1, depth: 1 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  const w = digWorld(), book = new BlueprintBook(), id = book.add(pit)
  const m = fakeMotor(book, w)
  m.digCell = async () => ({ ok: false, why: 'underfoot' })
  assert.deepEqual(await dig.run(m, id), { result: 'no_path', detail: '1 cells' })
})

test('build_blueprint run: a dig cell motor.digCell refuses as underfoot is unreachable, never ok (+0 placed)', async () => {
  const w = buildWorld(), book = new BlueprintBook(), id = book.add(hutAt())
  for (const c of buildWork(book.get(id), w.blockAt).work) if (c.op === 'place') w.set(c.pos, c.want)
  w.set({ x: 0, y: 64, z: -4 }, 'stone')   // interior air cell: the only work left is a dig
  const bot = { blockAt: v => w.blockAt({ x: v.x, y: v.y, z: v.z }), inventory: { items: () => [] }, entity: { position: new Vec3(0.5, 65, -3.5) } }
  const m = {
    bot, blueprints: bookAccessor(book, { blockAt: w.blockAt }), current: null, reserveMs: 0,
    check () {}, timeLeft: () => 60_000, log () {}, count: () => 0, occupied: () => new Set(),
    settleInventory: async () => {}, stepClear: async () => {}, removeScaffold: async () => 0,
    digCell: async () => ({ ok: false, why: 'underfoot' }), placeCell: async () => ({ ok: false, why: 'unreachable' }),
  }
  assert.deepEqual(await build.run(m, id), { result: 'unreachable', detail: '1 cells' })
})

// Task 7 fix round 1: an executor started far from its blueprint walks there first (the smoke's hut: unreachable (80
// cells) from a pit 10+ m away), then works; approachTarget is the pure part.
import { approachTarget, APPROACH_M } from '../agent/blueprint_exec.js'
test('approachTarget: the nearest work cell when it is more than APPROACH_M away, else null', () => {
  assert.equal(APPROACH_M, 12)
  const cellsAt = ps => ps.map(p => ({ pos: p }))
  assert.equal(approachTarget(cellsAt([{ x: 0, y: 64, z: -5 }]), { x: 0.5, y: 64, z: 0.5 }), null)
  assert.deepEqual(approachTarget(cellsAt([{ x: 30, y: 64, z: 0 }, { x: 20, y: 70, z: 5 }]), { x: 0.5, y: 64, z: 0.5 }), { x: 20, y: 70, z: 5 })
  assert.equal(approachTarget([], { x: 0, y: 0, z: 0 }), null)
})

test('build_blueprint and dig_blueprint run: from 30 m away they walk toward the blueprint before working', async () => {
  const w = buildWorld(), book = new BlueprintBook(), id = book.add(hutAt())
  const walks = []
  const bot = { blockAt: v => w.blockAt({ x: v.x, y: v.y, z: v.z }), inventory: { items: () => [] }, entity: { position: new Vec3(30.5, 64, 0.5) } }
  const m = {
    bot, blueprints: bookAccessor(book, { blockAt: w.blockAt }), current: null, reserveMs: 0,
    check () {}, timeLeft: () => 60_000, log () {}, count: () => 0, occupied: () => new Set(),
    settleInventory: async () => {}, stepClear: async () => {}, removeScaffold: async () => 0,
    walkWithin: async (goal) => { walks.push(goal); bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5) },
    digCell: async () => ({ ok: false, why: 'unreachable' }), placeCell: async () => ({ ok: false, why: 'unreachable' }),
  }
  await build.run(m, id)
  assert.equal(walks.length, 1)
  assert.ok(Math.hypot(walks[0].x - 0, walks[0].z + 2) <= 5, `walked toward the hut: ${walks[0].x},${walks[0].z}`)
  const dw = digWorld(), dbook = new BlueprintBook(), did = dbook.add(roomAt())
  const dm = fakeMotor(dbook, dw)
  dm.bot.entity.position = new Vec3(0.5, 64, 40.5)
  const dwalks = []
  dm.walkWithin = async (goal) => { dwalks.push(goal); dm.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5) }
  const r = await dig.run(dm, did)
  assert.equal(dwalks.length, 1); assert.equal(r.result, 'ok')
})

// Task 7 fix round 2: a dug staircase (or tunnel) over a cave gets a floor block under the walkable cell before it is
// dug; with no filler held the segment turns right once; rooms and pits keep the drop refusal.
import { floorCell } from '../agent/plugins/dig_blueprint.mjs'
import { cells } from '../agent/blueprints.js'
const stairsAt = () => makeBlueprint('stairs_down_to', { y: 56 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
function caveUnderSteps (w, bp, rows) {
  const low = new Map()
  for (const c of cells(bp)) if (rows.includes(c.row)) { const k = `${c.col},${c.row}`; if (!low.has(k) || c.pos.y < low.get(k).y) low.set(k, c.pos) }
  const floors = [...low.values()].map(p => ({ x: p.x, y: p.y - 1, z: p.z }))
  for (const f of floors) for (let d = 0; d < 5; d++) w.set({ ...f, y: f.y - d }, 'air')
  return floors
}
function placingMotor (book, w, items) {
  const m = fakeMotor(book, w, items)
  m.placed = []
  m.count = name => items.filter(i => i.name === name).reduce((n, i) => n + (i.count ?? 1), 0)
  m.placeCell = async (pos, item) => { w.set(pos, item); m.placed.push(wk(pos)); return { ok: true } }
  return m
}
test('floorCell: the cell under a plan column\'s lowest cell, when that column has a drop and the cell is not in the plan', () => {
  const w = digWorld(), bp = stairsAt()
  const plan = new Set(cells(bp).map(c => wk(c.pos)))
  const floors = caveUnderSteps(w, bp, [3, 4])
  const lowest = cells(bp).filter(c => c.row === 3).sort((a, b) => a.pos.y - b.pos.y)[0]
  assert.deepEqual(floorCell(lowest.pos, w.blockAt, plan), floors.find(f => f.z === lowest.pos.z))
  const upper = cells(bp).filter(c => c.row === 3).sort((a, b) => b.pos.y - a.pos.y)[0]
  assert.equal(floorCell(upper.pos, w.blockAt, plan), null, 'a cell with a plan cell under it: its floor is dug later, not bridged')
})
test('dig_blueprint run: stairs over a cave under steps 3-4 get floor blocks and the segment completes; no filler: turn right once', async () => {
  const w = digWorld(), book = new BlueprintBook(), id = book.add(stairsAt())
  const floors = caveUnderSteps(w, book.get(id), [3, 4])
  const m = placingMotor(book, w, [{ name: 'stone_pickaxe', type: 1 }, { name: 'cobblestone', count: 20 }])
  const r = await dig.run(m, id)
  assert.equal(r.result, 'ok', r.detail); assert.match(r.detail, /complete/); assert.match(r.detail, /2 floor/)
  assert.deepEqual(m.placed.sort(), floors.map(wk).sort())
  assert.ok(floors.every(f => w.blockAt(f).name === 'cobblestone'))
  // no filler: the segment turns right once, and digs on in the new facing
  const w2 = digWorld(), b2 = new BlueprintBook(), id2 = b2.add(stairsAt())
  caveUnderSteps(w2, b2.get(id2), [3, 4])
  const m2 = placingMotor(b2, w2, [{ name: 'stone_pickaxe', type: 1 }])
  const r2 = await dig.run(m2, id2)
  assert.match(r2.detail, /turned right/); assert.equal(b2.get(id2).facing, 'east'); assert.equal(m2.placed.length, 0)
  // a room keeps the refusal (no floor placed)
  const w3 = digWorld(), b3 = new BlueprintBook(), id3 = b3.add(roomAt())
  for (let y = 60; y <= 63; y++) w3.set({ x: 1, y, z: -2 }, 'air')
  const m3 = placingMotor(b3, w3, [{ name: 'stone_pickaxe', type: 1 }, { name: 'cobblestone', count: 20 }])
  const r3 = await dig.run(m3, id3)
  assert.match(r3.detail, /1 over a drop/); assert.equal(m3.placed.length, 0)
})

// Live stress session: "come here" from beyond tracking range (~48 m) gave go_to_player nothing to follow. The bot is op:
// with no entity it asks the server for the player's position (/data get entity <name> Pos), walks toward it and asks
// again every 10 s until the entity appears, then follows. Only server (non-chat) messages are read, numbers only.
import { EventEmitter } from 'node:events'
import { parseDataPos, followPlayer } from '../agent/plugins/go_to_player.mjs'
test('parseDataPos: the /data reply for that player, numbers only; anything else is null', () => {
  assert.deepEqual(parseDataPos('Steve has the following entity data: [120.5d, 64.0d, -33.25d]', 'Steve'), { x: 120.5, y: 64, z: -33.25 })
  assert.deepEqual(parseDataPos('Steve has the following entity data: [1.0E2d, -5d, 3d]', 'Steve'), { x: 100, y: -5, z: 3 })
  assert.equal(parseDataPos('Alex has the following entity data: [1d, 2d, 3d]', 'Steve'), null, 'another player')
  assert.equal(parseDataPos('No entity was found', 'Steve'), null)
  assert.equal(parseDataPos('Steve has the following entity data: [1d, 2d]', 'Steve'), null)
  assert.equal(parseDataPos('<Steve> Steve has the following entity data: [1d, 2d, 3d]', 'Steve'), null, 'must start with the name')
})
function farBot({ replyFor = () => 'Steve has the following entity data: [100.5d, 64.0d, 0.5d]', position = 'system' } = {}) {
  const bot = new EventEmitter()
  bot.username = 'Kevin'
  bot.players = { Steve: { gamemode: 0, entity: null } }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.goals = []; bot.chats = []
  bot.waitForTicks = async () => {}
  bot.pathfinder = { setGoal: g => { bot.goals.push(g) } }
  bot.chat = msg => { bot.chats.push(msg); const r = replyFor(msg); if (r) setTimeout(() => bot.emit('message', { toString: () => r }, position), 5) }
  return bot
}
const stubMotor = bot => ({ bot, check() {}, log() {}, current: null })
test('followPlayer: out of sight, asks /data, walks toward the position, re-asks, then follows the entity once it appears', async () => {
  const bot = farBot()
  setTimeout(() => {   // the player comes into range after ~120 ms, next to the bot
    bot.players.Steve.entity = { isValid: true, position: new Vec3(1, 64, 0) }
  }, 120)
  const r = await followPlayer(stubMotor(bot), 'Steve', { holdMs: 0, queryEveryMs: 50, replyMs: 200 })
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.ok(bot.chats.length >= 2 && bot.chats.every(c => c === '/data get entity Steve Pos'), bot.chats.join(' | '))
  const near = bot.goals.find(g => g?.constructor?.name === 'GoalNear')
  assert.ok(near && near.x === 100 && near.z === 0 && near.rangeSq === 4, "GoalNear 2 at the reported position")
  assert.ok(bot.goals.some(g => g?.constructor?.name === 'GoalFollow'), 'then follows')
})
test('followPlayer: no reply (not on the server) or only a player-chat spoof gives player_gone', async () => {
  let r = await followPlayer(stubMotor(farBot({ replyFor: () => 'No entity was found' })), 'Steve', { holdMs: 0, queryEveryMs: 50, replyMs: 100 })
  assert.equal(r.result, 'player_gone')
  r = await followPlayer(stubMotor(farBot({ position: 'chat' })), 'Steve', { holdMs: 0, queryEveryMs: 50, replyMs: 100 })
  assert.equal(r.result, 'player_gone', 'a chat line is never read as the server reply')
})
test('receive: a named giver out of sight is approached through /data (go_to_player first), not refused at once', async () => {
  const bot = farBot({ replyFor: () => 'No entity was found' })
  bot.entities = {}
  const motor = { ...stubMotor(bot), settleInventory: async () => {}, count: () => 0, deadline: Date.now() + 5000 }
  const r = await receive.run(motor, 'redstone_block', { goalTop: { kind: 'receive', arg: 'redstone_block', count: 2, from: 'Steve' } })
  assert.equal(r.result, 'player_gone')
  assert.deepEqual(bot.chats, ['/data get entity Steve Pos'], 'asked the server where the giver is')
})

// Live retry session (2026-09-27): the player was in spectator mode (no entity for other clients) and "come here" never
// arrived. Within 3 m of the last server-reported position with no entity counts as arrived (followPlayer ok); the
// reported position is kept in motor.mem.reportedPlayers so the goal layer sees the distance (summary.playersMap).
test('followPlayer: a spectator (no entity) is reached at the reported position: within 3 m is arrived', async () => {
  const bot = farBot()
  bot.players.Steve.gamemode = 3
  bot.players.Steve.entity = { isValid: true, position: new Vec3(100.5, 64, 0.5) }   // hidden: spectators are not followed
  setTimeout(() => { bot.entity.position = new Vec3(99, 64, 1) }, 100)   // the walk arrives
  const motor = { ...stubMotor(bot), mem: {} }
  const r = await followPlayer(motor, 'Steve', { holdMs: 0, queryEveryMs: 50, replyMs: 200 })
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.match(r.detail, /reported position/)
  const near = bot.goals.find(g => g?.constructor?.name === 'GoalNear')
  assert.ok(near && near.rangeSq === 4, 'walks to within 2 m of the reported position')
  assert.deepEqual(motor.mem.reportedPlayers.Steve.pos, { x: 100.5, y: 64, z: 0.5 })
  assert.ok(Number.isFinite(motor.mem.reportedPlayers.Steve.at))
})
test('receive: a spectator giver is reached at the reported position, then the bot waits for the drop', async () => {
  const bot = farBot()
  bot.players.Steve.gamemode = 3
  bot.entities = {}
  setTimeout(() => { bot.entity.position = new Vec3(100, 64, 0) }, 80)
  const motor = { ...stubMotor(bot), mem: {}, settleInventory: async () => {}, count: () => 0, deadline: Date.now() + 2200, goto: async () => {} }
  const r = await receive.run(motor, 'redstone_block', { goalTop: { kind: 'receive', arg: 'redstone_block', count: 2, from: 'Steve' } })
  assert.equal(r.result, 'timeout', JSON.stringify(r))
  assert.match(r.detail, /no redstone_block dropped/)
})
import { playersMap } from '../agent/summary.js'
test('playersMap: entities by distance and direction; a player with no entity at its reported position (60 s)', () => {
  const me = new Vec3(0, 64, 0)
  const bot = { username: 'Kevin', players: { Kevin: { entity: { position: me } }, Steve: { entity: { position: new Vec3(3, 64, 4) } }, Alex: { entity: null },
    Far: { entity: { position: new Vec3(0, 64, 100) } }, Spec: { gamemode: 3, entity: { position: new Vec3(1, 64, 0) } } } }
  const now = 1_000_000
  const reported = { Alex: { pos: { x: -12, y: 64, z: 0 }, at: now - 5000 }, Far: { pos: { x: 0, y: 64, z: 200 }, at: now }, Old: { pos: { x: 1, y: 64, z: 0 }, at: now - 61_000 } }
  assert.deepEqual(playersMap(bot, me, reported, now), {
    Steve: { dist: 5, dir: 'south-east' },
    Alex: { dist: 12, dir: 'west', reported: true },
    Far: { dist: 200, dir: 'south', reported: true },   // beyond 64 m only a reported position gives a distance
  }, 'a spectator with no report is absent')
  assert.deepEqual(playersMap(bot, me, null, now), { Steve: { dist: 5, dir: 'south-east' } })
})
