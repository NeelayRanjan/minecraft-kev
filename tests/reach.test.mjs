import test from 'node:test'
import assert from 'node:assert/strict'
import { reachSpots, faces, lineOfSight, occupiedCells, buildOrder, scaffoldMaterial, scaffoldPlan, clearSpots, standable, key, bestFace, eyeOf } from '../agent/reach.js'

// A fake world: solid stone below y 64, air from y 64 up, with explicit blocks by position.
function world (blocks = {}) {
  const m = new Map(Object.entries(blocks))
  const blockAt = p => {
    const n = m.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air')
    return { name: n, boundingBox: n === 'air' || n === 'water' || n === 'lava' ? 'empty' : 'block' }
  }
  return { blockAt, set: (p, n) => m.set(key(p), n) }
}
const P = (x, y, z) => ({ x, y, z })

test('faces: the solid neighbours with the face vector toward the target and the face centre', () => {
  const w = world({ '1,64,0': 'stone' })
  const f = faces(P(0, 64, 0), w.blockAt)
  assert.deepEqual(f.map(x => key(x.ref)).sort(), ['0,63,0', '1,64,0'])
  const down = f.find(x => x.ref.y === 63)
  assert.deepEqual(down.dir, [0, 1, 0]); assert.deepEqual(down.point, { x: 0.5, y: 64, z: 0.5 })
  const side = f.find(x => x.ref.x === 1)
  assert.deepEqual(side.dir, [-1, 0, 0]); assert.deepEqual(side.point, { x: 1, y: 64.5, z: 0.5 })
  assert.deepEqual(faces(P(0, 70, 0), w.blockAt), [])
})

test('lineOfSight stops at a solid block, ignores the listed cells, never samples the end point', () => {
  const w = world({ '2,64,0': 'stone' })
  assert.equal(lineOfSight(w.blockAt, P(0.5, 64.5, 0.5), P(4.5, 64.5, 0.5)), false)
  assert.equal(lineOfSight(w.blockAt, P(0.5, 64.5, 0.5), P(4.5, 64.5, 0.5), new Set(['2,64,0'])), true)
  assert.equal(lineOfSight(w.blockAt, P(0.5, 65.62, 0.5), P(0.5, 64, 3.5)), true)   // ends on the ground's top face
})

test('reachSpots: standable cells within reach, never the target or an avoided cell, the bot\'s own cell first', () => {
  const w = world()
  const target = P(0, 64, 0)
  const spots = reachSpots(target, w.blockAt, { from: P(2, 64, 0) })
  assert.ok(spots.length > 10)
  assert.deepEqual(spots[0].feet, P(2, 64, 0)); assert.equal(spots[0].cost, 0); assert.equal(spots[0].seen, true)
  assert.ok(spots.every(s => key(s.feet) !== key(target) && standable(w.blockAt, s.feet)))
  const avoid = new Set(['2,64,0', '1,64,0'])
  const s2 = reachSpots(target, w.blockAt, { from: P(2, 64, 0), avoid })
  assert.ok(s2.every(s => !avoid.has(key(s.feet)) && !avoid.has(key({ ...s.feet, y: s.feet.y + 1 }))))
  // a cell with a solid block over the head is not standable
  w.set(P(2, 65, 0), 'stone')
  assert.ok(!reachSpots(target, w.blockAt, { from: P(2, 64, 0) }).some(s => key(s.feet) === '2,64,0'))
  // a floating cell has no face: no spot at all
  assert.deepEqual(reachSpots(P(0, 70, 0), w.blockAt), [])
})

test('reachSpots ranks seen faces before hidden ones; blind: false drops the hidden ones', () => {
  // a 4-high pillar 64..67 at the origin; the next cell up, 68, only has the pillar top's face (seen from above only)
  const w = world({ '0,64,0': 'stone', '0,65,0': 'stone', '0,66,0': 'stone', '0,67,0': 'stone' })
  const target = P(0, 68, 0)
  const spots = reachSpots(target, w.blockAt, { from: P(1, 64, 0) })
  assert.ok(spots.length > 0)
  assert.ok(spots.every(s => s.seen === false))   // no standing cell has an eye above y 68 here
  assert.deepEqual(reachSpots(target, w.blockAt, { from: P(1, 64, 0), blind: false }), [])
  // a platform at y 68 next to it: standing on it (feet 69) sees the top face
  w.set(P(2, 68, 0), 'stone')
  const s2 = reachSpots(target, w.blockAt, { from: P(1, 64, 0) })
  assert.equal(s2[0].seen, true); assert.deepEqual(s2[0].feet, P(2, 69, 0))
})

test('reachSpots dig mode: the target centre within reach, never standing on the target', () => {
  const w = world({ '0,64,0': 'stone' })
  const spots = reachSpots(P(0, 64, 0), w.blockAt, { mode: 'dig', from: P(0, 65, 0) })
  assert.ok(spots.length > 0)
  assert.ok(!spots.some(s => key(s.feet) === '0,65,0'))
  assert.equal(spots[0].face, null)
})

test('bestFace: nearest seen face within reach from an eye', () => {
  const w = world({ '1,64,0': 'stone' })
  const b = bestFace(w.blockAt, eyeOf(P(-1, 64, 0)), P(0, 64, 0))
  assert.equal(b.seen, true); assert.deepEqual(b.face.dir, [-1, 0, 0])   // the side face is nearer than the top one
  assert.equal(bestFace(w.blockAt, eyeOf(P(-8, 64, 0)), P(0, 64, 0)), null)
})

test('occupiedCells: a 0.6 m body covers one column at a cell centre, two or four near an edge; two cells high', () => {
  assert.deepEqual([...occupiedCells([P(10.5, 64, 10.5)])].sort(), ['10,64,10', '10,65,10'])
  assert.equal(occupiedCells([P(10.2, 64, 10.5)]).size, 4)
  assert.equal(occupiedCells([P(10.2, 64, 10.8)]).size, 8)
  assert.equal(occupiedCells([P(10.5, 64.5, 10.5)]).size, 3)   // mid-jump: feet cell, the one above, and the next
  assert.equal(occupiedCells([null, P(0.5, 64, 0.5)]).size, 2)
})

test('buildOrder: foundation first, layers up, dig before place, far from the bot first, ties by col', () => {
  const c = (x, z, layer, op, col = x) => ({ pos: P(x, 64 + layer, z), layer, col, row: z, op })
  const list = [c(0, 0, 0, 'place'), c(0, 4, 0, 'place'), c(2, 4, 0, 'place'), c(1, 1, 1, 'place'), c(1, 1, 0, 'dig'), c(3, 3, -1, 'foundation')]
  const out = buildOrder(list, { from: P(0.5, 64, 0.5) }).map(x => `${x.op}@${x.pos.x},${x.layer},${x.pos.z}`)
  assert.deepEqual(out, ['foundation@3,-1,3', 'dig@1,0,1', 'place@2,0,4', 'place@0,0,4', 'place@0,0,0', 'place@1,1,1'])
  // ties by col: two cells at the same distance
  const t = buildOrder([c(1, 3, 0, 'place', 2), c(-1, 3, 0, 'place', 0)], { from: P(0.5, 64, 0.5) })
  assert.deepEqual(t.map(x => x.col), [0, 2])
  // top down (staircase_down): layers descending, near rows first
  const d = buildOrder([c(0, 2, -2, 'place'), c(0, 1, -1, 'place'), c(0, 1, -2, 'place')], { from: P(0.5, 64, 0.5), descending: true })
  assert.deepEqual(d.map(x => `${x.layer},${x.row}`), ['-1,1', '-2,1', '-2,2'])
})

test('scaffoldMaterial: dirt, then cobblestone, then another held full block; never one the blueprint needs', () => {
  assert.equal(scaffoldMaterial({ dirt: 5, cobblestone: 40 }, { cobblestone: 30 }), 'dirt')
  assert.equal(scaffoldMaterial({ dirt: 5, cobblestone: 40 }, { dirt: 3 }), 'cobblestone')
  assert.equal(scaffoldMaterial({ dirt: 5, cobblestone: 40, oak_planks: 9 }, { dirt: 3, cobblestone: 1 }), 'oak_planks')
  assert.equal(scaffoldMaterial({ cobblestone: 40, sand: 9, crafting_table: 1, torch: 5, iron_ore: 3 }, { cobblestone: 1 }), null)
  assert.equal(scaffoldMaterial({ stone: 2, andesite: 7 }, {}), 'andesite')
  assert.equal(scaffoldMaterial({}, {}), null)
})

test('scaffoldPlan: the lowest column outside the blueprint that puts the target in reach', () => {
  // a 1x1 pillar blueprint of 9 at the origin, built to y 71; the next cell (72) is out of reach from the ground
  const blocks = {}
  for (let y = 64; y <= 71; y++) blocks[`0,${y},0`] = 'cobblestone'
  const w = world(blocks)
  const target = P(0, 72, 0)
  assert.deepEqual(reachSpots(target, w.blockAt, { from: P(1, 64, 0) }), [])
  const avoid = new Set(Array.from({ length: 9 }, (_, i) => `0,${64 + i},0`))
  const plan = scaffoldPlan(target, w.blockAt, { from: P(1, 64, 0), avoid })
  assert.ok(plan, 'a plan')
  assert.equal(plan.base.y, 64); assert.ok(plan.height >= 2 && plan.height <= 4)
  assert.deepEqual(plan.feet, { ...plan.base, y: plan.base.y + plan.height })
  for (let i = 0; i < plan.height + 2; i++) assert.ok(!avoid.has(key({ ...plan.base, y: plan.base.y + i })))
  // everything around is blueprint: no column
  const all = new Set(avoid)
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) all.add(`${x},64,${z}`)
  assert.equal(scaffoldPlan(target, w.blockAt, { avoid: all }), null)
})

test('clearSpots: the nearest standable cells outside the avoided ones', () => {
  const w = world()
  const avoid = new Set(['0,64,0', '0,65,0', '1,64,0'])
  const s = clearSpots(P(0, 64, 0), w.blockAt, { avoid })
  assert.ok(s.length > 0)
  assert.ok(s.every(p => !avoid.has(key(p))))
  assert.equal(Math.hypot(s[0].x, s[0].z), 1)
})
