// The episode log (trajectory contract, adapted from the air combat track): meta / frames / decisions / events, plus
// the per-second timeline the post-hoc labelers read. toRecords() turns decisions into kev training records.
import { labelDecisions, POST_HOC } from './questions.js'

// Answers when nobody asked kev: one-hot on the teacher label, null probabilities for post-hoc questions.
export function oneHot(qs, labels) {
  const out = {}
  for (const [qid, q] of Object.entries(qs)) {
    const lab = labels[qid] ?? null
    let options, probabilities
    if (q.type === 'choice') { options = Object.keys(q.criteria); probabilities = lab == null ? null : Object.fromEntries(options.map(o => [o, o === lab ? 1 : 0])) }
    else if (q.type === 'score') { options = [...q.criteria]; probabilities = lab == null ? null : Object.fromEntries(options.map((_, i) => [i, i === lab ? 1 : 0])) }
    else { options = ['false', 'true']; probabilities = lab == null ? null : { false: lab ? 0 : 1, true: lab ? 1 : 0 } }
    out[qid] = { type: q.type, options, probabilities, label: lab, teacher_only: true }
  }
  return out
}

// kev's response reshaped so every question carries its full distribution and its label.
export function fromKev(resp, qs, labels) {
  const out = {}
  for (const [qid, q] of Object.entries(qs)) {
    const a = resp.answers[qid]
    const d = { type: q.type, label: labels[qid] ?? null }
    if (q.type === 'choice') Object.assign(d, { options: Object.keys(q.criteria), probabilities: a.probabilities, choice: a.choice, confidence: a.confidence })
    else if (q.type === 'score') Object.assign(d, { options: [...q.criteria], probabilities: a.probabilities, score: a.score, confidence: a.confidence })
    else Object.assign(d, { options: ['false', 'true'], probabilities: { false: Math.round((1 - a.noul) * 1e4) / 1e4, true: a.noul }, noul: a.noul })
    out[qid] = d
  }
  return out
}

export class EpisodeLog {
  constructor(meta = {}) { this.meta = { ...meta }; this.frames = []; this.decisions = []; this.events = []; this.timeline = []; this.leader = []; this.labelled = false }
  frame(f) { this.frames.push(f) }
  event(e) { this.events.push(e) }
  sample(s) { this.timeline.push(s) }
  decision(d) {
    this.decisions.push({ t: d.t, state_text: d.state_text, decision: !!d.decision, qs: d.qs, qids: Object.keys(d.qs), labels: { ...d.labels }, answers: d.answers || {},
      chosen: d.chosen ?? null, source: d.source ?? null, latency_ms: d.latency_ms ?? null, teacher_label: d.teacher_label ?? null, why: d.why ?? null, planner_latency_ms: d.planner_latency_ms ?? null, leader: d.leader ?? null })
    this.labelled = false
  }
  finish(extra = {}) { Object.assign(this.meta, extra) }

  label() {
    if (this.labelled) return
    labelDecisions(this.decisions, this.timeline)
    for (const d of this.decisions) for (const qid of d.qids) if (d.answers[qid]) d.answers[qid].label = d.labels[qid] ?? null
    this.labelled = true
  }

  censoring() {
    this.label()
    const out = {}
    for (const d of this.decisions) for (const qid of d.qids) {
      if (!POST_HOC.has(qid)) continue
      const c = out[qid] ||= { asked: 0, labelled: 0, censored: 0 }
      c.asked++
      if (d.labels[qid] == null) c.censored++; else c.labelled++
    }
    return out
  }

  toRecords() {
    this.label()
    const recs = []
    for (const d of this.decisions) {
      const questions = {}
      for (const qid of d.qids) {
        const lab = d.labels[qid]
        if (lab == null) continue
        const q = d.qs[qid]
        questions[qid] = { type: q.type, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}), label: lab }
      }
      if (!Object.keys(questions).length) continue
      recs.push({ state: d.state_text, questions, _meta: { seed: this.meta.seed ?? null, t: d.t, decision: d.decision } })
    }
    return recs
  }

  toJSON() {
    this.label()
    return { meta: this.meta, frames: this.frames, decisions: this.decisions.map(d => ({ t: d.t, decision: d.decision, state_text: d.state_text, qs: d.qs, labels: d.labels, answers: d.answers, chosen: d.chosen, source: d.source, latency_ms: d.latency_ms, teacher_label: d.teacher_label, why: d.why, planner_latency_ms: d.planner_latency_ms, leader: d.leader })),
      events: this.events, timeline: this.timeline, leader: this.leader }
  }
}
