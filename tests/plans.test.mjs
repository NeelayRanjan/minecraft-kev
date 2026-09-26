import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanBook, planTitle } from '../agent/plans.js'

const COMPASS = [{ kind: 'gather', arg: 'raw_iron', count: 4 }, { kind: 'gather', arg: 'iron_ingot', count: 4 },
  { kind: 'gather', arg: 'redstone', count: 1 }, { kind: 'craft_item', arg: 'compass', count: 1 }]
const STAIRS = [{ kind: 'gather', arg: 'oak_planks', count: 6 }, { kind: 'craft_item', arg: 'oak_stairs', count: 4 }]
const done = (g, t = 0) => ({ kind: 'goal_done', plan_id: g.plan_id, step_index: g.step_index, t })

test('planTitle', () => {
  assert.equal(planTitle('compass', 1), 'compass')
  assert.equal(planTitle('oak_stairs', 4), '4 oak stairs')
  assert.equal(planTitle('compass'), 'compass')
})

test('add, front and currentGoal', () => {
  const b = new PlanBook()
  assert.equal(b.front(), null)
  assert.equal(b.currentGoal(), null)
  const p = b.add({ title: 'compass', steps: COMPASS, source: 'audience:alice', t: 5 })
  assert.deepEqual(p, { id: 1, title: 'compass', source: 'audience:alice', steps: COMPASS, cursor: 0, status: 'pending', t: 5, end_t: null, reason: null })
  assert.notEqual(p.steps, COMPASS, 'steps are copied')
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 6 })
  assert.equal(b.front().id, 1)
  assert.equal(b.front().status, 'running')
  assert.equal(b.list()[1].status, 'pending')
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'raw_iron', count: 4, plan_id: 1, step_index: 0 })
})

test('currentGoal carries from (receive)', () => {
  const b = new PlanBook()
  b.add({ title: '4 redstone', steps: [{ kind: 'receive', arg: 'redstone', count: 4, from: 'Spacers_Choice' }], source: 'audience:Spacers_Choice', t: 0 })
  assert.deepEqual(b.currentGoal(), { kind: 'receive', arg: 'redstone', count: 4, from: 'Spacers_Choice', plan_id: 1, step_index: 0 })
})

test('advance: goal_done moves the cursor; the last step finishes the plan and front() moves on', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  let g = b.currentGoal()
  assert.deepEqual(b.advance(done(g), 10), [{ kind: 'plan_step_done', plan_id: 1, step_index: 0 }])
  assert.equal(b.front().cursor, 1)
  assert.deepEqual(b.advance(done(g), 11), [], 'a stale event (old step) is ignored')
  assert.deepEqual(b.advance({ kind: 'goal_done', plan_id: 99, step_index: 0 }, 11), [])
  // the GoalStack event shape: plan_id and step_index inside ev.goal
  g = b.currentGoal()
  assert.deepEqual(b.advance({ kind: 'goal_done', goal: { plan_id: 1, step_index: 1 } }, 12), [{ kind: 'plan_step_done', plan_id: 1, step_index: 1 }])
  b.advance(done(b.currentGoal()), 13)
  assert.deepEqual(b.advance(done(b.currentGoal()), 14), [{ kind: 'plan_step_done', plan_id: 1, step_index: 3 }, { kind: 'plan_done', plan_id: 1, step_index: 3 }])
  const p1 = b.list()[0]
  assert.equal(p1.status, 'done'); assert.equal(p1.end_t, 14); assert.equal(p1.cursor, 4)
  assert.equal(b.front().id, 2)
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'oak_planks', count: 6, plan_id: 2, step_index: 0 })
})

test('advance: goal_failed blocks the plan with the reason and front() skips it', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  const g = b.currentGoal()
  assert.deepEqual(b.advance({ kind: 'goal_failed', plan_id: 1, step_index: 0, reason: 'stuck' }, 20),
    [{ kind: 'plan_blocked', plan_id: 1, step_index: 0, reason: 'stuck' }])
  const p1 = b.list()[0]
  assert.equal(p1.status, 'blocked'); assert.equal(p1.reason, 'stuck'); assert.equal(p1.end_t, 20)
  assert.equal(b.front().id, 2)
  assert.deepEqual(b.advance(done(g), 21), [], 'a blocked plan ignores late events')
})

test('skip drops the current step; on a 1-step plan it finishes the plan', () => {
  const b = new PlanBook()
  assert.equal(b.skip(0), null)
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  assert.equal(b.skip(3), 'skipped mine 4 raw iron; next: smelt 4 iron')
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'iron_ingot', count: 4, plan_id: 1, step_index: 1 })
  assert.deepEqual(b.advance({ kind: 'goal_failed', plan_id: 1, step_index: 0, reason: 'popped' }, 4), [], 'the skipped step\'s goal is stale')
  const c = new PlanBook()
  c.add({ title: 'crafting table', steps: [{ kind: 'craft_item', arg: 'crafting_table', count: 1 }], source: 'leader', t: 0 })
  assert.equal(c.skip(7), 'skipped craft crafting table; plan #1 crafting table done')
  assert.equal(c.list()[0].status, 'done'); assert.equal(c.list()[0].end_t, 7)
  assert.equal(c.front(), null)
})

test('drop, moveFront and clear', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  b.add({ title: 'crafting table', steps: [{ kind: 'craft_item', arg: 'crafting_table', count: 1 }], source: 'leader', t: 0 })
  assert.equal(b.front().id, 1)
  assert.equal(b.moveFront(2), 'plan #2 4 oak stairs moves to the front')
  assert.equal(b.front().id, 2)
  assert.equal(b.list().find(p => p.id === 1).status, 'pending')
  assert.deepEqual(b.list().map(p => p.id), [2, 1, 3])
  assert.equal(b.moveFront(42), null)
  assert.equal(b.drop(2, 9), 'dropped plan #2 4 oak stairs')
  assert.equal(b.list().find(p => p.id === 2).status, 'dropped')
  assert.equal(b.list().find(p => p.id === 2).end_t, 9)
  assert.equal(b.drop(2, 9), null, 'already dropped')
  assert.equal(b.front().id, 1)
  assert.equal(b.clear(10), 'cleared 2 plans')
  assert.equal(b.front(), null)
  assert.equal(b.clear(11), 'no plans to clear')
  assert.deepEqual(b.render(), ['no plans'])
})

test('render: the front plan with its steps, then the queue', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  b.advance(done(b.currentGoal()), 1)
  assert.deepEqual(b.render(), [
    'Plan #1 compass: ✓ mine 4 raw iron ▶ smelt 4 iron · mine 1 redstone · craft compass',
    'then: #2 4 oak stairs',
  ])
  b.skip(2)
  assert.equal(b.render()[0], 'Plan #1 compass: ✓ mine 4 raw iron ✗ smelt 4 iron ▶ mine 1 redstone · craft compass')
})

test('render words for the other step kinds', () => {
  const b = new PlanBook()
  b.add({ title: 'x', source: 'leader', t: 0, steps: [{ kind: 'hunt', arg: 'white_wool', count: 3 }, { kind: 'hunt', arg: 'leather', count: 2 },
    { kind: 'smelt_item', arg: 'glass', count: 3 }, { kind: 'receive', arg: 'redstone', count: 4, from: 'Spacers_Choice' },
    { kind: 'go_to', arg: 'player:Spacers_Choice' }, { kind: 'gather', arg: 'oak_planks', count: 6 }, { kind: 'gather', arg: 'log', count: 3 },
    { kind: 'craft_item', arg: 'oak_stairs', count: 4 }] })
  assert.equal(b.render()[0], 'Plan #1 x: ▶ shear 3 white wool · hunt 2 leather · smelt 3 glass · get 4 redstone from Spacers_Choice'
    + ' · go to Spacers_Choice · craft 6 oak planks · gather 3 log · craft 4 oak stairs')
})

test('toJSON round-trips', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 1 })
  b.advance(done(b.currentGoal()), 2)
  b.drop(2, 3)
  const j = JSON.parse(JSON.stringify(b.toJSON()))
  assert.deepEqual(Object.keys(j), ['plans'])
  const c = PlanBook.fromJSON(j)
  assert.deepEqual(c.toJSON(), b.toJSON())
  assert.equal(c.add({ title: 'y', steps: STAIRS, source: 'leader', t: 4 }).id, 3, 'ids continue')
  assert.deepEqual(c.render(), b.render().concat('then: #3 y'))
})
