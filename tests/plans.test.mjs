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

test('a plan with no steps is done at once and never jams the book (expandItem of a held item)', () => {
  const b = new PlanBook()
  const empty = b.add({ title: 'compass', steps: [], source: 'leader', t: 3 })
  assert.equal(empty.status, 'done'); assert.equal(empty.end_t, 3)
  assert.equal(b.front(), null)
  assert.equal(b.currentGoal(), null)
  assert.equal(b.skip(4), null, 'skip does not throw')
  assert.deepEqual(b.render(), ['no plans'])
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 5 })
  assert.equal(b.front().id, 2)
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'oak_planks', count: 6, plan_id: 2, step_index: 0 })
  // a plan whose cursor ran past its steps (a hand-edited or restored book) is skipped too, and skip guards it
  const c = PlanBook.fromJSON({ plans: [{ id: 1, title: 'x', source: 'leader', steps: STAIRS, cursor: 2, status: 'running', t: 0, end_t: null, reason: null }] })
  assert.equal(c.front(), null)
  assert.equal(c.skip(1), null)
  assert.deepEqual(c.render(), ['no plans'])
})

test('advance only moves the running (front) plan; a demoted plan resumes its step', () => {
  const b = new PlanBook()
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  assert.equal(b.currentGoal().plan_id, 1)
  b.moveFront(2)
  assert.deepEqual(b.advance({ kind: 'goal_failed', plan_id: 1, step_index: 0, reason: 'popped' }, 5), [])
  const p1 = b.list().find(p => p.id === 1)
  assert.equal(p1.status, 'pending'); assert.equal(p1.cursor, 0); assert.equal(p1.reason, null)
  assert.deepEqual(b.advance({ kind: 'goal_done', plan_id: 1, step_index: 0 }, 6), [], 'a done event for a demoted plan is ignored too')
  assert.equal(p1.cursor, 0)
  assert.equal(b.front().id, 2); assert.equal(b.list().find(p => p.id === 2).status, 'running')
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'oak_planks', count: 6, plan_id: 2, step_index: 0 })
  b.drop(2, 7)
  assert.deepEqual(b.currentGoal(), { kind: 'gather', arg: 'raw_iron', count: 4, plan_id: 1, step_index: 0 }, 'plan 1 resumes its step')
})

// Final review, Important 6: a blocked plan is not planned again for 10 minutes unless a newer audience request asks.
test('stillBlocked and blockedLines: 10 minutes, unless a request arrived after the block', () => {
  const b = new PlanBook()
  const p = b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  const g = b.currentGoal()
  b.advance({ kind: 'goal_failed', plan_id: g.plan_id, step_index: g.step_index, reason: 'stuck' }, 100)
  assert.equal(b.stillBlocked('compass', 200, [])?.id, p.id)
  assert.equal(b.stillBlocked('Compass ', 200, [{ t: 50 }])?.id, p.id, 'a request from before the block does not lift it')
  assert.equal(b.stillBlocked('compass', 200, [{ t: 150 }]), null, 'a newer request asks again')
  assert.equal(b.stillBlocked('compass', 701, []), null, 'after 10 minutes')
  assert.equal(b.stillBlocked('4 torch', 200, []), null)
  assert.deepEqual(b.blockedLines(200), ['blocked #1 compass (100 s ago): stuck'])
  assert.deepEqual(b.blockedLines(800), [])
})

test('activeByTitle: a running or pending plan with the same title (duplicate requests)', () => {
  const b = new PlanBook()
  const p = b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  assert.equal(b.activeByTitle('compass')?.id, p.id)
  assert.equal(b.activeByTitle('4 oak stairs')?.id, 2)
  b.drop(p.id, 5)
  assert.equal(b.activeByTitle('compass'), null)
})

import { guardPlanAnswer } from '../agent/plans.js'
test('guardPlanAnswer: a duplicate title is marked; a recently blocked title is refused as cannot unless a newer request asks', () => {
  const b = new PlanBook()
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 0 })
  const blocked = b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  b.moveFront(blocked.id)
  const g = b.currentGoal()
  b.advance({ kind: 'goal_failed', plan_id: g.plan_id, step_index: g.step_index, reason: 'needs an iron pickaxe first' }, 100)
  const item = { kind: 'plan_item', id: null, item: 'oak_stairs', count: 4, why: '' }
  assert.deepEqual(guardPlanAnswer(item, b, 120, []), { ...item, duplicate: 1 })
  const again = { kind: 'plan_item', id: null, item: 'compass', count: 1, why: 'asked' }
  assert.deepEqual(guardPlanAnswer(again, b, 200, []), { kind: 'cannot', id: null, why: 'still blocked: needs an iron pickaxe first', guard: 'blocked_plan', plan_id: blocked.id, title: 'compass' })
  assert.deepEqual(guardPlanAnswer(again, b, 200, [{ t: 150 }]), again, 'a newer request asks for it again')
  const steps = { kind: 'plan_steps', id: null, title: 'Compass', steps: COMPASS, why: '' }
  assert.equal(guardPlanAnswer(steps, b, 200, []).kind, 'cannot')
  const other = { kind: 'push_goal', id: null, goal: { kind: 'find', arg: 'lava' } }
  assert.equal(guardPlanAnswer(other, b, 200, []), other)
})

test('leaderLines: render() plus the plans blocked within 10 minutes', () => {
  const b = new PlanBook()
  assert.deepEqual(b.leaderLines(0), ['no plans'])
  b.add({ title: 'compass', steps: COMPASS, source: 'leader', t: 0 })
  const g = b.currentGoal()
  b.advance({ kind: 'goal_failed', plan_id: g.plan_id, step_index: g.step_index, reason: 'stuck' }, 10)
  assert.deepEqual(b.leaderLines(40), ['blocked #1 compass (30 s ago): stuck'])
  b.add({ title: '4 oak stairs', steps: STAIRS, source: 'leader', t: 20 })
  assert.deepEqual(b.leaderLines(40), [...b.render(), 'blocked #1 compass (30 s ago): stuck'])
  assert.deepEqual(b.leaderLines(700), b.render())
})

// Live stress session: a player typed "plan" and saw "no plans" while the bot worked on the chain. The chat word prints
// the pushed goals (top first, with progress), the plans, then the chain's step: at most 3 chat lines.
import { planChatLines } from '../agent/plans.js'
test('planChatLines: pushed goals, plans, the chain step; at most 3 lines of at most 200 characters', () => {
  const chain = { stage: 'iron_tools', index: 12, of: 47, text: 'craft an iron sword (2 ingots)' }
  assert.deepEqual(planChatLines({ pushed: [], planLines: ['no plans'], chain }), ['No plans.', 'Chain: iron tools, step 12 of 47: craft an iron sword (2 ingots)'])
  const pushed = [{ id: 7, progress: 'go to y 12 (at y 40)' }, { id: 6, progress: 'gather 27 dirt (have 5)' }]
  const planLines = ['Plan #1 compass: ✓ mine 1 redstone ▶ craft compass', 'then: #2 4 torch']
  const out = planChatLines({ pushed, planLines, chain })
  assert.deepEqual(out, ['Goals: #7 go to y 12 (at y 40); then #6 gather 27 dirt (have 5)', 'Plan #1 compass: ✓ mine 1 redstone ▶ craft compass; then: #2 4 torch',
    'Chain: iron tools, step 12 of 47: craft an iron sword (2 ingots)'])
  const long = planChatLines({ pushed: [{ id: 1, progress: 'x'.repeat(300) }], planLines: ['y'.repeat(300)], chain })
  assert.equal(long.length, 3); for (const l of long) assert.ok(l.length <= 200, l.length)
  assert.deepEqual(planChatLines({ pushed: [], planLines: ['no plans'], chain: null }), ['No plans.'])
})

// Live stress session: "On it: go to player:Spacers Choice" and "On it: receive redstone block". goalPhrase speaks to the
// requester: "come to you" / "take the 2 redstone block from you" (a name when the player is someone else).
import { goalPhrase } from '../agent/plans.js'
test('goalPhrase: go_to(player) and receive address the requester; the other kinds as before', () => {
  assert.equal(goalPhrase({ kind: 'go_to', arg: 'player:Spacers_Choice', source: 'audience:Spacers_Choice' }), 'come to you')
  assert.equal(goalPhrase({ kind: 'go_to', arg: 'player:Steve', source: 'audience:Spacers_Choice' }), 'come to Steve')
  assert.equal(goalPhrase({ kind: 'go_to', arg: 'player:Steve', source: 'leader' }), 'come to Steve')
  assert.equal(goalPhrase({ kind: 'go_to', arg: 'player:Steve' }, 'Steve'), 'come to you')
  assert.equal(goalPhrase({ kind: 'receive', arg: 'redstone_block', count: 2, from: 'Spacers_Choice', source: 'audience:Spacers_Choice' }), 'take the 2 redstone block from you')
  assert.equal(goalPhrase({ kind: 'receive', arg: 'redstone_block', count: 2, from: 'Steve', source: 'audience:Spacers_Choice' }), 'take the 2 redstone block from Steve')
  assert.equal(goalPhrase({ kind: 'go_to', arg: 'y:12' }), 'go to y:12')
  assert.equal(goalPhrase({ kind: 'gather', arg: 'cobblestone', count: 8 }), 'gather 8 cobblestone')
  assert.equal(goalPhrase({ kind: 'craft_item', arg: 'iron_pickaxe' }), 'craft iron pickaxe')
  assert.equal(goalPhrase({ kind: 'survive_night' }), 'survive the night')
  assert.equal(goalPhrase({ kind: 'hunt', arg: 'white_wool', count: 3 }), 'hunt white wool')
})

test('PlanBook.add keeps an item plan\'s item and count (refreshPlanStep), more/base only for n MORE; plain plans unchanged', () => {
  const b = new PlanBook()
  const plain = b.add({ title: 'trip', steps: [{ kind: 'go_to', arg: 'base' }], source: 'leader', t: 1 })
  assert.deepEqual(Object.keys(plain).sort(), ['cursor', 'end_t', 'id', 'reason', 'source', 'status', 'steps', 't', 'title'])
  const it = b.add({ title: 'shears', steps: [{ kind: 'craft_item', arg: 'shears', count: 1 }], source: 'leader', t: 2, item: 'shears', count: 1 })
  assert.equal(it.item, 'shears'); assert.equal(it.count, 1); assert.equal(it.more, undefined)
  const more = b.add({ title: '2 iron ingot', steps: [{ kind: 'gather', arg: 'iron_ingot', count: 2 }], source: 'leader', t: 3, item: 'iron_ingot', count: 2, more: true, base: 3 })
  assert.equal(more.more, true); assert.equal(more.base, 3)
})
