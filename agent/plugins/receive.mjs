// receive(<item>): take items a player drops for the bot. The giver's name is not in the option (args are \w+ and the
// id is receive(<item>)): it comes from the goal, obs.goalTop.from (the runner puts the top goal's public fields on
// obs.goalTop); without one, the nearest other player within 32 m. Walks to the giver first (followPlayer, no hold),
// then for up to 60 s walks over item entities of <item> within 6 m (entity.name 'item', the dropped stack read with
// getDroppedItem()), until the goal's count is held (obs.goalTop.count) or, after a rise, 3 s pass with no <item> left
// in range. ok (+n <item>) when the count rose, else timeout; player_gone when there is no giver and nothing dropped
// in range. Says nothing itself (the runner announces "waiting for your <item>" at the goal start).
// pickUpItems() is shared with hunt(<mob>) (wool and meat drops).
import pathfinderPkg from 'mineflayer-pathfinder'
import { isItem } from '../recipes.js'
import { followPlayer, playerEntity, NEAR_M } from './go_to_player.mjs'

const { goals } = pathfinderPkg
export const PICKUP_M = 6
export const WAIT_S = 60
const GIVER_M = 32
const IDLE_AFTER_GAIN_MS = 3000
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The item name a dropped-item entity carries, else null (not an item entity, or its metadata not received yet).
export function droppedName(e) {
  if (!e || e.name !== 'item') return null
  try { return e.getDroppedItem?.()?.name ?? null } catch { return null }
}

// Item entities within `radius` of the bot whose item passes `want`, nearest first.
export function wantedDrops(bot, want, radius = PICKUP_M, skip = new Set()) {
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.isValid !== false && e.position && !skip.has(e.id) && e.position.distanceTo(me) <= radius)
    .filter(e => { const n = droppedName(e); return n !== null && want(n) })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// Walk over wanted item entities within `radius` for up to `ms`. Returns early when stop({ idleMs }) is true (idleMs:
// how long no wanted item has been in range). An item the pathfinder cannot reach twice is skipped.
export async function pickUpItems(motor, want, { radius = PICKUP_M, ms, stop = () => false } = {}) {
  const bot = motor.bot
  const end = Date.now() + ms
  const misses = new Map(), skip = new Set()
  let lastSeen = Date.now()
  while (Date.now() < end) {
    motor.check()
    const drops = wantedDrops(bot, want, radius, skip)
    if (drops.length) lastSeen = Date.now()
    if (stop({ idleMs: Date.now() - lastSeen })) return
    const e = drops[0]
    if (!e) { await sleep(250); continue }
    const p = e.position
    if (bot.entity.position.distanceTo(p) > 1) {
      try { await motor.goto(new goals.GoalNear(p.x, p.y, p.z, 1)) } catch (err) {
        if (!['NoPath', 'Timeout', 'GoalChanged', 'PathStopped'].includes(err?.name)) throw err
        misses.set(e.id, (misses.get(e.id) || 0) + 1)
        if (misses.get(e.id) >= 2) skip.add(e.id)
      }
    }
    await sleep(250)   // the pickup delay of a tossed stack is 2 s: standing on it is enough
  }
}

// The giver: obs.goalTop.from when it names a player, else the nearest other player within 32 m, else null.
export function giverName(bot, obs) {
  const from = obs?.goalTop?.from
  if (typeof from === 'string' && /^\w{1,16}$/.test(from)) return from
  let best = null, bestD = Infinity
  for (const name of Object.keys(bot.players || {})) {
    if (name === bot.username) continue
    const e = playerEntity(bot, name)
    const d = e ? e.position.distanceTo(bot.entity.position) : Infinity
    if (d <= GIVER_M && d < bestD) { best = name; bestD = d }
  }
  return best
}

const plugin = {
  id: 'receive',
  timeout: 100,   // the walk to the giver, then up to 60 s of waiting
  breaker: false,
  options(obs, goal) {
    if (goal?.kind !== 'receive' || !isItem(goal.arg)) return []
    return [{ arg: goal.arg, desc: `take the ${goal.arg.replace(/_/g, ' ')} ${goal.from ?? 'a player'} drops` }]
  },
  preconditions(obs, arg) { return isItem(arg) },
  async run(motor, item, obs) {
    if (!isItem(item)) return { result: 'failed', detail: `unknown item ${item}` }
    const bot = motor.bot
    const want = n => n === item
    const from = giverName(bot, obs)
    const g = obs?.goalTop
    const goalCount = Number.isInteger(g?.count) && (g.arg == null || g.arg === item) ? g.count : null
    await motor.settleInventory()
    const before = motor.count(item)
    const giver = from ? playerEntity(bot, from) : null
    if (!giver && !wantedDrops(bot, want).length) return { result: 'player_gone', detail: from ? `${from} is not in sight` : `no player within ${GIVER_M} m` }
    if (giver && giver.position.distanceTo(bot.entity.position) > NEAR_M) {
      const r = await followPlayer(motor, from, { holdMs: 0 })
      if (r.result !== 'ok') return r
      motor.check()
    }
    // Wait inside the run's own deadline, so a gain is reported as ok instead of being cut off as a timeout.
    const ms = Math.min(WAIT_S * 1000, (motor.deadline ?? Infinity) - Date.now() - 1500)
    const gained = () => motor.count(item) - before
    await pickUpItems(motor, want, {
      ms,
      stop: ({ idleMs }) => {
        const n = gained()
        if (motor.current) motor.current.progress = goalCount ? Math.min(1, motor.count(item) / goalCount) : n > 0 ? 0.5 : 0
        return (goalCount != null && motor.count(item) >= goalCount) || (n > 0 && idleMs >= IDLE_AFTER_GAIN_MS)
      },
    })
    await motor.settleInventory()
    const n = gained()
    return n > 0 ? { result: 'ok', detail: `+${n} ${item}` } : { result: 'timeout', detail: `no ${item} dropped within ${Math.round(ms / 1000)} s` }
  },
}
export default plugin
