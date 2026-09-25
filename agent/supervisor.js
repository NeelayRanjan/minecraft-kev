// The scripted supervisor (next step 2b): the cheapest test of whether kev's headline forecast carries information a
// planner could act on. While a subtask runs, it watches p(current step completes within 60 s); when p has stayed
// below the threshold for holdS seconds it "replans": the runner interrupts the subtask and withholds it at the next
// decision, so kev must pick something else. Three arms on the same seeds: off, real, and shuffled (the same trigger
// fed forecasts drawn from a pool of kev's own values, so it fires at the same rate but at the wrong moments). If the
// real arm does not beat both, no LLM leader reading the same forecasts will either.
//
// Pure: the runner feeds it one observation per tick and acts on the result.
export const DEFAULTS = { threshold: 0.25, holdS: 15, cooldownS: 30 }

export class Supervisor {
  constructor({ mode = 'off', threshold = DEFAULTS.threshold, holdS = DEFAULTS.holdS, cooldownS = DEFAULTS.cooldownS, pool = null, rng = Math.random } = {}) {
    if (!['off', 'real', 'shuffled'].includes(mode)) throw new Error(`unknown supervisor mode ${mode}`)
    if (mode === 'shuffled' && !(pool && pool.length)) throw new Error('shuffled supervisor needs a pool of forecasts')
    Object.assign(this, { mode, threshold, holdS, cooldownS, pool, rng })
    this.lowSince = null; this.lastFire = -Infinity; this.fires = 0; this.subtaskStart = null
  }

  onSubtaskStart(t) { this.lowSince = null; this.subtaskStart = t; this.draw = null }

  // The shuffled arm's stand-in forecast: one pool value per subtask, redrawn every holdS seconds. (An independent
  // draw per second never fires: 15 lows in a row has probability 0.24^15. The real forecast is sticky within a
  // subtask, so a per-block draw matches its firing rate while breaking the link to the state.)
  shuffledValue(t) {
    if (!this.draw || t - this.draw.t > this.holdS) this.draw = { t, v: this.pool[Math.floor(this.rng() * this.pool.length)] }   // > not >=: a block that stayed low fires before the redraw
    return this.draw.v
  }

  // p: the live forecast p(true) for subgoal_succeeds_60s, or null when it was not asked / not answered.
  // Returns null, or { id, p, shuffled } when the runner should abandon the running subtask.
  observe({ t, p, busy, subtaskId }) {
    if (this.mode === 'off' || !busy || p == null || subtaskId == null) { this.lowSince = null; return null }
    const q = this.mode === 'shuffled' ? this.shuffledValue(t) : p
    if (q >= this.threshold) { this.lowSince = null; return null }
    if (this.lowSince == null) this.lowSince = t
    if (t - this.lowSince < this.holdS) return null
    if (this.subtaskStart != null && t - this.subtaskStart < this.holdS) return null
    if (t - this.lastFire < this.cooldownS) return null
    this.lastFire = t; this.lowSince = null; this.fires++
    return { id: subtaskId, p: q, shuffled: this.mode === 'shuffled' }
  }
}

// The pool for the shuffled arm: every subgoal_succeeds_60s forecast kev emitted in the given episode logs.
export function forecastPool(logs) {
  const out = []
  for (const j of logs) for (const d of j.decisions || []) { const v = d.answers?.subgoal_succeeds_60s?.probabilities?.true; if (typeof v === 'number') out.push(v) }
  return out
}
