// One episode: a bot on its own Paper instance, the scripted motor layer, and a 1 Hz decision loop that asks kev (or
// uses one-hot teacher answers), logs every distribution, and writes the trajectory + kev records.
//
//   node agent/run_episode.mjs --seed 7 --port 25580 --policy teacher|kev [--kev-url http://127.0.0.1:8009]
//        [--eps-action 0.1] [--minutes 20] [--out name] [--video] [--no-server] [--difficulty normal] [--quiet]
//
// Writes out/<name>.json (meta / frames / decisions / events / timeline), out/<name>.jsonl (kev records with _meta),
// and out/<name>.mp4 with --video (first-person at --fps, default 5; frame k <-> t = k/fps s).
import fs from 'node:fs'
import path from 'node:path'
import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { plugin as pvp } from 'mineflayer-pvp'
import mcDataFor from 'minecraft-data'
import { startServer } from './server_ctl.js'
import { Motor } from './motor.js'
import { EpisodeMemory, summarize } from './summary.js'
import { serialize } from './serialize.js'
import { buildQuestions, questionMeta, HORIZONS } from './questions.js'
import { techStep } from './teacher.js'
import { counts } from './subtasks.js'
import { chooseAction, interruptFor } from './policy.js'
import { EpisodeLog, oneHot, fromKev } from './logger.js'
import { ask } from './kev_client.js'
import { injectDeaths } from './relabel.js'

// ---- args ------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && !argv[i + 1]?.startsWith('--') ? argv[i + 1] : d }
const flag = k => argv.includes(`--${k}`)
const seed = opt('seed', '1'), port = Number(opt('port', 25580)), policy = opt('policy', 'teacher'), kevUrl = opt('kev-url', null)
const epsAction = Number(opt('eps-action', 0)), minutes = Number(opt('minutes', 20)), successMin = Number(opt('success-minutes', 15))
const name = opt('out', `${policy}_s${seed}`), video = flag('video'), fps = Number(opt('fps', 5)), noServer = flag('no-server'), difficulty = opt('difficulty', 'normal'), quiet = flag('quiet')
if (policy === 'kev' && !kevUrl) { console.error('--policy kev needs --kev-url'); process.exit(2) }
fs.mkdirSync('out', { recursive: true })
const T0 = Date.now()
const log = s => { if (!quiet) console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`) }
const rng = mulberry32(Number.parseInt(String(seed).replace(/\D/g, '') || '0', 10) * 7919 + 17)
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

// ---- server + bot ----------------------------------------------------------------------------------------------
const server = noServer ? null : await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: `kev_${port % 100}`, version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
let finished = false
let wrote = false
const shutdown = async (why, code) => {
  if (finished) return
  finished = true
  log(`shutdown: ${why}`)
  try { clearInterval(loop) } catch {}
  if (!wrote) { try { elog?.finish({ end_reason: `crash: ${why}`.slice(0, 120), ended_t: now?.() ?? null }); fs.writeFileSync(path.join('out', `${name}.json`), JSON.stringify(elog.toJSON())); wrote = true } catch {} }
  try { if (recorder) await recorder.stop() } catch {}
  try { bot.quit() } catch {}
  if (server) await server.stop()
  process.exit(code)
}
process.on('uncaughtException', e => { console.error(e); shutdown(`uncaught: ${e.message}`, 1) })
process.on('unhandledRejection', e => { console.error(e); shutdown(`unhandled: ${e?.message || e}`, 1) })
bot.on('kicked', r => shutdown(`kicked: ${JSON.stringify(r)}`, 1))
bot.on('error', e => log(`bot error: ${e.message}`))

await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 10; i++) { try { await bot.waitForChunksToLoad(); break } catch { log('chunks not ready, retrying') } }
const me = bot.username
// Server commands go to the console when we own the server (works for any bot name); chat needs the bot to be an op.
const command = c => { if (server) server.proc.stdin.write(c + '\n'); else bot.chat('/' + c) }
for (const c of ['time set 0', `difficulty ${difficulty}`, 'gamerule doDaylightCycle true', 'gamerule keepInventory false', 'gamerule doImmediateRespawn true', 'weather clear']) command(c)
await bot.waitForTicks(20)
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log: s => log(`motor: ${s}`) })
const elog = new EpisodeLog({ seed, policy, eps_action: epsAction, minutes, kev_url: kevUrl, model: policy === 'kev' ? 'kev' : null, username: me, version: bot.version,
  difficulty, horizons: HORIZONS, questions: questionMeta(), started: new Date().toISOString(), video: video ? { file: `${name}.mp4`, fps } : null })
let recorder = null
if (video) { const { startRecorder } = await import('./recorder.js'); recorder = startRecorder(bot, { output: path.join('out', `${name}.mp4`), fps, log }) }

// ---- state ------------------------------------------------------------------------------------------------------
const t0 = Date.now()
const now = () => (Date.now() - t0) / 1000
let dead = false, deaths = 0, prevHostileDist = null, subtaskStartHealth = null, ticking = false, doneAt = null, startDay = Number(bot.time.day)
let lastResult = null
bot.on('death', () => { dead = true; deaths++; mem.deaths = deaths; elog.event({ t: now(), kind: 'death', pos: bot.entity?.position }); motor.interrupt('died'); log('died') })
bot.on('respawn', () => { if (dead) elog.event({ t: now(), kind: 'respawn' }); dead = false })
bot.on('health', () => { if (bot.health <= 0) dead = true })

function startSubtask(id, source, obs) {
  subtaskStartHealth = bot.health
  elog.event({ t: now(), kind: 'subtask_start', id, source })
  motor.run(id, obs).then(r => {
    lastResult = { id, result: r.result }
    elog.event({ t: now(), kind: 'subtask_done', id, result: r.result, detail: r.detail ?? null })
    log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
  }).catch(e => { lastResult = { id, result: 'failed' }; elog.event({ t: now(), kind: 'subtask_error', id, error: String(e?.message || e) }) })
}

// The 1 Hz tick is synchronous (sample, frame, interrupts, end conditions) so a slow kev request can never stall the
// timeline; the question/decision path is async and skipped while a previous request is still in flight.
let asking = false, kevErrors = 0
const KEV_DOWN_AFTER = 30
function tick() {
  if (finished) return
  const t = now()
  const cur = motor.current ? { name: motor.current.name, arg: motor.current.arg, elapsedS: motor.elapsedS(), progress: motor.progress() } : null
  const obs = summarize(bot, mcData, mem, { t, current: cur, last: lastResult, goal: 'iron_pickaxe' })
  const step = techStep(obs), c = counts(obs)
  if (obs.done && doneAt == null) { doneAt = t; elog.event({ t, kind: 'goal_done', item: 'iron_pickaxe' }); log(`GOAL: iron pickaxe at ${t.toFixed(0)} s`) }
  elog.sample({ t, step: step.index, rawIron: c.rawIron, ingots: c.ingots, health: dead ? 0 : obs.health, dead, timeOfDay: obs.timeOfDay, day: obs.day, done: obs.done })
  elog.frame({ t, x: +obs.pos.x.toFixed(1), y: +obs.pos.y.toFixed(1), z: +obs.pos.z.toFixed(1), yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2), health: obs.health, food: obs.food, timeOfDay: obs.timeOfDay, hostile: obs.nearestHostile?.dist ?? null })
  const why = interruptFor({ hostileDist: obs.nearestHostile?.dist ?? null, prevHostileDist, current: motor.current, healthDrop: subtaskStartHealth != null ? subtaskStartHealth - obs.health : 0, dead })
  if (why && motor.busy) { elog.event({ t, kind: 'interrupt', reason: why, subtask: motor.current?.id }); motor.interrupt(why) }
  prevHostileDist = obs.nearestHostile?.dist ?? null
  const morning = obs.day > startDay && obs.timeOfDay < 12000
  if (t >= minutes * 60) { finish('time'); return }
  if (morning) { finish(doneAt != null ? 'morning_after_goal' : 'morning'); return }
  if (kevErrors >= KEV_DOWN_AFTER) { finish('kev_down'); return }
  if (!asking) decide(obs, t).catch(e => { console.error(e); shutdown(`decide: ${e.message}`, 1) })
}

async function decide(obs, t) {
  asking = true
  try {
    const decision = !motor.busy && !dead
    const { qs, labels } = buildQuestions(obs, { decision })
    if (!Object.keys(qs).length) return
    const text = serialize(obs)
    let answers, latency = null, source = null, chosen = null
    if (kevUrl) {
      try { const resp = await ask(kevUrl, text, qs, { timeoutMs: 10_000 }); answers = fromKev(resp, qs, labels); latency = resp.latency_ms; kevErrors = 0 }
      catch (e) { kevErrors++; log(`kev error: ${e.message}`); elog.event({ t, kind: 'kev_error', error: String(e.message) }); answers = oneHot(qs, labels); source = 'kev_error' }
    } else answers = oneHot(qs, labels)
    if (finished) return
    if (decision) {
      if (source === 'kev_error' && policy === 'kev') chosen = 'wait'
      else ({ id: chosen, source } = chooseAction({ policy, qs, labels, answers, rng, epsAction }))
      if (source === 'fallback') elog.event({ t, kind: 'fallback', wanted: policy === 'kev' ? answers.next_subtask?.choice : labels.next_subtask })
    }
    elog.decision({ t, state_text: text, decision, qs, labels, answers, chosen, source, latency_ms: latency })
    if (decision && !motor.busy && !finished) startSubtask(chosen, source, obs)
  } finally { asking = false }
}

async function finish(reason) {
  if (finished) return
  const t = now()
  motor.interrupt('episode_end')
  elog.timeline = injectDeaths(elog.timeline, elog.events)   // the sampler rarely catches the few ticks between death and respawn
  elog.finish({ end_reason: reason, ended_t: t, deaths, goal_done_t: doneAt, success_15min: doneAt != null && doneAt <= successMin * 60, video_frames: recorder ? recorder.frames() : null })
  const json = elog.toJSON(), recs = elog.toRecords()
  fs.writeFileSync(path.join('out', `${name}.json`), JSON.stringify(json)); wrote = true
  fs.writeFileSync(path.join('out', `${name}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''))
  const cens = elog.censoring()
  const dec = json.decisions.filter(d => d.decision).length
  console.log(JSON.stringify({ name, seed, policy, end_reason: reason, t: Math.round(t), goal_done_t: doneAt, deaths, decisions: json.decisions.length, decision_points: dec, records: recs.length, censoring: cens }))
  await shutdown(reason, 0)
}

log(`episode ${name}: seed ${seed}, policy ${policy}, eps ${epsAction}, ${minutes} min, spawn ${bot.entity.position.floored()}`)
const loop = setInterval(() => { try { tick() } catch (e) { console.error(e); shutdown(`tick: ${e.message}`, 1) } }, 1000)
