// hunt(<mob>): get a recipes.HUNT drop from the nearest such mob within 32 m (never a player, a named animal or a
// baby). Which drop: the goal's (obs.goalTop.arg of a hunt goal, e.g. white_wool -> shear, mutton -> kill); without
// one, shear a sheep when shears are held, else kill. via 'shear': equip shears, walk within 2 m, activateEntity, then
// walk over the wool dropped within 6 m for up to 5 s; an already sheared sheep is skipped (the next nearest is
// taken). via 'kill': the best weapon and mineflayer-pvp (as fight(threat) does), wait up to 30 s for the mob to be
// gone, then walk over its drops within 6 m for up to 5 s. ok (+n <drop>) when the drop rose; not_found when no such
// mob is within 32 m; needs_tool (shears) for a shear drop without shears; took_damage comes from the runner's
// interrupt. Under a hunt goal, a kill that drops something else than the goal's drop (a cow without leather) is failed
// with the gains; without a goal any drop of the mob is ok.
import pathfinderPkg from 'mineflayer-pathfinder'
import mcDataFor from 'minecraft-data'
import { HUNT } from '../recipes.js'
import { pickUpItems, PICKUP_M } from './receive.mjs'

const { goals } = pathfinderPkg
export const RANGE = 32
const KILL_S = 30
const COLLECT_MS = 5000
const SHEAR_REACH = 2
const sleep = ms => new Promise(r => setTimeout(r, ms))
export const MOBS = new Set(Object.values(HUNT).flatMap(h => h.mobs))
const dropsOf = mob => Object.keys(HUNT).filter(d => HUNT[d].mobs.includes(mob))

// The HUNT drop this run aims at: the hunt goal's own drop when this mob gives it, else shear when that is possible
// with the held shears, else the first kill drop of the mob. Pure.
export function huntDrop(mob, goalTop, inventory = {}) {
  if (goalTop?.kind === 'hunt' && HUNT[goalTop.arg]?.mobs.includes(mob)) return goalTop.arg
  const drops = dropsOf(mob)
  return drops.find(d => HUNT[d].via === 'shear' && (inventory[HUNT[d].tool] || 0) > 0) ?? drops.find(d => HUNT[d].via === 'kill') ?? drops[0] ?? null
}

// Entity metadata by key, at its index in minecraft-data 1.20.4's metadataKeys (custom_name 2, baby 16, sheep wool 17
// whose bit 0x10 is 'sheared'); prismarine-entity keeps metadata as an array indexed that way.
const md = mcDataFor('1.20.4')
const meta = (e, key) => {
  const i = md.entitiesByName[e.name]?.metadataKeys?.indexOf(key) ?? -1
  return i >= 0 ? e.metadata?.[i] : undefined
}
export const isNamed = e => { const n = meta(e, 'custom_name'); return n !== undefined && n !== null && n !== '' }
export const isBaby = e => meta(e, 'baby') === true
export const isSheared = e => ((Number(meta(e, 'wool')) || 0) & 0x10) !== 0

// Whether `e` may be hunted as `mob` (shear: not yet sheared).
export function huntable(e, mob, shear) {
  return !!e && e.name === mob && e.type !== 'player' && e.isValid !== false && !isNamed(e) && !isBaby(e) && !(shear && isSheared(e))
}

const plugin = {
  id: 'hunt',
  timeout: 60,
  breaker: true,
  // Under hunt(<drop>): the drop's mobs seen in obs.entities (nearest first), else its first mob so the option exists
  // and fails not_found (the breaker withholds it).
  options(obs, goal) {
    if (goal?.kind !== 'hunt' || !HUNT[goal.arg]) return []
    const mobs = HUNT[goal.arg].mobs
    const seen = [...new Set((obs.entities || []).filter(e => mobs.includes(e.name) && (e.dist ?? 0) <= RANGE).map(e => e.name))]
    const verb = HUNT[goal.arg].via === 'shear' ? 'shear' : 'hunt'
    return (seen.length ? seen : [mobs[0]]).map(m => ({ arg: m, desc: `${verb} a ${m.replace(/_/g, ' ')} for ${goal.arg.replace(/_/g, ' ')}` }))
  },
  preconditions(obs, arg) { return MOBS.has(arg) },
  async run(motor, mob, obs) {
    if (!MOBS.has(mob)) return { result: 'failed', detail: `${mob} is not hunted` }
    const bot = motor.bot
    await motor.settleInventory()
    const inv = {}
    for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const drop = huntDrop(mob, obs?.goalTop, inv)
    const h = HUNT[drop]
    const shear = h.via === 'shear'
    if (shear && !motor.item(h.tool)) return { result: 'needs_tool', detail: h.tool }
    const target = bot.nearestEntity(e => huntable(e, mob, shear) && e.position.distanceTo(bot.entity.position) <= RANGE)
    if (!target) return { result: 'not_found', detail: `no ${shear ? 'unsheared ' : ''}${mob} within ${RANGE} m` }
    const wanted = shear ? [drop] : dropsOf(mob).filter(d => HUNT[d].via === 'kill')
    const want = n => wanted.includes(n) || n === drop
    const before = Object.fromEntries([...new Set([...wanted, drop])].map(d => [d, motor.count(d)]))

    if (shear) {
      await bot.equip(motor.item(h.tool), 'hand')
      motor.check()
      if (bot.entity.position.distanceTo(target.position) > SHEAR_REACH) await motor.goto(new goals.GoalFollow(target, SHEAR_REACH - 0.5))
      motor.check()
      if (!target.isValid || !bot.entities[target.id]) return { result: 'target_gone', detail: `the ${mob} left` }
      if (bot.entity.position.distanceTo(target.position) > 3.5) return { result: 'target_gone', detail: `the ${mob} walked off` }
      await bot.lookAt(target.position.offset(0, target.height / 2, 0), true)
      await bot.activateEntity(target)
      motor.current && (motor.current.progress = 0.5)
      await sleep(300)
    } else {
      await motor.equipWeapon()
      motor.check()
      bot.pvp.attack(target)
      const t0 = Date.now()
      for (;;) {
        motor.check()
        if (!target.isValid || !bot.entities[target.id]) break
        if (Date.now() - t0 > KILL_S * 1000) { try { bot.pvp.stop() } catch {} return { result: 'timeout', detail: `the ${mob} is still alive after ${KILL_S} s` } }
        if (bot.entity.position.distanceTo(target.position) > RANGE) { try { bot.pvp.stop() } catch {} return { result: 'target_gone', detail: 'out of range' } }
        await sleep(250)
      }
      try { bot.pvp.stop() } catch {}
      bot.pathfinder.setGoal(null)
      motor.current && (motor.current.progress = 0.5)
    }
    await pickUpItems(motor, want, { radius: PICKUP_M, ms: COLLECT_MS, stop: ({ idleMs }) => idleMs >= 1500 })
    await motor.settleInventory()
    const gains = Object.entries(before).map(([d, n]) => [d, motor.count(d) - n]).filter(([, n]) => n > 0)
    const text = gains.map(([d, n]) => `+${n} ${d}`).join(', ')
    // Under a hunt goal its drop must rise; without one (a direct call) any drop of the mob counts.
    const goalDrop = obs?.goalTop?.kind === 'hunt' && obs.goalTop.arg === drop
    if (goalDrop ? gains.some(([d]) => d === drop) : gains.length) return { result: 'ok', detail: text }
    return { result: 'failed', detail: `${shear ? 'sheared' : 'killed'} a ${mob}, no ${drop}${text ? ` (${text})` : ''}` }
  },
}
export default plugin
