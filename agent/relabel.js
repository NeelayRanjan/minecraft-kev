// Post-hoc relabelling from a raw episode log. Two jobs: (1) make deaths authoritative — the 1 Hz sampler almost never
// catches the few ticks between the death packet and the immediate respawn, so a synthetic dead sample is inserted
// at every death event before the labelers run; (2) rebuild kev records (and the censoring table) from out/<name>.json
// with the current labelers, optionally dropping questions.
import { EpisodeLog } from './logger.js'
import { questionFor } from './questions.js'
import { DESC } from './subtasks.js'

// Older logs (and toJSON before qs was stored) carry only answers: rebuild each question from the answer's options
// and the state text (step text, hostile name), byte-identical to what buildQuestions produced at play time.
export function reconstructQs(d) {
  if (d.qs) return d.qs
  const stepText = /step \d of 7: ([^)]+)\)/.exec(d.state_text || '')?.[1] ?? ''
  const hostile = /nearest hostile: ([a-z ]+?) \d+ m/.exec(d.state_text || '')?.[1] ?? ''
  const qs = {}
  for (const [qid, a] of Object.entries(d.answers || {})) {
    if (qid === 'next_subtask') qs[qid] = questionFor(qid, { optionDescs: Object.fromEntries((a.options || []).map(o => [o, DESC[o]])) })
    else qs[qid] = questionFor(qid, { stepText, hostile })
  }
  return qs
}

export function injectDeaths(timeline, events) {
  const tl = [...timeline].sort((a, b) => a.t - b.t)
  for (const e of events || []) {
    if (e.kind !== 'death') continue
    const covered = tl.some(s => s.dead && Math.abs(s.t - e.t) <= 1.5)
    if (covered) continue
    let prev = null
    for (const s of tl) { if (s.t <= e.t) prev = s; else break }
    tl.push({ t: e.t, step: 1, rawIron: 0, ingots: 0, health: 0, dead: true, timeOfDay: prev?.timeOfDay ?? 0, day: prev?.day ?? 0, done: false })
  }
  return tl.sort((a, b) => a.t - b.t)
}

export function rebuildRecords(json, { drop = [] } = {}) {
  const log = new EpisodeLog(json.meta || {})
  for (const s of injectDeaths(json.timeline || [], json.events || [])) log.sample(s)
  const dropSet = new Set(drop)
  for (const d of json.decisions || []) {
    const qs = Object.fromEntries(Object.entries(reconstructQs(d)).filter(([q]) => !dropSet.has(q)))
    if (!Object.keys(qs).length) continue
    // teacher labels are authoritative as logged; post-hoc labels are recomputed by toRecords
    const labels = Object.fromEntries(Object.entries(d.labels || {}).filter(([q]) => !dropSet.has(q) && (q === 'next_subtask' || q === 'threat_response')))
    log.decision({ t: d.t, state_text: d.state_text, decision: d.decision, qs, labels, answers: d.answers || {}, chosen: d.chosen, source: d.source, latency_ms: d.latency_ms })
  }
  return { records: log.toRecords(), censoring: log.censoring(), log }
}
