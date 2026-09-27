import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FACINGS, facingFromYaw, toWorld, cells, itemForBlock, materials, diff, foundation, validate, isPlaceable, layerCut,
} from '../agent/blueprints.js'

const A = { x: 10, y: 64, z: 20 }
const bp3 = (facing, extra = {}) => ({
  id: 't', kind: 'build', legend: { '#': 'cobblestone' }, anchor: A, facing,
  layers: [['###', '###', '###'], ['###', '###', '###']], ...extra,
})

// a world as a map "x,y,z" -> name; anything unset is air, `unloaded` returns null
function fakeWorld (blocks = {}, { unloaded = [] } = {}) {
  const solid = n => !['air', 'cave_air', 'water', 'lava', 'short_grass', 'torch'].includes(n)
  return pos => {
    const k = `${pos.x},${pos.y},${pos.z}`
    if (unloaded.includes(k)) return null
    const name = blocks[k] ?? 'air'
    return { name, boundingBox: solid(name) ? 'block' : 'empty' }
  }
}
const key = p => `${p.x},${p.y},${p.z}`

test('FACINGS lists the four cardinals', () => {
  assert.deepEqual(FACINGS, ['north', 'east', 'south', 'west'])
})

test('facingFromYaw: mineflayer yaw 0 = north, pi/2 = west, pi = south, -pi/2 = east', () => {
  assert.equal(facingFromYaw(0), 'north')
  assert.equal(facingFromYaw(Math.PI / 2), 'west')
  assert.equal(facingFromYaw(Math.PI), 'south')
  assert.equal(facingFromYaw(-Math.PI), 'south')
  assert.equal(facingFromYaw(-Math.PI / 2), 'east')
  assert.equal(facingFromYaw(3 * Math.PI / 2), 'east')
  assert.equal(facingFromYaw(0.7), 'north')
  assert.equal(facingFromYaw(0.8), 'west')
  assert.equal(facingFromYaw(-0.8), 'east')
  assert.equal(facingFromYaw(2 * Math.PI + 0.1), 'north')
  assert.equal(facingFromYaw(2.5), 'south')
})

test('toWorld: all four facings on a 3x3 build blueprint (offset 2, cols centred, col to the right)', () => {
  const cases = {
    north: [{ x: 9, y: 64, z: 18 }, { x: 11, y: 65, z: 16 }, { x: 10, y: 64, z: 18 }],
    east: [{ x: 12, y: 64, z: 19 }, { x: 14, y: 65, z: 21 }, { x: 12, y: 64, z: 20 }],
    south: [{ x: 11, y: 64, z: 22 }, { x: 9, y: 65, z: 24 }, { x: 10, y: 64, z: 22 }],
    west: [{ x: 8, y: 64, z: 21 }, { x: 6, y: 65, z: 19 }, { x: 8, y: 64, z: 20 }],
  }
  for (const [f, [a, b, c]] of Object.entries(cases)) {
    const bp = bp3(f)
    assert.deepEqual(toWorld(bp, { col: 0, row: 0, layer: 0 }), a, f)
    assert.deepEqual(toWorld(bp, { col: 2, row: 2, layer: 1 }), b, f)
    assert.deepEqual(toWorld(bp, { col: 1, row: 0, layer: 0 }), c, f)
  }
})

test('toWorld: dig defaults to offset 0, an explicit offset wins, baseLayer shifts y', () => {
  const dig = { kind: 'dig', legend: {}, layers: [['...']], anchor: A, facing: 'north' }
  assert.deepEqual(toWorld(dig, { col: 1, row: 0, layer: 0 }), { x: 10, y: 64, z: 20 })
  assert.deepEqual(toWorld(bp3('north', { offset: 0 }), { col: 1, row: 0, layer: 0 }), { x: 10, y: 64, z: 20 })
  assert.deepEqual(toWorld(bp3('north', { offset: 5 }), { col: 1, row: 1, layer: 0 }), { x: 10, y: 64, z: 14 })
  assert.deepEqual(toWorld(bp3('north', { baseLayer: -3 }), { col: 1, row: 0, layer: 1 }), { x: 10, y: 62, z: 18 })
})

test('cells skips spaces and maps "." to air', () => {
  const bp = { kind: 'build', legend: { '#': 'stone' }, anchor: A, facing: 'north', offset: 0, layers: [['# .']] }
  const cs = cells(bp)
  assert.equal(cs.length, 2)
  assert.deepEqual(cs[0], { col: 0, row: 0, layer: 0, pos: { x: 9, y: 64, z: 20 }, want: 'stone' })
  assert.deepEqual(cs[1], { col: 2, row: 0, layer: 0, pos: { x: 11, y: 64, z: 20 }, want: 'air' })
})

test('cells throws on an unknown legend character; validate reports it instead', () => {
  const bp = { kind: 'build', legend: { '#': 'stone' }, layers: [['#X#']] }
  assert.throws(() => cells(bp), /unknown legend character "X"/)
  assert.deepEqual(validate(bp), { ok: false, reason: 'unknown legend character "X"' })
  assert.throws(() => materials(bp), /unknown legend character/)
})

test('itemForBlock: same-name item, grass_block -> dirt, null when no item places it', () => {
  assert.equal(itemForBlock('stone'), 'stone')
  assert.equal(itemForBlock('oak_planks'), 'oak_planks')
  assert.equal(itemForBlock('grass_block'), 'dirt')
  assert.equal(itemForBlock('water'), null)
  assert.equal(itemForBlock('air'), null)
})

test('materials: a 3x3x2 ring is 16 of the material; dig -> {}', () => {
  const ring = { kind: 'build', legend: { '#': 'cobblestone' }, layers: [['###', '#.#', '###'], ['###', '#.#', '###']] }
  assert.deepEqual(materials(ring), { cobblestone: 16 })
  const mixed = { kind: 'build', legend: { '#': 'cobblestone', G: 'grass_block' }, layers: [['#G ']] }
  assert.deepEqual(materials(mixed), { cobblestone: 1, dirt: 1 })
  assert.deepEqual(materials({ kind: 'dig', legend: {}, layers: [['...']] }), {})
})

test('diff: done / missing / wrong / blocked over a fake world', () => {
  // north, offset 0: col c -> x 9+c, row r -> z 20-r
  const bp = { kind: 'build', legend: { '#': 'stone' }, anchor: A, facing: 'north', offset: 0, layers: [['###', '#..']] }
  const world = fakeWorld({ '9,64,20': 'stone', '10,64,20': 'dirt', '10,64,19': 'dirt' }, { unloaded: ['11,64,19'] })
  const d = diff(bp, world)
  assert.equal(d.total, 6)
  assert.equal(d.done, 1)
  assert.deepEqual(d.missing.map(c => key(c.pos)), ['11,64,20', '9,64,19'])
  assert.deepEqual(d.wrong.map(c => key(c.pos)), ['10,64,20', '10,64,19'])
  assert.deepEqual(d.blocked.map(c => key(c.pos)), ['11,64,19'])
})

test('diff: a dig cell counts done once air (or a non-solid plant), wrong while solid', () => {
  const bp = { kind: 'dig', legend: {}, anchor: A, facing: 'north', layers: [['...']] }
  const d = diff(bp, fakeWorld({ '9,64,20': 'stone', '10,64,20': 'short_grass' }))
  assert.equal(d.total, 3)
  assert.equal(d.done, 2)
  assert.deepEqual(d.wrong.map(c => key(c.pos)), ['9,64,20'])
  assert.equal(d.missing.length, 0)
})

test('foundation: one block under each layer-0 build cell over air, same material', () => {
  const bp = { kind: 'build', legend: { '#': 'stone', P: 'oak_planks' }, anchor: A, facing: 'north', offset: 0, layers: [['#P#'], ['###']] }
  // ground under col 0 only; cols 1 and 2 hang over air
  const f = foundation(bp, fakeWorld({ '9,63,20': 'dirt' }))
  assert.deepEqual(f, [{ x: 10, y: 63, z: 20, want: 'oak_planks' }, { x: 11, y: 63, z: 20, want: 'stone' }])
  assert.deepEqual(foundation({ ...bp, kind: 'dig' }, fakeWorld()), [])
})

test('isPlaceable: full blocks with an item; doors, stairs, slabs, torches, walls, liquids refused', () => {
  for (const n of ['stone', 'cobblestone', 'oak_planks', 'glass', 'dirt']) assert.equal(isPlaceable(n), true, n)
  for (const n of ['oak_door', 'red_bed', 'oak_stairs', 'stone_slab', 'torch', 'glass_pane', 'oak_fence',
    'oak_sign', 'cobblestone_wall', 'stone_button', 'lever', 'white_carpet', 'rail', 'ladder', 'vine',
    'flower_pot', 'water', 'lava', 'air', 'snow', 'not_a_block']) assert.equal(isPlaceable(n), false, n)
})

test('isPlaceable: boundingBox "block" is not enough; the collision shape must be one full cube', () => {
  for (const n of ['target', 'glass', 'ice', 'oak_leaves', 'oak_log', 'crafting_table', 'grass_block']) assert.equal(isPlaceable(n), true, n)
  for (const n of ['cauldron', 'campfire', 'soul_campfire', 'composter', 'beacon', 'conduit', 'scaffolding',
    'honey_block', 'slime_block', 'turtle_egg', 'sea_pickle', 'big_dripleaf', 'anvil', 'chipped_anvil',
    'damaged_anvil', 'lantern', 'soul_lantern', 'chain', 'pointed_dripstone', 'chest', 'hopper', 'bell', 'cake',
    'end_rod', 'lightning_rod', 'dirt_path', 'soul_sand', 'skeleton_skull', 'candle', 'white_banner',
    'brain_coral_block', 'lectern', 'grindstone', 'stonecutter', 'enchanting_table', 'brewing_stand',
    'daylight_detector', 'cactus']) assert.equal(isPlaceable(n), false, n)
})

test('validate: ok for a plain floor and a free-standing staircase with its supports', () => {
  assert.deepEqual(validate({ kind: 'build', legend: { '#': 'stone' }, layers: [['###', '###']] }), { ok: true, reason: null })
  // side view, 1 wide: step k at row k layer k, a support under each step above the first
  const stairs = { kind: 'build', legend: { '#': 'cobblestone' }, layers: [['#', '#', ' ', ' '], [' ', '#', '#', ' '], [' ', ' ', '#', '#'], [' ', ' ', ' ', '#']] }
  assert.deepEqual(validate(stairs), { ok: true, reason: null })
})

test('validate: a floating block is named', () => {
  const bp = { kind: 'build', legend: { '#': 'stone' }, layers: [['#  '], ['  #']] }
  assert.deepEqual(validate(bp), { ok: false, reason: 'floating block at layer 1 row 0 col 2' })
})

test('validate: ground connectors seed the BFS; with baseLayer < 0 only ground does', () => {
  // staircase_down shape: top step at array layer 2, hanging steps below, anchored to the anchor's block via ground
  const down = {
    kind: 'build', legend: { '#': 'stone' }, baseLayer: -3, offset: 0,
    layers: [[' ', ' ', '#'], [' ', '#', '#'], ['#', '#', ' ']],
    ground: [{ col: 0, row: -1, layer: 2 }],
  }
  assert.deepEqual(validate(down), { ok: true, reason: null })
  assert.deepEqual(validate({ ...down, ground: [] }), { ok: false, reason: 'floating block at layer 0 row 2 col 0' })
  // with baseLayer 0 a hanging block connected through ground is fine too
  const hang = { kind: 'build', legend: { '#': 'stone' }, layers: [[' '], ['#']], ground: [{ col: 0, row: -1, layer: 1 }] }
  assert.deepEqual(validate(hang), { ok: true, reason: null })
})

test('validate: size and block caps, skipped when streamed', () => {
  const wide = { kind: 'build', legend: { '#': 'stone' }, layers: [['##########']] }
  assert.equal(validate(wide).ok, false)
  assert.match(validate(wide).reason, /too big/)
  assert.equal(validate(wide, { streamed: true }).ok, true)
  const tall = { kind: 'build', legend: { '#': 'stone' }, layers: Array.from({ length: 10 }, () => ['#']) }
  assert.match(validate(tall).reason, /too big/)
  // 151 blocks within 9x9x2: 81 + 70
  const l1 = Array.from({ length: 9 }, () => '#########')
  const l2 = [...Array.from({ length: 7 }, () => '#########'), '#######  ', '         ']
  const many = { kind: 'build', legend: { '#': 'stone' }, layers: [l1, l2] }
  assert.equal(cells(many).length, 81 + 63 + 7)
  assert.equal(validate(many).reason, 'too many blocks: 151 (max 150)')
  assert.equal(validate(many, { streamed: true }).ok, true)
})

test('validate: an unplaceable legend item and an unknown character', () => {
  const door = { kind: 'build', legend: { '#': 'stone', D: 'oak_door' }, layers: [['#D#']] }
  assert.deepEqual(validate(door), { ok: false, reason: 'oak_door is not a placeable block' })
  const unk = { kind: 'build', legend: { '#': 'stone' }, layers: [['#X#']] }
  assert.deepEqual(validate(unk), { ok: false, reason: 'unknown legend character "X"' })
  assert.equal(validate({ kind: 'build', legend: { '#': 'stone' }, layers: [['#D#']] }, { placeable: () => true }).ok, false)
  assert.equal(validate(door, { placeable: () => true }).ok, true)
})

test('validate: a closed ring on layers 0 and 1 needs a door gap', () => {
  const closed = { kind: 'build', legend: { '#': 'stone' }, layers: [['###', '#.#', '###'], ['###', '#.#', '###']] }
  assert.deepEqual(validate(closed), { ok: false, reason: 'no way in (needs a door gap)' })
  const door = { kind: 'build', legend: { '#': 'stone' }, layers: [['#.#', '#.#', '###'], ['#.#', '#.#', '###'], ['###', '###', '###']] }
  assert.deepEqual(validate(door), { ok: true, reason: null })
  // a gap on layer 0 only, wall above it: still no way in
  const low = { kind: 'build', legend: { '#': 'stone' }, layers: [['#.#', '#.#', '###'], ['###', '#.#', '###']] }
  assert.equal(validate(low).reason, 'no way in (needs a door gap)')
  // a gap on layer 1 above a placed layer-0 block with nothing above: a step up, a way in
  const step = { kind: 'build', legend: { '#': 'stone' }, layers: [['###', '#.#', '###'], ['#.#', '#.#', '###']] }
  assert.deepEqual(validate(step), { ok: true, reason: null })
})

test('validate: dig blueprints skip connectivity and the door rule', () => {
  assert.deepEqual(validate({ kind: 'dig', legend: {}, layers: [['...', '...'], ['...', '...']] }), { ok: true, reason: null })
  assert.equal(validate({ kind: 'mine', legend: {}, layers: [['.']] }).ok, false)
})

test('layerCut: 9x9 around the centre, far rows on top, bot marked', () => {
  // north, offset 0, 3 wide x 2 deep: row 0 at z 20, row 1 at z 19; cols x 9..11
  const bp = { kind: 'build', legend: { '#': 'stone' }, anchor: A, facing: 'north', offset: 0, layers: [['###', '#..']] }
  const world = fakeWorld({ '9,64,20': 'stone', '10,64,20': 'dirt', '10,64,19': 'dirt' }, { unloaded: ['11,64,19'] })
  const cut = layerCut(bp, 0, world, { x: 10.5, y: 64, z: 21.5 })
  assert.deepEqual(cut, [
    '         ',
    '         ',
    '         ',
    '         ',
    '   o.x   ',
    '   #xo   ',
    '    @    ',
    '         ',
    '         ',
  ])
})
