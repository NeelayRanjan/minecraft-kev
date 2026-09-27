// The plan book (pure): ordered multi-step plans the player can see and edit from chat. A plan is a list of typed goal
// steps (the recipe expander's output, or the leader's); the front plan's current step is what the runner pushes on the
// goal stack (with plan_id and step_index, so the stack's goal_done/goal_failed events come back here). A failed step
// blocks its plan (kept, with the reason) and the next plan takes the front; skip drops one step, drop a whole plan.
import { MINE, HUNT } from './recipes.js'

const humanize = s => String(s).replace(/_/g, ' ')
const ACTIVE = new Set(['pending', 'running'])
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
  add({ title, steps, source, t = null }) {
    const plan = { id: this.nextId++, title, source, steps: steps.map(s => ({ ...s })), cursor: 0, status: 'pending', t, end_t: null, reason: null }
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
  toJSON() { return { plans: this.plans.map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) })) } }
  list() { return [...this.plans] }
}
