import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATES, checkParams, makeBlueprint, nextSegment, turnSegment, describeTemplates } from '../agent/templates.js'
import { cells, materials, validate, toWorld } from '../agent/blueprints.js'

const A = { x: 100, y: 64, z: 200 }
const placedCells = bp => cells(bp).filter(c => c.want !== 'air')
const airCells = bp => cells(bp).filter(c => c.want === 'air')
const key = p => `${p.x},${p.y},${p.z}`
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)
const fwdOf = (bp, p) => ({ north: A.z - p.z, south: p.z - A.z, east: p.x - A.x, west: A.x - p.x })[bp.facing]

function allSegments (bp) {
  const out = [bp]
  for (let s = nextSegment(bp); s; s = nextSegment(s)) {
    out.push(s)
    if (out.length > 200) throw new Error('runaway stream')
  }
  return out
}

// segment i's farthest cells and segment i+1's nearest cells touch face to face; no cell is in two segments
function assertContinuous (segs) {
  const seen = new Set()
  for (const s of segs) {
    for (const c of cells(s)) {
      assert.ok(!seen.has(key(c.pos)), `cell ${key(c.pos)} in two segments`)
      seen.add(key(c.pos))
    }
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = cells(segs[i]).map(c => c.pos)
    const b = cells(segs[i + 1]).map(c => c.pos)
    const maxA = Math.max(...a.map(p => fwdOf(segs[i], p)))
    const minB = Math.min(...b.map(p => fwdOf(segs[i + 1], p)))
    const last = a.filter(p => fwdOf(segs[i], p) === maxA)
    const first = b.filter(p => fwdOf(segs[i + 1], p) === minB)
    assert.ok(last.some(p => first.some(q => manhattan(p, q) === 1)), `segments ${i} and ${i + 1} do not touch`)
  }
}

test('TEMPLATES: the fifteen templates, kinds and streaming', () => {
  assert.deepEqual(Object.keys(TEMPLATES), [
    'hut', 'wall', 'floor', 'tower', 'pillar', 'bridge', 'staircase_up', 'staircase_down',
    'room', 'tunnel', 'strip_mine', 'stairs_down_to', 'stairs_up_to', 'shaft_down', 'pit',
  ])
  for (const n of ['hut', 'wall', 'floor', 'tower', 'pillar', 'bridge', 'staircase_up', 'staircase_down']) {
    assert.equal(TEMPLATES[n].kind, 'build', n)
    assert.equal(TEMPLATES[n].material, true, n)
  }
  for (const n of ['room', 'tunnel', 'strip_mine', 'stairs_down_to', 'stairs_up_to', 'shaft_down', 'pit']) {
    assert.equal(TEMPLATES[n].kind, 'dig', n)
    assert.equal(TEMPLATES[n].material, false, n)
  }
  const streamed = Object.keys(TEMPLATES).filter(n => TEMPLATES[n].streamed)
  assert.deepEqual(streamed, ['staircase_up', 'staircase_down', 'tunnel', 'strip_mine', 'stairs_down_to', 'stairs_up_to', 'shaft_down'])
  assert.deepEqual(TEMPLATES.hut.params, { w: { min: 5, max: 9, default: 5 }, d: { min: 5, max: 9, default: 5 }, h: { min: 3, max: 5, default: 3 } })
})

test('hut 5x5x3: wall ring with a 1x2 door gap in the near wall, a full roof, interior kept clear', () => {
  const bp = makeBlueprint('hut', { w: 5, d: 5, h: 3 }, 'cobblestone', { anchor: A, facing: 'north' })
  assert.equal(bp.kind, 'build')
  assert.equal(bp.layers.length, 4)
  assert.deepEqual(bp.layers[0], ['##.##', '#...#', '#...#', '#...#', '#####'])
  assert.deepEqual(bp.layers[1], bp.layers[0])
  assert.deepEqual(bp.layers[2], ['#####', '#...#', '#...#', '#...#', '#####'])
  assert.deepEqual(bp.layers[3], ['#####', '#####', '#####', '#####', '#####'])
  assert.deepEqual(materials(bp), { cobblestone: 16 * 3 - 2 + 25 })
  assert.equal(bp.offset ?? 2, 2)
  assert.equal(bp.baseLayer ?? 0, 0)
  // the door is straight ahead of the anchor, two blocks out
  const door = cells(bp).find(c => c.layer === 0 && c.row === 0 && c.want === 'air')
  assert.deepEqual(door.pos, { x: 100, y: 64, z: 198 })
  assert.deepEqual(validate(bp), { ok: true, reason: null })
})

test('hut 7x9x5 dimensions; material carried in legend', () => {
  const bp = makeBlueprint('hut', { w: 7, d: 9, h: 5 }, 'oak_planks', { anchor: A, facing: 'east' })
  assert.equal(bp.layers.length, 6)
  assert.equal(bp.layers[0].length, 9)
  assert.ok(bp.layers[0].every(r => r.length === 7))
  assert.equal(bp.layers[0][0], '###.###')
  assert.equal(bp.layers[2][0], '#######')
  assert.deepEqual(bp.legend, { '#': 'oak_planks' })
  assert.deepEqual(materials(bp), { oak_planks: (2 * 7 + 2 * 7) * 5 - 2 + 63 })
})

test('wall, floor, pillar, tower, bridge shapes', () => {
  const wall = makeBlueprint('wall', { len: 4, h: 2 }, 'stone')
  assert.deepEqual(wall.layers, [['####'], ['####']])
  const floor = makeBlueprint('floor', { w: 3, d: 2 }, 'stone')
  assert.deepEqual(floor.layers, [['###', '###']])
  const pillar = makeBlueprint('pillar', { h: 3 }, 'stone')
  assert.deepEqual(pillar.layers, [['#'], ['#'], ['#']])
  const tower = makeBlueprint('tower', { w: 3, h: 4 }, 'stone')
  assert.deepEqual(tower.layers, [['#.#', '#.#', '###'], ['#.#', '#.#', '###'], ['###', '#.#', '###'], ['###', '#.#', '###']])
  const bridge = makeBlueprint('bridge', { len: 4 }, 'stone', { anchor: A, facing: 'south' })
  assert.deepEqual(bridge.layers, [['#', '#', '#', '#']])
  // level with the block the anchor stands on, starting right in front of it, connected through that block
  assert.deepEqual(cells(bridge).map(c => c.pos), [201, 202, 203, 204].map(z => ({ x: 100, y: 63, z })))
  assert.deepEqual(bridge.ground.map(g => toWorld(bridge, g)), [{ x: 100, y: 63, z: 200 }])
})

test('every non-streamed template validates at its defaults, its minimums and its maximums', () => {
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (t.streamed) continue
    for (const pick of ['default', 'min', 'max']) {
      const params = Object.fromEntries(Object.entries(t.params).map(([k, s]) => [k, s[pick]]))
      const bp = makeBlueprint(name, params, 'cobblestone', { anchor: A, facing: 'west' })
      // the 9x9x5 hut has 239 blocks: templates are trusted past the free-form cap of 150
      const caps = name === 'hut' && pick === 'max' ? { maxBlocks: 250 } : {}
      assert.deepEqual(validate(bp, caps), { ok: true, reason: null }, `${name} ${pick}`)
    }
  }
  assert.match(validate(makeBlueprint('hut', { w: 9, d: 9, h: 5 }, 'stone')).reason, /too many blocks: 239/)
})

test('staircase_up(6): 6 steps + 5 supports, headroom above each step, connected to the ground', () => {
  const bp = makeBlueprint('staircase_up', { height: 6 }, 'cobblestone', { anchor: A, facing: 'north' })
  assert.equal(placedCells(bp).length, 11)
  assert.equal(bp.segments, 1)
  assert.equal(bp.offset ?? 2, 2)
  for (let k = 0; k < 6; k++) {
    const at = (layer, row = k) => cells(bp).find(c => c.row === row && c.layer === layer)
    assert.equal(at(k).want, 'cobblestone', `step ${k}`)
    if (k >= 1) assert.equal(at(k - 1).want, 'cobblestone', `support ${k}`)
    assert.equal(at(k + 1).want, 'air')
    assert.equal(at(k + 2).want, 'air')
  }
  assert.deepEqual(validate(bp), { ok: true, reason: null })
  assert.equal(nextSegment(bp), null)
  const wide = makeBlueprint('staircase_up', { height: 4, width: 3 }, 'cobblestone', { anchor: A, facing: 'north' })
  assert.equal(placedCells(wide).length, 3 * 7)
  assert.deepEqual(validate(wide), { ok: true, reason: null })
})

test('staircase_down(5): steps hang from the anchor\'s standing block (a ground cell), each step beside a support', () => {
  const bp = makeBlueprint('staircase_down', { depth: 5 }, 'cobblestone', { anchor: A, facing: 'south' })
  assert.equal(bp.offset, 0)
  assert.equal(placedCells(bp).length, 9)
  assert.deepEqual(bp.ground.map(g => toWorld(bp, g)), [{ x: 100, y: 63, z: 200 }])
  const placedAt = new Set(placedCells(bp).map(c => key(c.pos)))
  for (let k = 1; k <= 5; k++) {
    assert.ok(placedAt.has(key({ x: 100, y: 64 - k, z: 200 + k })), `step ${k}`)
    if (k >= 2) assert.ok(placedAt.has(key({ x: 100, y: 64 - k, z: 200 + k - 1 })), `connector ${k}`)
  }
  const airAt = new Set(airCells(bp).map(c => key(c.pos)))
  for (let k = 1; k <= 5; k++) {
    assert.ok(airAt.has(key({ x: 100, y: 64 - k + 1, z: 200 + k })) && airAt.has(key({ x: 100, y: 64 - k + 2, z: 200 + k })))
  }
  assert.deepEqual(validate(bp), { ok: true, reason: null })
  assert.match(validate({ ...bp, ground: [] }).reason, /floating/)
})

test('dig templates: room at the feet, pit below the feet, veins flags', () => {
  const room = makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, { anchor: A, facing: 'north' })
  assert.equal(room.kind, 'dig')
  assert.equal(room.veins, false)
  assert.deepEqual(room.layers, [['...', '...', '...'], ['...', '...', '...']])
  const ys = cells(room).map(c => c.pos.y)
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [64, 65])
  assert.ok(cells(room).some(c => key(c.pos) === key(A)))
  const pit = makeBlueprint('pit', { w: 2, d: 2, depth: 3 }, null, { anchor: A, facing: 'north' })
  assert.equal(pit.baseLayer, -3)
  const py = cells(pit).map(c => c.pos.y)
  assert.deepEqual([Math.min(...py), Math.max(...py)], [61, 63])
  assert.equal(cells(pit).length, 12)
  assert.equal(makeBlueprint('tunnel', {}, null).veins, true)
  assert.equal(makeBlueprint('strip_mine', {}, null).veins, true)
  assert.equal(makeBlueprint('stairs_down_to', { y: 50 }, null, { anchor: A, facing: 'north' }).veins, false)
  assert.equal(makeBlueprint('shaft_down', {}, null).veins, false)
  assert.equal(makeBlueprint('pit', {}, null).veins, false)
})

test('tunnel(20, 2 wide, 3 high): 3 segments of 8, 8, 4 rows; the union is the whole tunnel', () => {
  const bp = makeBlueprint('tunnel', { len: 20, w: 2, h: 3 }, null, { anchor: A, facing: 'east' })
  assert.equal(bp.segments, 3)
  const segs = allSegments(bp)
  assert.deepEqual(segs.map(s => s.segment), [0, 1, 2])
  assert.deepEqual(segs.map(s => cells(s).length), [48, 48, 24])
  assert.deepEqual(segs.map(s => s.anchor.x), [100, 108, 116])
  const got = new Set(segs.flatMap(s => cells(s).map(c => key(c.pos))))
  const want = new Set()
  for (let f = 0; f < 20; f++) for (const dz of [-1, 0]) for (let dy = 0; dy < 3; dy++) want.add(key({ x: 100 + f, y: 64 + dy, z: 200 + dz }))
  assert.deepEqual([...got].sort(), [...want].sort())
  assertContinuous(segs)
})

test('strip_mine: segment 0 is the first 8 blocks of main tunnel plus its branches; continues; null after len', () => {
  const bp = makeBlueprint('strip_mine', { len: 32, branch_every: 3, branch_len: 8 }, null, { anchor: A, facing: 'north' })
  assert.equal(bp.template, 'strip_mine')
  assert.deepEqual([bp.segment, bp.segments], [0, 4])
  const main = s => cells(s).filter(c => c.col === 8)
  assert.equal(main(bp).length, 16)
  assert.deepEqual([...new Set(main(bp).map(c => c.row))], [0, 1, 2, 3, 4, 5, 6, 7])
  const branchRows = s => [...new Set(cells(s).filter(c => c.col !== 8).map(c => c.row))]
  assert.deepEqual(branchRows(bp), [3, 6])
  assert.equal(cells(bp).length, 16 + 2 * 2 * 8 * 2)
  assert.ok(bp.layers[0].every(r => r.length === 17))
  const segs = allSegments(bp)
  assert.equal(segs.length, 4)
  assert.deepEqual(segs.map(s => s.anchor.z), [200, 192, 184, 176])
  assert.deepEqual(branchRows(segs[1]), [1, 4, 7]) // global rows 9, 12, 15
  assertContinuous(segs)
  for (const s of segs) assert.deepEqual(validate(s, { streamed: true }), { ok: true, reason: null })
  assert.equal(nextSegment(segs[3]), null)
  // a short last segment keeps the full width, so its columns stay centred on the main tunnel
  const odd = allSegments(makeBlueprint('strip_mine', { len: 9, branch_every: 3, branch_len: 3 }, null, { anchor: A, facing: 'north' }))
  assert.equal(odd.length, 2)
  assert.ok(odd[1].layers.flat().every(r => r.length === 7))
  assert.ok(cells(odd[1]).every(c => c.pos.x === 100))
})

test('stairs_down_to from y 64 to y 40: 3 segments descending 8 levels each, the last ending at y 40', () => {
  const bp = makeBlueprint('stairs_down_to', { y: 40 }, null, { anchor: A, facing: 'west' })
  assert.equal(bp.segments, 3)
  const segs = allSegments(bp)
  assert.deepEqual(segs.map(s => s.anchor.y), [64, 56, 48])
  assert.deepEqual(segs.map(s => s.anchor.x), [100, 92, 84])
  for (const s of segs) {
    assert.equal(cells(s).length, 24)
    const ys = cells(s).map(c => c.pos.y)
    assert.equal(Math.min(...ys), s.anchor.y - 8)
    assert.deepEqual(validate(s, { streamed: true }), { ok: true, reason: null })
  }
  // walkable: each step has feet, head and the headroom cell above
  const first = new Set(cells(segs[0]).map(c => key(c.pos)))
  for (let k = 1; k <= 8; k++) for (let dy = 0; dy < 3; dy++) assert.ok(first.has(key({ x: 100 - k, y: 64 - k + dy, z: 200 })))
  assertContinuous(segs)
  // 20 levels: 8 + 8 + 4
  const short = allSegments(makeBlueprint('stairs_down_to', { y: 44 }, null, { anchor: A, facing: 'west' }))
  assert.deepEqual(short.map(s => cells(s).length), [24, 24, 12])
  assert.equal(Math.min(...cells(short[2]).map(c => c.pos.y)), 44)
})

test('stairs_up_to mirrors: up 8 per segment, ends with the feet at y', () => {
  const bp = makeBlueprint('stairs_up_to', { y: 74 }, null, { anchor: A, facing: 'south' })
  const segs = allSegments(bp)
  assert.deepEqual(segs.map(s => s.anchor.y), [64, 72])
  assert.deepEqual(segs.map(s => cells(s).length), [24, 6])
  const all = new Set(segs.flatMap(s => cells(s).map(c => key(c.pos))))
  for (let k = 1; k <= 10; k++) {
    assert.ok(all.has(key({ x: 100, y: 64 + k, z: 200 + k })), `feet ${k}`)
    assert.ok(all.has(key({ x: 100, y: 65 + k, z: 200 + k })), `head ${k}`)
    assert.ok(all.has(key({ x: 100, y: 65 + k, z: 199 + k })), `headroom ${k}`)
  }
  assertContinuous(segs)
  for (const s of segs) assert.deepEqual(validate(s, { streamed: true }), { ok: true, reason: null })
})

test('staircase_up(20) and staircase_down(20) stream in 8-step segments that stay connected', () => {
  for (const [name, p] of [['staircase_up', { height: 20 }], ['staircase_down', { depth: 20 }]]) {
    const segs = allSegments(makeBlueprint(name, p, 'cobblestone', { anchor: A, facing: 'east' }))
    assert.equal(segs.length, 3, name)
    assertContinuous(segs)
    for (const s of segs) assert.deepEqual(validate(s, { streamed: true }), { ok: true, reason: null }, `${name} ${s.segment}`)
    // every later segment is grounded on the previous segment's last step (the only connector)
    for (let i = 1; i < segs.length; i++) {
      const prev = new Set(placedCells(segs[i - 1]).map(c => key(c.pos)))
      assert.ok(segs[i].ground.every(g => prev.has(key(toWorld(segs[i], g)))), `${name} ${i} ground`)
    }
    const steps = name === 'staircase_up' ? 20 + 19 : 20 + 19
    assert.equal(segs.reduce((n, s) => n + placedCells(s).length, 0), steps)
  }
})

test('every streamed template: every segment validates (streamed) and stays within 8 blocks of main progress', () => {
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (!t.streamed) continue
    for (const pick of ['default', 'min', 'max']) {
      const params = Object.fromEntries(Object.entries(t.params).map(([k, s]) => [k, s[pick] ?? s.min]))
      if (name === 'stairs_down_to') params.y = pick === 'max' ? 63 : -58
      if (name === 'stairs_up_to') params.y = pick === 'max' ? 65 : 150
      const segs = allSegments(makeBlueprint(name, params, 'cobblestone', { anchor: A, facing: 'north' }))
      assert.ok(segs.length >= 1)
      for (const s of segs) {
        assert.deepEqual(validate(s, { streamed: true }), { ok: true, reason: null }, `${name} ${pick} ${s.segment}`)
        const rows = cells(s).map(c => c.row)
        assert.ok(Math.max(...rows) - Math.min(...rows) <= 8, `${name} ${pick} ${s.segment} rows`)
      }
      assertContinuous(segs)
    }
  }
})

test('turnSegment: the same segment turned 90 degrees right from its start; the stream continues the new way', () => {
  const bp = makeBlueprint('stairs_down_to', { y: 40 }, null, { anchor: A, facing: 'north' })
  const r = turnSegment(bp, 'right')
  assert.equal(r.facing, 'east')
  assert.deepEqual(r.anchor, A)
  assert.deepEqual(r.layers, bp.layers)
  assert.equal(turnSegment(bp, 'left').facing, 'west')
  const next = nextSegment(r)
  assert.deepEqual(next.anchor, { x: 108, y: 56, z: 200 })
  assert.equal(next.facing, 'east')
})

test('checkParams: defaults, clamping, rounding, rejections', () => {
  assert.deepEqual(checkParams('hut', {}), { ok: true, params: { w: 5, d: 5, h: 3, material: 'cobblestone' }, reason: null })
  assert.deepEqual(checkParams('hut', { w: 20, d: 2, h: '4', material: 'stone' }).params, { w: 9, d: 5, h: 4, material: 'stone' })
  assert.deepEqual(checkParams('tunnel', { len: 7.6 }).params, { len: 8, w: 1, h: 2 })
  assert.deepEqual(checkParams('room', { w: 3, colour: 'red' }).params, { w: 3, d: 3, h: 2 })
  assert.deepEqual(checkParams('stairs_down_to', { y: -100 }).params, { y: -58 })
  const no = (r, re) => { assert.equal(r.ok, false); assert.match(r.reason, re) }
  no(checkParams('castle', {}), /unknown template castle/)
  no(checkParams('stairs_down_to', {}), /needs y/)
  no(checkParams('stairs_up_to', {}), /needs y/)
  no(checkParams('stairs_down_to', { y: 70 }, { anchorY: 64 }), /below/)
  no(checkParams('stairs_down_to', { y: 64 }, { anchorY: 64 }), /below/)
  no(checkParams('stairs_up_to', { y: 12 }, { anchorY: 64 }), /above/)
  no(checkParams('hut', { w: 'big' }), /w must be a number/)
  no(checkParams('wall', { material: 'oak_door' }), /oak_door is not a placeable block/)
  assert.equal(checkParams('stairs_down_to', { y: 12 }, { anchorY: 64 }).ok, true)
  assert.throws(() => makeBlueprint('stairs_down_to', { y: 70 }, null, { anchor: A, facing: 'north' }), /below/)
  assert.throws(() => makeBlueprint('stairs_down_to', { y: 12 }, null), /anchor/)
  assert.throws(() => makeBlueprint('hut', {}, 'glass_pane'), /not a placeable block/)
})

test('makeBlueprint: fields for the runner; material defaults to cobblestone', () => {
  const bp = makeBlueprint('wall', {}, undefined, { anchor: A, facing: 'north', source: 'leader', title: 'a wall here' })
  assert.equal(bp.title, 'a wall here')
  assert.equal(bp.source, 'leader')
  assert.equal(bp.template, 'wall')
  assert.deepEqual(bp.params, { len: 5, h: 3, material: 'cobblestone' })
  assert.equal(bp.material, 'cobblestone')
  assert.deepEqual(bp.legend, { '#': 'cobblestone' })
  assert.equal(bp.segment, undefined)
  assert.equal(nextSegment(bp), null)
  const t = makeBlueprint('tunnel', {}, null, { anchor: A, facing: 'north' })
  assert.equal(t.material, null)
  assert.equal(typeof t.title, 'string')
})

test('describeTemplates: one line per template, hut first', () => {
  const lines = describeTemplates().split('\n')
  assert.equal(lines.length, 15)
  assert.equal(lines[0], 'hut(w 5-9 [5], d 5-9 [5], h 3-5 [3], material) build: a walled hut with a flat roof and a door gap')
  assert.match(lines.find(l => l.startsWith('stairs_down_to(')), /y -58\.\.319 required/)
  for (const [i, name] of Object.keys(TEMPLATES).entries()) assert.ok(lines[i].startsWith(`${name}(`))
})
