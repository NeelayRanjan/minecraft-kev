// The LLM leader (chain mode): a slow model watching kev drive. At each trigger it sees the state text kev sees plus
// the goal chain, recent events, per-subtask stats, kev's forecasts with their trend and its own previous calls, and
// answers "continue" or one subtask id from the offered list (JSON schema; nothing else is parsed). kev keeps choosing
// at 1 Hz between leader calls; an override replaces kev's choice at the next decision point.
//
// Goal mode (trigger `subgoals`, goals enabled): the leader also answers push_goal (a typed goal from agent/goals.js,
// validated by validateGoal), pop_goal or cannot (a reason the audience reads), and sees the goal stack and the
// unanswered audience requests (chat text appears only in that section of its prompt, never in kev's state).
//
// Pure: the runner (agent/run_episode.mjs) owns the transport (planner.js askLeader), the timing and the motor.
import { GOAL_KINDS, validateGoal, RECIPES, PRODUCERS, FINDABLE_NOW, PLACES, STRUCTURES } from './goals.js'

export const TRIGGERS = ['periodic15', 'events', 'periodic30_interrupts', 'subgoals']
const PERIOD = { periodic15: 15, periodic30_interrupts: 30, subgoals: 120 }
const EVENT_TRIGGERS = {
  events: new Set(['subtask_done', 'subtask_failed', 'subtask_error', 'death']),
  periodic30_interrupts: new Set(['interrupt', 'death']),
  subgoals: new Set(['goal_done', 'goal_failed', 'subtask_failed', 'interrupt', 'death', 'audience_request']),
}
// subgoals: at most one call per SPACING s, except for these events (which also skip the FIRST_AT wait)
const SPACING = { subgoals: 20 }
const BYPASS = { subgoals: new Set(['death', 'interrupt', 'audience_request']) }
const FIRST_AT = 20   // periodic modes: let the bot start before the first call

// When to ask. The runner calls due() once per tick with the most important event of that tick (pickEvent) and
// asked(t) when it fires a call; never due while a call is in flight (answers would overlap).
export class LeaderTrigger {
  constructor(mode) {
    if (!TRIGGERS.includes(mode)) throw new Error(`unknown leader mode ${mode}`)
    this.mode = mode
    this.lastAsk = PERIOD[mode] ? FIRST_AT - PERIOD[mode] : null
    this.everAsked = false
  }
  due({ t, event = null, inFlight = false }) {
    this.reason = null   // why the last due() fired: the event, or 'periodic'
    if (inFlight) return false
    const spacing = SPACING[this.mode]
    if (spacing != null) {
      if (event && BYPASS[this.mode].has(event)) { this.reason = event; return true }
      if (t < FIRST_AT || (this.everAsked && t - this.lastAsk < spacing)) return false
    }
    if (event && EVENT_TRIGGERS[this.mode]?.has(event)) { this.reason = event; return true }
    const period = PERIOD[this.mode]
    if (period != null && t - this.lastAsk >= period) { this.reason = 'periodic'; return true }
    return false
  }
  asked(t) { this.lastAsk = t; this.everAsked = true }
}

// The most important event of a tick. With a mode, events that mode ignores are skipped, so a goal_done does not
// shadow a subtask_done in the events mode.
const EVENT_RANK = ['death', 'interrupt', 'audience_request', 'goal_failed', 'goal_done', 'subtask_failed', 'subtask_error', 'subtask_done']
export function pickEvent(events, mode = null) {
  const cares = mode ? EVENT_TRIGGERS[mode] : null
  for (const e of EVENT_RANK) if (events.includes(e) && (!cares || cares.has(e))) return e
  return null
}

// What an answer does, judged against what is running now. askedCurrentId is the subtask the leader was shown (or, when
// asked while idle, the one kev started right after); if that has ended, the answer is about a situation that is gone.
// Two guards (run 1: prompt rules alone did not hold) turn an otherwise valid override into 'blocked':
// - threat: the bot is in a threat response (fight, flee, pillar_up) with a hostile near (threatNear) and the answer
//   is not itself a threat response; switching into or between threat responses stays allowed;
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

// Goal answers (goalsEnabled only) are about the goal stack, not the running subtask, so they are never stale:
// push_goal carries the validated goal {kind, arg, count} (invalid with validateGoal's reason, prefixed with the goal,
// otherwise); pop_goal (the runner decides whether a pushed goal is there to pop) and cannot pass `why` through.
export const GOAL_ACTIONS = ['push_goal', 'pop_goal', 'cannot']
const goalText = ({ kind, arg, count } = {}) => `${kind}${arg != null || count != null ? `(${[arg, count].filter(x => x != null).join(', ')})` : ''}`

// The snapshot of a leader call: which subtask the answer will be judged against. A call fired by an interrupt, or while
// the motor is ending an interrupted run (Motor.run keeps current for ~150 ms), or while it runs wait (3 s, shorter
// than the leader's median latency) is judged like an idle ask: against the subtask kev starts next (bindNext, bound in
// the runner's startSubtask, which never binds to wait). Otherwise against the running subtask.
export const TRANSPARENT = new Set(['wait'])
export function snapshotFor({ event = null, currentId = null, busy = false, interrupted = false } = {}) {
  if (!busy || interrupted || event === 'interrupt' || currentId == null || TRANSPARENT.has(currentId)) return { currentId: null, bindNext: true }
  return { currentId, bindNext: false }
}
// The askedCurrentId applyAnswer compares with at answer time: a snapshot still unbound (kev has only been idle or
// waiting since) accepts an idle or waiting motor as the situation it was asked about.
export function askedIdFor(snap, currentId) {
  if (snap?.bindNext && (currentId == null || TRANSPARENT.has(currentId))) return currentId ?? null
  return snap?.currentId ?? null
}

export function applyAnswer({ answer, currentId, askedCurrentId, offered, threatNear = false, recentResults = [], goalsEnabled = false, obs = null }) {
  const action = answer?.action ?? null
  if (!action) return { kind: 'invalid', id: null }
  if (goalsEnabled && GOAL_ACTIONS.includes(action)) {
    const why = typeof answer.why === 'string' ? answer.why : ''
    if (action !== 'push_goal') return { kind: action, id: null, why }
    const raw = answer.goal
    if (!raw || typeof raw !== 'object') return { kind: 'invalid', id: action, reason: 'push_goal without a goal' }
    const goal = { kind: raw.kind ?? null, arg: raw.arg == null || raw.arg === '' ? null : raw.arg, count: raw.count ?? null }
    const v = validateGoal(goal, obs)
    if (!v.ok) return { kind: 'invalid', id: action, reason: `${goalText(goal)}: ${v.reason}` }
    return { kind: 'push_goal', id: null, goal: v.goal ?? goal, why, ...(v.note ? { note: v.note } : {}) }
  }
  if ((currentId ?? null) !== (askedCurrentId ?? null)) return { kind: 'stale', id: null }
  if (action === 'continue' || action === currentId) return { kind: 'continue', id: null }
  if (!offered.some(o => o.id === action)) return { kind: 'invalid', id: action }
  if (threatNear && THREAT_RESPONSES.has(currentId) && !THREAT_RESPONSES.has(action)) return { kind: 'blocked', id: action, reason: 'threat' }
  if (recentFailure(action, recentResults)) return { kind: 'blocked', id: action, reason: 'recent_failure' }
  return { kind: 'override', id: action }
}

export const PUSHABLE_KINDS = Object.keys(GOAL_KINDS).filter(k => k !== 'chain' && k !== 'iron_pickaxe')

export const leaderSchema = (options, { goals = false } = {}) => goals ? {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['continue', ...GOAL_ACTIONS, ...options.map(o => o.id)] },
    goal: { type: 'object', properties: { kind: { type: 'string', enum: PUSHABLE_KINDS }, arg: { type: 'string' }, count: { type: 'integer' } }, required: ['kind'] },
    why: { type: 'string' },
  },
  required: ['action'],
} : {
  type: 'object',
  properties: { action: { type: 'string', enum: ['continue', ...options.map(o => o.id)] }, why: { type: 'string' } },
  required: ['action'],
}

// With goals, the goal actions are accepted and `goal` ({kind, arg, count} as sent, or null) is returned for
// applyAnswer to validate; without, the result is {action, why} exactly as before.
export function parseLeaderAnswer(text, options, { goals = false } = {}) {
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
  const ok = a === 'continue' || options.some(o => o.id === a) || (goals && GOAL_ACTIONS.includes(a))
  if (!goals) return { action: ok ? a : null, why }
  const gl = obj.goal && typeof obj.goal === 'object' ? obj.goal : null
  const goal = gl ? { kind: typeof gl.kind === 'string' ? gl.kind : null, arg: typeof gl.arg === 'string' ? gl.arg : null,
    count: Number.isInteger(gl.count) ? gl.count : null } : null
  return { action: ok ? a : null, why, goal }
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

const LEADER_RULES = `You supervise a Minecraft survival bot. A small model, kev, drives it: every second kev picks the next subtask from a declared list, and a scripted motor layer carries it out. You see more context than kev and think slower. Each time you are asked, either let kev carry on ("continue") or override with one subtask id from the offered list; your pick replaces kev's at once.

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
Never override fight, flee or pillar_up with anything other than another of those three while a hostile is within 16 m; at night the bot must be underground or in a shelter before doing anything else.
Pickaxes wear out after about 500 blocks: when the bot has an iron pickaxe and cobblestone, having a spare stone pickaxe before a long dig is worth an override to craft(stone_pickaxe); losing the iron pickaxe resets the whole chain.
Override rarely: \`continue\` is the right answer whenever kev's current subtask makes progress on the current step.`

export const LEADER_SYSTEM = `${LEADER_RULES}

Answer with JSON only: {"action": "continue" | "<subtask id>", "why": "<one sentence>"}`

// Goal mode: the same rules, then the goal rules with the declared vocabularies (from goals.js), then the answer format.
const list = xs => xs.join(', ')
export const LEADER_SYSTEM_GOALS = `${LEADER_RULES}

Goals. Above kev's subtasks there is a goal stack: the chain at the bottom, and on top any goals pushed by you or asked for by the audience (players chatting with the bot). kev works on the top goal until it is done or stuck, then the one below resumes. Besides "continue" and a subtask id you can answer:
- push_goal with a typed goal: {"action": "push_goal", "goal": {"kind": ..., "arg": ..., "count": ...}, "why": ...};
- pop_goal: drop the top pushed goal when it is pointless now (its materials are lost, night has fallen on the surface, it keeps failing);
- cannot: decline an audience request; "why" is sent to the audience as your reply, so write one short friendly sentence saying why.
Goal kinds and their arguments (nothing else is accepted):
- craft_item, arg one of: ${list(Object.keys(RECIPES))};
- gather, arg one of: ${list(Object.keys(PRODUCERS))}; count an integer from 1 to 64;
- find, arg one of: ${list(FINDABLE_NOW)};
- go_to, arg one of: ${list(PLACES)};
- build, arg one of: ${list(Object.keys(STRUCTURES).filter(k => STRUCTURES[k].executor))};
- survive_night, return_to_base: no arg.
Answer every audience request with exactly one push_goal or one cannot (with a reason the audience will read); if the request names something outside these lists, answer cannot and say what the bot can do instead.
Prefer goals to subtask overrides: push a goal and let kev choose the subtasks.
Never push a goal that sends the bot to the surface at night (go_to surface, gather wood, find water or a cave on the surface): the night protocol comes first; push it in the morning or answer cannot.
"continue" remains the default when there is no request and the goals make progress.

Answer with JSON only: {"action": "continue" | "push_goal" | "pop_goal" | "cannot" | "<subtask id>", "goal": {"kind": "<goal kind>", "arg": "<argument>", "count": <integer>}, "why": "<one sentence>"} (goal only with push_goal)`

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
    case 'goal_done': return e.goal ? `${T(e.t)} goal #${e.goal.id} ${goalText(e.goal)} done` : `${T(e.t)} GOAL REACHED`
    case 'goal_failed': return `${T(e.t)} goal #${e.goal?.id} ${goalText(e.goal)} failed${e.reason ? ` (${e.reason})` : ''}`
    case 'goal_pushed': return `${T(e.t)} goal #${e.goal?.id} ${goalText(e.goal)} pushed by ${sanitizeChat(e.goal?.source ?? '?', 40)}`
    case 'goal_popped': return `${T(e.t)} goal #${e.goal?.id} ${goalText(e.goal)} popped${e.reason ? ` (${e.reason})` : ''}`
    case 'leader_cannot': return `${T(e.t)} leader declined a request${e.why ? ` (${sanitizeChat(e.why, 120)})` : ''}`
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
  'leader_override', 'leader_continue', 'leader_stale', 'leader_invalid', 'leader_dropped', 'leader_blocked', 'kev_error',
  'goal_failed', 'goal_pushed', 'goal_popped', 'leader_cannot'])

// Chat text for the prompt and for the bot's own chat lines: no special-token markers, one line (newlines become a
// space), no formatting codes (a section sign and the code after it) and no other control characters (below 0x20,
// 0x7f): the server disconnects a client that sends them, which would end the episode. Capped.
export const sanitizeChat = (s, max = 200) => String(s ?? '').replace(/<\||\|>/g, '').replace(/[\r\n]+/g, ' ')
  .replace(/\u00a7.?/gs, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)

// A player's chat line from mineflayer's 'message' event (jsonMsg: a prismarine-chat ChatMessage, or its JSON), or
// null. Only position 'chat' (signed player chat; system messages arrive as 'system'/'game_info') whose chat type is
// the plain player one: translate 'chat.type.text' with [sender, text]. Console `say` (chat.type.announcement), emotes
// and anything else are not requests. Without a translate key (a server that preformats chat) the vanilla
// "<name> text" line is accepted. The bot's own lines and lines without a sender give null.
const plain = x => x == null ? '' : typeof x === 'string' ? x : typeof x.toString === 'function' && x.toString !== Object.prototype.toString ? x.toString()
  : [x.text ?? '', ...(x.extra || []).map(plain)].join('')
export function parseChatMessage(jsonMsg, position, botName) {
  if (position !== 'chat' || !jsonMsg) return null
  let name = null, text = null
  if (jsonMsg.translate != null) {
    if (jsonMsg.translate !== 'chat.type.text' || !Array.isArray(jsonMsg.with) || jsonMsg.with.length < 2) return null
    name = plain(jsonMsg.with[0]).trim(); text = plain(jsonMsg.with[1])
  } else {
    const m = /^<(\w{1,16})> (.*)$/s.exec(plain(jsonMsg))
    if (!m) return null
    name = m[1]; text = m[2]
  }
  text = String(text ?? '').trim()
  if (!name || !/^\w{1,16}$/.test(name) || name === botName || !text) return null
  return { name, text }
}

// Chat requests and who has answered them. A request is answered only by a goal-level answer (push_goal, pop_goal,
// cannot; the runner passes an invalid push it replied to as cannot). Any other outcome of a call that showed it
// (continue, override, blocked, stale, invalid, error) leaves it waiting; after maxShown such calls it is settled as
// 'not_now' and returned so the runner can reply "Not now". Ids are 1, 2, ... in arrival order.
export const REQUEST_ANSWERS = new Set(['push_goal', 'pop_goal', 'cannot'])
export class RequestBook {
  constructor({ maxShown = 2 } = {}) { this.maxShown = maxShown; this.all = []; this.nextId = 1 }
  add({ t, name, text }) { const r = { id: this.nextId++, t, name, text, shown: 0, answered: null }; this.all.push(r); return r }
  pending() { return this.all.filter(r => !r.answered) }
  unshown() { return this.all.filter(r => !r.answered && r.shown === 0) }
  // a leader call was made with these requests in its prompt: only the first MAX_REQUESTS are rendered, so only those count
  shown(ids) { const put = ids.slice(0, MAX_REQUESTS); for (const r of this.all) if (put.includes(r.id) && !r.answered) r.shown++; return put }
  // that call's outcome: answers them (goal kinds) or, after maxShown calls without an answer, settles them as not_now
  settle(ids, kind, t = null) {
    const mine = this.all.filter(r => ids.includes(r.id) && !r.answered)
    if (REQUEST_ANSWERS.has(kind)) { for (const r of mine) r.answered = { t, kind }; return [] }
    const notNow = mine.filter(r => r.shown >= this.maxShown)
    for (const r of notNow) r.answered = { t, kind: 'not_now', after: kind }
    return notNow
  }
}

// The bot's chat lines, paced (pure; the runner drains it on a timer and sends). A non-op that sends ~11 lines in a
// burst is kicked for spam, which ends the episode: at most one line every intervalS, a line identical to one queued or
// sent within dupS is dropped, a kind with a gap (not_now: one per 10 s) is dropped inside it, and the queue is bounded.
export class ChatQueue {
  constructor({ intervalS = 1.5, dupS = 10, kindGapS = { not_now: 10 }, max = 10 } = {}) {
    this.intervalS = intervalS; this.dupS = dupS; this.kindGapS = kindGapS; this.max = max
    this.q = []; this.lastSent = -Infinity; this.seen = new Map(); this.kindT = new Map(); this.dropped = 0
  }
  enqueue(text, t, kind = null) {
    const prev = this.seen.get(text)
    const gap = kind ? this.kindGapS[kind] : null
    if ((prev != null && t - prev < this.dupS) || (gap != null && this.kindT.has(kind) && t - this.kindT.get(kind) < gap) || this.q.length >= this.max) {
      this.dropped++; return false
    }
    this.seen.set(text, t)
    if (gap != null) this.kindT.set(kind, t)
    this.q.push(text)
    return true
  }
  // the line to send now, or null
  drain(t) {
    if (!this.q.length || t - this.lastSent < this.intervalS) return null
    this.lastSent = t
    return this.q.shift()
  }
  get size() { return this.q.length }
}

// The GOAL STACK section's input from a GoalStack: its describe text and the pushed goals, top first, with progress.
export function goalStackView(stack, obs) {
  return {
    text: stack.describe(obs),
    pushed: stack.stack.slice(1).reverse().map(g => ({ id: g.id, kind: g.kind, arg: g.arg, count: g.count, source: g.source, t: g.t,
      progress: GOAL_KINDS[g.kind].step(obs, g.arg, g.count).text })),
  }
}

function renderGoalStack(view) {
  const out = [view.text || '(chain only)']
  for (const g of view.pushed || [])
    out.push(`#${g.id} ${goalText(g)} from ${sanitizeChat(g.source, 40)}, pushed at ${g.t != null ? T(g.t) : 't=?'}, progress ${g.progress}`)
  if (!view.pushed?.length) out.push('no pushed goals')
  return out
}

export const MAX_REQUESTS = 5
function renderRequests(requests = []) {
  if (!requests.length) return ['(none)']
  const out = requests.slice(0, MAX_REQUESTS).map(r => `${T(r.t)} ${sanitizeChat(r.name, 40)}: ${sanitizeChat(r.text)}`)
  if (requests.length > MAX_REQUESTS) out.push(`(${requests.length - MAX_REQUESTS} more waiting)`)
  return out
}

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
  subtaskStats: stats = {}, ownHistory = [], minutesLeft = null, deaths = 0, recentResults = [], goalStack = null, requests = [] }) {
  const goals = goalStack != null
  const none = xs => xs.length ? xs.join('\n') : '(none yet)'
  const events = history.filter(e => SHOWN_EVENTS.has(e.kind)).slice(-30).map(renderEvent)
  const own = ownHistory.slice(-5).map(h => `${T(h.t)} ${h.action ?? '(no answer)'}${h.kind && h.kind !== h.action ? ` (${h.kind})` : ''}${h.why ? `: ${h.why}` : ''}`)
  const user = [
    'STATE', stateText, '',
    'GOAL CHAIN', chainText, ...renderNeeds(need), '',
    ...(goals ? ['GOAL STACK', ...renderGoalStack(goalStack), ''] : []),
    'CURRENT SUBTASK', ...renderCurrent(current), '',
    'RECENT EVENTS (oldest first)', none(events), '',
    'SUBTASK STATS THIS EPISODE', none(renderStats(stats)), '',
    'KEV FORECASTS', none(renderForecasts(forecasts, forecastTrend, kevPick)), '',
    'YOUR PREVIOUS DECISIONS', none(own), '',
    'TIME', `${minutesLeft != null ? minutesLeft.toFixed(1) : '?'} minutes left in the episode; deaths so far: ${deaths}`, '',
    ...(goals ? ['AUDIENCE REQUESTS (unanswered)', ...renderRequests(requests), ''] : []),
    'SUBTASKS OFFERED NOW', options.map(o => {
      const bad = recentFailure(o.id, recentResults)
      return `- ${o.id}: ${o.desc}${bad ? ` (failed recently: ${bad}, do not pick)` : ''}`
    }).join('\n'), '',
    goals ? 'Reply with JSON only: {"action": "continue" | "push_goal" | "pop_goal" | "cannot" | "<subtask id from the list>", "goal": {...} (push_goal only), "why": "<one sentence>"}'
      : 'Reply with JSON only: {"action": "continue" | "<subtask id from the list>", "why": "<one sentence>"}',
  ].join('\n')
  return [{ role: 'system', content: goals ? LEADER_SYSTEM_GOALS : LEADER_SYSTEM }, { role: 'user', content: user }]
}
