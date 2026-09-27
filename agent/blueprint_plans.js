// Blueprint plans (pure): what the runner needs to turn a leader's plan_build / plan_dig / plan_blueprint answer into a
// plan of the plan book and to show its progress. No Mineflayer here: positions, yaws and blockAt come in as values.
//
//   anchorFor         where the shape goes: the requesting player's floored feet and facing (bot.players[name].entity),
//                     else the server-reported position with the bot's facing toward it, else the bot itself
//   facingToward      the cardinal direction from one position toward another
//   parseDataPos      the position in the server's reply to `/data get entity <name> Pos`
//   splitGatherSteps  a gather step above the goal's cap (goals.GATHER_CAPS) split into consecutive steps of at most the cap
//   blueprintTitle    the plan's title: "hut (5x5x3)", "room (3x3x2)", "stairs down to (y 40)", "<free-form title> (3x2x2)"
//   progressText      "layer 2 of 3, 41 of 96 blocks" / "segment 3 of 4, 22 of 30 cells" from BlueprintBook.progress
//   blueprintGrid     every layer of a blueprint's current segment as rows of cell marks, for the status page
import { cells, diff, facingFromYaw, liquidBlocked, toWorld } from './blueprints.js'
import { TEMPLATES } from './templates.js'
import { GATHER_CAPS } from './goals.js'

const humanize = s => String(s).replace(/_/g, ' ')
const floorPos = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

// Mineflayer's yaw convention (blueprints.facingFromYaw): yaw = atan2(-dx, -dz). null when the two share a column.
export function facingToward (from, to) {
  const dx = to.x - from.x, dz = to.z - from.z
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return null
  return facingFromYaw(Math.atan2(-dx, -dz))
}

// player: { pos, yaw } of the requesting player's entity (in view), or null; serverPos: { x, y, z } the server reported
// for that player (no entity in view), or null; bot: { pos, yaw, facing? } (facing: the bot's last walk direction, used
// when the bot itself is the anchor). -> { anchor, facing, from: 'player' | 'server' | 'bot' }.
export function anchorFor ({ player = null, serverPos = null, bot }) {
  if (player?.pos && Number.isFinite(player.yaw)) return { anchor: floorPos(player.pos), facing: facingFromYaw(player.yaw), from: 'player' }
  if (serverPos) return { anchor: floorPos(serverPos), facing: facingToward(bot.pos, serverPos) ?? facingFromYaw(bot.yaw), from: 'server' }
  return { anchor: floorPos(bot.pos), facing: bot.facing ?? facingFromYaw(bot.yaw), from: 'bot' }
}

// "<name> has the following entity data: [12.5d, 64.0d, -3.25d]" -> { x, y, z } (numbers only), else null.
const NUM = '(-?\\d+(?:\\.\\d+)?(?:E-?\\d+)?)[dD]?'
const DATA_POS = new RegExp(`^(\\w{1,16}) has the following entity data: \\[\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]`)
export function parseDataPos (text, name) {
  const m = DATA_POS.exec(String(text ?? '').trim())
  if (!m || m[1] !== name) return null
  const [x, y, z] = [m[2], m[3], m[4]].map(Number)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

// A gather step whose count is above the goal kind's cap (the option layer never gathers past it, so the goal would be
// clamped and never cover the need) becomes consecutive steps of at most the cap, the remainder last. Other steps pass.
const capOf = (item, caps) => item === 'log' || String(item).endsWith('_log') ? caps.log : caps[item] ?? null
export function splitGatherSteps (steps, caps = GATHER_CAPS) {
  const out = []
  for (const s of steps) {
    const cap = s.kind === 'gather' ? capOf(s.arg, caps) : null
    if (cap == null || !Number.isInteger(s.count) || s.count <= cap) { out.push({ ...s }); continue }
    for (let left = s.count; left > 0; left -= cap) out.push({ ...s, count: Math.min(cap, left) })
  }
  return out
}

// The plan title: the template's name and its size ("hut (5x5x3)"; w x d x h or depth when the template has them,
// else its params as "len 32, branch every 3"), a material other than cobblestone after a comma; a free-form blueprint:
// its title and w x d x layers.
export function blueprintTitle (bp) {
  if (bp.template && TEMPLATES[bp.template]) {
    const p = bp.params ?? {}
    const h = p.h ?? p.depth
    const dims = p.w != null && p.d != null && h != null ? `${p.w}x${p.d}x${h}`
      : Object.keys(TEMPLATES[bp.template].params).filter(k => p[k] != null).map(k => `${humanize(k)} ${p[k]}`).join(', ')
    const mat = bp.material && bp.material !== 'cobblestone' ? `${dims ? ', ' : ''}${humanize(bp.material)}` : ''
    return `${humanize(bp.template)}${dims || mat ? ` (${dims}${mat})` : ''}`
  }
  const w = Math.max(0, ...bp.layers.flatMap(l => l.map(r => r.length))), d = Math.max(0, ...bp.layers.map(l => l.length))
  return `${bp.title ?? 'blueprint'} (${w}x${d}x${bp.layers.length})`
}

// The progress in words from BlueprintBook.progress (null -> ''): a build's layer and blocks, a dig's segment and cells.
export function progressText (p) {
  if (!p) return ''
  const seg = p.segments > 1 ? `segment ${p.segment} of ${p.segments}, ` : ''
  if (p.kind === 'build') return `${seg}layer ${p.layer} of ${p.layers}, ${p.blocksDone ?? p.done} of ${p.blocksTotal ?? p.total} blocks${p.blocked ? `, ${p.blocked} blocked` : ''}`
  return `${seg}${p.done} of ${p.total} cells${p.blocked ? `, ${p.blocked} blocked` : ''}`
}

// The status page's grid: each layer of the current segment (bottom first) as rows, the farthest row on top and
// columns left to right as seen looking along the facing (as blueprints.layerCut), one mark per cell:
//   '#' placed   'o' missing   'x' wrong block (dug first)   '!' blocked (liquid, unloaded)   's' scaffold standing
//   '.' still to dig   '_' dug / clear   ' ' no cell
// Scaffold blocks (the book's record; one still standing is the item it was placed as) outside the blueprint widen the
// grid so they show.
export const GRID_MARKS = { '#': 'placed', o: 'missing', x: 'wrong', '!': 'blocked', s: 'scaffold', '.': 'to dig', _: 'dug' }
const cellKey = p => `${p.x},${p.y},${p.z}`
export function blueprintGrid (bp, blockAt, scaffold = []) {
  const d = diff(bp, blockAt)
  const state = new Map()
  for (const c of d.missing) state.set(cellKey(c.pos), liquidBlocked(c, blockAt) ? '!' : 'o')
  for (const c of d.wrong) state.set(cellKey(c.pos), c.want === 'air' ? (liquidBlocked(c, blockAt) ? '!' : '.') : 'x')
  for (const c of d.blocked) state.set(cellKey(c.pos), '!')
  const all = cells(bp)
  const mark = c => state.get(cellKey(c.pos)) ?? (c.want === 'air' ? '_' : '#')
  // local coordinates of a world position (the inverse of toWorld: an affine map with unit forward/right vectors)
  const o = toWorld(bp, { col: 0, row: 0, layer: 0 })
  const fw = toWorld(bp, { col: 0, row: 1, layer: 0 }), rt = toWorld(bp, { col: 1, row: 0, layer: 0 })
  const f = { x: fw.x - o.x, z: fw.z - o.z }, r = { x: rt.x - o.x, z: rt.z - o.z }
  const local = p => ({ col: (p.x - o.x) * r.x + (p.z - o.z) * r.z, row: (p.x - o.x) * f.x + (p.z - o.z) * f.z, layer: p.y - o.y })
  const standing = scaffold.filter(s => blockAt(s)?.name === s.item).map(local)
  const pts = [...all.map(c => ({ col: c.col, row: c.row, layer: c.layer })), ...standing]
  const min = k => Math.min(...pts.map(p => p[k])), max = k => Math.max(...pts.map(p => p[k]))
  const [c0, c1, r0, r1, l0, l1] = [min('col'), max('col'), min('row'), max('row'), min('layer'), max('layer')]
  const byLocal = new Map(all.map(c => [`${c.col},${c.row},${c.layer}`, c]))
  const scaf = new Set(standing.map(p => `${p.col},${p.row},${p.layer}`))
  const layers = []
  for (let layer = l0; layer <= l1; layer++) {
    const rows = []
    for (let row = r1; row >= r0; row--) {
      let line = ''
      for (let col = c0; col <= c1; col++) {
        const k = `${col},${row},${layer}`
        const c = byLocal.get(k)
        line += scaf.has(k) ? 's' : c ? mark(c) : ' '
      }
      rows.push(line)
    }
    layers.push({ layer: layer - l0 + 1, rows })
  }
  return { id: bp.id ?? null, title: blueprintTitle(bp), kind: bp.kind, segment: (bp.segment ?? 0) + 1, segments: bp.segments ?? 1, layers }
}
