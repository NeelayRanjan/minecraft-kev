import test from 'node:test'
import assert from 'node:assert/strict'
import { EpisodeLog, oneHot, fromKev } from '../agent/logger.js'

test('oneHot shapes every question type like the parent project', () => {
  const qs = { a: { type: 'choice', criteria: { x: '', y: '' } }, b: { type: 'noul' }, c: { type: 'score', criteria: ['l', 'm', 'h'] } }
  const a = oneHot(qs, { a: 'y', b: null, c: 2 })
  assert.deepEqual(a.a, { type: 'choice', options: ['x', 'y'], probabilities: { x: 0, y: 1 }, label: 'y', teacher_only: true })
  assert.equal(a.b.probabilities, null)
  assert.deepEqual(a.b.options, ['false', 'true'])
  assert.deepEqual(a.c.probabilities, { 0: 0, 1: 0, 2: 1 })
})

test('fromKev keeps the full distribution, the choice, the confidence and the label', () => {
  const qs = { a: { type: 'choice', criteria: { x: '', y: '' } }, b: { type: 'noul' }, c: { type: 'score', criteria: ['l', 'm'] } }
  const resp = { answers: { a: { choice: 'x', probabilities: { x: 0.7, y: 0.3 }, confidence: 0.7 }, b: { noul: 0.2 }, c: { score: 1, probabilities: { 0: 0.4, 1: 0.6 }, confidence: 0.6 } } }
  const a = fromKev(resp, qs, { a: 'y', b: null, c: null })
  assert.equal(a.a.label, 'y'); assert.equal(a.a.choice, 'x'); assert.equal(a.a.confidence, 0.7)
  assert.deepEqual(a.b.probabilities, { false: 0.8, true: 0.2 }); assert.equal(a.b.noul, 0.2)
  assert.equal(a.c.score, 1); assert.deepEqual(a.c.options, ['l', 'm'])
})

const s = (t, over = {}) => ({ t, step: 1, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 1000 + t * 20, day: 0, done: false, ...over })

test('toRecords fills post-hoc labels, drops censored questions and empty records, keeps teacher labels', () => {
  const log = new EpisodeLog({ seed: 1, policy: 'teacher' })
  log.sample(s(0)); log.sample(s(30)); log.sample(s(50, { step: 2 })); log.sample(s(70, { step: 2 }))
  log.decision({ t: 0, state_text: 's0', decision: true, qs: { next_subtask: { type: 'choice', instructions: 'q', criteria: { a: 'A', wait: 'W' } }, subgoal_succeeds_60s: { type: 'noul', instructions: 'q' }, damage_next_20s: { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c', 'd'] } }, labels: { next_subtask: 'a', subgoal_succeeds_60s: null, damage_next_20s: null }, answers: {}, chosen: 'a', source: 'teacher' })
  log.decision({ t: 70, state_text: 's1', decision: false, qs: { subgoal_succeeds_60s: { type: 'noul', instructions: 'q' } }, labels: { subgoal_succeeds_60s: null }, answers: {} })  // horizon runs past the end: censored
  const recs = log.toRecords()
  assert.equal(recs.length, 1)
  assert.equal(recs[0].state, 's0')
  assert.equal(recs[0].questions.next_subtask.label, 'a')
  assert.deepEqual(recs[0].questions.next_subtask.criteria, { a: 'A', wait: 'W' })
  assert.equal(recs[0].questions.subgoal_succeeds_60s.label, true)
  assert.equal(recs[0].questions.damage_next_20s.label, 0)
  assert.deepEqual(recs[0]._meta, { seed: 1, t: 0, decision: true })
  const c = log.censoring()
  assert.deepEqual(c.subgoal_succeeds_60s, { asked: 2, labelled: 1, censored: 1 })
  assert.deepEqual(c.damage_next_20s, { asked: 1, labelled: 1, censored: 0 })
})

test('toJSON carries meta, frames, decisions with labels, events and the timeline', () => {
  const log = new EpisodeLog({ seed: 2 })
  log.frame({ t: 0, x: 1, y: 2, z: 3 })
  log.event({ t: 0, kind: 'subtask_start', id: 'wait' })
  log.sample(s(0)); log.sample(s(25))
  log.decision({ t: 0, state_text: 's', decision: false, qs: { damage_next_20s: { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c', 'd'] } }, labels: { damage_next_20s: null }, answers: { damage_next_20s: { type: 'score', options: ['a', 'b', 'c', 'd'], probabilities: null, label: null } } })
  log.finish({ end_reason: 'time' })
  const j = log.toJSON()
  assert.equal(j.meta.seed, 2); assert.equal(j.meta.end_reason, 'time')
  assert.equal(j.frames.length, 1); assert.equal(j.events.length, 1); assert.equal(j.timeline.length, 2)
  assert.equal(j.decisions[0].labels.damage_next_20s, 0)
  assert.equal(j.decisions[0].answers.damage_next_20s.label, 0)
})
