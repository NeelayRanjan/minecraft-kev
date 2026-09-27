// The plan book (pure): ordered multi-step plans the player can see and edit from chat. A plan is a list of typed goal
// steps (the recipe expander's output, or the leader's); the front plan's current step is what the runner pushes on the
// goal stack (with plan_id and step_index, so the stack's goal_done/goal_failed events come back here). A failed step
// blocks its plan (kept, with the reason) and the next plan takes the front; skip drops one step, drop a whole plan.
import { MINE, HUNT } from './recipes.js'

const humanize = s => String(s).replace(/_/g, ' ')
const ACTIVE = new Set(['pending', 'running'])
export const BLOCKED_WINDOW_S = 600
const normTitle = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
// Active with a step left: a plan with no steps (expandItem of a held item) is done at add, and one whose cursor ran
// past its steps (a restored book) is never the front.
const live = p => ACTIVE.has(p.status) && p.cursor < p.steps.length

export function planTitle(item, count = 1) {
  return count > 1 ? `${count} ${humanize(item)}` : humanize(item)
}

// A step in chat words: "mine 4 raw iron", "smelt 4 iron", "craft compass", "shear 3 white wool".
const LEGACY_GATHER = { raw_iron: 'mine', cobblestone: 'mine', coal: 'mine', diamond: 'mine', flint: 'mine', obsidian: 'mine', iron_ingot: 'smelt',
  planks: 'craft', stick: 'craft', sticks: 'craft' }
const itemWord = item => humanize(String(item).replace(/_ingot$/, ''))
export function stepText({ kind, arg, count, from } = {}) {
  const n = count != null ? `${count} ` : ''
  switch (kind) {
    case 'gather': {
      const verb = LEGACY_GATHER[arg] || (MINE[arg] ? 'mine' : /_planks$/.test(arg) ? 'craft' : 'gather')
      return `${verb} ${n}${itemWord(arg)}`
    }
    case 'craft_item': return `craft ${planTitle(arg, count ?? 1)}`
    case 'smelt_item': return `smelt ${n}${itemWord(arg)}`
    case 'hunt': return `${HUNT[arg]?.via === 'shear' ? 'shear' : 'hunt'} ${n}${itemWord(arg)}`
    case 'receive': return `get ${n}${itemWord(arg)} from ${from}`
    case 'go_to': return `go to ${String(arg).startsWith('player:') ? arg.slice(7) : humanize(arg)}`
    default: return [humanize(kind), arg != null ? humanize(arg) : null].filter(Boolean).join(' ')
  }
}

export class PlanBook {
  constructor() { this.plans = []; this.nextId = 1 }
  static fromJSON({ plans = [] } = {}) {
    const b = new PlanBook()
    b.plans = plans.map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) }))
    b.nextId = 1 + b.plans.reduce((m, p) => Math.max(m, p.id), 0)
    return b
  }
  // item/count (an item plan: goals.refreshPlanStep re-expands it when a step is pushed), more/base (n MORE of it) and
  // materials_only are kept only when given.
  add({ title, steps, source, t = null, item = null, count = null, more = false, base = null, materials_only = false }) {
    const plan = { id: this.nextId++, title, source, steps: steps.map(s => ({ ...s })), cursor: 0, status: 'pending', t, end_t: null, reason: null,
      ...(item ? { item, count: count ?? 1 } : {}), ...(item && more ? { more: true, base: base ?? 0 } : {}), ...(item && materials_only ? { materials_only: true } : {}) }
    if (!plan.steps.length) { plan.status = 'done'; plan.end_t = t }
    this.plans.push(plan)
    return plan
  }
  active() { return this.plans.filter(live) }
  front() {
    const p = this.plans.find(live)
    if (!p) return null
    p.status = 'running'
    return p
  }
  currentGoal() {
    const p = this.front()
    if (!p || p.cursor >= p.steps.length) return null
    const { skipped, ...step } = p.steps[p.cursor]
    return { ...step, plan_id: p.id, step_index: p.cursor }
  }
  // Moves the cursor past the current step (done or skipped); finishes the plan after its last step.
  #next(p, t, out) {
    p.cursor++
    if (p.cursor >= p.steps.length) { p.status = 'done'; p.end_t = t; out.push({ kind: 'plan_done', plan_id: p.id, step_index: p.cursor - 1 }) }
  }
  // ev: a goal event, { kind: 'goal_done'|'goal_failed', plan_id, step_index, reason } or the goal stack's shape
  // { kind, goal: { plan_id, step_index }, reason }. Only the running (front) plan moves: events for another plan (a
  // demoted one keeps its cursor and resumes that step at the front again) or another step are stale: ignored.
  advance(ev, t) {
    const planId = ev.plan_id ?? ev.goal?.plan_id, index = ev.step_index ?? ev.goal?.step_index
    const p = this.plans.find(q => q.id === planId)
    if (!p || p.status !== 'running' || index !== p.cursor) return []
    if (ev.kind === 'goal_done') {
      const out = [{ kind: 'plan_step_done', plan_id: p.id, step_index: index }]
      this.#next(p, t, out)
      return out
    }
    if (ev.kind === 'goal_failed') {
      p.status = 'blocked'; p.reason = ev.reason ?? null; p.end_t = t
      return [{ kind: 'plan_blocked', plan_id: p.id, step_index: index, reason: p.reason }]
    }
    return []
  }
  skip(t) {
    const p = this.front()
    if (!p || p.cursor >= p.steps.length) return null
    const step = p.steps[p.cursor]
    step.skipped = true
    const out = []
    this.#next(p, t, out)
    const tail = p.status === 'done' ? `plan #${p.id} ${p.title} done` : `next: ${stepText(p.steps[p.cursor])}`
    return `skipped ${stepText(step)}; ${tail}`
  }
  drop(id, t) {
    const p = this.plans.find(q => q.id === id)
    if (!p || !ACTIVE.has(p.status)) return null
    p.status = 'dropped'; p.end_t = t
    return `dropped plan #${p.id} ${p.title}`
  }
  moveFront(id) {
    const i = this.plans.findIndex(q => q.id === id)
    if (i < 0 || !ACTIVE.has(this.plans[i].status)) return null
    for (const q of this.plans) if (q.status === 'running') q.status = 'pending'
    const [p] = this.plans.splice(i, 1)
    this.plans.unshift(p)
    return `plan #${p.id} ${p.title} moves to the front`
  }
  clear(t) {
    const act = this.active()
    if (!act.length) return 'no plans to clear'
    for (const p of act) { p.status = 'dropped'; p.end_t = t }
    return `cleared ${act.length} plan${act.length === 1 ? '' : 's'}`
  }
  // Chat lines: the front plan with a mark per step (✓ done, ✗ skipped, ▶ current, · to do), then the queue.
  render() {
    const [p, ...rest] = this.active()
    if (!p) return ['no plans']
    const marks = p.steps.map((s, i) => `${s.skipped ? '✗' : i < p.cursor ? '✓' : i === p.cursor ? '▶' : '·'} ${stepText(s)}`)
    const lines = [`Plan #${p.id} ${p.title}: ${marks.join(' ')}`]
    if (rest.length) lines.push(`then: ${rest.map(q => `#${q.id} ${q.title}`).join(', ')}`)
    return lines
  }
  // A blocked plan with this title (case and spaces ignored) that ended within windowS of t, unless one of `requests`
  // ({t}) arrived after it was blocked: the leader may not plan it again yet (final review: blocked plans were re-planned
  // every ~300 s). The newest such plan, or null.
  stillBlocked(title, t, requests = [], windowS = BLOCKED_WINDOW_S) {
    const key = normTitle(title)
    const p = [...this.plans].reverse().find(q => q.status === 'blocked' && normTitle(q.title) === key && q.end_t != null && t - q.end_t <= windowS)
    if (!p) return null
    return requests.some(r => r.t > p.end_t) ? null : p
  }
  // The leader's PLANS lines for plans blocked within windowS: "blocked #3 compass (120 s ago): stuck".
  blockedLines(t, windowS = BLOCKED_WINDOW_S) {
    return this.plans.filter(p => p.status === 'blocked' && p.end_t != null && t - p.end_t <= windowS)
      .map(p => `blocked #${p.id} ${p.title} (${Math.round(t - p.end_t)} s ago): ${p.reason ?? 'stuck'}`)
  }
  // The leader's PLANS section: render() and then the recently blocked plans (with no active plan, only those).
  leaderLines(t) {
    const lines = this.render(), bl = this.blockedLines(t)
    return bl.length ? [...(this.active().length ? lines : []), ...bl] : lines
  }
  // A running or pending plan with this title (a duplicate request adds nothing), else null.
  activeByTitle(title) {
    const key = normTitle(title)
    return this.plans.find(p => ACTIVE.has(p.status) && normTitle(p.title) === key) ?? null
  }
  toJSON() { return { plans: this.plans.map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) })) } }
  list() { return [...this.plans] }
}

// The code guards on a plan answer (plan_item or plan_steps), before the runner acts on it (pure):
// - its title equals a running or pending plan's: marked {duplicate: <plan id>} (the runner replies "Already on it"
//   and adds nothing);
// - its title equals a plan blocked within BLOCKED_WINDOW_S and no request in `requests` ({t}) arrived after the block:
//   refused as {kind: 'cannot', why: 'still blocked: <reason>'} (final review: render() hid blocked plans, so the leader
//   planned the same blocked item again every ~300 s).
// Any other answer is returned unchanged.
export function guardPlanAnswer(res, book, t, requests = []) {
  if (res?.kind !== 'plan_item' && res?.kind !== 'plan_steps') return res
  const title = res.kind === 'plan_item' ? planTitle(res.item, res.count) : res.title
  const dup = book.activeByTitle(title)
  if (dup) return { ...res, duplicate: dup.id }
  const b = book.stillBlocked(title, t, requests)
  if (b) return { kind: 'cannot', id: null, why: `still blocked: ${b.reason ?? 'stuck'}`, guard: 'blocked_plan', plan_id: b.id, title: b.title }
  return res
}

// The chat word `plan` (live stress session: a player saw "no plans" while the bot worked on the chain): the pushed
// goals, top first with their progress (goalStackView's pushed), the plans (PlanBook.render, joined on one line), then
// the default chain's step ({stage, index, of, text}: chainStep, or techStep with stage iron_pickaxe). At most 3 lines,
// each cut to CHAT_LINE characters so none splits.
const CHAT_LINE = 200
export function planChatLines({ pushed = [], planLines = [], chain = null } = {}) {
  const cut = s => s.length > CHAT_LINE ? `${s.slice(0, CHAT_LINE - 3)}...` : s
  const out = []
  if (pushed.length) out.push(cut(`Goals: ${pushed.map((g, i) => `${i ? 'then ' : ''}#${g.id} ${g.progress}`).join('; ')}`))
  const plans = planLines.filter(l => l && l !== 'no plans')
  out.push(cut(plans.length ? plans.join('; ') : 'No plans.'))
  if (chain) out.push(cut(`Chain: ${String(chain.stage).replace(/_/g, ' ')}, step ${chain.index} of ${chain.of}: ${chain.text}`))
  return out
}

// A goal as the bot says it in chat ("On it: ...", "Done: ...", "Gave up on ..."). go_to(player:<name>) and receive
// speak to the requester (live stress session: "On it: go to player:Spacers Choice"): "come to you" and "take the <n>
// <item> from you", or the player's name when it is someone else. requester: the requesting player (default: the name
// in the goal's source 'audience:<name>').
export function goalPhrase(g, requester = null) {
  const h = x => String(x ?? '').replace(/_/g, ' ')
  const who = requester ?? (typeof g.source === 'string' && g.source.startsWith('audience:') ? g.source.slice(9) : null)
  const you = name => (name && name === who ? 'you' : name)
  switch (g.kind) {
    case 'gather': return `gather ${g.count ?? ''} ${h(g.arg)}`.replace(/\s+/g, ' ')
    case 'craft_item': return `craft ${h(g.arg)}`
    case 'find': return `find ${h(g.arg)}`
    case 'go_to': {
      const m = /^player:(\w{1,16})$/.exec(g.arg ?? '')
      return m ? `come to ${you(m[1])}` : `go to ${h(g.arg)}`
    }
    case 'receive': return `take the ${g.count != null ? `${g.count} ` : ''}${h(g.arg)} from ${g.from ? you(g.from) : 'you'}`
    case 'stay': {
      const m = /^player:(\w{1,16})$/.exec(g.arg ?? '')
      return m ? `wait here with ${you(m[1])}` : 'wait here'
    }
    case 'build': return `build ${h(g.arg)}`
    case 'survive_night': return 'survive the night'
    case 'return_to_base': return 'return to base'
    default: return `${h(g.kind)}${g.arg ? ` ${h(g.arg)}` : ''}`
  }
}
