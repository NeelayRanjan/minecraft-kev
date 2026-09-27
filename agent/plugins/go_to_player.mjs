// go_to_player(<name>): walk to a player and stay with them: pathfinder GoalFollow(entity, 2) as a dynamic goal (it
// tracks the player as they move), ok once within 3 m for 5 s in a row. Typed failures: player_gone (not on the
// server, out of tracking range, or in spectator mode: a spectator has no entity for other clients), no_path (the
// pathfinder reports noPath three times in a row while still farther than 3 m). Player names are \w{1,16}, so the
// name is the option arg. followPlayer() is shared with receive(<item>), which walks to the giver first.
import pathfinderPkg from 'mineflayer-pathfinder'

const { goals } = pathfinderPkg
export const NEAR_M = 3
export const HOLD_S = 5
const FOLLOW_M = 2
const NO_PATH_LIMIT = 3
const sleep = ms => new Promise(r => setTimeout(r, ms))
const validName = name => typeof name === 'string' && /^\w{1,16}$/.test(name)

// The player's live entity as this client sees it, else null (gone, untracked, spectator).
export function playerEntity(bot, name) {
  const p = bot.players?.[name]
  if (!p || p.gamemode === 3) return null
  const e = p.entity
  return e && e.isValid !== false && e.position ? e : null
}

// Follow `name` until within NEAR_M for holdMs in a row: { result: 'ok' | 'player_gone' | 'no_path', detail }.
// Timeouts and interrupts come from motor.check() (the run's deadline).
export async function followPlayer(motor, name, { holdMs = HOLD_S * 1000 } = {}) {
  const bot = motor.bot
  let target = playerEntity(bot, name)
  if (!target) return { result: 'player_gone', detail: `${name} is not in sight` }
  bot.pathfinder.setGoal(null)   // drains a stale stop flag before the new goal (Motor.goto does the same)
  await bot.waitForTicks(1)
  motor.check()
  let noPath = 0, since = null
  const onPath = r => { if (r?.status === 'noPath') noPath++; else if (r?.status === 'success' || r?.status === 'partial') noPath = 0 }
  bot.on('path_update', onPath)
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_M), true)
    for (;;) {
      motor.check()
      const e = playerEntity(bot, name)
      if (!e) return { result: 'player_gone', detail: `${name} left or went out of sight` }
      if (e !== target) { target = e; bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_M), true) }   // respawned: a new entity
      const d = bot.entity.position.distanceTo(e.position)
      if (d <= NEAR_M) {
        since ??= Date.now()
        if (Date.now() - since >= holdMs) return { result: 'ok', detail: `with ${name} (${d.toFixed(1)} m)` }
        if (motor.current) motor.current.progress = 0.5 + 0.5 * Math.min(1, (Date.now() - since) / Math.max(1, holdMs))
      } else {
        since = null
        if (noPath >= NO_PATH_LIMIT) return { result: 'no_path', detail: `${name} is ${Math.round(d)} m away` }
      }
      await sleep(250)
    }
  } finally {
    bot.removeListener('path_update', onPath)
    try { bot.pathfinder.setGoal(null) } catch {}
  }
}

const plugin = {
  id: 'go_to_player',
  timeout: 60,
  breaker: true,
  // Under go_to(player:<name>): go_to_player(<name>), offered even when the player is out of sight (it fails
  // player_gone and the breaker withholds it).
  options(obs, goal) {
    if (goal?.kind !== 'go_to') return []
    const m = /^player:(\w{1,16})$/.exec(goal.arg ?? '')
    return m ? [{ arg: m[1], desc: `walk to ${m[1]}` }] : []
  },
  preconditions(obs, arg) { return validName(arg) },
  async run(motor, arg) {
    if (!validName(arg)) return { result: 'failed', detail: `bad player name ${arg}` }
    return followPlayer(motor, arg)
  },
}
export default plugin
