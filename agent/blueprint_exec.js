// Shared by the blueprint executors (agent/plugins/build_blueprint.mjs, agent/plugins/dig_blueprint.mjs): the time
// budget constants, the blueprint lookup through motor.blueprints and the inventory map. Lives outside agent/plugins/
// because every *.mjs file there is loaded as a plugin.
//
// Time budget: an executor keeps MARGIN_MS free before its run's deadline while it works (motor.reserveMs: every walk
// is capped to end before it, no step starts with under 2 s of it left); its final tidy then runs with FINAL_MS
// reserved. The call returns its own result before the run's deadline, never a timeout after productive work.
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

export const MARGIN_MS = 12_000
export const FINAL_MS = 1500

// Far from the blueprint (Task 7 fix round 1: the smoke's hut answered unreachable (80 cells) from a pit 10+ m away,
// every reach spot out of the pathfinder's short tries): an executor whose nearest work cell is more than APPROACH_M
// away walks toward it first (the walk movements: no digging, no towers; time-capped, a stalled walk ends in 5 s), and
// only then computes reach spots and classifies cells unreachable.
export const APPROACH_M = 12
export const APPROACH_WALK_MS = 45_000
export function approachTarget (work, from, far = APPROACH_M) {
  let best = null, bd = Infinity
  for (const c of work) {
    const d = Math.hypot(c.pos.x + 0.5 - from.x, c.pos.y - from.y, c.pos.z + 0.5 - from.z)
    if (d < bd) { bd = d; best = c.pos }
  }
  return best && bd > far ? { x: best.x, y: best.y, z: best.z } : null
}
// Walk toward the nearest work cell when it is far; never throws but an Abort (an interrupt). true when a walk ran.
export async function approach (motor, work, tag) {
  const target = approachTarget(work, motor.bot.entity.position)
  if (!target) return false
  motor.log(`${tag}: ${Math.round(motor.bot.entity.position.distanceTo?.(new Vec3(target.x, target.y, target.z)) ?? 0)} m from the nearest cell, walking there`)
  try { await motor.walkWithin(new goals.GoalNear(target.x, target.y, target.z, 4), APPROACH_WALK_MS) } catch (e) {
    if (e?.name === 'Abort') throw e
    motor.log(`${tag}: walk toward the blueprint ended (${e?.name ?? e})`)
  }
  motor.check?.()
  return true
}

// The blueprint `arg` of kind `kind` through the accessor motor.blueprints (goals.js registerBlueprintAccessor
// contract; the runner sets it, an arena check may set a BlueprintBook itself): { acc, bp } | { error: <typed result> }.
export function loadBlueprint (motor, arg, kind) {
  const acc = motor.blueprints
  if (!acc?.get) return { error: { result: 'failed', detail: 'no blueprint book' } }
  const bp = acc.get(arg)
  if (!bp) return { error: { result: 'failed', detail: `no blueprint ${arg}` } }
  if (bp.kind !== kind) return { error: { result: 'failed', detail: `${arg} is not a ${kind} blueprint` } }
  return { acc, bp }
}

// { item name: count } of the bot's inventory.
export function inventoryOf (bot) {
  const m = {}
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}
