import test from 'node:test'
import assert from 'node:assert/strict'
import { BlueprintBook, bookAccessor, blueprintNumber } from '../agent/blueprint_book.js'
import { makeBlueprint } from '../agent/templates.js'
import { cells } from '../agent/blueprints.js'

const anchor = { x: 0, y: 64, z: 0 }
const k = p => `${p.x},${p.y},${p.z}`
// A fake world: explicit blocks by position over a default (ground below y 64: grass; above: air, or stone for digs).
function world ({ below = 'grass_block', above = 'air' } = {}) {
  const m = new Map()
  const blockAt = p => {
    if (m.has(k(p))) return m.get(k(p))
    const name = p.y < 64 ? below : above
    return name == null ? null : { name, boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block' }
  }
  const set = (p, name) => m.set(k(p), name == null ? null : { name, boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block' })
  return { blockAt, set }
}
const hut = () => makeBlueprint('hut', {}, 'cobblestone', { anchor, facing: 'north' })   // 4 layers, 100 cells, 71 blocks

test('add renders bp<n> ids; get, update, toJSON round trip', () => {
  const b = new BlueprintBook()
  const a = b.add(hut()), c = b.add(hut())
  assert.equal(a, 'bp1'); assert.equal(c, 'bp2')
  assert.equal(b.get('bp1').id, 'bp1'); assert.equal(b.get('bp1').template, 'hut')
  assert.equal(b.get('bp9'), null)
  assert.equal(blueprintNumber('bp12'), 12); assert.equal(blueprintNumber('portal_frame'), null)
  b.update('bp2', { ...hut(), title: 'renamed' })
  assert.equal(b.get('bp2').title, 'renamed'); assert.equal(b.get('bp2').id, 'bp2')
  assert.throws(() => b.update('bp7', hut()))
  const j = JSON.parse(JSON.stringify(b))
  assert.equal(j.next, 3); assert.deepEqual(Object.keys(j.blueprints), ['bp1', 'bp2'])
  const r = BlueprintBook.fromJSON(j)
  assert.equal(r.add(hut()), 'bp3'); assert.equal(r.get('bp2').title, 'renamed')
})

test('build progress over a fake world: empty, a finished layer, an unwanted block, foundation over a hole', () => {
  const b = new BlueprintBook(), id = b.add(hut()), w = world()
  assert.deepEqual(b.progress(id, w.blockAt), {
    kind: 'build', name: 'hut', done: 29, total: 100, missing: 71, blocked: 0, layer: 1, layers: 4, segment: 1, segments: 1,
    finished: false, blocksDone: 0, blocksTotal: 71, needs: { cobblestone: 71 }, layerNeeds: { cobblestone: 15 }, scaffoldLeft: 0,
  })
  const bp = b.get(id)
  for (const c of cells(bp)) if (c.layer === 0 && c.want !== 'air') w.set(c.pos, 'cobblestone')
  let p = b.progress(id, w.blockAt)
  assert.deepEqual([p.layer, p.blocksDone, p.missing, p.layerNeeds, p.needs], [2, 15, 56, { cobblestone: 15 }, { cobblestone: 56 }])
  const inside = cells(bp).find(c => c.layer === 0 && c.want === 'air' && c.row === 2)
  w.set(inside.pos, 'dirt')   // a solid block where air must be: work on layer 1 again, no material needed for it
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.layer, p.done, p.missing, p.layerNeeds], [1, 43, 57, {}])
  // a hole under two layer-0 cells of a fresh hut: one foundation block each while the cell above is not placed
  const id2 = b.add(hut()), w2 = world(), l0 = cells(b.get(id2)).filter(c => c.layer === 0 && c.want !== 'air')
  for (const c of l0.slice(0, 2)) w2.set({ ...c.pos, y: 63 }, 'air')
  p = b.progress(id2, w2.blockAt)
  assert.deepEqual([p.needs, p.layerNeeds], [{ cobblestone: 73 }, { cobblestone: 17 }])
  w2.set(l0[0].pos, 'cobblestone')
  assert.deepEqual(b.progress(id2, w2.blockAt).needs, { cobblestone: 71 })
  // complete: every cell as wanted
  for (const c of cells(bp)) w.set(c.pos, c.want)
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.finished, p.missing, p.layer, p.blocksDone, p.needs], [true, 0, 4, 71, {}])
})

test('an unloaded cell is blocked and keeps the build unfinished', () => {
  const b = new BlueprintBook(), id = b.add(hut()), w = world()
  for (const c of cells(b.get(id))) w.set(c.pos, c.want)
  const roof = cells(b.get(id)).find(c => c.layer === 3)
  w.set(roof.pos, null)
  const p = b.progress(id, w.blockAt)
  assert.deepEqual([p.missing, p.blocked, p.finished, p.blocksDone], [0, 1, false, 70])
})

test('dig progress: solid cells are the work, liquid cells are blocked and never remaining work', () => {
  const b = new BlueprintBook(), w = world({ above: 'stone', below: 'stone' })
  const id = b.add(makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, { anchor, facing: 'north' }))
  let p = b.progress(id, w.blockAt)
  assert.deepEqual(p, { kind: 'dig', name: 'room', done: 0, total: 18, missing: 18, blocked: 0, layer: 2, layers: 2, segment: 1, segments: 1, finished: false, tier: 1 })
  const cs = cells(b.get(id))
  w.set(cs[0].pos, 'water')
  for (const c of cs.slice(1)) w.set(c.pos, 'air')
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.done, p.missing, p.blocked, p.finished], [17, 0, 1, true])
})

test('streamed dig: not finished until the last segment; advance replaces the segment', () => {
  const b = new BlueprintBook(), w = world({ above: 'stone', below: 'stone' })
  const id = b.add(makeBlueprint('strip_mine', {}, null, { anchor, facing: 'north' }))
  for (const c of cells(b.get(id))) w.set(c.pos, 'air')
  let p = b.progress(id, w.blockAt)
  assert.deepEqual([p.segment, p.segments, p.missing, p.finished], [1, 4, 0, false])
  assert.equal(b.advance(id).segment, 1)
  assert.equal(b.get(id).segment, 1)
  assert.equal(b.progress(id, w.blockAt).segment, 2)
  b.advance(id); b.advance(id)
  assert.equal(b.advance(id), null, 'the last segment has no next')
  for (const c of cells(b.get(id))) w.set(c.pos, 'air')
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.segment, p.finished], [4, true])
  assert.equal(b.advance('bp99'), null)
})

test('the state line, exact strings', () => {
  const b = new BlueprintBook()
  b.add(hut()); b.add(hut()); b.add(hut())
  const id = b.add(hut())   // bp4
  const w = world()
  const bp = b.get(id)
  for (const c of cells(bp)) if (c.layer === 0 && c.want !== 'air') w.set(c.pos, 'cobblestone')
  const roof = cells(bp).filter(c => c.layer === 3)
  for (const c of roof.slice(0, 3)) w.set(c.pos, null)
  assert.equal(b.line(id, w.blockAt, { cobblestone: 41 }), 'building hut (#4): layer 2 of 4, 15 of 71 blocks, 3 unreachable, need 15 cobblestone')
  assert.equal(b.line(id, w.blockAt, { cobblestone: 64 }, { unreachable: 0 }), 'building hut (#4): layer 2 of 4, 15 of 71 blocks')
  const sm = b.add(makeBlueprint('strip_mine', {}, null, { anchor, facing: 'north' }))   // bp5
  const ws = world({ above: 'stone', below: 'stone' })
  const cs = cells(b.get(sm))
  for (const c of cs.slice(0, 22)) ws.set(c.pos, 'air')
  b.advance(sm); b.advance(sm)
  for (const c of cells(b.get(sm)).slice(0, 22)) ws.set(c.pos, 'air')
  assert.equal(b.line(sm, ws.blockAt, {}), `digging strip mine (#5): segment 3 of 4, 22 of ${cells(b.get(sm)).length} cells`)
  ws.set(cells(b.get(sm))[30].pos, 'lava')
  assert.match(b.line(sm, ws.blockAt, {}), /, 1 blocked$/)
  assert.equal(b.line('bp42', ws.blockAt, {}), null)
})

test('bookAccessor: get, progress with the surface flag, advance', () => {
  const b = new BlueprintBook(), id = b.add(hut()), w = world()
  const acc = bookAccessor(b, { blockAt: w.blockAt, isSurface: (bp, obs) => bp.anchor.y > 60 && !obs.underground })
  assert.equal(acc.get(id).template, 'hut')
  assert.equal(acc.progress(id, { underground: false }).surface, true)
  assert.equal(acc.progress(id, { underground: true }).surface, false)
  assert.equal(acc.progress('bp9', {}), null)
  assert.equal(acc.advance(id), null)
  assert.equal(bookAccessor(b, { blockAt: w.blockAt }).progress(id, {}).surface, false)
})

test('build progress: a liquid in an air cell, or in a block cell with nothing to place against, is blocked, not work', () => {
  const b = new BlueprintBook(), w = world()
  const id = b.add(makeBlueprint('floor', { w: 1, d: 1 }, 'cobblestone', { anchor, facing: 'north' }))
  const [cell] = cells(b.get(id))
  w.set(cell.pos, 'water')   // the ground below is a face: the water is displaced by placing
  let p = b.progress(id, w.blockAt)
  assert.deepEqual([p.missing, p.blocked, p.finished], [1, 0, false])
  w.set({ ...cell.pos, y: cell.pos.y - 1 }, 'water')   // nothing solid around it now
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.missing, p.blocked, p.finished], [0, 1, true])
  const hid = b.add(hut())
  const inside = cells(b.get(hid)).find(c => c.want === 'air' && c.layer === 0)
  w.set(inside.pos, 'water')
  p = b.progress(hid, w.blockAt)
  assert.equal(p.blocked, 1); assert.equal(p.missing, 71)
})

test('a build is not finished while its scaffold stands; the line says removing scaffold (n); the record round-trips', () => {
  const b = new BlueprintBook(), w = world()
  const id = b.add(makeBlueprint('floor', { w: 1, d: 1 }, 'cobblestone', { anchor, facing: 'north' }))
  for (const c of cells(b.get(id))) w.set(c.pos, 'cobblestone')
  assert.equal(b.progress(id, w.blockAt).finished, true)
  const s1 = { x: 3, y: 64, z: 0, item: 'dirt', layer: 0, segment: 0 }, s2 = { x: 3, y: 65, z: 0, item: 'dirt', layer: 0, segment: 0 }
  b.scaffold(id).push(s1, s2)
  w.set(s1, 'dirt'); w.set(s2, 'dirt')
  let p = b.progress(id, w.blockAt)
  assert.deepEqual([p.finished, p.scaffoldLeft, p.missing], [false, 2, 0])
  assert.match(b.line(id, w.blockAt, {}), /, removing scaffold \(2\)$/)
  assert.equal(bookAccessor(b, { blockAt: w.blockAt }).scaffold(id), b.scaffold(id))
  const r = BlueprintBook.fromJSON(JSON.parse(JSON.stringify(b)))
  assert.equal(r.progress(id, w.blockAt).scaffoldLeft, 2)
  w.set(s2, 'air')   // a block broken by someone else no longer counts
  assert.equal(b.progress(id, w.blockAt).scaffoldLeft, 1)
  w.set(s1, 'air')
  p = b.progress(id, w.blockAt)
  assert.deepEqual([p.finished, p.scaffoldLeft], [true, 0])
  assert.doesNotMatch(b.line(id, w.blockAt, {}), /scaffold/)
})

// Task 7 fix round 1: the pickaxe tier the remaining dig work needs (present only when above 0).
import { toolTierFor } from '../agent/blueprints.js'
test('toolTierFor and progress().tier: the pickaxe tier the solid cells still to dig need', () => {
  assert.deepEqual(['dirt', 'stone', 'deepslate', 'iron_ore', 'diamond_ore', 'obsidian', 'air', 'nope'].map(toolTierFor), [0, 1, 1, 2, 3, 4, 0, 0])
  const b = new BlueprintBook(), id = b.add(makeBlueprint('room', {}, null, { anchor, facing: 'north' }))
  const w = world({ below: 'stone', above: 'dirt' })
  assert.equal(b.progress(id, w.blockAt).tier, undefined, 'dirt only: no tier')
  const c = cells(b.get(id))
  w.set(c[0].pos, 'stone'); w.set(c[1].pos, 'iron_ore')
  assert.equal(b.progress(id, w.blockAt).tier, 2)
  const hb = b.add(hut()), hw = world()
  const inside = cells(b.get(hb)).find(x => x.layer === 0 && x.want === 'air' && x.row === 2)
  hw.set(inside.pos, 'stone')
  assert.equal(b.progress(hb, hw.blockAt).tier, 1, 'a build\'s wrong cells count too')
})
