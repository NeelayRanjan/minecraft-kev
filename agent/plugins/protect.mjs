// protect(<name>): guard a player (live retry session: "Im so scared, there is a skeleton next to me" was refused).
// Under the goal protect(player:<name>). For up to PROTECT_RUN_S per run: the hostile mob nearest to the player within
// GUARD_M of them (classifyEntity 'hostile': never a player, never a passive mob) is attacked with the best weapon
// (mineflayer-pvp, as fight(threat) does) until it is dead, gone, or has left the player's side; otherwise the bot keeps
// close to the player (GoalFollow 2). A player out of sight is reached first (go_to_player's followPlayer, with the
// /data fallback). ok with the count of fights; the goal ends after 120 s (goals.PROTECT_S), at a new request or "stop".
// Safety (final review, Important 6): a creeper is never attacked (melee next to one is how bots die): within
// CREEPER_KEEP_M of the bot, the bot moves to the player's far side from it; at PROTECT_MIN_HEALTH or less the bot never
// engages: it eats if it can, else steps behind the player (away from the threat) and ends the run, so the decision layer
// can pick flee or eat; the option is not offered at that health (preconditions) and the goal guard never forces it.
import pathfinderPkg from 'mineflayer-pathfinder'
import mcDataFor from 'minecraft-data'
import { classifyEntity } from '../summary.js'
import { followPlayer, playerEntity } from './go_to_player.mjs'
import { playerPos } from './linger.mjs'
import { FOOD } from '../subtasks.js'

const { goals } = pathfinderPkg
const md = mcDataFor('1.20.4')
export const GUARD_M = 8
export const PROTECT_RUN_S = 20
const FIGHT_S = 15
const FOLLOW_M = 2
export const PROTECT_MIN_HEALTH = 8   // at or below: never engage (the goal guard's FIGHT_HEALTH is the same number)
export const CREEPER_KEEP_M = 6       // a creeper this close to the bot: move away past the player
const BEHIND_M = 3                    // how far past the player a retreat goes
const RETREAT_S = 3
const sleep = ms => new Promise(r => setTimeout(r, ms))
const validName = name => typeof name === 'string' && /^\w{1,16}$/.test(name)

// The hostile mob nearest to `center` within `radius` of it, else null. Players and passive mobs never count, and
// neither do creepers (never attacked; creeperNear).
export function threatNear(entities, center, radius = GUARD_M, mcData = md) {
  let best = null, bestD = radius
  for (const e of Object.values(entities || {})) {
    if (!e?.position || e.isValid === false || e.name === 'creeper' || classifyEntity(e, mcData) !== 'hostile') continue
    const d = e.position.distanceTo(center)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

// The creeper nearest to `center` within `radius`, else null.
export function creeperNear(entities, center, radius = GUARD_M) {
  let best = null, bestD = radius
  for (const e of Object.values(entities || {})) {
    if (!e?.position || e.isValid === false || e.name !== 'creeper') continue
    const d = e.position.distanceTo(center)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

// The spot past the player on the far side from `from` (horizontal): BEHIND_M past the player, and at least minFrom
// from `from`; the player's spot without one.
function behind(player, from, minFrom = 0) {
  if (!from) return player
  const dx = player.x - from.x, dz = player.z - from.z, n = Math.hypot(dx, dz)
  if (n < 1e-6) return player
  const k = Math.max(BEHIND_M, minFrom - n)
  return player.offset(dx / n * k, 0, dz / n * k)
}

// One step of the guard (pure): {act: 'attack', target} | {act: 'eat'} | {act: 'retreat', to, why} | {act: 'follow'}.
// health <= PROTECT_MIN_HEALTH: eat when it can (food below 20 and something to eat), else retreat past the player,
// away from the threat. A creeper within CREEPER_KEEP_M of the bot: retreat past the player, away from it (it comes
// before any attack). Otherwise attack the hostile (never a creeper: threatNear skips them), else follow.
export function protectDecision({ health, food, hasFood, bot, player, hostile = null, creeper = null }) {
  if ((health ?? 20) <= PROTECT_MIN_HEALTH) {
    if (hasFood && (food ?? 20) < 20) return { act: 'eat' }
    return { act: 'retreat', to: behind(player, (hostile ?? creeper)?.position ?? null), why: 'low_health' }
  }
  if (creeper && bot && creeper.position.distanceTo(bot) < CREEPER_KEEP_M) return { act: 'retreat', to: behind(player, creeper.position, CREEPER_KEEP_M + 2), why: 'creeper' }
  if (hostile && hostile.name !== 'creeper') return { act: 'attack', target: hostile }
  return { act: 'follow' }
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
  preconditions(obs, arg) { return validName(arg) && (obs?.health ?? 20) > PROTECT_MIN_HEALTH },
  async run(motor, name) {
    if (!validName(name)) return { result: 'failed', detail: `bad player name ${name}` }
    const bot = motor.bot
    if (!playerPos(motor, name)) {
      const r = await followPlayer(motor, name, { holdMs: 0 })
      if (r.result !== 'ok') return r
      motor.check()
    }
    const end = Date.now() + Math.min(PROTECT_RUN_S * 1000, (motor.deadline ?? Infinity) - Date.now() - 1500)
    let fights = 0, following = null, lastRetreat = null
    try {
      while (Date.now() < end) {
        motor.check()
        const center = playerPos(motor, name)
        if (!center) return { result: 'player_gone', detail: `${name} left or went out of sight` }
        const food = (bot.inventory?.items?.() ?? []).find(i => FOOD.has(i.name))
        const d = protectDecision({ health: bot.health, food: bot.food, hasFood: !!food, bot: bot.entity.position, player: center,
          hostile: threatNear(bot.entities, center), creeper: creeperNear(bot.entities, bot.entity.position, CREEPER_KEEP_M) })
        if (d.act === 'eat') {
          following = null
          try { bot.pathfinder.setGoal(null) } catch {}
          motor.log?.(`protect: health ${Math.round(bot.health)}, eating ${food.name}`)
          try { await bot.equip(food, 'hand'); await bot.consume() } catch (e) { return { result: 'ok', detail: `low health (${Math.round(bot.health)}), could not eat: ${e?.message || e}` } }
          continue
        }
        if (d.act === 'retreat') {
          following = null
          try { bot.pvp.stop() } catch {}
          if (lastRetreat !== d.why) motor.log?.(`protect: ${d.why === 'creeper' ? 'creeper near' : `health ${Math.round(bot.health)}`}, stepping behind ${name}`)
          lastRetreat = d.why
          bot.pathfinder.setGoal(new goals.GoalNear(d.to.x, d.to.y, d.to.z, 1))
          const t0 = Date.now()
          while (Date.now() - t0 < RETREAT_S * 1000 && Date.now() < end) {
            await sleep(250)   // at least one wait per step: the spot may already be reached with the creeper still near
            motor.check()
            if (bot.entity.position.distanceTo(d.to) <= 1.5) break
          }
          try { bot.pathfinder.setGoal(null) } catch {}
          if (d.why === 'low_health') return { result: 'ok', detail: `low health (${Math.round(bot.health)}): stepped back behind ${name}` }
          continue
        }
        lastRetreat = null
        const h = d.act === 'attack' ? d.target : null
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
