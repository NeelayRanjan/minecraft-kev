import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestions, labelDecisions, HORIZONS, DAMAGE_LEVELS, questionMeta } from '../agent/questions.js'
import { baseObs } from './fixtures.mjs'

test('forecasts always, choice only at a decision point, threat only with a hostile near', () => {
  const { qs } = buildQuestions(baseObs(), { decision: false })
  assert.deepEqual(Object.keys(qs).sort(), ['damage_next_20s', 'subgoal_succeeds_60s'])
  assert.deepEqual(qs.damage_next_20s.criteria, DAMAGE_LEVELS)
  const d = buildQuestions(baseObs({ blocks: [{ name: 'oak_log', dist: 5, dir: 'north', dy: 0, reachable: true }] }), { decision: true })
  assert.equal(d.qs.next_subtask.type, 'choice')
  assert.equal(d.labels.next_subtask, 'gather_wood')
  assert.ok(Object.keys(d.qs.next_subtask.criteria).includes('wait'))
  assert.ok(!d.qs.threat_response)
  const t = buildQuestions(baseObs({ nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 } }), { decision: true })
  assert.equal(t.labels.threat_response, 'fight')
  assert.deepEqual(Object.keys(t.qs.threat_response.criteria), ['fight', 'flee', 'pillar_up', 'ignore'])
  assert.match(t.qs.threat_response.instructions, /zombie/)
})

test('iron_found_3min only while looking for iron; survive_until_morning only from dusk; step question stops when done', () => {
  assert.ok(buildQuestions(baseObs({ inventory: { stone_pickaxe: 1 } }), { decision: false }).qs.iron_found_3min)
  assert.ok(!buildQuestions(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 1 } }), { decision: false }).qs.iron_found_3min)
  assert.ok(!buildQuestions(baseObs({ inventory: { wooden_pickaxe: 1 } }), { decision: false }).qs.iron_found_3min)
  assert.ok(buildQuestions(baseObs({ phase: 'night', timeOfDay: 15000 }), { decision: false }).qs.survive_until_morning)
  assert.ok(buildQuestions(baseObs({ phase: 'dusk', timeOfDay: 12500 }), { decision: false }).qs.survive_until_morning)
  assert.ok(!buildQuestions(baseObs(), { decision: false }).qs.survive_until_morning)
  assert.ok(!buildQuestions(baseObs({ inventory: { iron_pickaxe: 1 } }), { decision: false }).qs.subgoal_succeeds_60s)
})

test('post-hoc questions carry a null label; instructions name the step and the horizons', () => {
  const { qs, labels } = buildQuestions(baseObs({ inventory: { stone_pickaxe: 1 } }), { decision: false })
  assert.equal(labels.subgoal_succeeds_60s, null)
  assert.match(qs.subgoal_succeeds_60s.instructions, /find and mine 3 iron ore/)
  assert.match(qs.subgoal_succeeds_60s.instructions, new RegExp(`${HORIZONS.step} seconds`))
  assert.match(qs.iron_found_3min.instructions, /3 minutes/)
  assert.ok(questionMeta().damage_next_20s.options.length === 4)
})

const sample = (t, over = {}) => ({ t, step: 1, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: 1000 + t * 20, day: 0, done: false, ...over })
const dec = (t, qids) => ({ t, qids, labels: {} })

test('subgoal_succeeds_60s: true when the step index rises within 60 s, false when not, censored at the end', () => {
  const tl = [sample(0), sample(30), sample(50, { step: 2 }), sample(100, { step: 2 }), sample(130, { step: 2 })]
  const ds = [dec(0, ['subgoal_succeeds_60s']), dec(50, ['subgoal_succeeds_60s']), dec(100, ['subgoal_succeeds_60s'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.subgoal_succeeds_60s, true)
  assert.equal(ds[1].labels.subgoal_succeeds_60s, false)
  assert.equal(ds[2].labels.subgoal_succeeds_60s, null)
})

test('subgoal_succeeds_60s: the goal completing counts as success; a step index falling after death does not', () => {
  const tl = [sample(0, { step: 7 }), sample(20, { step: 8, done: true })]
  const ds = [dec(0, ['subgoal_succeeds_60s'])]
  labelDecisions(ds, tl); assert.equal(ds[0].labels.subgoal_succeeds_60s, true)
  const tl2 = [sample(0, { step: 5 }), sample(10, { dead: true, step: 5 }), sample(20, { step: 1 }), sample(70, { step: 1 })]
  const ds2 = [dec(0, ['subgoal_succeeds_60s'])]
  labelDecisions(ds2, tl2); assert.equal(ds2[0].labels.subgoal_succeeds_60s, false)
})

test('iron_found_3min: raw iron count rises within 180 s', () => {
  const tl = [sample(0), sample(100), sample(170, { rawIron: 1 }), sample(400, { rawIron: 1 })]
  const ds = [dec(0, ['iron_found_3min']), dec(170, ['iron_found_3min']), dec(400, ['iron_found_3min'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.iron_found_3min, true)
  assert.equal(ds[1].labels.iron_found_3min, false)
  assert.equal(ds[2].labels.iron_found_3min, null)
})

test('damage_next_20s: none / minor / major / death from the health trace; death overrides', () => {
  const tl = [sample(0), sample(5, { health: 18 }), sample(10, { health: 17 }), sample(25, { health: 17 }), sample(30, { health: 10 }), sample(40, { dead: true, health: 0 }), sample(70, { health: 20 })]
  const ds = [dec(0, ['damage_next_20s']), dec(10, ['damage_next_20s']), dec(25, ['damage_next_20s']), dec(60, ['damage_next_20s'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.damage_next_20s, 1)
  assert.equal(ds[1].labels.damage_next_20s, 2)
  assert.equal(ds[2].labels.damage_next_20s, 3)
  assert.equal(ds[3].labels.damage_next_20s, null)
})

test('damage_next_20s: healing between hits does not cancel damage; a full quiet window is none', () => {
  const tl = [sample(0), sample(5, { health: 17 }), sample(10, { health: 20 }), sample(15, { health: 17 }), sample(21, { health: 20 }), sample(45, { health: 20 })]
  const ds = [dec(0, ['damage_next_20s']), dec(21, ['damage_next_20s'])]
  labelDecisions(ds, tl)
  assert.equal(ds[0].labels.damage_next_20s, 2)
  assert.equal(ds[1].labels.damage_next_20s, 0)
})

test('survive_until_morning: true past sunrise with no death; false on death; censored before sunrise', () => {
  const night = (t, over = {}) => sample(t, { timeOfDay: 13000 + t * 20, day: 0, ...over })
  const tl = [night(0), night(100), { ...sample(600), timeOfDay: 500, day: 1 }]
  const ds = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds, tl); assert.equal(ds[0].labels.survive_until_morning, true)
  const tl2 = [night(0), night(100, { dead: true }), { ...sample(600), timeOfDay: 500, day: 1 }]
  const ds2 = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds2, tl2); assert.equal(ds2[0].labels.survive_until_morning, false)
  const ds3 = [dec(0, ['survive_until_morning'])]
  labelDecisions(ds3, [night(0), night(100)]); assert.equal(ds3[0].labels.survive_until_morning, null)
})

test('labelDecisions leaves teacher-labelled questions alone', () => {
  const ds = [{ t: 0, qids: ['next_subtask', 'damage_next_20s'], labels: { next_subtask: 'wait' } }]
  labelDecisions(ds, [sample(0), sample(25)])
  assert.equal(ds[0].labels.next_subtask, 'wait')
  assert.equal(ds[0].labels.damage_next_20s, 0)
})
