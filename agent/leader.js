// The LLM leader (chain mode): a slow model watching kev drive. At each trigger it sees the state text kev sees plus
// the goal chain, recent events, per-subtask stats, kev's forecasts with their trend and its own previous calls, and
// answers "continue" or one subtask id from the offered list (JSON schema; nothing else is parsed). kev keeps choosing
// at 1 Hz between leader calls; an override replaces kev's choice at the next decision point.
//
// Pure: the runner (agent/run_episode.mjs) owns the transport (planner.js askLeader), the timing and the motor.

export const TRIGGERS = ['periodic15', 'events', 'periodic30_interrupts']
const PERIOD = { periodic15: 15, periodic30_interrupts: 30 }
const EVENT_TRIGGERS = { events: new Set(['subtask_done', 'subtask_error', 'death']), periodic30_interrupts: new Set(['interrupt', 'death']) }
const FIRST_AT = 20   // periodic modes: let the bot start before the first call

// When to ask. The runner calls due() once per tick with the most important event of that tick (pickEvent) and
// asked(t) when it fires a call; never due while a call is in flight (answers would overlap).
export class LeaderTrigger {
  constructor(mode) {
    if (!TRIGGERS.includes(mode)) throw new Error(`unknown leader mode ${mode}`)
    this.mode = mode
    this.lastAsk = PERIOD[mode] ? FIRST_AT - PERIOD[mode] : null
  }
  due({ t, event = null, inFlight = false }) {
    this.reason = null   // why the last due() fired: the event, or 'periodic'
    if (inFlight) return false
    if (event && EVENT_TRIGGERS[this.mode]?.has(event)) { this.reason = event; return true }
    const period = PERIOD[this.mode]
    if (period != null && t - this.lastAsk >= period) { this.reason = 'periodic'; return true }
    return false
  }
  asked(t) { this.lastAsk = t }
}

const EVENT_RANK = ['death', 'interrupt', 'subtask_error', 'subtask_done']
export function pickEvent(events) {
  for (const e of EVENT_RANK) if (events.includes(e)) return e
  return null
}

// What an answer does, judged against what is running now. askedCurrentId is the subtask the leader was shown (or, when
// asked while idle, the one kev started right after); if that has ended, the answer is about a situation that is gone.
// Two guards (run 1: prompt rules alone did not hold) turn an otherwise valid override into 'blocked':
// - threat: the bot is in a threat response (fight, flee, pillar_up) with a hostile near (threatNear) and the answer
//   is something else; switching INTO a threat response stays allowed;
// - recent_failure: the answer's id failed to path (or timed out) in one of its last two attempts (recentResults: the
//   runner's last subtask completions {id, result}, oldest first).
export const THREAT_RESPONSES = new Set(['fight(threat)', 'flee(threat)', 'pillar_up'])
export const PATH_FAILURES = new Set(['no_path', 'target_gone', 'timeout', 'not_found'])

// The failing result among the last two attempts of id in recentResults, or null.
export function recentFailure(id, recentResults) {
  const mine = (recentResults || []).filter(r => r && r.id === id).slice(-2)
  const bad = mine.reverse().find(r => PATH_FAILURES.has(r.result))
  return bad ? bad.result : null
}

export function applyAnswer({ answer, currentId, askedCurrentId, offered, threatNear = false, recentResults = [] }) {
  const action = answer?.action ?? null
  if (!action) return { kind: 'invalid', id: null }
  if ((currentId ?? null) !== (askedCurrentId ?? null)) return { kind: 'stale', id: null }
  if (action === 'continue' || action === currentId) return { kind: 'continue', id: null }
  if (!offered.some(o => o.id === action)) return { kind: 'invalid', id: action }
  if (threatNear && THREAT_RESPONSES.has(currentId)) return { kind: 'blocked', id: action, reason: 'threat' }
  if (recentFailure(action, recentResults)) return { kind: 'blocked', id: action, reason: 'recent_failure' }
  return { kind: 'override', id: action }
}

export const leaderSchema = options => ({
  type: 'object',
  properties: { action: { type: 'string', enum: ['continue', ...options.map(o => o.id)] }, why: { type: 'string' } },
  required: ['action'],
})

export function parseLeaderAnswer(text, options) {
  if (typeof text !== 'string') return { action: null, why: '' }
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { action: null, why: '' }
  let obj
  try { obj = JSON.parse(s.slice(start, end + 1)) } catch { return { action: null, why: '' } }
  const why = typeof obj.why === 'string' ? obj.why.slice(0, 300) : ''
  const a = typeof obj.action === 'string' ? obj.action.trim() : null
  const ok = a === 'continue' || options.some(o => o.id === a)
  return { action: ok ? a : null, why }
}

// Per subtask id this episode: attempts, successes and failures by result, from the runner's events.
export function subtaskStats(events) {
  const out = {}
  for (const e of events) {
    if (e.kind !== 'subtask_done' && e.kind !== 'subtask_error') continue
    const s = out[e.id] ||= { attempts: 0, ok: 0, fails: {} }
    s.attempts++
    const r = e.kind === 'subtask_error' ? 'error' : e.result
    if (r === 'ok') s.ok++
    else s.fails[r] = (s.fails[r] || 0) + 1
  }
  return out
}

export const LEADER_SYSTEM = `You supervise a Minecraft survival bot. A small model, kev, drives it: every second kev picks the next subtask from a declared list, and a scripted motor layer carries it out. You see more context than kev and think slower. Each time you are asked, either let kev carry on ("continue") or override with one subtask id from the offered list; your pick replaces kev's at once.

The goal is a chain of five stages, in order (craft at a crafting table; 1 log = 4 planks, 2 planks = 4 sticks):
1. Iron pickaxe: wood, crafting table, wooden pickaxe, cobblestone, stone pickaxe, raw iron (needs a stone pickaxe), furnace (8 cobblestone), smelt with fuel (coal, planks or logs), iron pickaxe = 3 iron ingots + 2 sticks.
2. Iron tools: iron sword = 2 ingots + 1 stick; iron axe = 3 ingots + 2 sticks.
3. Full iron armor: helmet 5 ingots, chestplate 8, leggings 7, boots 4 (24 ingots in all).
4. Diamond tools: dig down to diamond level (y -58) and mine diamond ore with an iron pickaxe. Diamond pickaxe = 3 diamonds + 2 sticks; diamond sword = 2 diamonds + 1 stick; diamond axe = 3 diamonds + 2 sticks.
5. Lit nether portal: bucket = 3 ingots; fill it with water; make 10 obsidian by pouring water on lava source blocks, then mine the obsidian with the diamond pickaxe; flint and steel = 1 ingot + 1 flint (mine gravel for flint); frame = 10 obsidian + 4 corner blocks (any block); light it with the flint and steel.

"continue" means kev's current subtask is fine, or an override would not help.
Override only with a concrete reason:
- kev is looping: the same subtask keeps failing the same way, or it alternates without progress;
- a cheaper route exists (for example the ore or table it needs is already known and close);
- danger: low health, a hostile close, night on the surface;
- a prerequisite is missing (it cannot finish the step without something else first);
- the current step's forecast is low AND a better option is offered.
Never override into wait. Never pick a subtask whose last attempt ended no_path, target_gone, timeout or not_found; pick something that changes the situation instead (explore_toward(down), return_to_base, mine_stone).
Never override fight, flee or pillar_up while a hostile is within 16 m; at night the bot must be underground or in a shelter before doing anything else.
Pickaxes wear out after about 500 blocks: when the bot has an iron pickaxe and cobblestone, having a spare stone pickaxe before a long dig is worth an override to craft(stone_pickaxe); losing the iron pickaxe resets the whole chain.
Override rarely: \`continue\` is the right answer whenever kev's current subtask makes progress on the current step.

Answer with JSON only: {"action": "continue" | "<subtask id>", "why": "<one sentence>"}`

const humanize = s => String(s).replace(/_/g, ' ')
const STAGE_NAMES = ['iron pickaxe', 'iron tools', 'iron armor', 'diamond tools', 'lit nether portal']
const FORECAST_LABELS = {
  subgoal_succeeds_60s: 'step done in 60 s',
  iron_found_3min: 'iron ore mined within 3 min',
  damage_major_or_death: 'major damage or death in 20 s',
  survive_until_morning: 'survives until morning',
}
const f2 = p => typeof p === 'number' ? p.toFixed(2) : String(p)
const T = t => `t=${Math.round(t)}s`

function renderEvent(e) {
  switch (e.kind) {
    case 'subtask_done': return `${T(e.t)} ${e.id} -> ${e.result}${e.detail ? ` (${String(e.detail).slice(0, 60)})` : ''}`
    case 'subtask_error': return `${T(e.t)} ${e.id} -> error`
    case 'interrupt': return `${T(e.t)} interrupted: ${e.reason}${e.subtask ? ` (${e.subtask})` : ''}`
    case 'death': return `${T(e.t)} DIED`
    case 'respawn': return `${T(e.t)} respawned`
    case 'goal_done': return `${T(e.t)} GOAL REACHED`
    case 'stage_done': return e.stage >= 5 ? `${T(e.t)} stage 5: CHAIN DONE` : `${T(e.t)} reached stage ${e.stage}: now on ${STAGE_NAMES[e.stage] ?? e.stage}`
    case 'leader_override': return `${T(e.t)} leader override: ${e.from ?? 'idle'} -> ${e.to}${e.why ? ` (${e.why})` : ''}`
    case 'leader_continue': return `${T(e.t)} leader: continue${e.why ? ` (${e.why})` : ''}`
    case 'leader_stale': return `${T(e.t)} leader answer came too late (subtask had ended)`
    case 'leader_invalid': return `${T(e.t)} leader answer invalid`
    case 'leader_dropped': return `${T(e.t)} leader pick ${e.id} no longer offered, kev chose`
    case 'leader_blocked': return `${T(e.t)} leader pick ${e.action} blocked (${e.reason === 'threat' ? 'threat response running with a hostile near' : 'it failed recently'})`
    default: return `${T(e.t)} ${e.kind}`
  }
}
const SHOWN_EVENTS = new Set(['subtask_done', 'subtask_error', 'interrupt', 'death', 'respawn', 'goal_done', 'stage_done',
  'leader_override', 'leader_continue', 'leader_stale', 'leader_invalid', 'leader_dropped', 'leader_blocked', 'kev_error'])

function renderNeeds(need) {
  if (!need) return []
  const parts = []
  if (need.ingots) parts.push(`${need.ingots} iron ingots`)
  if (need.diamonds) parts.push(`${need.diamonds} diamonds`)
  if (need.sticks) parts.push(`${need.sticks} sticks`)
  if (need.obsidian) parts.push(`${need.obsidian} obsidian`)
  if (need.flint) parts.push(`${need.flint} flint`)
  const out = [`Still needed for this stage (net of what is held): ${parts.length ? parts.join(', ') : 'no raw materials'}.`]
  if (need.missing?.length) out.push(`Items still to craft this stage: ${need.missing.map(humanize).join(', ')}.`)
  return out
}

function renderCurrent(current) {
  const last = current?.lastResult
  const lastLine = last ? `last result: ${last.id} -> ${last.result}${last.repeats > 1 ? ` (${last.repeats} times in a row)` : ''}` : 'last result: none'
  if (!current?.id) return ['none: the bot is between subtasks; kev is picking the next one now ("continue" lets kev\'s pick run, an id replaces it)', lastLine]
  return [`${current.id}, running for ${Math.round(current.elapsedS ?? 0)} s${current.progress != null ? `, ${Math.round(current.progress * 100)}% done` : ''}`, lastLine]
}

function renderForecasts(forecasts = {}, trend = {}, kevPick = null) {
  const out = []
  for (const [q, p] of Object.entries(forecasts)) {
    if (typeof p !== 'number') continue
    const label = FORECAST_LABELS[q] ?? q
    const h = (trend[q] || []).slice(-5)
    let tail = ''
    if (h.length >= 2) {
      const d = h[h.length - 1] - h[0]
      tail = ` (was ${h.map(f2).join(' → ')}, ${d > 0.1 ? 'rising' : d < -0.1 ? 'falling' : 'steady'})`
    }
    out.push(`${label}: ${f2(p)}${tail}`)
  }
  if (kevPick?.top?.length) out.push(`kev's last pick (${T(kevPick.t)}): ${kevPick.top.map(([id, p]) => `${id} ${f2(p)}`).join(', ')}`)
  return out
}

function renderStats(stats = {}) {
  return Object.entries(stats).sort((a, b) => b[1].attempts - a[1].attempts).slice(0, 20).map(([id, s]) => {
    const worst = Object.entries(s.fails || {}).sort((a, b) => b[1] - a[1])[0]
    return `${id}: ${s.attempts} attempts, ${s.ok} ok${worst ? `, most common failure ${worst[0]} (${worst[1]})` : ''}`
  })
}

export function buildLeaderMessages({ stateText, chainText, need = null, options, current = null, history = [], forecasts = {}, forecastTrend = {}, kevPick = null,
  subtaskStats: stats = {}, ownHistory = [], minutesLeft = null, deaths = 0, recentResults = [] }) {
  const none = xs => xs.length ? xs.join('\n') : '(none yet)'
  const events = history.filter(e => SHOWN_EVENTS.has(e.kind)).slice(-30).map(renderEvent)
  const own = ownHistory.slice(-5).map(h => `${T(h.t)} ${h.action ?? '(no answer)'}${h.kind && h.kind !== h.action ? ` (${h.kind})` : ''}${h.why ? `: ${h.why}` : ''}`)
  const user = [
    'STATE', stateText, '',
    'GOAL CHAIN', chainText, ...renderNeeds(need), '',
    'CURRENT SUBTASK', ...renderCurrent(current), '',
    'RECENT EVENTS (oldest first)', none(events), '',
    'SUBTASK STATS THIS EPISODE', none(renderStats(stats)), '',
    'KEV FORECASTS', none(renderForecasts(forecasts, forecastTrend, kevPick)), '',
    'YOUR PREVIOUS DECISIONS', none(own), '',
    'TIME', `${minutesLeft != null ? minutesLeft.toFixed(1) : '?'} minutes left in the episode; deaths so far: ${deaths}`, '',
    'SUBTASKS OFFERED NOW', options.map(o => {
      const bad = recentFailure(o.id, recentResults)
      return `- ${o.id}: ${o.desc}${bad ? ` (failed recently: ${bad}, do not pick)` : ''}`
    }).join('\n'), '',
    'Reply with JSON only: {"action": "continue" | "<subtask id from the list>", "why": "<one sentence>"}',
  ].join('\n')
  return [{ role: 'system', content: LEADER_SYSTEM }, { role: 'user', content: user }]
}
