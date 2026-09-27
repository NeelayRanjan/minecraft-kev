// The LLM leader (chain mode): a slow model watching kev drive. At each trigger it sees the state text kev sees plus
// the goal chain, recent events, per-subtask stats, kev's forecasts with their trend and its own previous calls, and
// answers "continue" or one subtask id from the offered list (JSON schema; nothing else is parsed). kev keeps choosing
// at 1 Hz between leader calls; an override replaces kev's choice at the next decision point.
//
// Goal mode (trigger `subgoals`, goals enabled): the leader also answers push_goal (a typed goal from agent/goals.js,
// validated by validateGoal), pop_goal or cannot (a reason the audience reads), the plan answers plan_item (an item the
// code expands into steps), plan_steps (1..8 typed goal steps), edit (skip | drop | move_front | clear on the plan book)
// and say (a chat line), and the shape answers plan_build / plan_dig (a template from agent/templates.js) and
// plan_blueprint (a free-form shape); it sees the goal stack, the plans, the unanswered audience requests (chat text
// appears only in that section of its prompt, never in kev's state) and, when the runner passes them, the active
// blueprint's 9x9 cut and the feedback on a refused free-form blueprint.
//
// Pure: the runner (agent/run_episode.mjs) owns the transport (planner.js askLeader), the timing and the motor.
import { GOAL_KINDS, validateGoal, RECIPES, PRODUCERS, FINDABLE_NOW, PLACES, STRUCTURES } from './goals.js'
import { isItem, expandItem } from './recipes.js'
import { stepText } from './plans.js'
import { TEMPLATES, checkParams, describeTemplates } from './templates.js'
import { validate, cells } from './blueprints.js'

export const TRIGGERS = ['periodic15', 'events', 'periodic30_interrupts', 'subgoals']
const PERIOD = { periodic15: 15, periodic30_interrupts: 30, subgoals: 120 }
const EVENT_TRIGGERS = {
  events: new Set(['subtask_done', 'subtask_failed', 'subtask_error', 'death']),
  periodic30_interrupts: new Set(['interrupt', 'death']),
  subgoals: new Set(['goal_done', 'goal_failed', 'subtask_failed', 'interrupt', 'death', 'audience_request', 'idle_wait', 'plan_blocked']),
}
// subgoals: at most one call per SPACING s, except for these events (which also skip the FIRST_AT wait)
const SPACING = { subgoals: 20 }
const BYPASS = { subgoals: new Set(['death', 'interrupt', 'audience_request', 'idle_wait', 'plan_blocked']) }
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
const EVENT_RANK = ['death', 'interrupt', 'audience_request', 'idle_wait', 'plan_blocked', 'goal_failed', 'goal_done', 'subtask_failed', 'subtask_error', 'subtask_done']
export function pickEvent(events, mode = null) {
  const cares = mode ? EVENT_TRIGGERS[mode] : null
  for (const e of EVENT_RANK) if (events.includes(e) && (!cares || cares.has(e))) return e
  return null
}

// What an answer does, judged against what is running now. askedCurrentId is the subtask the leader was shown (or, when
// asked while idle, the one kev started right after); if that has ended, the answer is about a situation that is gone.
// Two guards (run 1: prompt rules alone did not hold) turn an otherwise valid override into 'blocked':
// - threat: the bot is in a threat response (fight, flee, pillar_up, build_shelter) with a hostile near (threatNear) and the answer
//   is not itself a threat response; switching into or between threat responses stays allowed;
// - recent_failure: the answer's id failed to path (or timed out) in one of its last two attempts (recentResults: the
//   runner's last subtask completions {id, result}, oldest first).
// build_shelter too (live stress session: at 1 hp the guard refused flee -> build_shelter and the bot died)
export const THREAT_RESPONSES = new Set(['fight(threat)', 'flee(threat)', 'pillar_up', 'build_shelter'])
export const PATH_FAILURES = new Set(['no_path', 'target_gone', 'timeout', 'not_found'])

// The failing result among the last two attempts of id in recentResults, or null.
export function recentFailure(id, recentResults) {
  const mine = (recentResults || []).filter(r => r && r.id === id).slice(-2)
  const bad = mine.reverse().find(r => PATH_FAILURES.has(r.result))
  return bad ? bad.result : null
}

// Goal answers (goalsEnabled only) are about the goal stack and the plans, not the running subtask, so they are never
// stale: push_goal carries the validated goal {kind, arg, count[, from]} (invalid with validateGoal's reason, prefixed
// with the goal, otherwise); pop_goal (the runner decides whether a pushed goal is there to pop) and cannot pass `why`
// through. The plan answers (pure: the runner applies them to its PlanBook):
// - plan_item {item: {name, count}}: a minecraft-data item name (else invalid 'unknown item <name>'), count default 1;
// - plan_steps {title, steps}: 1..MAX_PLAN_STEPS steps, each validated by validateGoal (invalid names the step);
// - edit {edit: {op, plan_id}}: op in EDIT_OPS; drop and move_front need an integer plan_id, skip and clear drop it;
// - say {text}: sanitized, not truncated below 200 (the runner splits long lines); empty is invalid;
// - plan_build {build: {template, params, material}}: a build template (TEMPLATES), only its params passed to
//   checkParams (defaults, clamps; no anchor here, the runner re-checks stairs targets against it), material default
//   cobblestone and placeable -> {template, params (checked, material included), material};
// - plan_dig {dig: {template, params, at_y}}: a dig template, checkParams without an anchor; at_y (optional) an integer
//   in AT_Y (the runner walks there first) -> {template, params, at_y (or null)};
// - plan_blueprint {blueprint: {title, kind, legend, layers}}: a free-form shape validated with the free-form caps and
//   no anchor (connectivity does not depend on it); a dig one holds only '.' and ' ' cells -> {blueprint: {title,
//   kind, legend, layers, source: 'leader'}};
//   invalid carries the title too, for the runner's BLUEPRINT FEEDBACK.
export const PLAN_ACTIONS = ['plan_item', 'plan_steps', 'edit', 'say', 'plan_build', 'plan_dig', 'plan_blueprint']
export const GOAL_ACTIONS = [...PLAN_ACTIONS, 'push_goal', 'pop_goal', 'cannot']
export const EDIT_OPS = ['skip', 'drop', 'move_front', 'clear']
const EDIT_NEEDS_PLAN = new Set(['drop', 'move_front'])
export const MAX_PLAN_STEPS = 8
const SAY_MAX = 1000
export const BUILD_TEMPLATES = Object.keys(TEMPLATES).filter(n => TEMPLATES[n].kind === 'build')
export const DIG_TEMPLATES = Object.keys(TEMPLATES).filter(n => TEMPLATES[n].kind === 'dig')
export const AT_Y = { min: -58, max: 319 }
const FREE_FORM = { maxSize: 9, maxBlocks: 150 }
const DEFAULT_MATERIAL = 'cobblestone'
const goalText = ({ kind, arg, count } = {}) => `${kind}${arg != null || count != null ? `(${[arg, count].filter(x => x != null).join(', ')})` : ''}`
// A goal object as the model sent it -> {kind, arg, count} plus from only when given (a receive goal's giver).
const goalOf = raw => {
  const goal = { kind: raw.kind ?? null, arg: raw.arg == null || raw.arg === '' ? null : raw.arg, count: raw.count ?? null }
  if (typeof raw.from === 'string' && raw.from !== '') goal.from = raw.from
  return goal
}

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

export function applyAnswer({ answer, currentId, askedCurrentId, offered, threatNear = false, recentResults = [], goalsEnabled = false, obs = null,
  requests = [], recentSays = [] }) {
  const action = answer?.action ?? null
  if (!action) return { kind: 'invalid', id: null }
  if (goalsEnabled && GOAL_ACTIONS.includes(action)) {
    const why = typeof answer.why === 'string' ? answer.why : ''
    if (action === 'say') return guardSay(applyPlanAnswer(action, answer, why, obs), requests, recentSays)
    if (PLAN_ACTIONS.includes(action)) return applyPlanAnswer(action, answer, why, obs)
    if (action !== 'push_goal') return { kind: action, id: null, why }
    const raw = answer.goal
    if (!raw || typeof raw !== 'object') return { kind: 'invalid', id: action, reason: 'push_goal without a goal' }
    const goal = goalOf(raw)
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

// The cannot backstop (live stress session: the leader refused "white bed", "5 leather" and "ender pearl" as outside its
// lists). itemInRequest parses the PLAYER's request text (never the model's): scanning left to right, at each word the
// two-word underscore join first, then the word alone, each as written, without a trailing 's', then without 'es';
// the first minecraft-data item wins, with the integer right before it as the count (else 1). Common English words
// that happen to be items are skipped.
const NOT_ITEM_WORDS = new Set(['air', 'light', 'target', 'chain', 'lead', 'barrier', 'structure_void', 'jigsaw'])
export function itemInRequest(text) {
  const w = String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  const forms = x => [x, x.replace(/s$/, ''), x.replace(/es$/, '')]
  const hit = x => forms(x).find(f => !NOT_ITEM_WORDS.has(f) && isItem(f)) ?? null
  const countAt = i => (i > 0 && /^\d+$/.test(w[i - 1]) ? Math.max(1, Math.min(64, Number(w[i - 1]))) : 1)
  for (let i = 0; i < w.length; i++) {
    if (/^\d+$/.test(w[i])) continue
    const two = i + 1 < w.length ? hit(`${w[i]}_${w[i + 1]}`) : null
    const item = two ?? hit(w[i])
    if (item) return { item, count: countAt(i) }
  }
  return null
}
// The leader's own cannot (not the code's night or blocked-plan refusal) to shown requests: the first request naming an
// item whose expansion has steps or a missing leaf becomes plan_item (the code plans it or says what is missing);
// otherwise null and the cannot stands.
export function cannotBackstop(res, requests = [], inventory = {}, { placed } = {}) {
  if (res?.kind !== 'cannot' || res.night || res.guard) return null
  return requestItemPlan(requests, inventory, placed, res.why ?? '', 'cannot')
}
// The same for a plan_item the validator refused as an unknown item (retry probe: "white bed" came back as plan_item
// "bed"): the request text's item is planned instead, else null and the invalid answer stands.
export function unknownItemBackstop(res, requests = [], inventory = {}, { placed } = {}) {
  if (res?.kind !== 'invalid' || res.id !== 'plan_item' || !String(res.reason ?? '').startsWith('unknown item')) return null
  return requestItemPlan(requests, inventory, placed, '', 'unknown_item')
}
function requestItemPlan(requests, inventory, placed, why, via) {
  for (const r of (requests || []).slice(0, MAX_REQUESTS)) {
    const m = itemInRequest(r?.text)
    if (!m) continue
    const ex = expandItem(m.item, m.count, inventory || {}, placed ? { placed } : {})
    if (ex.steps.length || ex.missing.length) return { kind: 'plan_item', id: null, item: m.item, count: m.count, why, via }
  }
  return null
}
// A model's item name as minecraft-data spells it: lowercase, no minecraft: prefix, spaces and dashes to underscores.
const normItem = n => typeof n === 'string' ? n.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_') : n

// The say guards (live stress session: say used to acknowledge instead of acting, 7 identical lines, and to refuse with
// invented reasons). requests: the ones the call showed; recentSays: the leader's say texts so far (the last SAY_MEMORY
// count). A say is invalid with nothing to reply to, with no question among the requests, or when it repeats one of them.
export const SAY_MEMORY = 5
const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
// A shown request (the first MAX_REQUESTS, as the prompt renders them) asks a question: it contains '?' or its first
// word is a question word (players skip the '?': "where are you", "do you have an iron pick").
const QUESTION_WORDS = new Set(['what', 'where', 'when', 'why', 'how', 'who', 'which', 'whose', 'is', 'are', 'am', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'have', 'has', 'should'])
const asksQuestion = text => { const s = String(text ?? '').trim().toLowerCase(); return s.includes('?') || QUESTION_WORDS.has(s.split(/[^a-z]+/)[0]) }
export const hasQuestion = (requests = []) => requests.slice(0, MAX_REQUESTS).some(r => asksQuestion(r?.text))
function guardSay(res, requests, recentSays) {
  if (res.kind !== 'say') return res
  const bad = reason => ({ kind: 'invalid', id: 'say', reason })
  if (!requests?.length) return bad('nothing to reply to')
  if (!hasQuestion(requests)) return bad('say only answers a question; nobody asked one')
  if ((recentSays || []).slice(-SAY_MEMORY).some(t => sameText(t, res.text))) return bad('repeated reply')
  return res
}
// The leader's say texts from the runner's events, the last SAY_MEMORY.
export const recentSayTexts = events => (events || []).filter(e => e?.kind === 'leader_say' && typeof e.text === 'string').map(e => e.text).slice(-SAY_MEMORY)
// The FEEDBACK line for the next call: a refused say with requests shown (they stay pending), else null.
export function leaderFeedback(res, hasRequests) {
  if (res?.kind !== 'invalid' || res.id !== 'say' || !hasRequests) return null
  return `your last answer was refused: ${res.reason}; act on the request with a goal, a plan or cannot`
}

function applyPlanAnswer(action, answer, why, obs) {
  const bad = reason => ({ kind: 'invalid', id: action, reason })
  if (action === 'plan_item') {
    const it = answer.item
    if (!it || typeof it !== 'object') return bad('plan_item without an item')
    const name = normItem(it.name)
    if (!isItem(name)) return bad(`unknown item ${it.name}`)
    const count = it.count ?? 1
    if (!Number.isInteger(count) || count < 1) return bad(`bad count ${count}`)
    return { kind: 'plan_item', id: null, item: name, count: Math.min(64, count), why }   // the expander's cap: the title matches the plan
  }
  if (action === 'plan_steps') {
    const raw = answer.steps
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PLAN_STEPS) return bad(`plan_steps needs 1 to ${MAX_PLAN_STEPS} steps`)
    const steps = []
    for (let i = 0; i < raw.length; i++) {
      if (!raw[i] || typeof raw[i] !== 'object') return bad(`step ${i + 1}: not a goal`)
      const goal = goalOf(raw[i])
      const v = validateGoal(goal, obs)
      if (!v.ok) return bad(`step ${i + 1} ${goalText(goal)}: ${v.reason}`)
      steps.push(v.goal ? { ...goal, ...v.goal } : goal)
    }
    const title = sanitizeChat(answer.title, 60).trim() || steps.map(goalText).join(', ').slice(0, 60)
    return { kind: 'plan_steps', id: null, title, steps, why }
  }
  if (action === 'edit') {
    const e = answer.edit
    if (!e || typeof e !== 'object') return bad('edit without an op')
    if (!EDIT_OPS.includes(e.op)) return bad(`unknown edit op ${e.op}`)
    if (!EDIT_NEEDS_PLAN.has(e.op)) return { kind: 'edit', id: null, op: e.op, plan_id: null, why }
    if (!Number.isInteger(e.plan_id)) return bad(`edit ${e.op} needs a plan_id`)
    return { kind: 'edit', id: null, op: e.op, plan_id: e.plan_id, why }
  }
  if (action === 'plan_build' || action === 'plan_dig') return applyTemplateAnswer(action, answer, why)
  if (action === 'plan_blueprint') return applyBlueprintAnswer(answer, why)
  const text = sanitizeChat(typeof answer.text === 'string' && answer.text.trim() ? answer.text : answer.reply, SAY_MAX).trim()   // a say may put its line in reply
  if (!text) return bad('say without text')
  return { kind: 'say', id: null, text }
}

function applyTemplateAnswer(action, answer, why) {
  const bad = reason => ({ kind: 'invalid', id: action, reason })
  const isBuild = action === 'plan_build'
  const key = isBuild ? 'build' : 'dig'
  const a = answer[key]
  if (!a || typeof a !== 'object') return bad(`${action} without a ${key}`)
  if (!(isBuild ? BUILD_TEMPLATES : DIG_TEMPLATES).includes(a.template)) return bad(`unknown ${key} template ${a.template}`)
  const given = a.params && typeof a.params === 'object' ? a.params : {}
  const params = {}
  for (const k of Object.keys(TEMPLATES[a.template].params)) if (Object.hasOwn(given, k)) params[k] = given[k]
  if (isBuild) params.material = typeof a.material === 'string' && a.material ? a.material : DEFAULT_MATERIAL
  const chk = checkParams(a.template, params)
  if (!chk.ok) return bad(chk.reason)
  if (isBuild) return { kind: action, id: null, template: a.template, params: chk.params, material: chk.params.material, why }
  let atY = null
  if (a.at_y != null) {
    if (!Number.isInteger(a.at_y)) return bad('at_y must be an integer')
    if (a.at_y < AT_Y.min || a.at_y > AT_Y.max) return bad(`at_y ${a.at_y} is outside ${AT_Y.min}..${AT_Y.max}`)
    atY = a.at_y
  }
  return { kind: action, id: null, template: a.template, params: chk.params, at_y: atY, why }
}

// What the model writes for a legend, as the blueprint format wants it (live probe: {"S": "stone", ".": "air"}): entries
// keyed '.' or ' ' dropped; values lowercased, "minecraft:" stripped, spaces to underscores; a single-character key
// whose value means air has its cells rewritten to '.' and the entry dropped. Malformed layers pass through for
// validate to refuse.
const AIR_WORDS = new Set(['air', 'cave_air', 'void_air', 'empty', 'nothing'])
export function normalizeShape(rawLegend, rawLayers) {
  const legend = {}
  const air = new Set()
  const src = rawLegend && typeof rawLegend === 'object' && !Array.isArray(rawLegend) ? rawLegend : {}
  for (const [k, v] of Object.entries(src)) {
    if (k === '.' || k === ' ') continue
    const name = typeof v === 'string' ? v.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_') : v
    if (k.length === 1 && AIR_WORDS.has(name)) { air.add(k); continue }
    legend[k] = name
  }
  const wellFormed = Array.isArray(rawLayers) && rawLayers.every(l => Array.isArray(l) && l.every(r => typeof r === 'string'))
  const layers = wellFormed && air.size ? rawLayers.map(l => l.map(r => [...r].map(ch => air.has(ch) ? '.' : ch).join(''))) : rawLayers
  return { legend, layers }
}

function applyBlueprintAnswer(answer, why) {
  const b = answer.blueprint
  if (!b || typeof b !== 'object') return { kind: 'invalid', id: 'plan_blueprint', reason: 'plan_blueprint without a blueprint' }
  const title = sanitizeChat(b.title, 60).trim() || 'blueprint'
  const bad = reason => ({ kind: 'invalid', id: 'plan_blueprint', reason, title })
  const bp = { title, kind: b.kind, ...normalizeShape(b.legend, b.layers), source: 'leader' }
  const v = validate(bp, FREE_FORM)
  if (!v.ok) return bad(v.reason)
  if (bp.kind === 'dig' && cells(bp).some(c => c.want !== 'air')) return bad('a dig blueprint can only contain . (dig) and spaces')
  if (!cells(bp).length) return bad('empty blueprint')
  return { kind: 'plan_blueprint', id: null, blueprint: bp, why }
}

// dig(<bp id>) arrives through the blueprint plans only (the leader never names a blueprint id), so the schema is unchanged
export const PUSHABLE_KINDS = Object.keys(GOAL_KINDS).filter(k => k !== 'chain' && k !== 'iron_pickaxe' && k !== 'dig')
const STEP_SCHEMA = { type: 'object', properties: { kind: { type: 'string', enum: PUSHABLE_KINDS }, arg: { type: 'string' }, count: { type: 'integer' }, from: { type: 'string' } }, required: ['kind'] }
// params: every param name of that kind's templates as an optional integer (applyAnswer keeps the chosen template's)
const paramsSchema = names => ({ type: 'object', properties: Object.fromEntries([...new Set(names.flatMap(n => Object.keys(TEMPLATES[n].params)))].map(k => [k, { type: 'integer' }])) })
const BUILD_SCHEMA = { type: 'object', properties: { template: { type: 'string', enum: BUILD_TEMPLATES }, params: paramsSchema(BUILD_TEMPLATES), material: { type: 'string' } }, required: ['template'] }
const DIG_SCHEMA = { type: 'object', properties: { template: { type: 'string', enum: DIG_TEMPLATES }, params: paramsSchema(DIG_TEMPLATES), at_y: { type: 'integer' } }, required: ['template'] }
const BLUEPRINT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    kind: { type: 'string', enum: ['build', 'dig'] },
    legend: { type: 'object', additionalProperties: { type: 'string' } },   // single-character keys: checked by validate
    layers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: ['title', 'kind', 'layers'],
}

// blueprints (default false): the plan_build / plan_dig / plan_blueprint answers and their payloads; without, the
// schema is the one before the blueprint answers (66867fc).
export const BLUEPRINT_ACTIONS = ['plan_build', 'plan_dig', 'plan_blueprint']
const goalActionsFor = ({ blueprints = false } = {}) => blueprints ? GOAL_ACTIONS : GOAL_ACTIONS.filter(a => !BLUEPRINT_ACTIONS.includes(a))
// requests: the ones the prompt shows; say is in the action enum only when one of them asks a question (hasQuestion).
export const leaderSchema = (options, { goals = false, blueprints = false, requests = [] } = {}) => goals ? {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['continue', ...goalActionsFor({ blueprints }).filter(a => a !== 'say' || hasQuestion(requests)), ...options.map(o => o.id)] },
    goal: STEP_SCHEMA,
    item: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name'] },
    title: { type: 'string' },
    steps: { type: 'array', items: STEP_SCHEMA, minItems: 1, maxItems: MAX_PLAN_STEPS },
    edit: { type: 'object', properties: { op: { type: 'string', enum: EDIT_OPS }, plan_id: { type: 'integer' } }, required: ['op'] },
    text: { type: 'string' },
    ...(blueprints ? { build: BUILD_SCHEMA, dig: DIG_SCHEMA, blueprint: BLUEPRINT_SCHEMA } : {}),
    reply: { type: 'string' },   // any action: a short line the runner sends to the player (live retry: talking and acting were exclusive)
    why: { type: 'string' },
  },
  required: ['action'],
} : {
  type: 'object',
  properties: { action: { type: 'string', enum: ['continue', ...options.map(o => o.id)] }, why: { type: 'string' } },
  required: ['action'],
}

// With goals, the goal actions are accepted and `goal` ({kind, arg, count[, from]} as sent, or null) is returned for
// applyAnswer to validate, plus the plan answer's payload (item, title + steps, edit, text) when the action is one of
// PLAN_ACTIONS; without, the result is {action, why} exactly as before. Without blueprints a blueprint action is refused
// (action null) like any action outside the schema.
export function parseLeaderAnswer(text, options, { goals = false, blueprints = false } = {}) {
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
  const ok = a === 'continue' || options.some(o => o.id === a) || (goals && goalActionsFor({ blueprints }).includes(a))
  if (!goals) return { action: ok ? a : null, why }
  const goal = obj.goal && typeof obj.goal === 'object' ? parsedGoal(obj.goal) : null
  const out = { action: ok ? a : null, why, goal, reply: typeof obj.reply === 'string' ? obj.reply : null }
  if (!ok) return out
  const o = x => x && typeof x === 'object' && !Array.isArray(x) ? x : null
  if (a === 'plan_item') out.item = o(obj.item) && { name: typeof obj.item.name === 'string' ? obj.item.name : null, count: Number.isInteger(obj.item.count) ? obj.item.count : null }
  if (a === 'plan_steps') { out.title = typeof obj.title === 'string' ? obj.title : ''; out.steps = Array.isArray(obj.steps) ? obj.steps.map(s => o(s) ? parsedGoal(s) : null) : null }
  if (a === 'edit') out.edit = o(obj.edit) && { op: typeof obj.edit.op === 'string' ? obj.edit.op : null, plan_id: Number.isInteger(obj.edit.plan_id) ? obj.edit.plan_id : null }
  if (a === 'say') out.text = typeof obj.text === 'string' ? obj.text : ''
  // template and blueprint payloads pass through as sent (applyAnswer checks them)
  const tpl = (x, extra) => o(x) && { template: typeof x.template === 'string' ? x.template : null, params: o(x.params) ?? {}, [extra]: x[extra] ?? null }
  if (a === 'plan_build') out.build = tpl(obj.build, 'material')
  if (a === 'plan_dig') out.dig = tpl(obj.dig, 'at_y')
  if (a === 'plan_blueprint') out.blueprint = o(obj.blueprint)
  return out
}
const parsedGoal = gl => {
  const g = { kind: typeof gl.kind === 'string' ? gl.kind : null, arg: typeof gl.arg === 'string' ? gl.arg : null, count: Number.isInteger(gl.count) ? gl.count : null }
  if (typeof gl.from === 'string') g.from = gl.from
  return g
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
// The BUILDING AND DIGGING block and the plan_build / plan_dig / plan_blueprint answers are offered only with blueprints
// (the runner wires the blueprint book; live stress session: plan_dig was chosen in a session without it and the
// request was settled silently). Without, the prompt is byte-identical to the one before the blueprint answers (66867fc).
const BLUEPRINT_RULES = `BUILDING AND DIGGING. A shape is built or dug from the requesting player's feet, facing where they look. Templates, name(param min-max [default], ...) kind: what it is:
${describeTemplates()}
- plan_build: {"action": "plan_build", "build": {"template": "hut", "params": {"w": 5, "d": 5, "h": 3}, "material": "cobblestone"}, "why": ...}; material a full block (default cobblestone);
- plan_dig: {"action": "plan_dig", "dig": {"template": "strip_mine", "params": {}, "at_y": -58}, "why": ...}; at_y (optional) walks down or up to that level first;
- plan_blueprint: {"action": "plan_blueprint", "blueprint": {"title": "arch", "kind": "build", "legend": {"#": "stone_bricks"}, "layers": [["#.#"], ["###"]]}, "why": ...}; layers bottom first, rows nearest first, one legend character per block, '.' air, ' ' any.
Use a template whenever one fits; write your own blueprint (plan_blueprint) only for a shape no template covers, full blocks only, at most 9x9x9.
Examples: "build me a small stone hut" -> plan_build hut w 5 d 5 h 3 material cobblestone; "stairs up 6 blocks" -> plan_build staircase_up height 6; "dig a 3x3x2 cave here" -> plan_dig room w 3 d 3 h 2; "mine down to y 12" -> plan_dig stairs_down_to y 12; "strip mine for diamonds" -> plan_dig strip_mine at_y -58.
`
export function leaderSystemGoals({ blueprints = false } = {}) {
  const bpActions = blueprints ? ', plan_build, plan_dig, plan_blueprint' : ''
  const bpFormat = blueprints ? ' | "plan_build" | "plan_dig" | "plan_blueprint"' : ''
  const bpFields = blueprints ? ', "build" (plan_build only), "dig" (plan_dig only), "blueprint" (plan_blueprint only)' : ''
  return `${LEADER_RULES}

Goals. Above kev's subtasks there is a goal stack: the chain at the bottom, and on top any goals pushed by you or asked for by the audience (players chatting with the bot). kev works on the top goal until it is done or stuck, then the one below resumes. Plans: the PLANS section lists the bot's plans, ordered goal steps it works through one at a time, the front plan first (numbered #1, #2, ...), then any plan blocked in the last 10 minutes ("blocked #n ...: reason"; the code refuses to plan it again until a new request asks). Besides "continue" and a subtask id you can answer:
- plan_item with an item: {"action": "plan_item", "item": {"name": "compass", "count": 1}, "why": ...};
- plan_steps with a title and 1 to 8 goal steps: {"action": "plan_steps", "title": "stone from home", "steps": [{"kind": "go_to", "arg": "base"}, {"kind": "gather", "arg": "cobblestone", "count": 8}], "why": ...};
- edit with an op (skip, drop, move_front, clear) and, for drop and move_front, the plan number from PLANS: {"action": "edit", "edit": {"op": "drop", "plan_id": 3}, "why": ...};
- say with a line the audience reads, only for conversation (a question with nothing to do); when a request can be acted on, act and answer in reply: {"action": "say", "text": "...", "why": ...};
- push_goal with a typed goal: {"action": "push_goal", "goal": {"kind": ..., "arg": ..., "count": ...}, "why": ...};
- pop_goal: drop the top pushed goal when it is pointless now (its materials are lost, night has fallen on the surface, it keeps failing);
- cannot: decline an audience request; write one short friendly sentence saying why in reply (or in "why").
Every answer may also carry "reply": one short line the player reads in chat. Add a short reply for the player whenever you act on a request ("on my way!", "sure, making it now").
push_goal goal kinds and their arguments (these lists are for push_goal only; plan_item is not limited to them):
- craft_item (push_goal only), arg one of: ${list(Object.keys(RECIPES))};
- gather (push_goal only), arg one of: ${list(Object.keys(PRODUCERS))}; count an integer from 1 to 64;
- find, arg one of: ${list(FINDABLE_NOW)};
- go_to, arg one of: ${list(PLACES)}, or player:<name>, or y:<height>;
- build, arg one of: ${list(Object.keys(STRUCTURES).filter(k => STRUCTURES[k].executor))};
- receive, arg an item, count, from the name of the player giving it (the bot waits for the item);
- survive_night, return_to_base: no arg.
For a request that names an item, answer plan_item with the item's minecraft-data name and a count (default 1; 'some' = 8); the code expands it into steps and announces them, so never list the steps yourself. plan_item takes ANY Minecraft item name (beds, torches, glass, leather, wool, compasses, tools, blocks); code works out how to get it (mining, smelting, crafting, hunting animals) and tells the player if it cannot. Never answer cannot for an item without trying plan_item first. plan_steps only for requests that are not an item (a trip, a sequence of goals). edit changes the plans on request ('skip that', 'forget the compass', 'do the stairs first', 'stop everything'). say only answers a question a player asked (it is offered only then); never use it to acknowledge, promise or refuse: act with a goal or a plan, or answer cannot. cannot only for things that are neither an item nor a goal above.
The split between plan_item and push_goal: an item the bot has to craft or smelt is plan_item, a raw material it gathers is one push_goal gather. Examples: "make me a compass" -> plan_item compass count 1; "some torches" -> plan_item torch count 8; "make me an iron sword" -> plan_item iron_sword count 1; "get me some logs" -> push_goal gather log count 8; "grab a bit of stone" -> push_goal gather cobblestone count 8; "can you find diamonds" -> push_goal find diamond_ore; "come home" -> push_goal return_to_base; "go to y 12" -> push_goal go_to, arg y:12; Steve says "come here" -> push_goal go_to, arg player:Steve; Steve says "I have 4 redstone for you" -> push_goal receive, arg redstone, count 4, from Steve.
${blueprints ? BLUEPRINT_RULES : ''}Answer every audience request with exactly one of plan_item, plan_steps${bpActions}, edit, say, push_goal, pop_goal or cannot, whatever the current subtask is. Without a number, gather uses count 8. When you answer cannot, name what the bot can do instead (an item, a trip, the goal kinds above), not the current subtasks.
Prefer goals to subtask overrides: push a goal and let kev choose the subtasks.
Audience requests always come before the default goal chain; the chain resumes afterwards.
Never push a goal that sends the bot to the surface at night (go_to surface, gather wood, find water or a cave on the surface): the night protocol comes first; push it in the morning or answer cannot. The night rule only forbids surface work at night; going underground (go_to y:<n>, digging down) is safe at night.
"continue" remains the default when there is no request and the goals make progress.

Answer with JSON only: {"action": "continue" | "push_goal" | "pop_goal" | "cannot" | "plan_item" | "plan_steps" | "edit" | "say"${bpFormat} | "<subtask id>", "goal": {"kind": "<goal kind>", "arg": "<argument>", "count": <integer>, "from": "<player>"} (push_goal only), "item": {"name": "<item>", "count": <integer>} (plan_item only), "title": "<title>", "steps": [<goal>, ...] (plan_steps only), "edit": {"op": "skip" | "drop" | "move_front" | "clear", "plan_id": <integer>} (edit only), "text": "<line>" (say only)${bpFields}, "reply": "<short line for the player>" (optional, any action), "why": "<one sentence>"}`
}
export const LEADER_SYSTEM_GOALS = leaderSystemGoals({ blueprints: true })

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
    case 'plan_blocked': {
      const st = e.step ? [e.step.kind, e.step.arg].filter(x => x != null).join(' ') : ''
      const at = e.step_index != null ? `step ${e.step_index + 1}${st ? ` ${st}` : ''}` : st ? `step ${st}` : 'a step'
      return `${T(e.t)} plan #${e.plan_id}${e.title ? ` (${sanitizeChat(e.title, 60)})` : ''} blocked at ${at}${e.reason ? `: ${sanitizeChat(e.reason, 80)}` : ''}`
    }
    case 'plan_added': {
      const p = e.plan || {}, n = p.steps?.length ?? 0
      const who = typeof p.source === 'string' && p.source.startsWith('audience:') ? ` for ${sanitizeChat(p.source.slice(9), 40)}` : ''
      return `${T(e.t)} plan #${p.id} ${sanitizeChat(p.title, 60)} added (${n} step${n === 1 ? '' : 's'})${who}`
    }
    case 'plan_step': return `${T(e.t)} plan #${e.plan_id} step ${e.step_index + 1}/${e.of}: ${stepText(e.step)}`
    case 'plan_done': return `${T(e.t)} plan #${e.plan_id}${e.title ? ` ${sanitizeChat(e.title, 60)}` : ''} done`
    case 'plan_edit': return `${T(e.t)} plan edit ${e.op}${e.plan_id != null ? ` #${e.plan_id}` : ''}: ${sanitizeChat(e.result ?? 'nothing to change', 120)}`
    case 'plan_missing': return `${T(e.t)} cannot plan ${humanize(e.item)}: needs ${(e.missing || []).map(humanize).join(', ')} (no way to get it)`
    case 'leader_say': return `${T(e.t)} you said: ${sanitizeChat(e.text, 160)}`
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
  'goal_failed', 'goal_pushed', 'goal_popped', 'leader_cannot', 'plan_blocked', 'plan_added', 'plan_step', 'plan_done', 'plan_edit', 'plan_missing',
  'leader_say'])

// Chat text for the prompt and for the bot's own chat lines: no special-token markers, one line (newlines become a
// space), no formatting codes (a section sign and the code after it) and no other control characters (below 0x20,
// 0x7f): the server disconnects a client that sends them, which would end the episode. Capped.
export const sanitizeChat = (s, max = 200) => String(s ?? '').replace(/<\||\|>/g, '').replace(/[\r\n]+/g, ' ')
  .replace(/\u00a7.?/gs, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)

// A chat text as lines of 1..max characters split at word boundaries (runs of whitespace collapse; a word longer than
// max is cut). Blank text gives no lines. The runner's say() sends each line through the ChatQueue.
export function splitChat(text, max = 200) {
  const out = []
  let line = ''
  for (let w of String(text ?? '').split(/\s+/).filter(Boolean)) {
    while (w.length > max) {
      if (line) { out.push(line); line = '' }
      out.push(w.slice(0, max)); w = w.slice(max)
    }
    if (!w) continue
    if (!line) line = w
    else if (line.length + 1 + w.length <= max) line += ' ' + w
    else { out.push(line); line = w }
  }
  if (line) out.push(line)
  return out
}

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
    // vanilla sends chat.type.text; Paper 1.20.4 sends the literal format string '<%s> %s' as the translate key
    const key = String(jsonMsg.translate)
    if ((key !== 'chat.type.text' && !/^<%s> %s$/.test(key)) || !Array.isArray(jsonMsg.with) || jsonMsg.with.length < 2) return null
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
// cannot, plan_item, plan_steps, edit, say; the runner passes an invalid push it replied to as cannot). Any other outcome of a call that showed it
// (continue, override, blocked, stale, invalid, error) leaves it waiting; after maxShown such calls it is settled as
// 'not_now' and returned so the runner can reply "Not now". Ids are 1, 2, ... in arrival order.
export const REQUEST_ANSWERS = new Set([...GOAL_ACTIONS, 'reply'])
// How a call's outcome settles the audience requests it showed: an invalid goal-level answer (push_goal or a plan answer
// the validator refused: an unknown item, a bad step, an edit without its plan_id, an empty say) is replied to with the
// reason, so it settles them as cannot; every other outcome settles as its own kind.
// A refused say is not replied to (it settles nothing; the next prompt carries FEEDBACK, leaderFeedback).
const REPLIED_INVALID = new Set(['push_goal', ...PLAN_ACTIONS.filter(a => a !== 'say')])
// A continue or override that carries a reply (the runner sends it) answers the shown requests as 'reply'.
export function settleKind(res, hasRequests, reply = null) {
  if (hasRequests && (res?.kind === 'continue' || res?.kind === 'override') && typeof reply === 'string' && reply.trim()) return 'reply'
  return res?.kind === 'invalid' && hasRequests && REPLIED_INVALID.has(res.id) ? 'cannot' : res?.kind ?? null
}
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
      progress: GOAL_KINDS[g.kind].step(obs, g.arg, g.count, g).text })),
  }
}

function renderGoalStack(view) {
  const out = [view.text || '(chain only)']
  for (const g of view.pushed || [])
    out.push(`#${g.id} ${goalText(g)} from ${sanitizeChat(g.source, 40)}, pushed at ${g.t != null ? T(g.t) : 't=?'}, progress ${g.progress}`)
  if (!view.pushed?.length) out.push('no pushed goals')
  return out
}

// The PLANS section: the plan book's render() lines (the runner passes them), or (none).
function renderPlans(plans) {
  if (!Array.isArray(plans) || !plans.length || (plans.length === 1 && plans[0] === 'no plans')) return ['(none)']
  return plans.map(l => sanitizeChat(l, 400))
}

// The CONVERSATION section (goals mode, only when there is chat): the last MAX_CONVERSATION chat lines both ways (the
// players' and the bot's own), {t, name, text}, sanitized and cut to 120 characters.
export const MAX_CONVERSATION = 8
function renderConversation(lines = []) {
  if (!lines?.length) return []
  return ['CONVERSATION (last 8 chat lines, oldest first)',
    ...lines.slice(-MAX_CONVERSATION).map(l => `${T(l.t)} ${sanitizeChat(l.name, 40)}: ${sanitizeChat(l.text, 120)}`), '']
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

// The active or blocked blueprint's cut (the runner passes { title, layer, of, lines } with layerCut's lines, layer
// 1-based) and the feedback on a refused free-form blueprint ({ title, reason }); nothing at all without them.
function renderBlueprint(cut, feedback) {
  const out = []
  if (cut) {
    out.push(`BLUEPRINT ${sanitizeChat(cut.title, 80)}: layer ${cut.layer} of ${cut.of}`,
      "('#' placed, 'o' still to place, 'x' wrong or blocked, '.' still to dig, '@' the bot; the farthest row on top)",
      ...(cut.lines || []).map(l => sanitizeChat(l, 20)), '')
  }
  if (feedback) out.push(`BLUEPRINT FEEDBACK: your blueprint "${sanitizeChat(feedback.title, 60)}" was refused: ${sanitizeChat(feedback.reason, 160)}. Fix it or answer cannot.`, '')
  return out
}

export function buildLeaderMessages({ stateText, chainText, need = null, options, current = null, history = [], forecasts = {}, forecastTrend = {}, kevPick = null,
  subtaskStats: stats = {}, ownHistory = [], minutesLeft = null, deaths = 0, recentResults = [], goalStack = null, requests = [], plans = null,
  blueprintCut = null, blueprintFeedback = null, blueprints = false, feedback = null, conversation = [], inventory = null }) {
  const goals = goalStack != null
  const none = xs => xs.length ? xs.join('\n') : '(none yet)'
  const events = history.filter(e => SHOWN_EVENTS.has(e.kind)).slice(-30).map(renderEvent)
  const own = ownHistory.slice(-5).map(h => `${T(h.t)} ${h.action ?? '(no answer)'}${h.kind && h.kind !== h.action ? ` (${h.kind})` : ''}${h.why ? `: ${h.why}` : ''}`)
  // INVENTORY (exact): the state text names tools without counts; with chat to answer, the leader gets every stack total
  const chat = goals && inventory && (requests.length > 0 || conversation?.length > 0)
  const inv = chat ? [`INVENTORY (exact): ${Object.entries(inventory).filter(([, n]) => n > 0).map(([k, n]) => `${sanitizeChat(k, 60)} x${n}`).join(', ') || 'empty'}`] : []
  const user = [
    'STATE', stateText, ...inv, '',
    'GOAL CHAIN', chainText, ...renderNeeds(need), '',
    ...(goals ? ['GOAL STACK', ...renderGoalStack(goalStack), '', 'PLANS', ...renderPlans(plans), ''] : []),
    ...renderBlueprint(blueprintCut, blueprintFeedback),
    'CURRENT SUBTASK', ...renderCurrent(current), '',
    'RECENT EVENTS (oldest first)', none(events), '',
    'SUBTASK STATS THIS EPISODE', none(renderStats(stats)), '',
    'KEV FORECASTS', none(renderForecasts(forecasts, forecastTrend, kevPick)), '',
    'YOUR PREVIOUS DECISIONS', none(own), '',
    'TIME', `${minutesLeft != null ? minutesLeft.toFixed(1) : '?'} minutes left in the episode; deaths so far: ${deaths}`, '',
    ...(goals ? renderConversation(conversation) : []),
    ...(goals ? ['AUDIENCE REQUESTS (unanswered)', ...renderRequests(requests), ''] : []),
    ...(goals && feedback ? [`FEEDBACK: ${sanitizeChat(feedback, 300)}`, ''] : []),
    'SUBTASKS OFFERED NOW', options.map(o => {
      const bad = recentFailure(o.id, recentResults)
      return `- ${o.id}: ${o.desc}${bad ? ` (failed recently: ${bad}, do not pick)` : ''}`
    }).join('\n'), '',
    goals ? 'Reply with JSON only: {"action": "continue" | "plan_item" | "plan_steps" | "edit" | "say" | "push_goal" | "pop_goal" | "cannot" | "<subtask id from the list>", "goal" (push_goal), "item" (plan_item), "title" and "steps" (plan_steps), "edit" (edit), "text" (say), "reply" (any action), "why": "<one sentence>"}'
      : 'Reply with JSON only: {"action": "continue" | "<subtask id from the list>", "why": "<one sentence>"}',
  ].join('\n')
  return [{ role: 'system', content: goals ? leaderSystemGoals({ blueprints }) : LEADER_SYSTEM }, { role: 'user', content: user }]
}
