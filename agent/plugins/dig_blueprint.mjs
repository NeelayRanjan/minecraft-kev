// dig_blueprint(<bp id>): dig the current segment of a dig blueprint of the book (agent/blueprint_book.js), at most
// MAX_DIGS blocks per call (plan cells and vein ores together), streaming on to the next segment in the same call while
// budget remains. The blueprint comes through `motor.blueprints` (agent/blueprint_exec.js loadBlueprint; the accessor
// contract of goals.registerBlueprintAccessor plus update(id, bp); an arena check may set a BlueprintBook itself).
//
// Each step recomputes the work from the world (digWork: the diff's solid '.' cells; cells holding a liquid are never
// work, cells not loaded wait) and takes the first cell of digOrder that can be acted on:
//   order     near rows first; within a row the centre column, then the left side outward, then the right side
//             outward; within a column the top layer first (a tunnel is dug face by face, a staircase step by step, a
//             strip-mine branch from the main tunnel outward)
//   liquid    before a cell is dug, liquidExposure: the cell, a face neighbour (source or flowing water/lava, an
//             underwater plant or a waterlogged block: blueprints.isLiquidBlock) or a
//             liquid resting on a column of sand/gravel above it. A cell that would expose a liquid is never dug. The
//             streamed digs (TURNABLE) turn their segment 90 degrees right once (templates.turnSegment, replaced in the
//             book with accessor.update, marked bp.turned = segment) when the turned segment's first cell is dry, and
//             carry on in the new facing; otherwise (a second liquid in the segment, a room, a pit) the call stops:
//             hit_liquid (x, y, z of the liquid).
//   tool      a cell no held tool harvests (stone with no pickaxe, obsidian below a diamond pickaxe, bedrock) is
//             skipped for this call (needs_tool in the detail); needs_tool when nothing else is left.
//   walking   motor.digCell: from where the bot stands when the cell is in reach and in sight, else from a reach spot
//             (agent/reach.js reachSpots; the dug cells are standing spots, so the bot walks into the tunnel or down the
//             stairs as it digs), walked with the pathfinder's digging off (walkMovements). Spots no path reached and
//             cells with no spot are retried after the next successful dig (it opens new spots).
//   gravity   sand or gravel above a dug cell: wait for it to fall and dig the bot out (motor.digOut) if it landed on it.
//   veins     bp.veins (tunnel, strip_mine): after every dug cell, the ores face-adjacent to it (veinTargets: outside the
//             plan, not next to a liquid, harvestable with a held pickaxe) are dug, then the ores adjacent to those
//             (up to VEIN_MAX per vein); their drops are walked to at the end of the call.
//
//   footing  never the block the bot stands on: motor.digCell walks to a dig reach spot first (reach.js standsOn,
//             reachSpots mode 'dig') and answers 'underfoot' when it cannot step off; such a cell is retried after the
//             next dig. A cell with more than MAX_DROP non-solid cells straight below it is never dug (dropUnder:
//             whoever stands in it afterwards falls into the cave or shaft under it).
//
// Results: ok (+n dug[, v ore mined][, k drops][, j liquid][, t needs_tool][, d over a drop][, turned right], segment i/n[, complete]) |
// hit_liquid (x, y, z: <liquid>, +n dug) | needs_tool (<block>) | no_path (<n> cells) | unreachable (<n> cells over a
// drop) | failed (no blueprint).
// Started more than 12 m from the nearest cell still to work on, the call first walks toward it (blueprint_exec.approach).
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { diff } from '../blueprints.js'
import { FACES, REACH, at, isLiquid, key, standable } from '../reach.js'
import { turnSegment } from '../templates.js'
import { MINE } from '../recipes.js'
import { FINAL_MS, MARGIN_MS, approach, loadBlueprint } from '../blueprint_exec.js'

const { goals } = pathfinderPkg

export const MAX_DIGS = 40
export const VEIN_MAX = 16
export const MAX_DROP = 3
export const TURNABLE = new Set(['stairs_down_to', 'stairs_up_to', 'shaft_down', 'tunnel', 'strip_mine'])
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|_concrete_powder$/
const LEGACY_ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']
const ORES = new Set([
  ...LEGACY_ORES.flatMap(o => [`${o}_ore`, `deepslate_${o}_ore`]),
  ...Object.values(MINE).filter(m => m?.where === 'ore').flatMap(m => m.blocks),
])
// What ores drop (counted before and after the call).
const DROPS = ['coal', 'raw_iron', 'raw_copper', 'raw_gold', 'redstone', 'lapis_lazuli', 'diamond', 'emerald']

export const isOre = name => ORES.has(name)

// The dig work of the blueprint's current segment against the world: { work, liquid, unloaded, total, done }.
export function digWork (bp, blockAt) {
  const d = diff(bp, blockAt)
  const work = [], liquid = []
  for (const c of d.wrong) (isLiquid(blockAt(c.pos)) ? liquid : work).push(c)
  return { work, liquid, unloaded: d.blocked, total: d.total, done: d.done }
}

const widthOf = bp => Math.max(0, ...bp.layers.flatMap(l => l.map(r => r.length)))

// The dig order (see the header): row ascending; centre column, then left outward, then right outward; layer descending.
export function digOrder (work, bp) {
  const c0 = Math.floor(widthOf(bp) / 2)
  const side = c => c.col === c0 ? 0 : c.col < c0 ? 1 : 2
  return [...work].sort((a, b) => (a.row - b.row) || (side(a) - side(b)) || (Math.abs(a.col - c0) - Math.abs(b.col - c0)) || (b.layer - a.layer))
}

// The liquid digging `pos` would expose: the cell itself, a face neighbour, or a liquid resting on a column of falling
// blocks (sand, gravel) over the cell. Its position, or null. Pure.
export function liquidExposure (pos, blockAt) {
  if (isLiquid(blockAt(pos))) return { x: pos.x, y: pos.y, z: pos.z }
  for (const d of FACES) {
    const n = at(pos, ...d)
    if (isLiquid(blockAt(n))) return n
    if (d[1] !== 1) continue
    let p = n
    for (let i = 0; i < 16 && GRAVITY.test(blockAt(p)?.name ?? ''); i++) {
      p = at(p, 0, 1, 0)
      if (isLiquid(blockAt(p))) return p
    }
  }
  return null
}

// The number of non-solid cells straight below `pos` (air, plants, liquids), counted up to `max` + 1. Pure.
export function dropUnder (pos, blockAt, max = MAX_DROP) {
  let n = 0
  for (let y = pos.y - 1; n <= max; y--, n++) {
    const b = blockAt({ x: pos.x, y, z: pos.z })
    if (!b || b.boundingBox === 'block') break
  }
  return n
}

// True when a held item (or the hand) harvests `block`: no harvest tool needed, or one held. Never bedrock or blocks
// with no hardness. Pure (prismarine-block's harvestTools: { itemId: true }).
export function harvestable (block, items) {
  if (!block || block.hardness == null || block.hardness < 0 || block.name === 'bedrock') return false
  if (!block.harvestTools) return true
  return items.some(i => block.harvestTools[i.type])
}

// The ores face-adjacent to `pos` worth vein-mining: not a plan cell (`plan`: keys; those are dug anyway) and exposing
// no liquid. Pure.
export function veinTargets (pos, blockAt, { plan = new Set() } = {}) {
  const out = []
  for (const d of FACES) {
    const n = at(pos, ...d)
    if (plan.has(key(n)) || !isOre(blockAt(n)?.name)) continue
    if (liquidExposure(n, blockAt)) continue
    out.push(n)
  }
  return out
}

const segText = bp => bp.segments != null ? `segment ${(bp.segment ?? 0) + 1}/${bp.segments}` : null

const plugin = {
  id: 'dig_blueprint',
  timeout: 150,
  breaker: false,
  options (obs, goal) {
    if (goal?.kind !== 'dig' || !/^bp\d+$/.test(goal.arg ?? '')) return []
    return [{ arg: goal.arg, desc: `dig blueprint #${goal.arg.slice(2)}` }]
  },
  preconditions () { return true },
  async run (motor, arg) {
    const got = loadBlueprint(motor, arg, 'dig')
    if (got.error) return got.error
    const acc = got.acc
    let bp = got.bp
    const bot = motor.bot
    const blockAt = p => bot.blockAt(new Vec3(p.x, p.y, p.z))
    const dropsBefore = DROPS.reduce((n, d) => n + motor.count(d), 0)
    let dug = 0, ores = 0, turned = 0, complete = false, stalled = false, hit = null
    const skip = new Map()      // cell key -> why, for this call ('needs_tool' stays; reach failures are retried)
    const bad = new Set()       // standing spots no path reached (cleared after every dig: new spots open)
    const mined = []            // vein ore positions (their drops are collected at the end)
    motor.reserveMs = MARGIN_MS

    const budget = () => dug + ores < MAX_DIGS && motor.timeLeft() >= 2000
    const overDrop = pos => dropUnder(pos, blockAt) > MAX_DROP
    const afterDig = async (pos) => {
      if (!GRAVITY.test(blockAt(at(pos, 0, 1, 0))?.name ?? '')) return
      await bot.waitForTicks(12); motor.check()
      await motor.digOut(bot.entity.position.floored()); motor.check()
    }
    // Vein mining from a dug cell: its adjacent ores, then theirs, up to VEIN_MAX.
    const vein = async (from, plan) => {
      const queue = veinTargets(from, blockAt, { plan })
      const seen = new Set(queue.map(key))
      let n = 0
      while (queue.length && n < VEIN_MAX && budget()) {
        const p = queue.shift()
        const blk = blockAt(p)
        if (!isOre(blk?.name) || !harvestable(blk, bot.inventory.items()) || liquidExposure(p, blockAt)) continue
        const eye = bot.entity.position.offset(0, 1.62, 0)
        if (eye.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) > REACH + 2) continue
        if (overDrop(p)) continue
        const r = await motor.digCell(p, { avoid: plan, bad })
        if (!r.ok) { if (r.why === 'no_time') break; continue }
        n++; ores++; mined.push(p)
        motor.log(`dig ${arg}: vein ${blk.name} at ${key(p)}`)
        await afterDig(p)
        for (const q of veinTargets(p, blockAt, { plan })) if (!seen.has(key(q))) { seen.add(key(q)); queue.push(q) }
      }
    }

    { const w0 = digWork(bp, blockAt); await approach(motor, [...w0.work, ...w0.unloaded], `dig ${arg}`) }   // far away: walk there first
    for (;;) {
      motor.check()
      if (!budget()) break
      bp = acc.get(arg)
      const w = digWork(bp, blockAt)
      if (!w.work.length) {
        if (w.unloaded.length) break   // not loaded yet: not done
        const next = acc.advance(arg)
        if (next) { motor.log(`dig ${arg}: segment ${(next.segment ?? 0) + 1} of ${next.segments}`); skip.clear(); bad.clear(); continue }
        complete = true
        break
      }
      const plan = new Set(w.work.map(c => key(c.pos)))
      let acted = false, outOfTime = false, stop = false
      for (const c of digOrder(w.work, bp)) {
        const k = key(c.pos)
        if (skip.has(k)) continue
        const liquid = liquidExposure(c.pos, blockAt)
        if (liquid) {
          const seg = bp.segment ?? 0
          if (TURNABLE.has(bp.template) && bp.turned !== seg) {
            const t = { ...turnSegment(bp, 'right'), turned: seg }
            const first = digOrder(digWork(t, blockAt).work, t)[0]
            const wet = first ? liquidExposure(first.pos, blockAt) : null
            if (!wet) {
              acc.update(arg, t); turned++; skip.clear(); bad.clear(); acted = true
              motor.log(`dig ${arg}: ${blockAt(liquid)?.name} at ${key(liquid)} next to ${k}, turning right (now ${t.facing})`)
              break
            }
            hit = wet
          } else hit = liquid
          motor.log(`dig ${arg}: ${blockAt(hit)?.name} at ${key(hit)}, stopping`)
          stop = true
          break
        }
        const blk = blockAt(c.pos)
        if (!harvestable(blk, bot.inventory.items())) { skip.set(k, 'needs_tool'); continue }
        if (overDrop(c.pos)) { skip.set(k, 'drop'); continue }
        const r = await motor.digCell(c.pos, { avoid: plan, bad })
        if (r.ok) {
          dug++; acted = true
          for (const [sk, why] of skip) if (why !== 'needs_tool' && why !== 'drop') skip.delete(sk)
          bad.clear()
          if (motor.current) motor.current.progress = Math.min(1, (dug + ores) / MAX_DIGS)
          await afterDig(c.pos)
          if (bp.veins) await vein(c.pos, plan)
          break
        }
        if (r.why === 'no_time') { outOfTime = true; break }
        skip.set(k, r.why)
      }
      if (stop || outOfTime) break
      if (!acted) { stalled = true; break }
    }

    // The vein drops: walk next to each one still lying near a mined ore.
    motor.reserveMs = FINAL_MS
    if (mined.length) await collectDrops(motor, mined, blockAt)
    const drops = DROPS.reduce((n, d) => n + motor.count(d), 0) - dropsBefore

    bp = acc.get(arg)
    const w = digWork(bp, blockAt)
    const toolless = w.work.filter(c => skip.get(key(c.pos)) === 'needs_tool')
    const deep = w.work.filter(c => skip.get(key(c.pos)) === 'drop')
    const unreached = w.work.filter(c => ['unreachable', 'no_path', 'rejected', 'unbreakable', 'underfoot'].includes(skip.get(key(c.pos))))
    if (hit) {
      const name = blockAt(hit)?.name ?? 'liquid'
      return { result: 'hit_liquid', detail: `${hit.x}, ${hit.y}, ${hit.z}: ${name}, +${dug} dug${ores ? `, ${ores} ore mined` : ''}${turned ? ', turned right' : ''}` }
    }
    if (dug + ores > 0 || turned || complete) {
      const parts = [`+${dug} dug`]
      if (ores) parts.push(`${ores} ore mined`)
      if (drops > 0) parts.push(`${drops} drops`)
      if (w.liquid.length) parts.push(`${w.liquid.length} liquid`)
      if (toolless.length) parts.push(`${toolless.length} needs_tool`)
      if (deep.length) parts.push(`${deep.length} over a drop`)
      if (turned) parts.push('turned right')
      const seg = segText(bp)
      return { result: 'ok', detail: parts.join(', ') + (seg ? `, ${seg}` : '') + (complete ? ', complete' : '') }
    }
    if (stalled && toolless.length && toolless.length === w.work.length) return { result: 'needs_tool', detail: blockAt(toolless[0].pos)?.name ?? 'block' }
    if (stalled && unreached.length) return { result: 'no_path', detail: `${unreached.length} cells` }
    if (stalled && deep.length) return { result: 'unreachable', detail: `${deep.length} cells over a drop` }
    if (stalled && toolless.length) return { result: 'needs_tool', detail: blockAt(toolless[0].pos)?.name ?? 'block' }
    return { result: 'ok', detail: `+0 dug${segText(bp) ? `, ${segText(bp)}` : ''}` }   // out of time before any step
  },
}
export default plugin

// Walk next to every item lying within 1.5 m of a mined ore (the pickup box reaches one block around the bot), each
// walk capped by the budget. Items are counted by the caller from the inventory.
async function collectDrops (motor, mined, blockAt) {
  const bot = motor.bot
  await bot.waitForTicks(12)   // items can be picked up 10 ticks after they drop
  for (let round = 0; round < 6; round++) {
    motor.check()
    const me = bot.entity.position
    const items = Object.values(bot.entities).filter(e => e.name === 'item' &&
      mined.some(p => e.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) < 1.5))
      .sort((a, b) => me.distanceTo(a.position) - me.distanceTo(b.position))
    if (!items.length) return
    const it = items[0].position.floored()
    const cand = []
    for (const dy of [0, -1, 1]) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const f = { x: it.x + dx, y: it.y + dy, z: it.z + dz }
      if (standable(blockAt, f)) cand.push(f)
    }
    cand.sort((a, b) => me.distanceTo(new Vec3(a.x + 0.5, a.y, a.z + 0.5)) - me.distanceTo(new Vec3(b.x + 0.5, b.y, b.z + 0.5)))
    let reached = false
    for (const f of cand.slice(0, 3)) {
      if (motor.timeLeft() < 2500) return
      try { await motor.walkWithin(new goals.GoalBlock(f.x, f.y, f.z), 8000); reached = true; break } catch (e) {
        motor.check()
        if (e?.name === 'NoTime') return
      }
    }
    await bot.waitForTicks(6)
    if (!reached) mined.splice(0, mined.length, ...mined.filter(p => items[0].position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) >= 1.5))
  }
}
