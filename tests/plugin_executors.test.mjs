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
import dig, { digWork, digOrder, liquidExposure, harvestable, veinTargets, isOre, MAX_DIGS, TURNABLE } from '../agent/plugins/dig_blueprint.mjs'
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
    return { name: n, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(n) ? 'empty' : 'block' }
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
