// One episode: a bot on its own Paper instance, the scripted motor layer, and a 1 Hz decision loop that asks kev (or
// uses one-hot teacher answers), logs every distribution, and writes the trajectory + kev records.
//
//   node agent/run_episode.mjs --seed 7 --port 25580 --policy teacher|kev [--kev-url http://127.0.0.1:8009]
//        [--goal iron_pickaxe|nether] [--eps-action 0.1] [--minutes 20] [--out name] [--video] [--live-view 3007] [--no-server] [--difficulty normal] [--quiet]
//        [--leader off|periodic15|events|periodic30_interrupts|subgoals --leader-think --leader-model m --leader-url u --leader-num-predict n]   (chain mode, needs --kev-url)
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
import { stageOf, describeChain, needs } from './stages.js'
import { counts, REPEAT_WINDOW } from './subtasks.js'
import { chooseAction, interruptFor } from './policy.js'
import { EpisodeLog, oneHot, fromKev } from './logger.js'
import { ask } from './kev_client.js'
import { injectDeaths } from './relabel.js'
import { askPlanner, askLeader } from './planner.js'
import { TRIGGERS, LeaderTrigger, applyAnswer, pickEvent, subtaskStats, goalStackView, sanitizeChat, parseChatMessage, RequestBook } from './leader.js'
import { options as optionsFor } from './subtasks.js'
import { GoalStack } from './goals.js'
import { Supervisor, DEFAULTS as SUP } from './supervisor.js'

// ---- args ------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && !argv[i + 1]?.startsWith('--') ? argv[i + 1] : d }
const flag = k => argv.includes(`--${k}`)
const seed = opt('seed', '1'), port = Number(opt('port', 25580)), policy = opt('policy', 'teacher'), kevUrl = opt('kev-url', null)
const epsAction = Number(opt('eps-action', 0)), minutes = Number(opt('minutes', 20)), successMin = Number(opt('success-minutes', 15))
const name = opt('out', `${policy}_s${seed}`), video = flag('video'), fps = Number(opt('fps', 5)), noServer = flag('no-server'), difficulty = opt('difficulty', 'normal'), quiet = flag('quiet')
const liveViewPort = opt('live-view', null)   // optional, off by default: a browser view at http://127.0.0.1:<port> (prismarine-viewer's web viewer, not the recorder)
const goal = opt('goal', 'iron_pickaxe')
if (!['iron_pickaxe', 'nether'].includes(goal)) { console.error(`unknown goal ${goal}`); process.exit(2) }
// The goal stack (agent/goals.js): the default entry is the chain (nether) or experiment 1's iron pickaxe; with nothing
// pushed its step, describe, filter and teacher equal chainStep/techStep, describeChain, options and teacherSubtask.
// Only the subgoals leader pushes goals (from its own judgement or an audience request typed in the game chat).
const goalStack = new GoalStack({ goal })
const llmUrl = opt('llm-url', 'http://127.0.0.1:11434'), llmModel = opt('llm-model', 'qwen3:4b')
if (policy === 'kev' && !kevUrl) { console.error('--policy kev needs --kev-url'); process.exit(2) }
if (!['teacher', 'kev', 'llm'].includes(policy)) { console.error(`unknown policy ${policy}`); process.exit(2) }
// The scripted supervisor (agent/supervisor.js): --supervisor off|real|shuffled [--supervisor-pool forecasts.json]
// [--supervisor-threshold 0.25 --supervisor-hold 15]. Needs kev's forecasts (--kev-url).
const supMode = opt('supervisor', 'off'), supPoolFile = opt('supervisor-pool', null)
const supThreshold = Number(opt('supervisor-threshold', SUP.threshold)), supHold = Number(opt('supervisor-hold', SUP.holdS))
if (supMode !== 'off' && !kevUrl) { console.error('--supervisor needs --kev-url'); process.exit(2) }
const supervisor = new Supervisor({ mode: supMode, threshold: supThreshold, holdS: supHold, pool: supPoolFile ? JSON.parse(fs.readFileSync(supPoolFile, 'utf8')) : null,
  rng: mulberry32(Number.parseInt(String(seed).replace(/\D/g, '') || '0', 10) * 104729 + 3) })
// The LLM leader (agent/leader.js): watches kev in chain mode and says continue or overrides with an offered subtask.
// Independent of the scripted supervisor; both may be on.
const leaderMode = opt('leader', 'off'), leaderThink = flag('leader-think')
const leaderNumPredict = opt('leader-num-predict', null)   // default: askLeader's (200, 1500 with thinking)
const leaderModel = opt('leader-model', 'qwen38-27b-iq3xxs'), leaderUrl = opt('leader-url', 'http://100.109.91.95:11434')
if (leaderMode !== 'off' && !TRIGGERS.includes(leaderMode)) { console.error(`unknown --leader ${leaderMode}`); process.exit(2) }
if (leaderMode !== 'off' && (!kevUrl || goal !== 'nether')) { console.error('--leader needs --kev-url and --goal nether'); process.exit(2) }
const goalsOn = leaderMode === 'subgoals'   // the leader answers at goal level (push_goal / pop_goal / cannot) and reads chat
const leaderTrigger = leaderMode === 'off' ? null : new LeaderTrigger(leaderMode)
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
  if (!wrote) { try { elog?.finish({ end_reason: `crash: ${why}`.slice(0, 120), ended_t: now?.() ?? null, ...(() => { try { return stageMeta() } catch { return {} } })() }); fs.writeFileSync(path.join('out', `${name}.json`), JSON.stringify(elog.toJSON())); wrote = true } catch {} }
  try { if (recorder) await recorder.stop() } catch {}
  try { bot.viewer?.close?.() } catch {}
  try { bot.quit() } catch {}
  if (server) await server.stop()
  process.exit(code)
}
process.on('uncaughtException', e => { console.error(e); shutdown(`uncaught: ${e.message}`, 1) })
process.on('unhandledRejection', e => { console.error(e); shutdown(`unhandled: ${e?.message || e}`, 1) })
bot.on('kicked', r => shutdown(`kicked: ${JSON.stringify(r)}`, 1))
bot.on('error', e => log(`bot error: ${e.message}`))
// A server that dies (a JVM segfault) or a dropped connection ends the episode at once instead of idling until
// gen_data's kill timer; no summary line is printed, so gen_data retries the seed.
bot.on('end', r => shutdown(`disconnected: ${r}`, 1))
if (server) server.proc.on('exit', c => shutdown(`server exited (${c})`, 1))

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
const elog = new EpisodeLog({ seed, policy, goal, eps_action: epsAction, minutes, kev_url: kevUrl, model: policy === 'kev' ? 'kev' : policy === 'llm' ? llmModel : null, username: me, version: bot.version,
  difficulty, horizons: HORIZONS, questions: questionMeta(), started: new Date().toISOString(), video: video ? { file: `${name}.mp4`, fps } : null,
  supervisor: supMode === 'off' ? null : { mode: supMode, threshold: supThreshold, hold_s: supHold, cooldown_s: supervisor.cooldownS, pool: supPoolFile, pool_n: supervisor.pool?.length ?? null },
  leader: leaderTrigger ? { mode: leaderMode, think: leaderThink, model: leaderModel, url: leaderUrl, num_predict: leaderNumPredict ? Number(leaderNumPredict) : null } : null })
let recorder = null
if (video) { const { startRecorder } = await import('./recorder.js'); recorder = startRecorder(bot, { output: path.join('out', `${name}.mp4`), fps, log }) }
// The live view (--live-view <port>): prismarine-viewer's browser web viewer, separate from the recorder above (which
// renders headlessly to a file). A failure to start it (e.g. the port is taken) must not end the episode.
if (liveViewPort) {
  try {
    const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
    mineflayerViewer(bot, { port: Number(liveViewPort), firstPerson: true, viewDistance: 4 })
    log(`live view: http://127.0.0.1:${liveViewPort}`)
  } catch (e) { log(`live view failed to start: ${e.message}`) }
}

// ---- state ------------------------------------------------------------------------------------------------------
const t0 = Date.now()
const now = () => (Date.now() - t0) / 1000
let dead = false, deaths = 0, prevHostileDist = null, prevOxygen = null, subtaskStartHealth = null, ticking = false, doneAt = null, startDay = Number(bot.time.day)
let stageReached = 0   // chain mode: the highest stageOf(obs).index seen (a stage_done event on each increase)
let lastResult = null, recent = []   // recent: the last REPEAT_WINDOW attempts {id, result}, oldest first (livelock breaker)
let lastForecast = null, withhold = []   // supervisor: kev's latest p(step done in 60 s) {t, p}; the subtask it abandoned, withheld at the next decision
// leader: events since the last tick (the trigger's input), the call in flight, an override waiting for the next
// decision, the last 5 values of each forecast (the trend line) and kev's last pick with its top alternatives.
let leaderEvents = [], leaderAsk = null, pendingLeader = null, forecastHist = {}, kevPick = null, leaderCalls = 0
let lastObs = null   // the latest tick's obs: the leader's threat guard re-checks it when an answer arrives
const threatNearIn = o => !!(o?.nearestHostile && o.nearestHostile.dist <= 16)
const leaderNote = kind => { if (leaderTrigger) leaderEvents.push(kind) }
// Chat: requests from players (never the bot itself, never system lines) for the leader's prompt (agent/leader.js
// RequestBook: answered only by a goal-level answer, else "not now" after two calls). Chat text reaches only the
// leader's prompt and the log.
const requestBook = new RequestBook()
const goalLog = []   // pushed goals: {id, kind, arg, count, source, t, why, end_t, outcome}
const say = msg => { try { bot.chat(sanitizeChat(msg, 240)) } catch (e) { log(`chat failed: ${e?.message || e}`) } }
const goalPhrase = g => {
  const h = x => String(x ?? '').replace(/_/g, ' ')
  switch (g.kind) {
    case 'gather': return `gather ${g.count ?? ''} ${h(g.arg)}`.replace(/\s+/g, ' ')
    case 'craft_item': return `craft ${h(g.arg)}`
    case 'find': return `find ${h(g.arg)}`
    case 'go_to': return `go to ${h(g.arg)}`
    case 'build': return `build ${h(g.arg)}`
    case 'survive_night': return 'survive the night'
    case 'return_to_base': return 'return to base'
    default: return `${h(g.kind)}${g.arg ? ` ${h(g.arg)}` : ''}`
  }
}
const whyTail = (why, sep = ': ') => { const w = sanitizeChat(why, 80).trim(); return w ? `${sep}${w}` : '' }
// The offered list everywhere (kev's question, the teacher, the leader, the LLM policy): options under the top goal.
const offeredFor = o => goalStack.filter(o, optionsFor(o))
const goalStepOf = o => { const s = goalStack.step(o), d = goalStack.depth(); return { ...s, local: s.index - 100 * d, pushed: d > 0 } }
bot.on('message', (jsonMsg, position) => {
  if (finished) return
  const c = parseChatMessage(jsonMsg, position, bot.username)
  if (!c) return
  const t = +now().toFixed(1), text = c.text.slice(0, 200)
  requestBook.add({ t, name: c.name, text })
  elog.event({ t, kind: 'audience_request', name: c.name, text })
  log(`chat <${c.name}> ${text}`)
  if (goalsOn) leaderNote('audience_request')
})
bot.on('death', () => {
  dead = true; deaths++; mem.deaths = deaths; elog.event({ t: now(), kind: 'death', pos: bot.entity?.position }); leaderNote('death')
  if (pendingLeader) { elog.event({ t: now(), kind: 'leader_dropped', id: pendingLeader.id, reason: 'death' }); pendingLeader = null }   // an override for a life that ended
  motor.interrupt('died'); log('died')
})
bot.on('respawn', () => { if (dead) elog.event({ t: now(), kind: 'respawn' }); dead = false })
bot.on('health', () => { if (bot.health <= 0) dead = true })

function startSubtask(id, source, obs) {
  subtaskStartHealth = bot.health
  withhold = []; supervisor.onSubtaskStart(now())
  elog.event({ t: now(), kind: 'subtask_start', id, source })
  if (leaderAsk && leaderAsk.bindNext) { leaderAsk.currentId = id; leaderAsk.bindNext = false }   // asked while idle: the leader judges this pick
  motor.run(id, obs).then(r => {
    // A subtask the leader interrupted says nothing about whether it works: it stays out of the livelock breaker's
    // window and its repeat count (repeats 0), else three leader interrupts would withhold it from kev and the leader.
    const byLeader = r.result === 'interrupted' && r.detail === 'leader'
    const repeats = byLeader ? 0 : lastResult && lastResult.id === id && lastResult.result === r.result ? lastResult.repeats + 1 : 1
    if (!byLeader) recent = [...recent, { id, result: r.result }].slice(-REPEAT_WINDOW)
    lastResult = { id, result: r.result, repeats, recent }
    elog.event({ t: now(), kind: 'subtask_done', id, result: r.result, detail: r.detail ?? null })
    if (r.detail !== 'leader') { leaderNote('subtask_done'); if (goalsOn && r.result !== 'ok') leaderNote('subtask_failed') }   // the leader's own interrupt is not news to it
    log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
  }).catch(e => {
    recent = [...recent, { id, result: 'failed' }].slice(-REPEAT_WINDOW)
    lastResult = { id, result: 'failed', repeats: 1, recent }
    elog.event({ t: now(), kind: 'subtask_error', id, error: String(e?.message || e) })
    leaderNote('subtask_error')
  })
}

// The 1 Hz tick is synchronous (sample, frame, interrupts, end conditions) so a slow kev request can never stall the
// timeline; the question/decision path is async and skipped while a previous request is still in flight.
let asking = false, kevErrors = 0
const KEV_DOWN_AFTER = 30
function tick() {
  if (finished) return
  const t = now()
  const cur = motor.current ? { name: motor.current.name, arg: motor.current.arg, elapsedS: motor.elapsedS(), progress: motor.progress() } : null
  const obs = summarize(bot, mcData, mem, { t, current: cur, last: lastResult, goal, withhold })
  const goalEvents = goalStack.update(obs, t)   // a pushed goal done or stuck pops before this tick's step and text
  obs.goalText = goalStack.describe(obs)
  obs.goalStep = goalStepOf(obs)
  const step = obs.goalStep, c = counts(obs)
  for (const e of goalEvents) onGoalEvent(e, t)
  if (goal === 'nether') {
    const st = stageOf(obs).index
    if (st > stageReached) { stageReached = st; elog.event({ t, kind: 'stage_done', stage: st }); log(`stage ${st} reached at ${t.toFixed(0)} s`) }
  }
  if (obs.done && doneAt == null) {
    doneAt = t; const it = goal === 'nether' ? 'nether_portal' : 'iron_pickaxe'; elog.event({ t, kind: 'goal_done', item: it }); log(`GOAL: ${it} at ${t.toFixed(0)} s`)
    if (goal === 'nether') { stageReached = 5; elog.event({ t, kind: 'stage_done', stage: 5 }) }   // stage 5: the whole chain (a lit portal)
  }
  const doneIds = goalEvents.filter(e => e.kind === 'goal_done').map(e => e.goal.id)
  elog.sample({ t, step: step.index, goal_id: step.goal_id, rawIron: c.rawIron, ingots: c.ingots, health: dead ? 0 : obs.health, dead, timeOfDay: obs.timeOfDay, day: obs.day, done: obs.done,
    ...(doneIds.length ? { goals_done: doneIds } : {}) })
  elog.frame({ t, x: +obs.pos.x.toFixed(1), y: +obs.pos.y.toFixed(1), z: +obs.pos.z.toFixed(1), yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2), health: obs.health, food: obs.food, timeOfDay: obs.timeOfDay, hostile: obs.nearestHostile?.dist ?? null })
  const why = interruptFor({ hostileDist: obs.nearestHostile?.dist ?? null, prevHostileDist, current: motor.current, healthDrop: subtaskStartHealth != null ? subtaskStartHealth - obs.health : 0, dead,
    oxygen: obs.oxygen, prevOxygen })
  if (why && motor.busy) { elog.event({ t, kind: 'interrupt', reason: why, subtask: motor.current?.id }); leaderNote('interrupt'); motor.interrupt(why) }
  else if (motor.busy) {   // the supervisor replans on a forecast that has stayed low (a stale forecast counts as none)
    const p = lastForecast && t - lastForecast.t <= 3 ? lastForecast.p : null
    const fire = supervisor.observe({ t, p, busy: motor.busy, subtaskId: motor.current?.id })
    if (fire) { withhold = [fire.id]; elog.event({ t, kind: 'interrupt', reason: 'low_forecast', subtask: fire.id, p: +fire.p.toFixed(3), shuffled: fire.shuffled }); leaderNote('interrupt'); motor.interrupt('low_forecast'); log(`supervisor: abandon ${fire.id} (p=${fire.p.toFixed(2)}${fire.shuffled ? ', shuffled' : ''})`) }
  }
  prevHostileDist = obs.nearestHostile?.dist ?? null; prevOxygen = obs.oxygen ?? null; lastObs = obs
  const morning = goal !== 'nether' && obs.day > startDay && obs.timeOfDay < 12000   // the chain runs past sunrise
  if (t >= minutes * 60) { finish('time'); return }
  if (morning) { finish(doneAt != null ? 'morning_after_goal' : 'morning'); return }
  if (kevErrors >= KEV_DOWN_AFTER) { finish('kev_down'); return }
  if (leaderTrigger) leaderTick(obs, t)
  if (!asking) decide(obs, t).catch(e => { console.error(e); shutdown(`decide: ${e.message}`, 1) })
}

async function decide(obs, t) {
  asking = true
  try {
    const decision = !motor.busy && !dead
    const { qs, labels } = buildQuestions(obs, { decision, goals: goalStack })
    if (!Object.keys(qs).length) return
    const text = serialize(obs)
    let answers, latency = null, source = null, chosen = null
    if (kevUrl) {
      try { const resp = await ask(kevUrl, text, qs, { timeoutMs: 10_000 }); answers = fromKev(resp, qs, labels); latency = resp.latency_ms; kevErrors = 0 }
      catch (e) { kevErrors++; log(`kev error: ${e.message}`); elog.event({ t, kind: 'kev_error', error: String(e.message) }); answers = oneHot(qs, labels); source = 'kev_error' }
    } else answers = oneHot(qs, labels)
    if (finished) return
    const pStep = answers.subgoal_succeeds_60s?.probabilities?.true
    lastForecast = typeof pStep === 'number' && source !== 'kev_error' ? { t, p: pStep } : null
    if (leaderTrigger && kevUrl && source !== 'kev_error') {   // the leader's forecast trend (last 5 values; a question no longer asked drops out)
      const fc = forecastsOf(answers)
      forecastHist = Object.fromEntries(Object.entries(fc).map(([q, p]) => [q, [...(forecastHist[q] || []), +p.toFixed(3)].slice(-5)]))
      const ps = answers.next_subtask?.probabilities
      if (decision && ps) kevPick = { t, top: Object.entries(ps).sort((a, b) => b[1] - a[1]).slice(0, 3) }
    }
    let teacherLabel = labels.next_subtask ?? null, why = null, plannerLatency = null, leaderUse = null
    if (decision && pendingLeader) {   // a leader override waits for this decision point; kev's answers are still logged
      const p = pendingLeader; pendingLeader = null
      if (offeredFor(obs).some(o => o.id === p.id)) leaderUse = p
      else { elog.event({ t, kind: 'leader_dropped', id: p.id }); log(`leader: ${p.id} no longer offered, kev chooses`) }
    }
    if (leaderUse) { chosen = leaderUse.id; source = 'leader'; why = leaderUse.why }
    else if (decision && policy === 'llm') {
      // The LLM leads: it picks from the same offered list; its choice becomes the next_subtask label (LLM-teacher data).
      const opts = offeredFor(obs)
      const forecasts = forecastsOf(answers)
      try {
        const a = await askPlanner({ url: llmUrl, model: llmModel, stateText: text, options: opts, history: elog.events.slice(-12), forecasts: kevUrl ? forecasts : {} })
        plannerLatency = a.latency_ms
        if (a.id) { chosen = a.id; source = 'llm'; why = a.why; labels.next_subtask = a.id }
        else { elog.event({ t, kind: 'planner_invalid', raw: a.raw }); ({ id: chosen } = chooseAction({ policy: 'teacher', qs, labels, answers, rng, epsAction: 0 })); source = 'llm_fallback' }
      } catch (e) { log(`planner error: ${e.message}`); elog.event({ t, kind: 'planner_error', error: String(e.message).slice(0, 200) }); ({ id: chosen } = chooseAction({ policy: 'teacher', qs, labels, answers, rng, epsAction: 0 })); source = 'llm_fallback' }
      if (finished) return
    } else if (decision) {
      if (source === 'kev_error' && policy === 'kev') chosen = 'wait'
      else ({ id: chosen, source } = chooseAction({ policy, qs, labels, answers, rng, epsAction }))
      if (source === 'fallback') elog.event({ t, kind: 'fallback', wanted: policy === 'kev' ? answers.next_subtask?.choice : labels.next_subtask })
    }
    if (answers.next_subtask) answers.next_subtask.label = labels.next_subtask ?? null
    elog.decision({ t, state_text: text, decision, qs, labels, answers, chosen, source, latency_ms: latency, teacher_label: teacherLabel, why, planner_latency_ms: plannerLatency,
      leader: leaderUse ? { t_asked: leaderUse.t_asked, t_answered: leaderUse.t_answered, t_applied: +t.toFixed(1), action: leaderUse.id, why: leaderUse.why, thinking_chars: leaderUse.thinking_chars, latency_ms: leaderUse.latency_ms, stale: false } : null })
    if (decision && !motor.busy && !finished) startSubtask(chosen, source, obs)
  } finally { asking = false }
}

// kev's forecasts as single probabilities (the LLM prompts' view): p(true) per noul, p(major or death) for damage.
function forecastsOf(answers) {
  const out = {}
  for (const q of ['subgoal_succeeds_60s', 'iron_found_3min', 'survive_until_morning']) if (typeof answers[q]?.probabilities?.true === 'number') out[q] = answers[q].probabilities.true
  if (answers.damage_next_20s?.probabilities) out.damage_major_or_death = (answers.damage_next_20s.probabilities[2] || 0) + (answers.damage_next_20s.probabilities[3] || 0)
  return out
}

// ---- the LLM leader ------------------------------------------------------------------------------------------------
// Called once per tick. Fires a call when the trigger is due (never while one is in flight) without awaiting it; kev
// keeps driving meanwhile. The snapshot pins the subtask the leader judged: the running one, or, when asked while
// idle, the one kev starts next (bound in startSubtask).
function leaderTick(obs, t) {
  // A request not yet shown to the leader (it arrived while a call was in flight) keeps the trigger armed.
  if (goalsOn && requestBook.unshown().length) leaderEvents.push('audience_request')
  const event = pickEvent(leaderEvents, goalsOn ? leaderMode : null); leaderEvents = []   // the other modes pick as before
  if (!leaderTrigger.due({ t, event, inFlight: !!leaderAsk })) return
  leaderTrigger.asked(t)
  // The synchronous part (snapshot and prompt context) must never throw into the tick: a leader bug costs one call, not the episode.
  let snap, ctx, first
  try {
    const opts = offeredFor(obs)
    const currentId = motor.current?.id ?? null
    const requests = goalsOn ? requestBook.pending() : []
    snap = { t: +t.toFixed(1), event: leaderTrigger.reason, currentId, bindNext: !motor.busy, offered: opts, threatNear: threatNearIn(obs), requests }
    leaderAsk = snap
    first = leaderCalls++ === 0
    const forecasts = Object.fromEntries(Object.entries(forecastHist).map(([q, h]) => [q, h[h.length - 1]]))
    ctx = {
      stateText: serialize(obs), chainText: describeChain(obs), need: needs(obs), options: opts,
      current: motor.current ? { id: currentId, elapsedS: motor.elapsedS(), progress: motor.progress(), lastResult } : { id: null, lastResult },
      history: elog.events.slice(-300), forecasts, forecastTrend: forecastHist, kevPick, subtaskStats: subtaskStats(elog.events),
      ownHistory: elog.leader.slice(-5).map(l => ({ t: l.t_asked, action: l.action, kind: l.kind, why: l.why })),
      minutesLeft: Math.max(0, minutes - t / 60), deaths, recentResults: recent,
      ...(goalsOn ? { goals: true, goalStack: goalStackView(goalStack, obs), requests: requests.map(r => ({ t: r.t, name: r.name, text: r.text })) } : {}),
    }
    requestBook.shown(requests.map(r => r.id))
  } catch (e) {
    leaderAsk = null
    elog.event({ t, kind: 'leader_error', error: String(e?.message || e).slice(0, 200) }); log(`leader: snapshot failed: ${e?.message || e}`)
    return
  }
  // The very first call may wait for the 27B model to load (~2 min): a longer timeout, not an error.
  askLeader({ url: leaderUrl, model: leaderModel, think: leaderThink, ...(leaderNumPredict ? { numPredict: Number(leaderNumPredict) } : {}), ...(first ? { timeoutMs: 300_000 } : {}), ...ctx })
    .then(a => leaderAnswered(snap, a, null), e => leaderAnswered(snap, null, e))
    .catch(e => { leaderAsk = null; log(`leader: answer handling failed: ${e?.message || e}`); try { elog.event({ t: now(), kind: 'leader_error', error: String(e?.message || e).slice(0, 200) }) } catch {} })
}

function leaderAnswered(snap, a, err) {
  leaderAsk = null
  if (finished) return
  const t = now()
  const currentId = motor.current?.id ?? null
  // Guards: a hostile near when asked or now (either blocks leaving a threat response); the live subtask-result window.
  const threatNear = snap.threatNear || threatNearIn(lastObs)
  let res = err ? { kind: 'error', id: null } : applyAnswer({ answer: a, currentId, askedCurrentId: snap.currentId, offered: snap.offered, threatNear, recentResults: recent, goalsEnabled: goalsOn })
  // Goal answers act on the stack here. The requests the call was shown are answered only by a goal-level answer.
  const reqs = snap.requests || []
  let pushed = null
  if (res.kind === 'push_goal') {
    const src = reqs.length ? `audience:${reqs[0].name}` : 'leader'
    try { pushed = goalStack.push({ ...res.goal, source: src, t: +t.toFixed(1) }) }
    catch (e) { res = { kind: 'invalid', id: 'push_goal', reason: String(e?.message || e).slice(0, 160) } }
  } else if (res.kind === 'pop_goal' && goalStack.depth() === 0) res = { kind: 'invalid', id: 'pop_goal', reason: 'no pushed goal to pop' }
  // an invalid push is replied to below ("Can't do that yet"), so it answers the requests like cannot
  const settleAs = res.kind === 'invalid' && res.id === 'push_goal' && reqs.length ? 'cannot' : res.kind
  const waiting = reqs.filter(r => !r.answered)
  const notNow = requestBook.settle(reqs.map(r => r.id), settleAs, +t.toFixed(1))
  const settled = waiting.filter(r => r.answered).map(r => ({ t: r.t, name: r.name, as: r.answered.kind }))
  elog.leader.push({ t_asked: snap.t, t_answered: +t.toFixed(1), trigger: snap.event, current_id: snap.currentId, current_id_at_answer: currentId,
    action: a?.action ?? null, truncated: a?.truncated ?? null, kind: res.kind, id: res.id, reason: res.reason ?? null, threat_near: threatNear, why: a?.why ?? null, thinking: a?.thinking ?? '', raw: a?.raw ?? null,
    latency_ms: a?.latency_ms ?? null, tokens: a?.tokens ?? null, prompt_tokens: a?.prompt_tokens ?? null, tps: a?.tps != null ? +a.tps.toFixed(1) : null,
    prompt_chars: a?.prompt_chars ?? null, prompt_hash: a?.prompt_hash ?? null, offered: snap.offered.map(o => o.id), think: leaderThink,
    error: err ? String(err.message || err).slice(0, 200) : null,
    ...(goalsOn ? { goal: a?.goal ?? null, goal_id: pushed?.id ?? null, requests: reqs.map(r => ({ t: r.t, name: r.name })), settled } : {}) })
  if (res.kind === 'override') {
    elog.event({ t, kind: 'leader_override', from: currentId, to: res.id, why: a.why })
    pendingLeader = { id: res.id, why: a.why, t_asked: snap.t, t_answered: +t.toFixed(1), latency_ms: a.latency_ms, thinking_chars: a.thinking?.length ?? 0 }
    if (motor.busy) motor.interrupt('leader')
  } else if (res.kind === 'push_goal') {
    const g = { id: pushed.id, kind: pushed.kind, arg: pushed.arg, count: pushed.count, source: pushed.source }
    elog.event({ t, kind: 'goal_pushed', goal: g, why: a.why ?? null })
    goalLog.push({ ...g, t: +t.toFixed(1), why: a.why ?? null, end_t: null, outcome: null })
    say(`On it: ${goalPhrase(g)}${whyTail(a.why) || '.'}`)
  } else if (res.kind === 'pop_goal') {
    const g = goalStack.top(), popped = { id: g.id, kind: g.kind, arg: g.arg, count: g.count, source: g.source }
    goalStack.pop('leader')
    elog.event({ t, kind: 'goal_popped', goal: popped, why: a.why ?? null })
    closeGoal(popped.id, t, 'popped')
    say(`Dropping that${whyTail(a.why) || '.'}`)
  } else if (res.kind === 'cannot') {
    elog.event({ t, kind: 'leader_cannot', action: a.action, current: currentId, why: a.why ?? null })
    say(`Can't do that yet${whyTail(a.why) || '.'}`)
  } else {
    elog.event({ t, kind: `leader_${res.kind}`, action: a?.action ?? null, current: currentId, why: a?.why ?? null, ...(res.reason ? { reason: res.reason } : {}), ...(err ? { error: String(err.message || err).slice(0, 200) } : {}) })
    // a request answered with a goal outside the vocabulary still gets a reply: the validator's reason
    if (res.kind === 'invalid' && res.id === 'push_goal' && reqs.length) say(`Can't do that yet${whyTail(res.reason) || '.'}`)
  }
  if (notNow.length) {   // shown to two calls that did not answer them: tell the players the bot is busy
    let busy = 'the current goal'
    try { if (lastObs) busy = goalStack.step(lastObs).text || busy } catch {}
    for (const r of notNow) { elog.event({ t, kind: 'request_not_now', name: r.name, request_t: r.t, after: settleAs }); say(`Not now, ${r.name}: busy with ${busy}`) }
  }
  log(`leader (${snap.event}, ${a?.latency_ms ?? '-'} ms): ${res.kind}${res.id ? ` -> ${res.id}` : ''}${res.reason ? ` [${res.reason}]` : ''}${a?.why ? ` (${a.why})` : ''}${err ? ` error: ${err.message}` : ''}`)
}

// A pushed goal finished (goal_done) or popped by the stuck rule (goal_failed): logged, told to the leader and the chat.
function onGoalEvent(e, t) {
  elog.event({ t, kind: e.kind, goal: e.goal, ...(e.reason ? { reason: e.reason } : {}) })
  leaderNote(e.kind)
  closeGoal(e.goal.id, t, e.kind === 'goal_done' ? 'done' : `failed${e.reason ? ` (${e.reason})` : ''}`)
  log(`goal #${e.goal.id} ${goalPhrase(e.goal)}: ${e.kind}${e.reason ? ` (${e.reason})` : ''}`)
  say(e.kind === 'goal_done' ? `Done: ${goalPhrase(e.goal)}.` : `Gave up on ${goalPhrase(e.goal)}: ${e.reason ?? 'stuck'}`)
}
function closeGoal(id, t, outcome) { const g = goalLog.find(x => x.id === id); if (g && !g.outcome) { g.end_t = +t.toFixed(1); g.outcome = outcome } }

// Chain mode: the stage_done events are the one source of truth. stage_reached is the highest stage index entered
// (0..4, 5 once the portal is lit); stage_times maps each index to the second it was first reached.
function stageMeta() {
  if (goal !== 'nether') return { goal }
  const times = {}
  for (const e of elog.events) if (e.kind === 'stage_done' && times[e.stage] == null) times[e.stage] = +e.t.toFixed(1)
  return { goal, stage_reached: stageReached, stage_times: times }
}

// meta.goals: the pushed goals with their outcome (null: still on the stack at the end) and the chat requests.
function goalsMeta() {
  const n = o => goalLog.filter(g => (g.outcome || '').startsWith(o)).length
  return { pushed: goalLog.length, done: n('done'), failed: n('failed'), popped: n('popped'), open: goalLog.filter(g => !g.outcome).length,
    goals: goalLog, requests: requestBook.all.map(r => ({ t: r.t, name: r.name, text: r.text, shown: r.shown, answered: r.answered })) }
}

async function finish(reason) {
  if (finished) return
  const t = now()
  // A leader call still in flight is logged as unfinished, so the log's call count matches the calls made.
  if (leaderAsk) { elog.leader.push({ t_asked: leaderAsk.t, t_answered: null, trigger: leaderAsk.event, current_id: leaderAsk.currentId, kind: 'unfinished', action: null, id: null, latency_ms: null, think: leaderThink }); leaderAsk = null }
  motor.interrupt('episode_end')
  elog.timeline = injectDeaths(elog.timeline, elog.events)   // the sampler rarely catches the few ticks between death and respawn
  elog.finish({ end_reason: reason, ended_t: t, deaths, goal_done_t: doneAt, success_15min: doneAt != null && doneAt <= successMin * 60, ...stageMeta(), video_frames: recorder ? recorder.frames() : null,
    video_dupes: recorder ? recorder.stats().dupes : null,
    ...(goalsOn || goalLog.length || requestBook.all.length ? { goals: goalsMeta() } : {}) })
  const json = elog.toJSON(), recs = elog.toRecords()
  fs.writeFileSync(path.join('out', `${name}.json`), JSON.stringify(json)); wrote = true
  fs.writeFileSync(path.join('out', `${name}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''))
  const cens = elog.censoring()
  const dec = json.decisions.filter(d => d.decision).length
  console.log(JSON.stringify({ name, seed, policy, end_reason: reason, t: Math.round(t), goal_done_t: doneAt, deaths, ...(goal === 'nether' ? { stage_reached: stageReached } : {}), decisions: json.decisions.length, decision_points: dec, records: recs.length, censoring: cens }))
  await shutdown(reason, 0)
}

log(`episode ${name}: seed ${seed}, goal ${goal}, policy ${policy}, eps ${epsAction}, ${minutes} min, spawn ${bot.entity.position.floored()}`)
const loop = setInterval(() => { try { tick() } catch (e) { console.error(e); shutdown(`tick: ${e.message}`, 1) } }, 1000)
