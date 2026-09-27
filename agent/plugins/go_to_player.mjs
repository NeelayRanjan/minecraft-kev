// go_to_player(<name>): walk to a player and stay with them: pathfinder GoalFollow(entity, 2) as a dynamic goal (it
// tracks the player as they move), ok once within 3 m for 5 s in a row. Typed failures: player_gone (not on the
// server, out of tracking range, or in spectator mode: a spectator has no entity for other clients), no_path (the
// pathfinder reports noPath three times in a row while still farther than 3 m). Player names are \w{1,16}, so the
// name is the option arg. followPlayer() is shared with receive(<item>), which walks to the giver first.
// Beyond tracking range (~48 m; live stress session: "come here" found nothing to follow and kev walked the surface
// until stuck) the bot, an op, asks the server where the player is (`/data get entity <name> Pos`), reads the reply
// from a server message (never player chat; numbers only), walks toward it (GoalNear 8) and asks again every 10 s until
// the entity comes into range, then follows as above. No reply (not on the server, not op) is player_gone.
import pathfinderPkg from 'mineflayer-pathfinder'

const { goals } = pathfinderPkg
export const NEAR_M = 3
export const HOLD_S = 5
const FOLLOW_M = 2
const FAR_NEAR_M = 8          // the walk toward a /data position ends this close (the entity appears well before)
const QUERY_EVERY_MS = 10_000
const REPLY_MS = 3000
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

// The position in the server's reply to `/data get entity <name> Pos` ("<name> has the following entity data: [x d,
// y d, z d]"), else null. Parses numbers only.
const NUM = '(-?\\d+(?:\\.\\d+)?(?:E-?\\d+)?)[dD]?'
const DATA_POS = new RegExp(`^(\\w{1,16}) has the following entity data: \\[\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]`)
export function parseDataPos(text, name) {
  const m = DATA_POS.exec(String(text ?? '').trim())
  if (!m || m[1] !== name) return null
  const [x, y, z] = [m[2], m[3], m[4]].map(Number)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}
const plainText = msg => { try { return typeof msg === 'string' ? msg : msg?.toString?.() ?? '' } catch { return '' } }

// Ask the server where `name` is: the parsed position, or null (an error reply, or none within replyMs). Only
// messages that are not player chat (position 'chat') are read.
export function queryPlayerPos(bot, name, { replyMs = REPLY_MS } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (done) return; done = true; clearTimeout(timer); bot.removeListener('message', onMsg); resolve(v) }
    const onMsg = (msg, position) => {
      if (position === 'chat') return
      const text = plainText(msg).trim()
      const pos = parseDataPos(text, name)
      if (pos) return finish(pos)
      if (/^No entity was found/.test(text)) finish(null)
    }
    const timer = setTimeout(() => finish(null), replyMs)
    bot.on('message', onMsg)
    try { bot.chat(`/data get entity ${name} Pos`) } catch { finish(null) }
  })
}

// Walk toward an out-of-sight player by /data queries until the entity is in range: { result: 'seen' } or a typed
// failure (player_gone: no position; no_path: the pathfinder reports noPath three times in a row).
async function approachUnseen(motor, name, { queryEveryMs, replyMs }) {
  const bot = motor.bot
  let lastQuery = -Infinity, noPath = 0
  const onPath = r => { if (r?.status === 'noPath') noPath++; else if (r?.status === 'success' || r?.status === 'partial') noPath = 0 }
  bot.on('path_update', onPath)
  try {
    for (;;) {
      motor.check()
      if (playerEntity(bot, name)) return { result: 'seen' }
      if (noPath >= NO_PATH_LIMIT) return { result: 'no_path', detail: `no path toward ${name}` }
      if (Date.now() - lastQuery >= queryEveryMs) {
        lastQuery = Date.now()
        const pos = await queryPlayerPos(bot, name, { replyMs })
        motor.check()
        if (playerEntity(bot, name)) return { result: 'seen' }
        if (!pos) return { result: 'player_gone', detail: `${name} is not on the server` }
        motor.log?.(`go_to_player: ${name} out of sight, walking toward ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`)
        bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, FAR_NEAR_M))
      }
      await sleep(Math.min(250, queryEveryMs))
    }
  } finally {
    bot.removeListener('path_update', onPath)
  }
}

// Follow `name` until within NEAR_M for holdMs in a row: { result: 'ok' | 'player_gone' | 'no_path', detail }.
// Timeouts and interrupts come from motor.check() (the run's deadline).
export async function followPlayer(motor, name, { holdMs = HOLD_S * 1000, queryEveryMs = QUERY_EVERY_MS, replyMs = REPLY_MS } = {}) {
  const bot = motor.bot
  let target = playerEntity(bot, name)
  if (!target) {
    const r = await approachUnseen(motor, name, { queryEveryMs, replyMs })
    if (r.result !== 'seen') { try { bot.pathfinder.setGoal(null) } catch {} return r }
    target = playerEntity(bot, name)
  }
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
  timeout: 120,   // a walk from beyond tracking range (a /data position) takes longer than following in sight
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
