// protect(<name>): guard a player (live retry session: "Im so scared, there is a skeleton next to me" was refused).
// Under the goal protect(player:<name>). For up to PROTECT_RUN_S per run: the hostile mob nearest to the player within
// GUARD_M of them (classifyEntity 'hostile': never a player, never a passive mob) is attacked with the best weapon
// (mineflayer-pvp, as fight(threat) does) until it is dead, gone, or has left the player's side; otherwise the bot keeps
// close to the player (GoalFollow 2). A player out of sight is reached first (go_to_player's followPlayer, with the
// /data fallback). ok with the count of fights; the goal ends after 120 s (goals.PROTECT_S), at a new request or "stop".
import pathfinderPkg from 'mineflayer-pathfinder'
import mcDataFor from 'minecraft-data'
import { classifyEntity } from '../summary.js'
import { followPlayer, playerEntity } from './go_to_player.mjs'
import { playerPos } from './linger.mjs'

const { goals } = pathfinderPkg
const md = mcDataFor('1.20.4')
export const GUARD_M = 8
export const PROTECT_RUN_S = 20
const FIGHT_S = 15
const FOLLOW_M = 2
const sleep = ms => new Promise(r => setTimeout(r, ms))
const validName = name => typeof name === 'string' && /^\w{1,16}$/.test(name)

// The hostile mob nearest to `center` within `radius` of it, else null. Players and passive mobs never count.
export function threatNear(entities, center, radius = GUARD_M, mcData = md) {
  let best = null, bestD = radius
  for (const e of Object.values(entities || {})) {
    if (!e?.position || e.isValid === false || classifyEntity(e, mcData) !== 'hostile') continue
    const d = e.position.distanceTo(center)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

const plugin = {
  id: 'protect',
  timeout: 150,   // a far player is reached first (followPlayer's /data approach), then PROTECT_RUN_S of guarding
  breaker: true,
  options(obs, goal) {
    if (goal?.kind !== 'protect') return []
    const m = /^player:(\w{1,16})$/.exec(goal.arg ?? '')
    return m ? [{ arg: m[1], desc: `stay with ${m[1]} and fight hostile mobs near them` }] : []
  },
  preconditions(obs, arg) { return validName(arg) },
  async run(motor, name) {
    if (!validName(name)) return { result: 'failed', detail: `bad player name ${name}` }
    const bot = motor.bot
    if (!playerPos(motor, name)) {
      const r = await followPlayer(motor, name, { holdMs: 0 })
      if (r.result !== 'ok') return r
      motor.check()
    }
    const end = Date.now() + Math.min(PROTECT_RUN_S * 1000, (motor.deadline ?? Infinity) - Date.now() - 1500)
    let fights = 0, following = null
    try {
      while (Date.now() < end) {
        motor.check()
        const center = playerPos(motor, name)
        if (!center) return { result: 'player_gone', detail: `${name} left or went out of sight` }
        const h = threatNear(bot.entities, center)
        if (h) {
          fights++; following = null
          motor.log?.(`protect: ${h.name} ${h.position.distanceTo(center).toFixed(1)} m from ${name}, attacking`)
          await motor.equipWeapon?.()
          bot.pvp.attack(h)
          const t0 = Date.now()
          while (Date.now() - t0 < FIGHT_S * 1000 && Date.now() < end) {
            motor.check()
            if (!h.isValid || !bot.entities[h.id]) break
            const c = playerPos(motor, name)
            if (c && h.position.distanceTo(c) > GUARD_M * 2) break   // it left the player's side
            await sleep(250)
          }
          try { bot.pvp.stop() } catch {}
          continue
        }
        const e = playerEntity(bot, name)
        if (bot.entity.position.distanceTo(center) > FOLLOW_M + 2) {
          if (e && following !== e) { bot.pathfinder.setGoal(new goals.GoalFollow(e, FOLLOW_M), true); following = e }
          else if (!e) { bot.pathfinder.setGoal(new goals.GoalNear(center.x, center.y, center.z, FOLLOW_M)); following = null }
        }
        await sleep(250)
      }
    } finally {
      try { bot.pvp.stop() } catch {}
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    return { result: 'ok', detail: fights ? `fought ${fights} mob${fights === 1 ? '' : 's'} near ${name}` : `guarded ${name}` }
  },
}
export default plugin
