// Blueprints (pure): one format for building and digging, its world transform, diff against the world, material
// counts, validation and a 9x9 ASCII cut. No Mineflayer here: the world is read through an injected
// blockAt(pos) -> { name, boundingBox } | null (null = not loaded).
//
// Format:
//   { id, kind: 'build' | 'dig', legend: { '#': 'cobblestone', ... },
//     layers: [ [row0, row1, ...], ... ],   // bottom layer first; row 0 nearest the anchor; columns left to right
//     anchor: { x, y, z }, facing: 'north' | 'east' | 'south' | 'west', title, source,
//     offset,      // rows start `offset` blocks in front of the anchor (default 2 for build, 0 for dig)
//     baseLayer,   // added to the layer index for world y (default 0; negative for shapes hanging below the anchor)
//     ground }     // [{ col, row, layer }] existing world blocks acting as connectors (not placed, not counted)
// Characters: a legend key = that block must be there; '.' = must be air; ' ' = don't care.
// Local coordinates: `layer` is always the array index (world y = anchor.y + baseLayer + layer); `ground` cells use
// the same local coordinates and may lie outside the arrays (a negative row, a layer below 0).
//
// Transform: row increases away from the anchor in the facing direction; col increases to the anchor's right when
// looking along the facing; columns are centred on the anchor (col - floor(width / 2)).
import mcDataFor from 'minecraft-data'

const md = mcDataFor('1.20.4')

export const FACINGS = ['north', 'east', 'south', 'west']

// Forward and right unit vectors (x, z) per facing. North is -z, east +x (Minecraft's axes).
const FORWARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const RIGHT = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }

// Mineflayer yaw convention, confirmed in node_modules/mineflayer/lib/plugins/physics.js, bot.lookAt:
//   yaw = Math.atan2(-delta.x, -delta.z)
// so looking toward -z (north) is yaw 0, toward -x (west) is pi/2, toward +z (south) is pi, toward +x (east) is
// -pi/2 (= 3pi/2): yaw increases counter-clockwise seen from above. (lib/conversions.js: yaw = PI - notchianYaw.)
const BY_QUARTER = ['north', 'west', 'south', 'east']
export function facingFromYaw (yaw) {
  const q = Math.round(yaw / (Math.PI / 2))
  return BY_QUARTER[((q % 4) + 4) % 4]
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIQUID = new Set(['water', 'lava', 'bubble_column'])

function offsetOf (bp) { return bp.offset ?? (bp.kind === 'build' ? 2 : 0) }
function widthOf (bp) {
  let w = 0
  for (const layer of bp.layers) for (const row of layer) w = Math.max(w, row.length)
  return w
}
function depthOf (bp) { return Math.max(0, ...bp.layers.map(l => l.length)) }

export function toWorld (bp, { col, row, layer }) {
  const f = FORWARD[bp.facing]
  const r = RIGHT[bp.facing]
  if (!f) throw new Error(`blueprint facing ${bp.facing} is not one of ${FACINGS.join(', ')}`)
  if (!bp.anchor) throw new Error('blueprint has no anchor')
  const fwd = row + offsetOf(bp)
  const side = col - Math.floor(widthOf(bp) / 2)
  return {
    x: bp.anchor.x + f[0] * fwd + r[0] * side,
    y: bp.anchor.y + (bp.baseLayer ?? 0) + layer,
    z: bp.anchor.z + f[1] * fwd + r[1] * side,
  }
}

// Every cell that is not a space, in order layer, row, col. Throws on a character that is neither a legend key,
// '.' nor ' ' (validate reports it as a reason first). `pos` only when the blueprint has an anchor and facing.
export function cells (bp) {
  const out = []
  const placedIn = bp.anchor && FORWARD[bp.facing]
  bp.layers.forEach((rows, layer) => rows.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (ch === ' ') continue
      if (ch !== '.' && !Object.hasOwn(bp.legend ?? {}, ch)) throw new Error(`unknown legend character "${ch}"`)
      const want = ch === '.' ? 'air' : bp.legend[ch]
      const c = { col, row, layer }
      out.push(placedIn ? { ...c, pos: toWorld(bp, c), want } : { ...c, want })
    }
  }))
  return out
}

const placed = c => c.want && c.want !== 'air'

// The item that places a block: the same-name item, with a few blocks whose item differs.
const ITEM_OF = { grass_block: 'dirt', dirt_path: 'dirt', farmland: 'dirt', mycelium: 'dirt', podzol: 'dirt' }
export function itemForBlock (block) {
  if (ITEM_OF[block]) return ITEM_OF[block]
  if (AIR.has(block) || LIQUID.has(block)) return null
  return md.itemsByName[block] ? block : null
}

// Build only (dig -> {}). Foundation blocks depend on the world and are not counted here (see foundation()).
export function materials (bp) {
  const out = {}
  if (bp.kind !== 'build') return out
  for (const c of cells(bp)) {
    if (!placed(c)) continue
    const item = itemForBlock(c.want) ?? c.want
    out[item] = (out[item] ?? 0) + 1
  }
  return out
}

// Classify every cell against the world. done + missing + wrong + blocked = total; the blueprint is finished when
// done === total (for a dig blueprint the remaining work is in `wrong`, not `missing`).
//   want a block: the same name -> done; air or a non-solid replaceable (grass, flowers, water) -> missing;
//                 another solid block -> wrong (dig it first)
//   want air:     air or a non-solid non-liquid block (grass, a torch) -> done; a solid block or a liquid -> wrong
//   unloaded (blockAt null) -> blocked
function classify (c, b) {
  if (!b) return 'blocked'
  if (c.want === 'air') {
    if (AIR.has(b.name)) return 'done'
    if (b.boundingBox !== 'block' && !LIQUID.has(b.name)) return 'done'
    return 'wrong'
  }
  if (b.name === c.want) return 'done'
  if (AIR.has(b.name) || b.boundingBox !== 'block') return 'missing'
  return 'wrong'
}

export function diff (bp, blockAt) {
  const out = { total: 0, done: 0, missing: [], blocked: [], wrong: [] }
  for (const c of cells(bp)) {
    out.total++
    const k = classify(c, blockAt(c.pos))
    if (k === 'done') out.done++
    else out[k].push(c)
  }
  return out
}

// A build cell holding a liquid the executor leaves alone: a liquid in a cell the build wants as air, or in a cell it
// wants as a block with no solid neighbour to place against (placing the block into the liquid displaces it; with
// nothing to place against there is nothing to do). Such cells are blocked, never remaining work, and never keep a
// build unfinished (agent/blueprint_book.js progress, agent/plugins/build_blueprint.mjs).
const FACE_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
export function liquidBlocked (c, blockAt) {
  const b = blockAt(c.pos)
  if (!b || !LIQUID.has(b.name)) return false
  if (c.want === 'air') return true
  return !FACE_DIRS.some(([dx, dy, dz]) => blockAt({ x: c.pos.x + dx, y: c.pos.y + dy, z: c.pos.z + dz })?.boundingBox === 'block')
}

// Layer-0 build cells (array index 0 of a blueprint with baseLayer 0) whose block below is air, a liquid or another
// non-solid block: one foundation block under each, of the cell's own material. Returns [{ x, y, z, want }].
export function foundation (bp, blockAt) {
  if (bp.kind !== 'build' || (bp.baseLayer ?? 0) !== 0) return []
  const out = []
  for (const c of cells(bp)) {
    if (c.layer !== 0 || !placed(c)) continue
    const below = { x: c.pos.x, y: c.pos.y - 1, z: c.pos.z }
    const b = blockAt(below)
    if (b && b.boundingBox !== 'block') out.push({ ...below, want: c.want })
  }
  return out
}

// Full, orientation-free cubes only this round. A block is placeable when minecraft-data 1.20.4 says its collision
// shape is exactly one full cube in every state (blockCollisionShapes; this refuses chests, cauldrons, campfires,
// anvils, lanterns, honey, dirt paths, soul sand...), it has a same-name item, and its name is not denied (blocks with
// orientation or state, and full-cube blocks with special behaviour: slime, beacon, ...).
const DENY = [
  /door/, /(^|_)bed$/, /stairs/, /slab/, /torch/, /pane/, /fence/, /sign/, /wall_/, /_wall$/, /button/,
  /pressure_plate/, /lever/, /carpet/, /rail/, /ladder/, /vine/, /flower_pot/, /^potted_/,
  /^water$/, /^lava$/, /air$/,
  /cauldron/, /campfire/, /anvil/, /lantern/, /dripleaf/, /head$/, /skull/, /candle/, /banner/, /coral/,
  /^chain$/, /^composter$/, /^beacon$/, /^conduit$/, /^scaffolding$/, /^honey_block$/, /^slime_block$/,
  /^turtle_egg$/, /^sea_pickle$/, /^pointed_dripstone$/, /^bell$/, /^lectern$/, /^grindstone$/, /^stonecutter$/,
  /^enchanting_table$/, /^brewing_stand$/, /^end_rod$/, /^lightning_rod$/, /^hopper$/, /^daylight_detector$/, /^cake$/,
]
const SHAPES = md.blockCollisionShapes
function fullCubeInEveryState (name) {
  const ids = SHAPES?.blocks?.[name]
  if (ids == null) return false
  return [].concat(ids).every(id => {
    const shape = SHAPES.shapes[id]
    return shape?.length === 1 && shape[0].join(',') === '0,0,0,1,1,1'
  })
}
export function isPlaceable (name) {
  const block = md.blocksByName[name]
  if (!block || block.boundingBox !== 'block') return false
  if (!md.itemsByName[name]) return false
  if (!fullCubeInEveryState(name)) return false
  return !DENY.some(re => re.test(name))
}

const OK = { ok: true, reason: null }
const fail = reason => ({ ok: false, reason })
const k3 = (col, row, layer) => `${col},${row},${layer}`
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

export function validate (bp, { maxSize = 9, maxBlocks = 150, placeable = isPlaceable, streamed = false } = {}) {
  if (bp.kind !== 'build' && bp.kind !== 'dig') return fail(`unknown kind ${bp.kind}`)
  if (!Array.isArray(bp.layers) || bp.layers.length === 0) return fail('no layers')
  if (!bp.layers.every(l => Array.isArray(l) && l.every(r => typeof r === 'string'))) return fail('layers must be arrays of strings')
  if (bp.facing != null && !FORWARD[bp.facing]) return fail(`unknown facing ${bp.facing}`)
  const legend = bp.legend ?? {}
  for (const ch of Object.keys(legend)) {
    if (ch.length !== 1 || ch === '.' || ch === ' ') return fail(`bad legend key "${ch}"`)
  }
  const w = widthOf(bp)
  const d = depthOf(bp)
  const h = bp.layers.length
  if (!streamed && (w > maxSize || d > maxSize || h > maxSize)) return fail(`too big: ${w}x${d}x${h} (max ${maxSize})`)
  for (const rows of bp.layers) {
    for (const line of rows) {
      for (const ch of line) if (ch !== ' ' && ch !== '.' && !Object.hasOwn(legend, ch)) return fail(`unknown legend character "${ch}"`)
    }
  }
  const cs = cells(bp)
  const blocks = cs.filter(placed)
  if (!streamed && blocks.length > maxBlocks) return fail(`too many blocks: ${blocks.length} (max ${maxBlocks})`)
  const used = new Set(blocks.map(c => c.want))
  for (const name of used) if (!placeable(name)) return fail(`${name} is not a placeable block`)
  if (bp.kind !== 'build') return OK

  // Connectivity: BFS by face adjacency over placed cells, seeded by layer-0 cells (they rest on the ground or a
  // foundation block; only when baseLayer is 0) and by every placed cell adjacent to a `ground` connector.
  const at = new Map(blocks.map(c => [k3(c.col, c.row, c.layer), c]))
  const seen = new Set()
  const queue = []
  const seed = c => { const k = k3(c.col, c.row, c.layer); if (!seen.has(k)) { seen.add(k); queue.push(c) } }
  if ((bp.baseLayer ?? 0) === 0) for (const c of blocks) if (c.layer === 0) seed(c)
  for (const g of bp.ground ?? []) {
    for (const [dc, dr, dl] of NEIGHBOURS) {
      const c = at.get(k3(g.col + dc, g.row + dr, g.layer + dl))
      if (c) seed(c)
    }
  }
  while (queue.length) {
    const c = queue.shift()
    for (const [dc, dr, dl] of NEIGHBOURS) {
      const n = at.get(k3(c.col + dc, c.row + dr, c.layer + dl))
      if (n) seed(n)
    }
  }
  const floating = blocks.find(c => !seen.has(k3(c.col, c.row, c.layer)))
  if (floating) return fail(`floating block at layer ${floating.layer} row ${floating.row} col ${floating.col}`)

  // Door rule: a shape at least 3x3 and 2 layers high with open space inside (layer 0 or 1) whose outer ring blocks
  // every entry needs a door gap. A ring position is a way in when layers 0 and 1 are both open, or when layer 0 is
  // placed and layers 1 and 2 are open (a step up; a layer above the top counts as open).
  if (w >= 3 && d >= 3 && h >= 2) {
    const isPlaced = (col, row, layer) => at.has(k3(col, row, layer))
    let interiorOpen = false
    for (let row = 1; row < d - 1 && !interiorOpen; row++) {
      for (let col = 1; col < w - 1; col++) {
        if (!isPlaced(col, row, 0) || !isPlaced(col, row, 1)) { interiorOpen = true; break }
      }
    }
    if (interiorOpen) {
      const ring = []
      for (let col = 0; col < w; col++) ring.push([col, 0], [col, d - 1])
      for (let row = 1; row < d - 1; row++) ring.push([0, row], [w - 1, row])
      const wayIn = ring.some(([col, row]) =>
        (!isPlaced(col, row, 0) && !isPlaced(col, row, 1)) ||
        (isPlaced(col, row, 0) && !isPlaced(col, row, 1) && !isPlaced(col, row, 2)))
      if (!wayIn) return fail('no way in (needs a door gap)')
    }
  }
  return OK
}

// A 9x9 ASCII cut of one layer around the blueprint's centre (col floor(w/2), row floor(d/2)), in blueprint-local
// view: the farthest row on top, columns left to right as seen looking along the facing. Characters:
//   '#' block placed ok, 'o' block missing, 'x' wrong or unloaded, '.' dig cell still solid, ' ' dug / air ok / no
//   cell, '@' the bot (its column, feet on this layer or one above).
export function layerCut (bp, layer, blockAt, botPos) {
  const cc = Math.floor(widthOf(bp) / 2)
  const rc = Math.floor(depthOf(bp) / 2)
  const byLocal = new Map(cells(bp).filter(c => c.layer === layer).map(c => [`${c.col},${c.row}`, c]))
  const bot = botPos && { x: Math.floor(botPos.x), y: Math.floor(botPos.y), z: Math.floor(botPos.z) }
  const lines = []
  for (let row = rc + 4; row >= rc - 4; row--) {
    let line = ''
    for (let col = cc - 4; col <= cc + 4; col++) {
      const pos = toWorld(bp, { col, row, layer })
      if (bot && bot.x === pos.x && bot.z === pos.z && (bot.y === pos.y || bot.y === pos.y + 1)) { line += '@'; continue }
      const c = byLocal.get(`${col},${row}`)
      if (!c) { line += ' '; continue }
      const k = classify(c, blockAt(c.pos))
      if (c.want === 'air') line += k === 'done' ? ' ' : k === 'blocked' ? 'x' : '.'
      else line += k === 'done' ? '#' : k === 'missing' ? 'o' : 'x'
    }
    lines.push(line)
  }
  return lines
}
