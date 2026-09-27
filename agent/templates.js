// Templates (pure): parametric building and digging shapes that return blueprints in agent/blueprints.js's format
// (legend, layers bottom first, offset, baseLayer, ground). The runner fills in the anchor and facing.
//
// Local geometry, relative to the anchor (the requesting player's feet, floored): `row` runs away from the anchor
// along the facing, `col` to its right (centred), `layer` up from the anchor's feet (negative below). Builds start
// 2 rows out (offset 2) unless stated; digs start at the anchor itself (offset 0).
//
// Long shapes are streamed in segments of at most SEGMENT steps / blocks of main tunnel. A streamed blueprint carries
// { template, params, segment, segments, material }; nextSegment(bp) returns the next one, anchored so the band
// continues seamlessly (tunnel / strip_mine: forward SEGMENT; the staircases: forward SEGMENT and down/up SEGMENT).
// turnSegment(bp, 'right') re-orients a dig segment 90 degrees from its start (the executor's liquid turn); null for
// builds.
import { isPlaceable, materials } from './blueprints.js'

export const SEGMENT = 8
const DEFAULT_MATERIAL = 'cobblestone'
const FORWARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const TURN = {
  right: { north: 'east', east: 'south', south: 'west', west: 'north' },
  left: { north: 'west', west: 'south', south: 'east', east: 'north' },
}

// Lay a list of local cells { col, row, layer, ch } into a blueprint body. Every row is padded to `width` so the
// columns stay centred the same way in every segment; a block wins over '.' on the same cell.
function body (kind, list, { width, material = null, offset, ground = [], veins }) {
  const minL = Math.min(...list.map(c => c.layer))
  const maxL = Math.max(...list.map(c => c.layer))
  const depth = Math.max(...list.map(c => c.row)) + 1
  const grid = []
  for (let l = minL; l <= maxL; l++) grid.push(Array.from({ length: depth }, () => Array(width).fill(' ')))
  for (const c of list) {
    const line = grid[c.layer - minL][c.row]
    if (line[c.col] !== '#') line[c.col] = c.ch
  }
  const out = {
    kind,
    legend: kind === 'build' ? { '#': material } : {},
    layers: grid.map(rows => rows.map(r => r.join(''))),
    offset: offset ?? (kind === 'build' ? 2 : 0),
    baseLayer: minL,
    ground: ground.map(g => ({ col: g.col, row: g.row, layer: g.layer - minL })),
  }
  if (kind === 'dig') out.veins = !!veins
  return out
}

const cols = n => Array.from({ length: n }, (_, i) => i)

// ---- building

function hut ({ w, d, h }, material) {
  const list = []
  const door = Math.floor(w / 2)
  for (let layer = 0; layer < h; layer++) {
    for (let row = 0; row < d; row++) {
      for (let col = 0; col < w; col++) {
        const edge = row === 0 || row === d - 1 || col === 0 || col === w - 1
        const gap = row === 0 && col === door && layer < 2
        list.push({ col, row, layer, ch: edge && !gap ? '#' : '.' })
      }
    }
  }
  for (let row = 0; row < d; row++) for (let col = 0; col < w; col++) list.push({ col, row, layer: h, ch: '#' })
  return body('build', list, { width: w, material })
}

// A hollow square tower: one-block walls, open top, a 1x2 door gap in the near wall (the validator's door rule).
function tower ({ w, h }, material) {
  const list = []
  const door = Math.floor(w / 2)
  for (let layer = 0; layer < h; layer++) {
    for (let row = 0; row < w; row++) {
      for (let col = 0; col < w; col++) {
        const edge = row === 0 || row === w - 1 || col === 0 || col === w - 1
        const gap = row === 0 && col === door && layer < 2
        list.push({ col, row, layer, ch: edge && !gap ? '#' : '.' })
      }
    }
  }
  return body('build', list, { width: w, material })
}

function box (w, d, h, ch, layer0 = 0) {
  const list = []
  for (let layer = layer0; layer < layer0 + h; layer++) {
    for (let row = 0; row < d; row++) for (let col = 0; col < w; col++) list.push({ col, row, layer, ch })
  }
  return list
}

const wall = ({ len, h }, material) => body('build', box(len, 1, h, '#'), { width: len, material })
const floor = ({ w, d }, material) => body('build', box(w, d, 1, '#'), { width: w, material })
const pillar = ({ h }, material) => body('build', box(1, 1, h, '#'), { width: 1, material })

// A 1-wide walkway level with the block the anchor stands on, starting right in front of it (offset 1) and
// connected through that block (a ground cell).
function bridge ({ len }, material) {
  return body('build', box(1, len, 1, '#', -1), { width: 1, material, offset: 1, ground: [{ col: 0, row: -1, layer: -1 }] })
}

// Step k (local 0..n-1) at row k, layer k; a support beneath every step but the very first of the staircase;
// a 3-high clear column above it (layers k+1..k+3, so walkable both ways under an overhang). Later segments rest on the previous segment's last step (row -1, layer -1).
function staircaseUp ({ height, width }, i, material) {
  const n = Math.min(SEGMENT, height - SEGMENT * i)
  const list = []
  for (const col of cols(width)) {
    for (let k = 0; k < n; k++) {
      list.push({ col, row: k, layer: k, ch: '#' })
      if (k >= 1 || i >= 1) list.push({ col, row: k, layer: k - 1, ch: '#' })
      for (let dy = 1; dy <= 3; dy++) list.push({ col, row: k, layer: k + dy, ch: '.' })
    }
  }
  const ground = i >= 1 ? cols(width).map(col => ({ col, row: -1, layer: -1 })) : []
  return body('build', list, { width, material, ground })
}

// Step k (local 1..n) at row k, layer -k; its connector at row k-1, layer -k (under the previous step); a 3-high
// clear column above it (layers -k+1..-k+3). Segment 0's first connector is the block the anchor stands on (a ground
// cell, the centre column's only: side columns connect through step 1); a later segment's anchor is the previous
// segment's last step, which is its ground cell in every column.
function staircaseDown ({ depth, width }, i, material) {
  const n = Math.min(SEGMENT, depth - SEGMENT * i)
  const list = []
  for (const col of cols(width)) {
    for (let k = 1; k <= n; k++) {
      list.push({ col, row: k, layer: -k, ch: '#' })
      if (k >= 2 || i >= 1) list.push({ col, row: k - 1, layer: -k, ch: '#' })
      for (let dy = 1; dy <= 3; dy++) list.push({ col, row: k, layer: -k + dy, ch: '.' })
    }
  }
  const ground = i === 0 ? [{ col: Math.floor(width / 2), row: 0, layer: -1 }] : cols(width).map(col => ({ col, row: 0, layer: 0 }))
  return body('build', list, { width, material, offset: 0, ground })
}

// ---- digging

// A walkable 1-wide dug staircase of n steps. Down: step k at row k, feet at layer -k, cells feet / head / the
// headroom above (layers -k..-k+2). Up: feet at row k, layer k, cells feet and head, plus the headroom above the
// previous position (row k-1, layer k+1) so the bot can jump up.
function digStairs (n, dir) {
  const list = []
  for (let k = 1; k <= n; k++) {
    if (dir === 'down') for (let dy = 0; dy < 3; dy++) list.push({ col: 0, row: k, layer: -k + dy, ch: '.' })
    else list.push({ col: 0, row: k, layer: k, ch: '.' }, { col: 0, row: k, layer: k + 1, ch: '.' }, { col: 0, row: k - 1, layer: k + 1, ch: '.' })
  }
  return body('dig', list, { width: 1 })
}

const room = ({ w, d, h }) => body('dig', box(w, d, h, '.'), { width: w })
const pit = ({ w, d, depth }) => body('dig', box(w, d, depth, '.', -depth), { width: w })

function tunnelSeg ({ len, w, h }, i) {
  const rows = Math.min(SEGMENT, len - SEGMENT * i)
  return body('dig', box(w, rows, h, '.'), { width: w, veins: true })
}

// A 1x2 main tunnel along the rows (column branch_len of a 2 * branch_len + 1 wide band), with 1x2 branches to both
// sides at every global row that is a positive multiple of branch_every.
function stripSeg ({ len, branch_every: every, branch_len: blen }, i) {
  const width = 2 * blen + 1
  const rows = Math.min(SEGMENT, len - SEGMENT * i)
  const list = []
  for (let row = 0; row < rows; row++) {
    const global = SEGMENT * i + row
    const branch = global > 0 && global % every === 0
    for (let col = 0; col < width; col++) {
      if (col !== blen && !branch) continue
      list.push({ col, row, layer: 0, ch: '.' }, { col, row, layer: 1, ch: '.' })
    }
  }
  return body('dig', list, { width, veins: true })
}

const levelsTo = (y, anchorY) => Math.abs(anchorY - y)

// ---- the table

const P = (min, max, def) => ({ min, max, default: def })
const Y = { min: -58, max: 319, required: true }
const segmentsOf = (steps) => Math.ceil(steps / SEGMENT)

export const TEMPLATES = {
  hut: { kind: 'build', params: { w: P(5, 9, 5), d: P(5, 9, 5), h: P(3, 5, 3) }, material: true, streamed: false, about: 'a walled hut with a flat roof and a door gap', make: hut },
  wall: { kind: 'build', params: { len: P(1, 9, 5), h: P(1, 5, 3) }, material: true, streamed: false, about: 'a straight wall across your view', make: wall },
  floor: { kind: 'build', params: { w: P(1, 9, 5), d: P(1, 9, 5) }, material: true, streamed: false, about: 'a flat platform one block thick', make: floor },
  tower: { kind: 'build', params: { w: P(3, 5, 3), h: P(3, 9, 6) }, material: true, streamed: false, about: 'a hollow square tower with a door gap and an open top', make: tower },
  pillar: { kind: 'build', params: { h: P(1, 9, 5) }, material: true, streamed: false, about: 'a 1x1 column', make: pillar },
  bridge: { kind: 'build', params: { len: P(2, 9, 8) }, material: true, streamed: false, about: 'a 1-wide walkway straight ahead, level with the ground you stand on', make: bridge },
  staircase_up: {
    kind: 'build', params: { height: P(1, 24, 6), width: P(1, 3, 1) }, material: true, streamed: true, shift: 1,
    about: 'free-standing stairs rising away from you, one block up per block forward',
    segment: (p, i, material) => staircaseUp(p, i, material), count: p => segmentsOf(p.height),
  },
  staircase_down: {
    kind: 'build', params: { depth: P(1, 24, 6), width: P(1, 3, 1) }, material: true, streamed: true, shift: -1,
    about: 'free-standing stairs descending into open air from the edge you stand on',
    segment: (p, i, material) => staircaseDown(p, i, material), count: p => segmentsOf(p.depth),
  },
  room: { kind: 'dig', params: { w: P(1, 9, 3), d: P(1, 9, 3), h: P(2, 5, 2) }, material: false, streamed: false, about: 'dig out a box starting where you stand, at your feet level', make: room },
  tunnel: {
    kind: 'dig', params: { len: P(1, 64, 16), w: P(1, 3, 1), h: P(2, 3, 2) }, material: false, streamed: true, shift: 0,
    about: 'dig straight ahead, mining ores seen in the walls', segment: (p, i) => tunnelSeg(p, i), count: p => segmentsOf(p.len),
  },
  strip_mine: {
    kind: 'dig', params: { len: P(8, 64, 32), branch_every: P(2, 4, 3), branch_len: P(2, 12, 8) }, material: false, streamed: true, shift: 0,
    about: 'a 1x2 main tunnel with side branches both ways, mining ores seen in the walls', segment: (p, i) => stripSeg(p, i), count: p => segmentsOf(p.len),
  },
  stairs_down_to: {
    kind: 'dig', params: { y: Y }, material: false, streamed: true, shift: -1, needsAnchor: 'below',
    about: 'a walkable dug staircase down to level y',
    segment: (p, i, _m, { anchorY }) => digStairs(Math.min(SEGMENT, levelsTo(p.y, anchorY)), 'down'),
    count: (p, { anchorY }) => segmentsOf(levelsTo(p.y, anchorY)),
  },
  stairs_up_to: {
    kind: 'dig', params: { y: Y }, material: false, streamed: true, shift: 1, needsAnchor: 'above',
    about: 'a walkable dug staircase up to level y',
    segment: (p, i, _m, { anchorY }) => digStairs(Math.min(SEGMENT, levelsTo(p.y, anchorY)), 'up'),
    count: (p, { anchorY }) => segmentsOf(levelsTo(p.y, anchorY)),
  },
  shaft_down: {
    kind: 'dig', params: { depth: P(1, 16, 10) }, material: false, streamed: true, shift: -1,
    about: 'a short 1x2 dug staircase down by depth blocks',
    segment: (p, i) => digStairs(Math.min(SEGMENT, p.depth - SEGMENT * i), 'down'), count: p => segmentsOf(p.depth),
  },
  pit: { kind: 'dig', params: { w: P(1, 5, 3), d: P(1, 5, 3), depth: P(1, 5, 3) }, material: false, streamed: false, about: 'dig a hole down from the block you stand on', make: pit },
}
for (const t of Object.values(TEMPLATES)) {
  if (t.streamed) t.make = (p, material, ctx = {}) => t.segment(p, 0, material, ctx)
}

const ok = params => ({ ok: true, params, reason: null })
const no = reason => ({ ok: false, params: null, reason })

// Defaults missing params, rounds and clamps numbers into range, drops unknown keys, checks the material (templates
// with one; default cobblestone) and, when the anchor's y is known, that a stairs target lies below / above it.
export function checkParams (name, params = {}, { anchorY } = {}) {
  const t = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : null
  if (!t) return no(`unknown template ${name}`)
  const out = {}
  const raw = {}
  for (const [k, spec] of Object.entries(t.params)) {
    const v = params?.[k]
    if (v == null || v === '') {
      if (spec.required) return no(`${name} needs ${k}`)
      out[k] = spec.default
      continue
    }
    const n = Number(v)
    if (typeof v === 'boolean' || !Number.isFinite(n)) return no(`${k} must be a number`)
    raw[k] = Math.round(n)
    out[k] = Math.min(spec.max, Math.max(spec.min, raw[k]))
  }
  if (t.material) {
    const m = params?.material ?? DEFAULT_MATERIAL
    if (!isPlaceable(m)) return no(`${m} is not a placeable block`)
    out.material = m
  }
  if (t.needsAnchor && anchorY != null) {
    const y = raw.y ?? out.y   // the requested y, before clamping, so the message names it
    if (t.needsAnchor === 'below' && y >= anchorY) return no(`y ${y} is not below the start (y ${anchorY})`)
    if (t.needsAnchor === 'above' && y <= anchorY) return no(`y ${y} is not above the start (y ${anchorY})`)
  }
  return ok(out)
}

function titleOf (name, p) {
  const nums = Object.keys(TEMPLATES[name].params).map(k => `${k} ${p[k]}`).join(' ')
  return `${name} ${nums}${p.material ? ` of ${p.material}` : ''}`
}

export function makeBlueprint (name, params, material, { anchor, facing, source, title } = {}) {
  const t = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : null
  if (!t) throw new Error(`unknown template ${name}`)
  const given = t.material && material != null ? { ...params, material } : params
  const chk = checkParams(name, given, { anchorY: anchor?.y })
  if (!chk.ok) throw new Error(chk.reason)
  if (t.needsAnchor && !anchor) throw new Error(`${name} needs an anchor (its segment count depends on the start y)`)
  const p = chk.params
  const mat = t.material ? p.material : null
  const ctx = { anchorY: anchor?.y }
  const bp = {
    id: name, title: title ?? titleOf(name, p), source: source ?? 'template',
    ...t.make(p, mat, ctx), anchor, facing, template: name, params: p, material: mat,
  }
  if (t.streamed) Object.assign(bp, { segment: 0, segments: t.count(p, ctx) })
  return bp
}

// The next segment of a streamed blueprint, or null when it was the last (or the blueprint is not streamed).
export function nextSegment (bp) {
  const t = bp?.template && Object.hasOwn(TEMPLATES, bp.template) ? TEMPLATES[bp.template] : null
  if (!t?.streamed || bp.segment == null) return null
  const i = bp.segment + 1
  if (bp.segments != null && i >= bp.segments) return null
  const f = FORWARD[bp.facing]
  if (!f || !bp.anchor) throw new Error('a streamed blueprint needs its anchor and facing to continue')
  const anchor = { x: bp.anchor.x + f[0] * SEGMENT, y: bp.anchor.y + t.shift * SEGMENT, z: bp.anchor.z + f[1] * SEGMENT }
  return { ...bp, ...t.segment(bp.params, i, bp.material, { anchorY: anchor.y }), anchor, segment: i }
}

// The materials a whole template takes: every segment of a streamed build (not only the one the blueprint holds), the
// one body otherwise; {} for digs. Params are checked (defaults, clamps) as makeBlueprint does. Pure.
export function templateMaterials (name, params, material) {
  const t = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : null
  if (!t) throw new Error(`unknown template ${name}`)
  if (t.kind !== 'build') return {}
  const chk = checkParams(name, t.material && material != null ? { ...params, material } : params)
  if (!chk.ok) throw new Error(chk.reason)
  const p = chk.params
  const mat = t.material ? p.material : null
  const out = {}
  const n = t.streamed ? t.count(p, {}) : 1
  for (let i = 0; i < n; i++) {
    const body = t.streamed ? t.segment(p, i, mat, {}) : t.make(p, mat, {})
    for (const [item, c] of Object.entries(materials(body))) out[item] = (out[item] ?? 0) + c
  }
  return out
}

// The same segment turned 90 degrees ('right' or 'left') about its anchor; the stream continues in the new facing.
// Dig streams only (tunnel, strip_mine, stairs_down_to, stairs_up_to, shaft_down): a build segment's ground cells
// point at the previous segment's blocks, which a turn would move into air, so builds are refused with null.
export function turnSegment (bp, dir = 'right') {
  if (bp.kind === 'build' || (bp.template && TEMPLATES[bp.template]?.kind === 'build')) return null
  const to = TURN[dir]?.[bp.facing]
  if (!to) throw new Error(`cannot turn ${dir} from facing ${bp.facing}`)
  return { ...bp, facing: to }
}

function range (spec) {
  const r = spec.min < 0 || spec.max < 0 ? `${spec.min}..${spec.max}` : `${spec.min}-${spec.max}`
  return spec.required ? `${r} required` : `${r} [${spec.default}]`
}

// One line per template for the leader prompt: name(param range [default], ..., material) kind: what it is.
export function describeTemplates () {
  return Object.entries(TEMPLATES).map(([name, t]) => {
    const ps = Object.entries(t.params).map(([k, s]) => `${k} ${range(s)}`)
    if (t.material) ps.push('material')
    return `${name}(${ps.join(', ')}) ${t.kind}: ${t.about}${t.streamed ? ' (streamed in segments of 8)' : ''}`
  }).join('\n')
}
