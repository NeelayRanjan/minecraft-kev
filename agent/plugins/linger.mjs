// linger(<name>): stay next to a player for a few seconds and pick up whatever lands within 6 m (live retry session:
// "come here" ended at 3 m and the bot walked off before the hand-off). Offered under go_to(player:<name>) once the
// goal has arrived (goals.js: the goal lingers LINGER_S seconds, then it is done). Each run holds for LINGER_RUN_S:
// any item entity within PICKUP_M is walked over (receive's pickUpItems); the bot walks back within 2 m of the player
// when it is farther than LINGER_M. The player's entity, else the position the server last reported (spectators).
// holdAround() is shared with stay(<player|here>).
import pathfinderPkg from 'mineflayer-pathfinder'
import { playerEntity } from './go_to_player.mjs'
import { pickUpItems, wantedDrops } from './receive.mjs'

const { goals } = pathfinderPkg
export const LINGER_RUN_S = 8
export const LINGER_M = 4
const REPORTED_FRESH_MS = 60_000
const PATH_ERRORS = new Set(['NoPath', 'Timeout', 'GoalChanged', 'PathStopped'])
const anyItem = () => true
const sleep = ms => new Promise(r => setTimeout(r, ms))
const validName = name => typeof name === 'string' && /^\w{1,16}$/.test(name)

// Hold around center() (a position or null) for ms: pick up any item entity within 6 m of the bot; when farther than
// keepM from the center walk back to within backToM. null when the time ran out, or {result: 'no_path'} when the way
// back is blocked. Interrupts and timeouts come from motor.check().
export async function holdAround(motor, { center, keepM, backToM = 2, ms }) {
  const bot = motor.bot
  const end = Date.now() + ms
  while (Date.now() < end) {
    motor.check()
    if (wantedDrops(bot, anyItem).length) {
      await pickUpItems(motor, anyItem, { ms: Math.max(0, Math.min(3000, end - Date.now())), stop: ({ idleMs }) => idleMs >= 300 })
      continue
    }
    const c = center()
    if (c && bot.entity.position.distanceTo(c) > keepM) {
      try { await motor.goto(new goals.GoalNear(c.x, c.y, c.z, backToM)) } catch (e) {
        if (!PATH_ERRORS.has(e?.name)) throw e
        return { result: 'no_path', detail: 'cannot get back to the spot' }
      }
      continue
    }
    await sleep(Math.min(250, Math.max(0, end - Date.now())))
  }
  return null
}

// The player's position: the entity, else the fresh server-reported one (go_to_player keeps it in motor.mem).
export function playerPos(motor, name) {
  const e = playerEntity(motor.bot, name)
  if (e) return e.position
  const r = motor.mem?.reportedPlayers?.[name]
  return r && Date.now() - r.at <= REPORTED_FRESH_MS ? r.pos : null
}

const plugin = {
  id: 'linger',
  timeout: 20,
  breaker: false,
  options(obs, goal) {
    if (goal?.kind !== 'go_to') return []
    const m = /^player:(\w{1,16})$/.exec(goal.arg ?? '')
    return m ? [{ arg: m[1], desc: `stay next to ${m[1]} and pick up anything they drop` }] : []
  },
  preconditions(obs, arg) { return validName(arg) },
  async run(motor, name) {
    if (!validName(name)) return { result: 'failed', detail: `bad player name ${name}` }
    const ms = Math.min(LINGER_RUN_S * 1000, (motor.deadline ?? Infinity) - Date.now() - 1000)
    const r = await holdAround(motor, { center: () => playerPos(motor, name), keepM: LINGER_M, ms })
    return r ?? { result: 'ok', detail: `stayed with ${name}` }
  },
}
export default plugin
