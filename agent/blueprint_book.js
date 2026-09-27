// The blueprint book (pure): the runner keeps every blueprint of the episode here by id (blueprints are too big for a
// goal arg). Ids render as `bp<n>` so goal and option args satisfy \w+: goals build(bp4) / dig(bp5), options
// build_blueprint(bp4) / dig_blueprint(bp5). The world is read through an injected blockAt(pos) -> { name, boundingBox }
// | null (null = not loaded), as in agent/blueprints.js.
//
// progress(id, blockAt) summarises the current segment:
//   { kind, name, done, total, missing, blocked, layer, layers, segment, segments, finished,
//     blocksDone, blocksTotal, needs, layerNeeds }
//   missing   the cells still to work on: a build's missing + wrong cells; a dig's solid cells (liquid cells excluded:
//             they are never dug, so never remaining work)
//   blocked   unloaded cells, plus a dig's cells holding a liquid
//   layer     1-based: a build's lowest layer with work left, a dig's highest (digs work top down); `layers` when none
//   segment   1-based; segments 1 for a blueprint that is not streamed
//   finished  nothing left in this segment (missing 0, nothing unloaded) and no next segment
//   blocksDone / blocksTotal   a build's block cells (air cells to clear are not blocks)
//   needs     { item: n } the materials the remaining block cells (unloaded ones included) and their foundation
//             blocks take (build only)
//   layerNeeds the same restricted to the working layer
import { diff, foundation, itemForBlock } from './blueprints.js'
import { nextSegment } from './templates.js'

const LIQUID = new Set(['water', 'lava', 'bubble_column'])
const key = p => `${p.x},${p.y},${p.z}`
const pretty = s => String(s).replace(/_/g, ' ')
const add = (m, item, n = 1) => { m[item] = (m[item] ?? 0) + n }
export const blueprintNumber = id => { const m = /^bp(\d+)$/.exec(id ?? ''); return m ? Number(m[1]) : null }

export class BlueprintBook {
  constructor () { this.blueprints = new Map(); this.next = 1 }

  add (bp) {
    const id = `bp${this.next++}`
    this.blueprints.set(id, { ...bp, id })
    return id
  }

  get (id) { return this.blueprints.get(id) ?? null }

  update (id, bp) {
    if (!this.blueprints.has(id)) throw new Error(`no blueprint ${id}`)
    this.blueprints.set(id, { ...bp, id })
    return this.get(id)
  }

  // A streamed blueprint's next segment replaces the current one; null (nothing changed) when it was the last.
  advance (id) {
    const bp = this.get(id)
    if (!bp) return null
    const next = nextSegment(bp)
    return next ? this.update(id, next) : null
  }

  progress (id, blockAt) {
    const bp = this.get(id)
    if (!bp) return null
    const d = diff(bp, blockAt)
    const build = bp.kind === 'build'
    const liquid = build ? [] : d.wrong.filter(c => LIQUID.has(blockAt(c.pos)?.name))
    const liquidSet = new Set(liquid)
    const work = build ? [...d.missing, ...d.wrong] : d.wrong.filter(c => !liquidSet.has(c))
    const layers = bp.layers.length
    const workLayers = work.map(c => c.layer)
    const layerIdx = workLayers.length ? (build ? Math.min(...workLayers) : Math.max(...workLayers)) : layers - 1
    const out = {
      kind: bp.kind, name: nameOf(bp), done: d.done, total: d.total, missing: work.length,
      blocked: d.blocked.length + liquid.length, layer: layerIdx + 1, layers,
      segment: (bp.segment ?? 0) + 1, segments: bp.segments ?? 1,
      finished: work.length === 0 && d.blocked.length === 0 && nextSegment(bp) === null,
    }
    if (!build) return out
    const notDone = new Set([...d.missing, ...d.wrong, ...d.blocked].map(c => key(c.pos)))
    const blockCells = [...d.missing, ...d.wrong, ...d.blocked].filter(c => c.want !== 'air')
    let total = 0
    for (const layer of bp.layers) for (const row of layer) for (const ch of row) if (ch !== ' ' && ch !== '.') total++
    const needs = {}, layerNeeds = {}
    for (const c of blockCells) {
      const item = itemForBlock(c.want) ?? c.want
      add(needs, item)
      if (c.layer === layerIdx) add(layerNeeds, item)
    }
    // foundation blocks under layer-0 cells still to place (a placed cell no longer takes one)
    for (const f of foundation(bp, blockAt)) {
      if (!notDone.has(key({ x: f.x, y: f.y + 1, z: f.z }))) continue
      const item = itemForBlock(f.want) ?? f.want
      add(needs, item)
      if (layerIdx === 0) add(layerNeeds, item)
    }
    return { ...out, blocksDone: total - blockCells.length, blocksTotal: total, needs, layerNeeds }
  }

  // The state-text line: `building hut (#4): layer 2 of 3, 41 of 96 blocks, 3 unreachable, need 12 cobblestone` /
  // `digging strip mine (#5): segment 3 of 4, 22 of 30 cells`. `unreachable` defaults to the unloaded cells; the
  // executor may report its own count. The materials needed are net of the inventory (exact item names).
  line (id, blockAt, inventory = {}, { unreachable } = {}) {
    const p = this.progress(id, blockAt)
    if (!p) return null
    const head = `${p.kind === 'build' ? 'building' : 'digging'} ${p.name} (#${blueprintNumber(id)}): `
    const seg = p.segments > 1 ? `segment ${p.segment} of ${p.segments}, ` : ''
    if (p.kind !== 'build') return `${head}${seg}${p.done} of ${p.total} cells${p.blocked ? `, ${p.blocked} blocked` : ''}`
    const unr = unreachable ?? p.blocked
    const short = Object.entries(p.needs).map(([item, n]) => [item, n - (inventory[item] || 0)]).filter(([, n]) => n > 0)
    return `${head}${seg}layer ${p.layer} of ${p.layers}, ${p.blocksDone} of ${p.blocksTotal} blocks` +
      `${unr ? `, ${unr} unreachable` : ''}${short.length ? `, need ${short.map(([item, n]) => `${n} ${pretty(item)}`).join(', ')}` : ''}`
  }

  toJSON () { return { next: this.next, blueprints: Object.fromEntries(this.blueprints) } }

  static fromJSON (j) {
    const b = new BlueprintBook()
    b.next = j?.next ?? 1
    for (const [id, bp] of Object.entries(j?.blueprints ?? {})) b.blueprints.set(id, bp)
    return b
  }
}

function nameOf (bp) { return pretty(bp.template ?? bp.title ?? 'blueprint') }

// The goal layer's accessor (goals.registerBlueprintAccessor) over a book: progress(id, obs) reads the world through
// blockAt and adds `surface` (isSurface(bp, obs): the runner's sky-light test of the anchor).
export function bookAccessor (book, { blockAt, isSurface = () => false }) {
  return {
    get: id => book.get(id),
    progress: (id, obs) => {
      const p = book.progress(id, blockAt)
      return p && { ...p, surface: !!isSurface(book.get(id), obs) }
    },
    advance: id => book.advance(id),
  }
}
