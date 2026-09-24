// The question schema (the game <-> kev interface) and the post-hoc labelers. Every option is declared; nothing is parsed.
// Choice questions are labelled by the teacher at ask time; forecasts are labelled after the episode from the
// per-second timeline (game truth), and a forecast whose horizon runs past the end of the timeline is censored (null).
import { options, counts } from './subtasks.js'
import { techStep, teacherSubtask, teacherThreat, THREAT_OPTIONS } from './teacher.js'

export const HORIZONS = { step: 60, iron: 180, damage: 20 }
export const DAMAGE_LEVELS = ['none: no damage taken', 'minor: less than 4 hp lost', 'major: 4 hp or more lost', 'death']
export const HOSTILE_RANGE = 16
export const POST_HOC = new Set(['subgoal_succeeds_60s', 'iron_found_3min', 'damage_next_20s', 'survive_until_morning'])

// One place for the question texts, shared by buildQuestions (play / data generation) and relabel.js (rebuilding
// records from raw logs whose decisions carry only answers). `hostile` is the pretty (space-separated) mob name.
export function questionFor(qid, { stepText = '', hostile = '', optionDescs = {} } = {}) {
  switch (qid) {
    case 'next_subtask': return { type: 'choice', instructions: 'Which subtask should the player do next to make progress on the goal without dying?', criteria: { ...optionDescs } }
    case 'threat_response': return { type: 'choice', instructions: `How should the player respond to the ${hostile} nearby?`, criteria: { ...THREAT_OPTIONS } }
    case 'subgoal_succeeds_60s': return { type: 'noul', instructions: `Will the current step (${stepText}) be completed within the next ${HORIZONS.step} seconds?` }
    case 'iron_found_3min': return { type: 'noul', instructions: `Will the player mine at least one iron ore within the next ${HORIZONS.iron / 60} minutes?` }
    case 'damage_next_20s': return { type: 'score', instructions: `How much damage will the player take in the next ${HORIZONS.damage} seconds?`, criteria: [...DAMAGE_LEVELS] }
    case 'survive_until_morning': return { type: 'noul', instructions: 'Will the player survive until sunrise without dying?' }
    default: throw new Error(`unknown question ${qid}`)
  }
}

export function buildQuestions(obs, { decision }) {
  const qs = {}, labels = {}
  const step = techStep(obs)
  const c = counts(obs)
  if (decision) {
    const opts = options(obs)
    qs.next_subtask = questionFor('next_subtask', { optionDescs: Object.fromEntries(opts.map(o => [o.id, o.desc])) })
    labels.next_subtask = teacherSubtask(obs)
    if (obs.nearestHostile && obs.nearestHostile.dist <= HOSTILE_RANGE) {
      qs.threat_response = questionFor('threat_response', { hostile: obs.nearestHostile.name.replace(/_/g, ' ') })
      labels.threat_response = teacherThreat(obs)
    }
  }
  if (step.index <= 7) { qs.subgoal_succeeds_60s = questionFor('subgoal_succeeds_60s', { stepText: step.text }); labels.subgoal_succeeds_60s = null }
  if (step.index === 5 && c.rawIron === 0) { qs.iron_found_3min = questionFor('iron_found_3min'); labels.iron_found_3min = null }
  qs.damage_next_20s = questionFor('damage_next_20s'); labels.damage_next_20s = null
  if (obs.phase === 'dusk' || obs.phase === 'night') { qs.survive_until_morning = questionFor('survive_until_morning'); labels.survive_until_morning = null }
  return { qs, labels }
}

export function questionMeta() {
  return {
    next_subtask: { type: 'choice', instructions: 'Which subtask should the player do next?', options: 'dynamic' },
    threat_response: { type: 'choice', instructions: 'How should the player respond to the hostile mob nearby?', options: Object.keys(THREAT_OPTIONS) },
    subgoal_succeeds_60s: { type: 'noul', instructions: `Current tech step completed within ${HORIZONS.step} s?`, options: ['false', 'true'] },
    iron_found_3min: { type: 'noul', instructions: `At least one iron ore mined within ${HORIZONS.iron / 60} min?`, options: ['false', 'true'] },
    damage_next_20s: { type: 'score', instructions: `Damage taken in the next ${HORIZONS.damage} s`, options: [...DAMAGE_LEVELS] },
    survive_until_morning: { type: 'noul', instructions: 'Survive until sunrise?', options: ['false', 'true'] },
  }
}

// ---- post-hoc labels over the per-second timeline -------------------------------------------------------------
// timeline samples: {t, step, rawIron, ingots, health, dead, timeOfDay, day, done}
const after = (tl, t) => tl.filter(s => s.t > t)
const at = (tl, t) => { let cur = tl[0]; for (const s of tl) { if (s.t <= t) cur = s; else break } return cur }

export function labelDecisions(decisions, timeline) {
  const tl = [...timeline].sort((a, b) => a.t - b.t)
  const end = tl.length ? tl[tl.length - 1].t : -Infinity
  for (const d of decisions) {
    const now = at(tl, d.t)
    if (!now) continue
    for (const qid of d.qids) {
      if (!POST_HOC.has(qid)) continue
      let v = null
      if (qid === 'subgoal_succeeds_60s') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.step)
        if (win.some(s => s.step > now.step || s.done)) v = true
        else if (end >= d.t + HORIZONS.step) v = false
      } else if (qid === 'iron_found_3min') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.iron)
        if (win.some(s => s.rawIron > now.rawIron || s.ingots > now.ingots)) v = true
        else if (end >= d.t + HORIZONS.iron) v = false
      } else if (qid === 'damage_next_20s') {
        const win = after(tl, d.t).filter(s => s.t <= d.t + HORIZONS.damage)
        let lost = 0, prev = now.health, dead = false
        for (const s of win) {
          if (s.dead) { dead = true; break }
          if (s.health < prev) lost += prev - s.health
          prev = s.health
        }
        if (dead) v = 3
        else if (lost >= 4) v = 2
        else if (lost > 0) v = 1
        else if (end >= d.t + HORIZONS.damage) v = 0
      } else if (qid === 'survive_until_morning') {
        let died = false, morning = false
        for (const s of after(tl, d.t)) {
          if (s.dead) { died = true; break }
          if (s.day > now.day || (now.timeOfDay >= 12000 && s.timeOfDay < 12000)) { morning = true; break }
        }
        v = died ? false : morning ? true : null
      }
      d.labels[qid] = v
    }
  }
}
