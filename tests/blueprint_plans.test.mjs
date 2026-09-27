// agent/blueprint_plans.js: the runner's pure helpers for blueprint plans (anchor, /data reply, gather split, title,
// progress words, the status page's grid).
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorFor, facingToward, parseDataPos, splitGatherSteps, blueprintTitle, progressText, blueprintGrid } from '../agent/blueprint_plans.js'
import { makeBlueprint } from '../agent/templates.js'
import { cells } from '../agent/blueprints.js'

const wk = p => `${p.x},${p.y},${p.z}`
function world (floorY = 64) {
  const m = new Map()
  const blockAt = p => {
    const n = m.has(wk(p)) ? m.get(wk(p)) : (p.y < floorY ? 'stone' : 'air')
    return n == null ? null : { name: n, boundingBox: ['air', 'water', 'lava'].includes(n) ? 'empty' : 'block' }
  }
  return { blockAt, set: (p, n) => m.set(wk(p), n) }
}

test('facingToward: the cardinal direction from one position toward another (mineflayer yaw convention)', () => {
  const o = { x: 0, y: 64, z: 0 }
  assert.equal(facingToward(o, { x: 0, y: 64, z: -5 }), 'north')
  assert.equal(facingToward(o, { x: 5, y: 64, z: 1 }), 'east')
  assert.equal(facingToward(o, { x: -1, y: 70, z: 6 }), 'south')
  assert.equal(facingToward(o, { x: -6, y: 64, z: 2 }), 'west')
  assert.equal(facingToward(o, { x: 0, y: 80, z: 0 }), null)
})

test('anchorFor: the player\'s floored feet and look direction; else the server position faced from the bot; else the bot', () => {
  const bot = { pos: { x: 10.7, y: 64, z: 3.2 }, yaw: Math.PI / 2 }   // looking west
  assert.deepEqual(anchorFor({ player: { pos: { x: -3.4, y: 71.5, z: 8.9 }, yaw: 0 }, bot }), { anchor: { x: -4, y: 71, z: 8 }, facing: 'north', from: 'player' })
  assert.deepEqual(anchorFor({ player: { pos: { x: 0.5, y: 64, z: 0.5 }, yaw: Math.PI }, bot }).facing, 'south')
  assert.deepEqual(anchorFor({ player: { pos: { x: 0.5, y: 64, z: 0.5 }, yaw: -Math.PI / 2 + 0.3 }, bot }).facing, 'east')
  assert.deepEqual(anchorFor({ player: null, serverPos: { x: 10.5, y: 63, z: 20.5 }, bot }), { anchor: { x: 10, y: 63, z: 20 }, facing: 'south', from: 'server' })
  assert.deepEqual(anchorFor({ bot }), { anchor: { x: 10, y: 64, z: 3 }, facing: 'west', from: 'bot' })
  assert.equal(anchorFor({ bot: { ...bot, facing: 'east' } }).facing, 'east', 'the bot\'s last walk direction wins over its yaw')
  assert.equal(anchorFor({ player: { pos: { x: 0, y: 64, z: 0 }, yaw: NaN }, bot }).from, 'bot', 'a player without a yaw is not an anchor')
})

test('parseDataPos: the reply to /data get entity <name> Pos, numbers only, the right name', () => {
  assert.deepEqual(parseDataPos('tester has the following entity data: [12.5d, 64.0d, -3.25d]', 'tester'), { x: 12.5, y: 64, z: -3.25 })
  assert.deepEqual(parseDataPos(' tester has the following entity data: [-1.0E-4d, 70d, 8d] ', 'tester'), { x: -0.0001, y: 70, z: 8 })
  assert.equal(parseDataPos('tester has the following entity data: [12.5d, 64.0d, -3.25d]', 'Steve'), null)
  assert.equal(parseDataPos('No entity was found', 'tester'), null)
  assert.equal(parseDataPos('<tester> tester has the following entity data: [1d, 2d, 3d]', 'tester'), null, 'player chat is not a reply')
  assert.equal(parseDataPos(null, 'tester'), null)
})

test('splitGatherSteps: a gather step above its cap becomes consecutive steps of at most the cap; the rest pass unchanged', () => {
  const steps = [{ kind: 'gather', arg: 'cobblestone', count: 70 }, { kind: 'gather', arg: 'oak_log', count: 13 }, { kind: 'gather', arg: 'coal', count: 40 },
    { kind: 'craft_item', arg: 'furnace', count: 1 }, { kind: 'build', arg: 'bp1', count: null }]
  assert.deepEqual(splitGatherSteps(steps), [
    { kind: 'gather', arg: 'cobblestone', count: 32 }, { kind: 'gather', arg: 'cobblestone', count: 32 }, { kind: 'gather', arg: 'cobblestone', count: 6 },
    { kind: 'gather', arg: 'oak_log', count: 12 }, { kind: 'gather', arg: 'oak_log', count: 1 },
    { kind: 'gather', arg: 'coal', count: 40 }, { kind: 'craft_item', arg: 'furnace', count: 1 }, { kind: 'build', arg: 'bp1', count: null }])
  assert.deepEqual(splitGatherSteps([{ kind: 'gather', arg: 'cobblestone', count: 32 }]), [{ kind: 'gather', arg: 'cobblestone', count: 32 }])
  const s = [{ kind: 'gather', arg: 'cobblestone', count: 40, title: 'x' }]
  const out = splitGatherSteps(s)
  assert.equal(out[0].title, 'x'); assert.notEqual(out[0], s[0], 'copies, never the input objects')
})

test('blueprintTitle: template and size, a material other than cobblestone, a free-form title and its box', () => {
  const at = { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' }
  assert.equal(blueprintTitle(makeBlueprint('hut', { w: 5, d: 5, h: 3 }, 'cobblestone', at)), 'hut (5x5x3)')
  assert.equal(blueprintTitle(makeBlueprint('hut', { w: 7, d: 5, h: 4 }, 'oak_planks', at)), 'hut (7x5x4, oak planks)')
  assert.equal(blueprintTitle(makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, at)), 'room (3x3x2)')
  assert.equal(blueprintTitle(makeBlueprint('pit', { w: 3, d: 3, depth: 4 }, null, at)), 'pit (3x3x4)')
  assert.equal(blueprintTitle(makeBlueprint('stairs_down_to', { y: 40 }, null, at)), 'stairs down to (y 40)')
  assert.equal(blueprintTitle(makeBlueprint('staircase_up', { height: 6 }, 'cobblestone', at)), 'staircase up (height 6, width 1)')
  assert.equal(blueprintTitle({ kind: 'build', title: 'arch', legend: { '#': 'stone' }, layers: [['#.#'], ['###', '#']] }), 'arch (3x2x2)')
})

test('progressText: a build\'s layer and blocks, a dig\'s segment and cells; nothing without progress', () => {
  assert.equal(progressText({ kind: 'build', layer: 2, layers: 4, done: 50, total: 100, blocksDone: 41, blocksTotal: 96, blocked: 0, segment: 1, segments: 1 }), 'layer 2 of 4, 41 of 96 blocks')
  assert.equal(progressText({ kind: 'build', layer: 1, layers: 2, done: 3, total: 9, blocksDone: 3, blocksTotal: 8, blocked: 2, segment: 1, segments: 1 }), 'layer 1 of 2, 3 of 8 blocks, 2 blocked')
  assert.equal(progressText({ kind: 'dig', done: 22, total: 30, blocked: 0, segment: 3, segments: 4 }), 'segment 3 of 4, 22 of 30 cells')
  assert.equal(progressText({ kind: 'dig', done: 0, total: 18, blocked: 1, segment: 1, segments: 1 }), '0 of 18 cells, 1 blocked')
  assert.equal(progressText(null), '')
})

test('blueprintGrid: each layer as rows (farthest on top), cell marks, a standing scaffold widens the grid', () => {
  const w = world()
  const bp = makeBlueprint('hut', { w: 5, d: 5, h: 3 }, 'cobblestone', { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  // layer 0 walls placed except the far-left corner; stone left in an interior cell; water in another interior cell
  for (const c of cells(bp)) if (c.layer === 0 && c.want !== 'air') w.set(c.pos, 'cobblestone')
  const far = cells(bp).find(c => c.layer === 0 && c.row === 4 && c.col === 0)
  w.set(far.pos, 'air')
  const inner = cells(bp).find(c => c.layer === 0 && c.row === 2 && c.col === 2)
  w.set(inner.pos, 'stone')
  const wet = cells(bp).find(c => c.layer === 0 && c.row === 1 && c.col === 1)
  w.set(wet.pos, 'water')
  const wrong = cells(bp).find(c => c.layer === 1 && c.row === 0 && c.col === 0)
  w.set(wrong.pos, 'dirt')
  // a scaffold dirt block one column right of the hut at layer 2 (standing) and one already dug (not shown)
  const right = { x: 3, y: 66, z: -4, item: 'dirt' }
  w.set(right, 'dirt')
  const gone = { x: 3, y: 65, z: -4, item: 'dirt' }
  const g = blueprintGrid(bp, w.blockAt, [right, gone])
  assert.equal(g.title, 'hut (5x5x3)'); assert.equal(g.kind, 'build'); assert.equal(g.segments, 1)
  assert.equal(g.layers.length, 4)
  // 5 columns and the scaffold's column on the right (x 3 = col 5, z -4 = row 2 on layer 2); the door gap is '_'
  assert.deepEqual(g.layers[0], { layer: 1, rows: ['o#### ', '#___# ', '#_._# ', '#!__# ', '##_## '] })
  assert.deepEqual(g.layers[1].rows, ['ooooo ', 'o___o ', 'o___o ', 'o___o ', 'xo_oo '])
  assert.deepEqual(g.layers[2].rows, ['ooooo ', 'o___o ', 'o___os', 'o___o ', 'ooooo '])
  assert.deepEqual(g.layers[3].rows, ['ooooo ', 'ooooo ', 'ooooo ', 'ooooo ', 'ooooo '])
})

test('blueprintGrid: a dig room reads . still to dig and _ dug', () => {
  const w = world(70)
  const bp = makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  for (const c of cells(bp)) if (c.layer === 1 || c.row === 0) w.set(c.pos, 'air')
  const g = blueprintGrid(bp, w.blockAt)
  assert.deepEqual(g.layers.map(l => l.rows), [['...', '...', '___'], ['___', '___', '___']])
})
