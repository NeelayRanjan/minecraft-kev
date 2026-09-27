// stay(<name> | here): the user's "wait over here" (2026-09-27), under the goal stay(player:<name>) or stay(here). The
// first run fixes the spot: for a player, the bot walks to them (go_to_player's followPlayer, with the /data fallback
// for a player out of sight) and the spot is where the player stood when it arrived (the bot does not follow them
// around afterwards); for here, where the bot stands. The spot is kept per goal in motor.mem.staySpot. Every run then
// walks back to the spot when farther than STAY_M, and holds it for STAY_RUN_S: drops within 6 m are picked up
// (linger's holdAround), and being pushed more than BACK_M away walks it back. Eating and the threat responses are
// the option layer's (the goal offers them beside this option).
import pathfinderPkg from 'mineflayer-pathfinder'
import { followPlayer } from './go_to_player.mjs'
import { holdAround, playerPos } from './linger.mjs'

const { goals } = pathfinderPkg
export const STAY_M = 3
export const BACK_M = 5
export const STAY_RUN_S = 15
const PATH_ERRORS = new Set(['NoPath', 'Timeout', 'GoalChanged', 'PathStopped'])
const validArg = arg => typeof arg === 'string' && /^\w{1,16}$/.test(arg)
const at = p => ({ x: p.x, y: p.y, z: p.z })

// The spot for this goal (goal id from obs.goalTop): kept, or fixed now. {spot} or a typed failure.
async function spotFor(motor, arg, obs) {
  const goalId = obs?.goalTop?.id ?? null
  const kept = motor.mem?.staySpot
  if (kept && kept.goalId === goalId && kept.arg === arg) return { spot: kept.pos }
  let pos
  if (arg === 'here') pos = at(motor.bot.entity.position)
  else {
    const r = await followPlayer(motor, arg, { holdMs: 0 })
    if (r.result !== 'ok') return { fail: r }
    motor.check()
    pos = at(playerPos(motor, arg) ?? motor.bot.entity.position)
  }
  if (motor.mem) motor.mem.staySpot = { goalId, arg, pos }
  return { spot: pos }
}

const plugin = {
  id: 'stay',
  timeout: 150,   // the first run may walk to a far player (followPlayer's /data approach), then holds STAY_RUN_S
  breaker: true,
  options(obs, goal) {
    if (goal?.kind !== 'stay') return []
    if (goal.arg === 'here') return [{ arg: 'here', desc: 'stay on this spot and pick up anything dropped nearby' }]
    const m = /^player:(\w{1,16})$/.exec(goal.arg ?? '')
    return m ? [{ arg: m[1], desc: `wait where ${m[1]} is and pick up anything dropped nearby` }] : []
  },
  preconditions(obs, arg) { return validArg(arg) },
  async run(motor, arg, obs) {
    if (!validArg(arg)) return { result: 'failed', detail: `bad stay arg ${arg}` }
    const s = await spotFor(motor, arg, obs)
    if (s.fail) return s.fail
    const spot = s.spot, bot = motor.bot
    if (bot.entity.position.distanceTo(spot) > STAY_M) {
      try { await motor.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 2)) } catch (e) {
        if (!PATH_ERRORS.has(e?.name)) throw e
        return { result: 'no_path', detail: 'cannot get back to the spot' }
      }
      motor.check()
    }
    const ms = Math.min(STAY_RUN_S * 1000, (motor.deadline ?? Infinity) - Date.now() - 1000)
    const r = await holdAround(motor, { center: () => spot, keepM: BACK_M, ms })
    return r ?? { result: 'ok', detail: arg === 'here' ? 'holding the spot' : `holding the spot near ${arg}` }
  },
}
export default plugin
