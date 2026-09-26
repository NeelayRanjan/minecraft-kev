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

test('chain mode: subgoal forecast asks about the chain step, and stops once the chain is done', () => {
  const chainObs = baseObs({ goal: 'nether', inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_ingot: 3, stick: 2 }, armor: { iron_helmet: 1 } })
  const { qs } = buildQuestions(chainObs, { decision: false })
  assert.match(qs.subgoal_succeeds_60s.instructions, /get 19 iron ingots/)
  assert.ok(!qs.iron_found_3min)
  const done = baseObs({ goal: 'nether', portalLit: true, inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 },
    armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 } })
  assert.ok(!buildQuestions(done, { decision: false }).qs.subgoal_succeeds_60s)
  // experiment 1 with an iron pickaxe: step 8, no subgoal question (unchanged)
  assert.ok(!buildQuestions(baseObs({ inventory: { iron_pickaxe: 1 } }), { decision: false }).qs.subgoal_succeeds_60s)
})

test('labelDecisions: a step that drops (items lost on death, chain mode) is not an advance', () => {
  const ds = [{ t: 0, qids: ['subgoal_succeeds_60s'], labels: {} }]
  labelDecisions(ds, [{ t: 0, step: 21 }, { t: 30, step: 11 }, { t: 61, step: 11 }])
  assert.equal(ds[0].labels.subgoal_succeeds_60s, false)
})

// ---- the goal stack (Task 3): questions from GoalStack, labels per goal ------------------------------------------
import { GoalStack } from '../agent/goals.js'
import { serialize } from '../agent/serialize.js'
const chainObs = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const withStack = (s, o) => { o.goalText = s.describe(o); const st = s.step(o), d = s.depth(); o.goalStep = { ...st, local: st.index - 100 * d, pushed: d > 0 }; return o }

test('goal stack: with only the default entry, questions, labels and state text equal the stackless ones', () => {
  const fixtures = [
    chainObs({}), chainObs({ inventory: { oak_log: 3 }, blocks: [{ name: 'oak_log', dist: 10, dir: 'north', dy: 0 }] }),
    chainObs({ inventory: { iron_pickaxe: 1, cobblestone: 5 }, nearestHostile: { name: 'zombie', dist: 6, dir: 'west', dy: 0 }, entities: [{ name: 'zombie', kind: 'hostile', dist: 6, dir: 'west', dy: 0 }] }),
    chainObs({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1, water_bucket: 1, flint_and_steel: 1 },
      armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }, portalFrame: true, portalLit: true }),
    baseObs(), baseObs({ inventory: { stone_pickaxe: 1 } }), baseObs({ inventory: { iron_pickaxe: 1 } }),
  ]
  for (const o of fixtures) for (const decision of [false, true]) {
    const s = new GoalStack({ goal: o.goal === 'nether' ? 'nether' : 'iron_pickaxe' })
    const plain = buildQuestions(o, { decision })
    const o2 = withStack(s, { ...o })
    assert.deepEqual(buildQuestions(o2, { decision, goals: s }), plain)
    assert.equal(serialize(o2), serialize(o))
  }
})

test('goal stack: a pushed goal filters the offered list, labels with its teacher and always asks the step question', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:alice', t: 0 })
  const o = withStack(s, chainObs({ inventory: { iron_pickaxe: 1, cobblestone: 3, oak_planks: 8, stick: 2 }, base: { crafting_table: { dist: 3 }, furnace: { dist: 4 } }, blocks: [{ name: 'stone', dist: 3 }] }))
  const { qs, labels } = buildQuestions(o, { decision: true, goals: s })
  const ids = Object.keys(qs.next_subtask.criteria)
  assert.ok(ids.includes('mine_stone') && !ids.includes('craft(sticks)') && !ids.includes('gather_wood'))
  assert.equal(labels.next_subtask, 'mine_stone')
  assert.match(qs.subgoal_succeeds_60s.instructions, /gather 8 cobblestone/)
  assert.match(serialize(o).split('\n')[0], /^Minecraft survival, day 1\. Goal from the audience \(alice\): gather 8 cobblestone/)
  // a chain past step 48 does not ask the step question; a goal pushed on it does (the gate reads the unbased step)
  const s2 = new GoalStack({ goal: 'nether' })
  const done = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1, water_bucket: 1, flint_and_steel: 1 }
  const late = () => chainObs({ inventory: done, armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }, portalFrame: true, portalLit: true })
  assert.ok(!buildQuestions(withStack(s2, late()), { decision: false, goals: s2 }).qs.subgoal_succeeds_60s)
  s2.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'leader', t: 0 })
  assert.ok(buildQuestions(withStack(s2, late()), { decision: false, goals: s2 }).qs.subgoal_succeeds_60s)
})

test('subgoal_succeeds_60s under a pushed goal: a goal change is not progress; the active goal done in the horizon is success', () => {
  const tl = [{ t: 0, step: 30, goal_id: 0 }, { t: 10, step: 101, goal_id: 1 }, { t: 70, step: 101, goal_id: 1 }].map(x => sample(x.t, x))
  const ds = [dec(0, ['subgoal_succeeds_60s'])]
  labelDecisions(ds, tl); assert.equal(ds[0].labels.subgoal_succeeds_60s, false)
  const tl2 = [sample(0, { step: 30, goal_id: 0 }), sample(10, { step: 101, goal_id: 1 }), sample(15, { step: 101, goal_id: 1 }),
    sample(40, { step: 30, goal_id: 0, goals_done: [1] }), sample(90, { step: 30, goal_id: 0 })]
  const ds2 = [dec(15, ['subgoal_succeeds_60s']), dec(0, ['subgoal_succeeds_60s'])]
  labelDecisions(ds2, tl2)
  assert.equal(ds2[0].labels.subgoal_succeeds_60s, true)    // goal 1 done at 40, within 60 s of 15
  assert.equal(ds2[1].labels.subgoal_succeeds_60s, false)   // goal 0 made no progress of its own
  // progress inside the same goal still counts; a pop back to a goal whose own step advanced counts for that goal
  const tl3 = [sample(0, { step: 102, goal_id: 1 }), sample(20, { step: 103, goal_id: 1 }), sample(70, { step: 103, goal_id: 1 })]
  const ds3 = [dec(0, ['subgoal_succeeds_60s'])]
  labelDecisions(ds3, tl3); assert.equal(ds3[0].labels.subgoal_succeeds_60s, true)
})
