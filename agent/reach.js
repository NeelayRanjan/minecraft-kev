// Reach geometry for building (pure): where the bot can stand to place a block into a cell (or dig one), the order a
// blueprint's cells are worked in, which cells a body occupies, which held block may serve as scaffolding, and where a
// scaffold column lets the bot reach a cell no standing spot reaches. No Mineflayer here: positions are plain
// { x, y, z } block coordinates and the world is read through an injected blockAt(pos) -> { name, boundingBox } | null
// (null = not loaded), as in agent/blueprints.js. motor.js's reachSpot / placeCell / scaffoldTo / removeScaffold and
// agent/plugins/build_blueprint.mjs are the Mineflayer side.
//
// Rules:
//   reach      the eye (feet + 1.62, cell centre) within 4.5 blocks of the target face's centre (place) or the target
//              block's centre (dig)
//   standing   a solid block below, air (or a non-solid, non-liquid block) at feet and head; neither the feet nor the
//              head cell is the target or in `avoid` (the blueprint cells still to place or dig; a done cell of the
//              build, a step or a lower layer, is fine to stand in or on)
//   sight      a face counts as seen when the eye is on its outer side and a block-step ray (0.05 m) from the eye to
//              the face centre crosses no solid block; spots with a seen face rank first, a spot whose faces are all
//              hidden (placing through a block, which the 1.20.4 server accepts) only after every seen one
//   ranking    by a path estimate from the bot's feet: horizontal distance + 2 per block up + 1 per block down
import { isLiquidBlock, isPlaceable } from './blueprints.js'

export const REACH = 4.5
export const EYE = 1.62
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|_concrete_powder$/
// Full cubes that are stations, containers or valuables: never spent as scaffolding.
const SCAFFOLD_DENY = /^(crafting_table|furnace|blast_furnace|smoker|barrel|chest|trapped_chest|jukebox|note_block|tnt|obsidian|crying_obsidian|bookshelf|dispenser|dropper|observer|piston|sticky_piston|target|spawner)$|_ore$|^(raw_)?(iron|gold|diamond|emerald|copper|lapis|redstone|netherite|coal)_block$|shulker_box$/
export const SCAFFOLD_FIRST = ['dirt', 'cobblestone']

export const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
export const key = p => `${p.x},${p.y},${p.z}`
export const at = (p, dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz })
export const isSolid = b => !!b && b.boundingBox === 'block'
export const isLiquid = isLiquidBlock   // water, lava, bubble columns, underwater plants, waterlogged blocks
const isClear = b => !!b && b.boundingBox !== 'block' && !isLiquidBlock(b)
export const eyeOf = feet => ({ x: feet.x + 0.5, y: feet.y + EYE, z: feet.z + 0.5 })
const centre = p => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export function standable (blockAt, feet) {
  return isSolid(blockAt(at(feet, 0, -1, 0))) && isClear(blockAt(feet)) && isClear(blockAt(at(feet, 0, 1, 0)))
}

// The solid neighbours of `target` a block can be placed against: { ref, dir, point } with dir = target - ref (the
// face vector mineflayer's placeBlock takes) and point the centre of the shared face.
export function faces (target, blockAt) {
  const out = []
  for (const d of FACES) {
    const ref = at(target, ...d)
    if (!isSolid(blockAt(ref))) continue
    out.push({ ref, dir: d.map(v => v === 0 ? 0 : -v), point: { x: target.x + 0.5 + d[0] * 0.5, y: target.y + 0.5 + d[1] * 0.5, z: target.z + 0.5 + d[2] * 0.5 } })
  }
  return out
}

// True when the segment from -> to crosses no solid block, the cells in `ignore` (keys) excepted. The end point itself
// is not sampled (it lies on a face, in the block behind it).
export function lineOfSight (blockAt, from, to, ignore = new Set()) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const n = Math.max(1, Math.ceil(Math.hypot(d.x, d.y, d.z) / 0.05))
  for (let i = 1; i < n; i++) {
    const c = { x: Math.floor(from.x + d.x * i / n), y: Math.floor(from.y + d.y * i / n), z: Math.floor(from.z + d.z * i / n) }
    if (ignore.has(key(c))) continue
    if (isSolid(blockAt(c))) return false
  }
  return true
}

// Whether the eye sees the face (on its outer side, nothing solid in between).
export function seesFace (blockAt, eye, target, face) {
  const out = (eye.x - face.point.x) * face.dir[0] + (eye.y - face.point.y) * face.dir[1] + (eye.z - face.point.z) * face.dir[2]
  return out > 0.01 && lineOfSight(blockAt, eye, face.point, new Set([key(target), key(face.ref)]))
}

export function pathCost (from, feet) {
  if (!from) return 0
  const dy = feet.y - from.y
  return Math.hypot(feet.x - from.x, feet.z - from.z) + (dy > 0 ? 2 * dy : -dy)
}

// The best face of `target` from an eye: a seen one within reach (nearest), else the nearest hidden one within reach
// when `blind`, else null. { face, seen, d }.
export function bestFace (blockAt, eye, target, { reach = REACH, blind = true, list = faces(target, blockAt) } = {}) {
  let best = null
  for (const f of list) {
    const d = dist(eye, f.point)
    if (d > reach) continue
    const seen = seesFace(blockAt, eye, target, f)
    if (!seen && !blind) continue
    if (!best || (seen && !best.seen) || (seen === best.seen && d < best.d)) best = { face: f, seen, d }
  }
  return best
}

// Standing cells from which the bot can place into `target` (mode 'place': a solid neighbour's face within reach) or
// dig it (mode 'dig': its centre within reach; a spot standing on the target is refused), ranked: seen before hidden,
// then by pathCost from `from`, then by distance. [{ feet, face, seen, cost }]; face is null in dig mode.
export function reachSpots (target, blockAt, { from = null, avoid = new Set(), mode = 'place', reach = REACH, radius = 4, below = 6, above = 2, blind = true } = {}) {
  const list = mode === 'place' ? faces(target, blockAt) : null
  if (mode === 'place' && !list.length) return []
  const tk = key(target)
  const out = []
  for (let dy = -below; dy <= above; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const feet = at(target, dx, dy, dz), head = at(feet, 0, 1, 0)
        const fk = key(feet), hk = key(head)
        if (fk === tk || hk === tk || avoid.has(fk) || avoid.has(hk)) continue
        if (mode === 'dig' && key(at(feet, 0, -1, 0)) === tk) continue
        const eye = eyeOf(feet)
        if (dist(eye, centre(target)) > reach + 1) continue
        if (!standable(blockAt, feet)) continue
        let face = null, seen
        if (mode === 'place') {
          const b = bestFace(blockAt, eye, target, { reach, blind, list })
          if (!b) continue
          face = b.face; seen = b.seen
        } else {
          if (dist(eye, centre(target)) > reach) continue
          seen = lineOfSight(blockAt, eye, centre(target), new Set([tk]))
          if (!seen && !blind) continue
        }
        out.push({ feet, face, seen, cost: pathCost(from, feet), d: dist(eye, face ? face.point : centre(target)) })
      }
    }
  }
  out.sort((a, b) => (b.seen - a.seen) || (a.cost - b.cost) || (a.d - b.d))
  return out.map(({ d, ...s }) => s)
}

// The cells a body at `pos` (feet, fractional) rests on: the blocks under its footprint (half-width `half`) one level
// below the feet (y - 0.01 floored: a body on a slab stands in the slab's own cell). [{ x, y, z }].
export function supportCells (pos, { half = 0.3 } = {}) {
  const out = [], eps = 1e-6, y = Math.floor(pos.y - 0.01)
  for (let x = Math.floor(pos.x - half); x <= Math.floor(pos.x + half - eps); x++) {
    for (let z = Math.floor(pos.z - half); z <= Math.floor(pos.z + half - eps); z++) out.push({ x, y, z })
  }
  return out
}

// True when digging `target` could drop a body standing at `pos`: the target is the cell straight under its feet, or
// the last solid cell its footprint rests on. Pure.
export function standsOn (pos, target, blockAt) {
  const tk = key(target)
  if (key({ x: Math.floor(pos.x), y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) }) === tk) return true
  const under = supportCells(pos)
  return under.some(c => key(c) === tk) && !under.some(c => key(c) !== tk && isSolid(blockAt(c)))
}

// The block cells a body occupies: an axis-aligned box of half-width `half` and `height` at `pos` (feet, fractional).
// Keys. The bot is 0.6 x 1.8; a player the same.
export function occupiedCells (positions, { half = 0.3, height = 1.8 } = {}) {
  const out = new Set()
  const eps = 1e-6
  for (const p of positions) {
    if (!p) continue
    for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half - eps); x++) {
      for (let y = Math.floor(p.y); y <= Math.floor(p.y + height - eps); y++) {
        for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half - eps); z++) out.add(`${x},${y},${z}`)
      }
    }
  }
  return out
}

// The work order of a build: foundation cells first; then layer ascending (descending for a blueprint built from the
// top: staircase_down); within a layer the cells to dig (wrong) before the cells to place, then far from `from`
// first (horizontal distance), ties by col, then row. Cells: { pos, layer, col, row, op: 'foundation'|'dig'|'place' }.
export function buildOrder (list, { from = null, descending = false } = {}) {
  const rank = { foundation: 0, dig: 1, place: 2 }
  const far = c => from ? Math.hypot(c.pos.x + 0.5 - from.x, c.pos.z + 0.5 - from.z) : 0
  return [...list].sort((a, b) =>
    ((a.op === 'foundation') !== (b.op === 'foundation') ? (a.op === 'foundation' ? -1 : 1) : 0) ||
    (descending ? b.layer - a.layer : a.layer - b.layer) ||
    (rank[a.op] - rank[b.op]) ||
    (descending ? (a.row ?? 0) - (b.row ?? 0) : far(b) - far(a)) ||
    ((a.col ?? 0) - (b.col ?? 0)) || ((a.row ?? 0) - (b.row ?? 0)))
}

// The held block to scaffold with: dirt, then cobblestone, then any other placeable, non-falling, non-station block
// (the largest stack first); never one the blueprint still needs (`needs` { item: n }). null when none.
export function scaffoldMaterial (inventory = {}, needs = {}) {
  const usable = name => (inventory[name] || 0) > 0 && !((needs[name] || 0) > 0) && isPlaceable(name) && !GRAVITY.test(name) && !SCAFFOLD_DENY.test(name)
  for (const name of SCAFFOLD_FIRST) if (usable(name)) return name
  const rest = Object.keys(inventory).filter(n => !SCAFFOLD_FIRST.includes(n) && usable(n)).sort((a, b) => inventory[b] - inventory[a] || a.localeCompare(b))
  return rest[0] ?? null
}

// A scaffold column from which `target` can be placed: a standing cell `base` outside the blueprint (no cell of the
// column, nor the feet and head cells on top of it, is in `avoid`: every blueprint and foundation cell), `height`
// blocks placed at base..base+height-1, the bot then standing on top. The lowest column wins, then a seen face, then
// the pathCost from `from`. { base, height, feet, face, seen } | null.
export function scaffoldPlan (target, blockAt, { from = null, avoid = new Set(), reach = REACH, maxHeight = 4, radius = 3 } = {}) {
  const tk = key(target)
  let best = null
  for (let dy = -(maxHeight + 6); dy <= 1; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const base = at(target, dx, dy, dz)
        if (!standable(blockAt, base) || avoid.has(key(base))) continue
        for (let h = 1; h <= maxHeight; h++) {
          const cells = []
          for (let i = 0; i <= h + 1; i++) cells.push(at(base, 0, i, 0))   // column blocks, then feet and head on top
          if (cells.some(c => key(c) === tk || avoid.has(key(c)) || !isClear(blockAt(c)))) break
          const column = new Set(cells.slice(0, h).map(key))
          const world = p => column.has(key(p)) ? { name: 'scaffold', boundingBox: 'block' } : blockAt(p)
          const feet = cells[h]
          const b = bestFace(world, eyeOf(feet), target, { reach })
          if (!b) continue
          const c = { base, height: h, feet, face: b.face, seen: b.seen, cost: pathCost(from, base) }
          if (!best || h < best.height || (h === best.height && ((c.seen && !best.seen) || (c.seen === best.seen && c.cost < best.cost)))) best = c
          break
        }
      }
    }
  }
  if (!best) return null
  const { cost, ...out } = best
  return out
}

// Standing cells near `from` outside `avoid` (keys), nearest first by pathCost: where the bot steps to when it stands
// in a cell the build still has to fill.
export function clearSpots (from, blockAt, { avoid = new Set(), radius = 3 } = {}) {
  const out = []
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const feet = at(from, dx, dy, dz)
        if (avoid.has(key(feet)) || avoid.has(key(at(feet, 0, 1, 0))) || !standable(blockAt, feet)) continue
        out.push({ feet, cost: pathCost(from, feet) })
      }
    }
  }
  return out.sort((a, b) => a.cost - b.cost).map(s => s.feet)
}
