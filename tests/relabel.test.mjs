import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { injectDeaths, rebuildRecords, reconstructQs } from '../agent/relabel.js'
import { labelDecisions } from '../agent/questions.js'

const s = (t, over = {}) => ({ t, step: 3, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 1000 + t * 20, day: 0, done: false, ...over })

test('a death event between two samples becomes a dead sample so damage and survival labels see it', () => {
  const timeline = [s(99), s(100, { health: 18 }), s(101, { health: 20, step: 1 })]
  const events = [{ t: 100.3, kind: 'death' }, { t: 100.5, kind: 'respawn' }]
  const tl = injectDeaths(timeline, events)
  assert.equal(tl.length, 4)
  const d = tl.find(x => x.dead)
  assert.equal(d.t, 100.3); assert.equal(d.health, 0); assert.equal(d.step, 1)
  const ds = [{ t: 90, qids: ['damage_next_20s', 'survive_until_morning'], labels: {} }]
  labelDecisions(ds, [...tl, s(700, { timeOfDay: 500, day: 1 })].map(x => x.t === 90 ? x : x))
  labelDecisions(ds, [s(90, { timeOfDay: 13000 }), ...tl.map(x => ({ ...x, timeOfDay: 13000 + x.t * 20 })), s(700, { timeOfDay: 500, day: 1 })])
  assert.equal(ds[0].labels.damage_next_20s, 3)
  assert.equal(ds[0].labels.survive_until_morning, false)
})

test('rebuilding the first recorded episode from its raw log reproduces the records the runner wrote', { skip: !fs.existsSync('out/t_s1.json') && 'out/t_s1.json not present' }, () => {
  const json = JSON.parse(fs.readFileSync('out/t_s1.json', 'utf8'))
  const want = fs.readFileSync('out/t_s1.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const { records } = rebuildRecords(json)
  assert.equal(records.length, want.length)
  for (let i = 0; i < want.length; i++) assert.deepEqual(records[i], want[i], `record ${i} differs`)
})

test('reconstructQs rebuilds questions from answers and state text', () => {
  const d = { state_text: 'Goal: get an iron pickaxe (step 5 of 7: find and mine 3 iron ore).\nnearby creatures: nearest hostile: cave spider 6 m west.',
    answers: { next_subtask: { options: ['mine_iron', 'wait'] }, threat_response: {}, subgoal_succeeds_60s: {}, damage_next_20s: {} } }
  const qs = reconstructQs(d)
  assert.equal(qs.next_subtask.criteria.wait, 'stand still for a few seconds')
  assert.match(qs.threat_response.instructions, /the cave spider nearby/)
  assert.match(qs.subgoal_succeeds_60s.instructions, /\(find and mine 3 iron ore\)/)
  assert.equal(qs.damage_next_20s.criteria.length, 4)
})

test('a death already sampled is not duplicated', () => {
  const timeline = [s(99), s(100, { dead: true, health: 0 }), s(101)]
  assert.equal(injectDeaths(timeline, [{ t: 100.1, kind: 'death' }]).length, 3)
})

test('rebuildRecords relabels from the raw log, drops a question, and keeps _meta', () => {
  const json = {
    meta: { seed: 5 },
    timeline: [s(0), s(30, { step: 4 }), s(70, { step: 4 })],
    events: [],
    decisions: [
      { t: 0, decision: true, state_text: 'a', qs: { next_subtask: { type: 'choice', instructions: 'q', criteria: { wait: 'w' } }, subgoal_succeeds_60s: { type: 'noul', instructions: 'q' }, survive_until_morning: { type: 'noul', instructions: 'q' } }, labels: { next_subtask: 'wait' }, answers: {} },
      { t: 70, decision: false, state_text: 'b', qs: { subgoal_succeeds_60s: { type: 'noul', instructions: 'q' } }, labels: {}, answers: {} },
    ],
  }
  const { records, censoring } = rebuildRecords(json, { drop: ['survive_until_morning'] })
  assert.equal(records.length, 1)
  assert.deepEqual(Object.keys(records[0].questions).sort(), ['next_subtask', 'subgoal_succeeds_60s'])
  assert.equal(records[0].questions.subgoal_succeeds_60s.label, true)
  assert.deepEqual(records[0]._meta, { seed: 5, t: 0, decision: true })
  assert.deepEqual(censoring.subgoal_succeeds_60s, { asked: 2, labelled: 1, censored: 1 })
  assert.equal(censoring.survive_until_morning, undefined)
})
