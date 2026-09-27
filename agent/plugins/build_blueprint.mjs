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
// recorded in the book's scaffold record (accessor.scaffold(id); without one, no scaffolding) and dug top down once
// its layer is done or the blueprint is complete. The book keeps a build unfinished while its scaffold stands, so the
// goal offers this executor again until the scaffold is gone (a call interrupted during the tidy is resumed).
//
// Results: ok (+n placed[, m dug][, s scaffold][, r scaffold removed][, k unreachable][, j blocked][, complete]) |
// no_materials (<item>) | unreachable (<n> cells) | no_path | failed (no blueprint).
import { Vec3 } from 'vec3'
import { cells, diff, foundation, itemForBlock, liquidBlocked } from '../blueprints.js'
import { buildOrder, faces, key, scaffoldMaterial } from '../reach.js'
import { FINAL_MS, MARGIN_MS, inventoryOf, loadBlueprint } from '../blueprint_exec.js'

export const MAX_PLACEMENTS = 30   // blueprint and scaffold blocks together
// Time budget (agent/blueprint_exec.js): the loop keeps MARGIN_MS free before the deadline; the final tidy and
// step-clear then run with FINAL_MS reserved.
export { MARGIN_MS }

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
    const got = loadBlueprint(motor, arg, 'build')
    if (got.error) return got.error
    const acc = got.acc
    let bp = got.bp
    const bot = motor.bot
    const blockAt = p => bot.blockAt(new Vec3(p.x, p.y, p.z))
    const scaffold = typeof acc.scaffold === 'function' ? acc.scaffold(arg) : null
    let placed = 0, dug = 0, scaffolds = 0, removed = 0, complete = false, stalled = false
    const skip = new Map()            // cell key -> why, for this call
    const scaffolded = new Set()      // cells a scaffold was built for in this call (one try each)
    const short = new Map()           // item -> cells lacking it
    const bad = new Set()             // standing spots no path reached in this call
    motor.reserveMs = MARGIN_MS       // motor is this run's context: the reserve applies to this run only

    // Scaffold blocks whose layer (or segment) has no work left are dug; all of them once the build is complete.
    const tidy = async (w, all = false) => {
      if (!scaffold?.length) return
      const seg = bp.segment ?? 0
      const needed = s => !all && s.segment === seg && w.work.some(c => c.layer === s.layer)
      removed += await motor.removeScaffold(scaffold, { avoid: new Set(w.work.map(c => key(c.pos))), keep: needed, bad })
    }
    let w = buildWork(bp, blockAt)
    await motor.stepClear(new Set(w.work.map(c => key(c.pos))))
    await tidy(w)

    for (;;) {
      motor.check()
      if (placed + scaffolds >= MAX_PLACEMENTS || motor.timeLeft() < 2000) break
      await motor.settleInventory(2, 20)   // Paper resyncs the inventory after every placement: count after the burst
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
      let acted = false, outOfTime = false
      for (const c of order) {
        const k = key(c.pos)
        if (skip.has(k)) continue
        if (c.op === 'dig') {
          const r = await motor.digCell(c.pos, { avoid, bad })
          if (r.ok) { dug++; acted = true; break }
          if (r.why === 'no_time') { outOfTime = true; break }
          skip.set(k, r.why); continue
        }
        const item = itemForBlock(c.want) ?? c.want
        if (!motor.count(item)) { short.set(item, (short.get(item) ?? 0) + 1); skip.set(k, 'no_materials'); continue }
        if (!faces(c.pos, blockAt).length) continue   // nothing to place against yet: a cell later in the order first
        if (occupied.has(k)) { skip.set(k, 'occupied'); continue }
        const r = await motor.placeCell(c.pos, item, c.want, { avoid, bad })
        if (r.ok) { placed++; acted = true; if (motor.current) motor.current.progress = Math.min(1, (placed + scaffolds) / MAX_PLACEMENTS); break }
        if (r.why === 'no_time') { outOfTime = true; break }
        if (r.why === 'unreachable' && scaffold && !scaffolded.has(k)) {
          scaffolded.add(k)
          const material = scaffoldMaterial(inventoryOf(bot), w.needs)
          if (material) {
            const s = await motor.scaffoldTo(c.pos, { list: scaffold, avoid: w.allKeys, material, layer: c.layer, segment: bp.segment ?? 0, max: MAX_PLACEMENTS - placed - scaffolds })
            scaffolds += s.placed
            if (s.plan) { acted = true; break }
          }
        }
        skip.set(k, r.why)
      }
      if (outOfTime) break
      if (!acted) { stalled = true; break }
    }

    // Never end standing in a cell still to fill; the scaffold goes once its layer is done or the build is complete.
    // Both run with their own small reserve, after the loop's margin.
    motor.reserveMs = FINAL_MS
    bp = acc.get(arg)
    w = buildWork(bp, blockAt)
    await tidy(w, complete)
    await motor.stepClear(new Set(w.work.map(c => key(c.pos))))
    const scaffoldLeft = scaffold?.length ?? 0

    const unreachable = w.work.filter(c => ['unreachable', 'occupied', 'rejected', 'unbreakable', 'no_face', 'solid', 'unloaded'].includes(skip.get(key(c.pos))) ||
      (stalled && !skip.has(key(c.pos)) && c.op !== 'dig' && !faces(c.pos, blockAt).length)).length   // floating: only once nothing else can be done
    const noPath = w.work.filter(c => skip.get(key(c.pos)) === 'no_path').length
    const liquid = w.blocked.length
    if (placed + dug + scaffolds + removed > 0 || complete) {
      const parts = [`+${placed} placed`]
      if (dug) parts.push(`${dug} dug`)
      if (scaffolds) parts.push(`${scaffolds} scaffold`)
      if (removed) parts.push(`${removed} scaffold removed`)
      if (unreachable) parts.push(`${unreachable} unreachable`)
      if (liquid) parts.push(`${liquid} blocked`)
      if (complete && !scaffoldLeft) parts.push('complete')
      else if (complete) parts.push(`${scaffoldLeft} scaffold left`)
      return { result: 'ok', detail: parts.join(', ') }
    }
    if (short.size) return { result: 'no_materials', detail: [...short.keys()][0] }
    if (noPath && !unreachable) return { result: 'no_path', detail: `${noPath} cells` }
    if (!unreachable && !noPath) return { result: 'ok', detail: '+0 placed' }   // out of time before any step
    return { result: 'unreachable', detail: `${unreachable + noPath} cells` }
  },
}
export default plugin
