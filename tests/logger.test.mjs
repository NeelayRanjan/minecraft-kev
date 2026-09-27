import test from 'node:test'
import assert from 'node:assert/strict'
import { EpisodeLog, oneHot, fromKev } from '../agent/logger.js'
import { steerQuestions } from '../agent/steer.js'

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

// Steering records (kev-steers Task 2): frames at t=0..40 (1 Hz); the bot sits far from every target through
// t=24, then from t=25 on it sits within 3 m of the near target (10,64,10). Three steering decisions:
//   t=0, near target  -> within 30 s (window (0,30]) a frame (t=25..30) is close: reach_target_30s = true
//   t=5, far target   -> 30 s of frames exist (window (5,35], endT 40 >= 35) and none is close: false
//   t=30, far target  -> window (30,60] needs frames past t=40 that don't exist yet: censored (null), dropped
const nearTarget = { x: 10, y: 64, z: 10 }
const farTarget = { x: 1000, y: 64, z: 1000 }
function buildSteerLog () {
  const log = new EpisodeLog({ seed: 9, policy: 'kev' })
  for (let t = 0; t <= 40; t++) log.frame(t < 25 ? { t, x: 0, y: 64, z: 0 } : { t, x: 10, y: 64, z: 10 })
  log.steerDecision({ t: 0, walkId: 'w1', state_text: 'steer-s0', target: { name: 'table', pos: nearTarget }, qs: steerQuestions(), answers: null, label: 'north', chosen: 'north', source: 'teacher', latency_ms: 12 })
  log.steerDecision({ t: 5, walkId: 'w1', state_text: 'steer-s5', target: { name: 'ore', pos: farTarget }, qs: steerQuestions(), answers: null, label: 'east', chosen: 'east', source: 'teacher', latency_ms: 12 })
  log.steerDecision({ t: 30, walkId: 'w1', state_text: 'steer-s30', target: { name: 'ore', pos: farTarget }, qs: steerQuestions(), answers: null, label: 'stop', chosen: 'stop', source: 'teacher', latency_ms: 12 })
  return log
}

test('labelSteer fills steer and reach_target_30s labels, true/false/censored, and is idempotent', () => {
  const log = buildSteerLog()
  log.labelSteer()
  assert.deepEqual(log.steer[0].labels, { steer: 'north', reach_target_30s: true })
  assert.deepEqual(log.steer[1].labels, { steer: 'east', reach_target_30s: false })
  assert.deepEqual(log.steer[2].labels, { steer: 'stop', reach_target_30s: null })
  const before = JSON.stringify(log.steer)
  log.labelSteer()
  assert.equal(JSON.stringify(log.steer), before)
})

test('toSteerRecords drops the censored decision and keeps both questions with their labels', () => {
  const log = buildSteerLog()
  const recs = log.toSteerRecords()
  assert.equal(recs.length, 2)
  assert.equal(recs[0].state, 'steer-s0')
  assert.equal(recs[0].questions.steer.label, 'north')
  assert.equal(recs[0].questions.steer.type, 'choice')
  assert.ok(recs[0].questions.steer.criteria)
  assert.equal(recs[0].questions.reach_target_30s.label, true)
  assert.equal(recs[0].questions.reach_target_30s.type, 'noul')
  assert.deepEqual(recs[0]._meta, { seed: 9, t: 0, walkId: 'w1' })
  assert.equal(recs[1].state, 'steer-s5')
  assert.equal(recs[1].questions.steer.label, 'east')
  assert.equal(recs[1].questions.reach_target_30s.label, false)
  assert.deepEqual(recs[1]._meta, { seed: 9, t: 5, walkId: 'w1' })
})

test('toJSON carries the full steer entries including state_text', () => {
  const log = buildSteerLog()
  const j = log.toJSON()
  assert.equal(j.steer.length, 3)
  assert.equal(j.steer[0].state_text, 'steer-s0')
  assert.equal(j.steer[0].target.name, 'table')
  assert.deepEqual(j.steer[0].target.pos, nearTarget)
  assert.equal(j.steer[2].labels.reach_target_30s, null)
})

test('steering decisions do not affect toRecords (the 1 Hz stream)', () => {
  const plain = new EpisodeLog({ seed: 1, policy: 'teacher' })
  plain.sample(s(0)); plain.sample(s(30)); plain.sample(s(50, { step: 2 })); plain.sample(s(70, { step: 2 }))
  plain.decision({ t: 0, state_text: 's0', decision: true, qs: { next_subtask: { type: 'choice', instructions: 'q', criteria: { a: 'A', wait: 'W' } } }, labels: { next_subtask: 'a' }, answers: {}, chosen: 'a', source: 'teacher' })

  const withSteer = new EpisodeLog({ seed: 1, policy: 'teacher' })
  withSteer.sample(s(0)); withSteer.sample(s(30)); withSteer.sample(s(50, { step: 2 })); withSteer.sample(s(70, { step: 2 }))
  withSteer.decision({ t: 0, state_text: 's0', decision: true, qs: { next_subtask: { type: 'choice', instructions: 'q', criteria: { a: 'A', wait: 'W' } } }, labels: { next_subtask: 'a' }, answers: {}, chosen: 'a', source: 'teacher' })
  for (let t = 0; t <= 40; t++) withSteer.frame({ t, x: 0, y: 64, z: 0 })
  withSteer.steerDecision({ t: 0, walkId: 'w1', state_text: 'steer-s0', target: { name: 'table', pos: nearTarget }, qs: steerQuestions(), answers: null, label: 'north', chosen: 'north', source: 'teacher', latency_ms: 12 })

  assert.equal(JSON.stringify(withSteer.toRecords()), JSON.stringify(plain.toRecords()))
})

// Final review minor: the live view's swallowed entity errors log once per entity id per 60 s.
import { onceEvery } from '../agent/logger.js'
test('onceEvery: true the first time per key, then false until the window has passed', () => {
  const ok = onceEvery(60_000)
  assert.equal(ok(7, 0), true)
  assert.equal(ok(7, 30_000), false)
  assert.equal(ok(8, 30_000), true)
  assert.equal(ok(7, 60_001), true)
})
