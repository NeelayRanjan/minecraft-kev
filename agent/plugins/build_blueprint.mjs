// build_blueprint(<bp id>): build the current segment of a build blueprint of the book (agent/blueprint_book.js), at
// most 30 placements per call, streaming on to the next segment in the same call while budget remains.
//
// The blueprint comes through `motor.blueprints`, the accessor contract of agent/goals.js registerBlueprintAccessor
// ({ get(id), progress(id, obs), advance(id) }; only get and advance are used here, the world is read directly). The
// runner sets motor.blueprints to the same BlueprintBook-backed accessor it registers with the goals; an arena check may
// set it to a BlueprintBook itself (same get / advance).
//
// Each step recomputes the work from the world (agent/blueprints.js diff):
//   foundation   foundation(bp) cells under layer-0 cells not yet built (material = the cell's)
//   dig          wrong cells (a solid block where air or another block is wanted): dug before placing in that layer
//   place        missing cells (air or a replaceable block); a liquid is displaced by placing into it when a face
//                exists, else the cell is blocked (liquidBlocked: also every liquid in a cell the build wants as air)
// and takes the first cell of agent/reach.js buildOrder (foundation first; layer ascending, staircase_down top down;
// dig before place; far from the bot first) that can be acted on: a place needs the material and a solid neighbour to
// place against. The bot stands where reach.js reachSpots says (never in a cell the build still has to fill), and
// never places into a cell its body or a player's occupies (skipped this call). A cell no standing spot reaches gets a
// scaffold column (motor.scaffoldTo: dirt, then cobblestone, then another held block the blueprint does not need),
// recorded in mem.scaffold[bp id] and dug top down once its layer is done or the blueprint is complete.
//
// Results: ok (+n placed[, m dug][, k unreachable][, j blocked][, complete]) | no_materials (<item>) |
// unreachable (<n> cells) | no_path | failed (no blueprint).
import { Vec3 } from 'vec3'
import { cells, diff, foundation, itemForBlock, liquidBlocked } from '../blueprints.js'
import { buildOrder, faces, key, scaffoldMaterial } from '../reach.js'

export const MAX_PLACEMENTS = 30
const MARGIN_MS = 12_000   // stop taking new cells this close to the deadline: time to step clear and tidy the scaffold

// The work of the blueprint's current segment against the world. { work: [{ pos, want, layer, col, row, op }],
// blocked: [cells], allKeys: every blueprint and foundation cell (scaffold never goes there), needs: { item: n } }.
export function buildWork (bp, blockAt) {
  const d = diff(bp, blockAt)
  const work = [], blocked = [...d.blocked]
  for (const c of [...d.missing, ...d.wrong]) {
    if (liquidBlocked(c, blockAt)) { blocked.push(c); continue }
    work.push({ ...c, op: d.wrong.includes(c) ? 'dig' : 'place' })
  }
  const notDone = new Set([...d.missing, ...d.wrong, ...d.blocked].map(c => key(c.pos)))
  const found = foundation(bp, blockAt)
  for (const f of found) {
    if (!notDone.has(key({ x: f.x, y: f.y + 1, z: f.z }))) continue
    work.push({ pos: { x: f.x, y: f.y, z: f.z }, want: f.want, layer: -1, col: 0, row: 0, op: 'foundation' })
  }
  const needs = {}
  for (const c of work) {
    if (c.want === 'air') continue
    const item = itemForBlock(c.want) ?? c.want
    needs[item] = (needs[item] ?? 0) + 1
  }
  if (bp.material && bp.segments != null && (bp.segment ?? 0) + 1 < bp.segments) needs[bp.material] = (needs[bp.material] ?? 0) + 1
  const allKeys = new Set([...cells(bp).map(c => key(c.pos)), ...found.map(f => key(f))])
  return { work, blocked, allKeys, needs }
}

const inventoryOf = bot => {
  const m = {}
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}

const plugin = {
  id: 'build_blueprint',
  timeout: 150,
  breaker: false,
  options (obs, goal) {
    if (goal?.kind !== 'build' || !/^bp\d+$/.test(goal.arg ?? '')) return []
    return [{ arg: goal.arg, desc: `build blueprint #${goal.arg.slice(2)}` }]
  },
  preconditions () { return true },
  async run (motor, arg) {
    const acc = motor.blueprints
    if (!acc?.get) return { result: 'failed', detail: 'no blueprint book' }
    let bp = acc.get(arg)
    if (!bp) return { result: 'failed', detail: `no blueprint ${arg}` }
    if (bp.kind !== 'build') return { result: 'failed', detail: `${arg} is not a build blueprint` }
    const bot = motor.bot
    const blockAt = p => bot.blockAt(new Vec3(p.x, p.y, p.z))
    let placed = 0, dug = 0, complete = false, stalled = false
    const skip = new Map()            // cell key -> why, for this call
    const scaffolded = new Set()      // cells a scaffold was built for in this call (one try each)
    const short = new Map()           // item -> cells lacking it
    const bad = new Set()             // standing spots no path reached in this call

    // A scaffold left by an earlier call whose layer (or segment) has no work left: dig it first.
    const tidy = async (w, all = false) => {
      if (!motor.mem.scaffold?.[arg]?.length) return
      const seg = bp.segment ?? 0
      const needed = s => !all && s.segment === seg && w.work.some(c => c.layer === s.layer)
      await motor.removeScaffold(arg, { avoid: new Set(w.work.map(c => key(c.pos))), keep: needed })
    }
    let w = buildWork(bp, blockAt)
    await motor.stepClear(new Set(w.work.map(c => key(c.pos))))
    await tidy(w)

    for (;;) {
      motor.check()
      if (placed >= MAX_PLACEMENTS || Date.now() > motor.deadline - MARGIN_MS) break
      bp = acc.get(arg)
      w = buildWork(bp, blockAt)
      if (!w.work.length) {
        if (w.blocked.some(c => !blockAt(c.pos))) break   // unloaded cells: not done yet
        const next = acc.advance(arg)
        if (next) { motor.log(`build ${arg}: segment ${(next.segment ?? 0) + 1} of ${next.segments}`); skip.clear(); scaffolded.clear(); continue }
        complete = true
        break
      }
      const avoid = new Set(w.work.map(c => key(c.pos)))
      const occupied = motor.occupied()
      const order = buildOrder(w.work, { from: bot.entity.position, descending: bp.template === 'staircase_down' })
      let acted = false
      for (const c of order) {
        const k = key(c.pos)
        if (skip.has(k)) continue
        if (c.op === 'dig') {
          const r = await motor.digCell(c.pos, { avoid, bad })
          if (r.ok) { dug++; acted = true; break }
          skip.set(k, r.why); continue
        }
        const item = itemForBlock(c.want) ?? c.want
        if (!motor.count(item)) { short.set(item, (short.get(item) ?? 0) + 1); skip.set(k, 'no_materials'); continue }
        if (!faces(c.pos, blockAt).length) continue   // nothing to place against yet: a cell later in the order first
        if (occupied.has(k)) { skip.set(k, 'occupied'); continue }
        const r = await motor.placeCell(c.pos, item, c.want, { avoid, bad })
        if (r.ok) { placed++; acted = true; if (motor.current) motor.current.progress = Math.min(1, placed / MAX_PLACEMENTS); break }
        if (r.why === 'unreachable' && !scaffolded.has(k)) {
          scaffolded.add(k)
          const material = scaffoldMaterial(inventoryOf(bot), w.needs)
          if (material && await motor.scaffoldTo(c.pos, { bpId: arg, avoid: w.allKeys, material, layer: c.layer, segment: bp.segment ?? 0 })) { acted = true; break }
        }
        skip.set(k, r.why)
      }
      if (!acted) { stalled = true; break }
    }

    // Never end standing in a cell still to fill; the scaffold goes once its layer is done or the build is complete.
    bp = acc.get(arg)
    w = buildWork(bp, blockAt)
    await tidy(w, complete)
    await motor.stepClear(new Set(w.work.map(c => key(c.pos))))

    const unreachable = w.work.filter(c => ['unreachable', 'occupied', 'rejected', 'unbreakable', 'no_face', 'solid', 'unloaded'].includes(skip.get(key(c.pos))) ||
      (stalled && !skip.has(key(c.pos)) && c.op !== 'dig' && !faces(c.pos, blockAt).length)).length   // floating: only once nothing else can be done
    const noPath = w.work.filter(c => skip.get(key(c.pos)) === 'no_path').length
    const liquid = w.blocked.length
    if (placed + dug > 0 || complete) {
      const parts = [`+${placed} placed`]
      if (dug) parts.push(`${dug} dug`)
      if (unreachable) parts.push(`${unreachable} unreachable`)
      if (liquid) parts.push(`${liquid} blocked`)
      if (complete) parts.push('complete')
      return { result: 'ok', detail: parts.join(', ') }
    }
    if (short.size) return { result: 'no_materials', detail: [...short.keys()][0] }
    if (noPath && !unreachable) return { result: 'no_path', detail: `${noPath} cells` }
    return { result: 'unreachable', detail: `${unreachable + noPath} cells` }
  },
}
export default plugin
