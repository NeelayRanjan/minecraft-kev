import test from 'node:test'
import assert from 'node:assert/strict'
import { replyFor } from '../agent/leader.js'

// The leader's reply goes out only when the action it chose is the one that took effect (final review, Important 3);
// when the code changed the outcome, the code's own message (sent by the runner) stands alone.
const R = 'On my way!'
test('replyFor: the code overruled the leader (night rule, blocked-plan guard, cannot turned into a plan): no reply', () => {
  assert.equal(replyFor({ kind: 'cannot', night: true, goal: { kind: 'go_to', arg: 'surface' } }, R), null)
  assert.equal(replyFor({ kind: 'cannot', guard: 'blocked_plan', plan_id: 2, title: 'bucket' }, 'Sure, making it now'), null)
  assert.equal(replyFor({ kind: 'plan_item', item: 'white_bed', count: 1, via: 'cannot' }, "Sorry, I can't make beds", { planAdded: true }), null)
})

test('replyFor: answers that did nothing, a say, and the leader\'s own cannot (its reply is the reason): no separate reply', () => {
  for (const kind of ['invalid', 'stale', 'blocked', 'error', 'say', 'cannot']) assert.equal(replyFor({ kind }, R), null, kind)
  assert.equal(replyFor({ kind: 'plan_steps', duplicate: 3, title: 'x' }, 'On it!', { planAdded: false }), null)
})

test('replyFor: a plan answer replies only after its plan was added (refused, duplicate or missing: none)', () => {
  for (const kind of ['plan_item', 'plan_steps', 'plan_build', 'plan_dig', 'plan_blueprint']) {
    assert.equal(replyFor({ kind }, 'On it!'), null, `${kind}: before the plan exists`)
    assert.equal(replyFor({ kind }, 'On it!', { planAdded: false }), null, `${kind}: refused`)
    assert.deepEqual(replyFor({ kind }, 'On it!', { planAdded: true }), { text: 'On it!', from: 'leader' }, `${kind}: added`)
  }
  // a push the code routed to a plan (routePush) and an unknown item planned from the request text keep the reply
  assert.deepEqual(replyFor({ kind: 'plan_item', via: 'push_goal', more: true }, 'Getting logs', { planAdded: true }), { text: 'Getting logs', from: 'leader' })
  assert.deepEqual(replyFor({ kind: 'plan_item', via: 'unknown_item' }, 'A bed, coming up', { planAdded: true }), { text: 'A bed, coming up', from: 'leader' })
})

test('replyFor: push_goal, pop_goal, edit, continue and override reply at once; an empty reply is none', () => {
  for (const kind of ['push_goal', 'pop_goal', 'edit', 'continue', 'override']) assert.deepEqual(replyFor({ kind }, R), { text: R, from: 'leader' }, kind)
  assert.equal(replyFor({ kind: 'push_goal' }, ''), null)
  assert.equal(replyFor({ kind: 'push_goal' }, null), null)
})

// Important 4: "stay here" then a new plan: the plan is created but waits under the stay; the code tells the player so
// (instead of the leader's "On it!"), and the stay continues. A new request ends protect, build and dig answers too.
import { STAY_HOLD_TEXT, holdsPlans, endsProtect } from '../agent/leader.js'
test('holdsPlans: a leader-pushed stay anywhere on the stack holds the plans; a plan step or no stay does not', () => {
  const chain = { id: 0, kind: 'chain' }
  assert.equal(holdsPlans([chain]), false)
  assert.equal(holdsPlans([chain, { id: 1, kind: 'stay', arg: 'player:Steve' }]), true)
  assert.equal(holdsPlans([chain, { id: 1, kind: 'stay', arg: 'here' }, { id: 2, kind: 'go_to', arg: 'player:Steve' }]), true)
  assert.equal(holdsPlans([chain, { id: 1, kind: 'gather', arg: 'log', count: 8 }]), false)
  assert.equal(holdsPlans([chain, { id: 1, kind: 'stay', arg: 'here', plan_id: 3, step_index: 0 }]), false)
})

test('replyFor: a plan added while a stay holds the plans gets the code message, not the reply', () => {
  assert.equal(STAY_HOLD_TEXT, "I'll do that when you say I can go")
  for (const kind of ['plan_item', 'plan_steps', 'plan_build', 'plan_dig', 'plan_blueprint']) {
    assert.deepEqual(replyFor({ kind }, 'On it!', { planAdded: true, held: true }), { text: STAY_HOLD_TEXT, from: 'code' }, kind)
    assert.deepEqual(replyFor({ kind }, '', { planAdded: true, held: true }), { text: STAY_HOLD_TEXT, from: 'code' }, `${kind} without a reply`)
    assert.equal(replyFor({ kind }, 'On it!', { planAdded: false, held: true }), null, `${kind} refused`)
  }
  assert.deepEqual(replyFor({ kind: 'push_goal' }, 'On my way!', { held: true }), { text: 'On my way!', from: 'leader' }, 'a push runs on top of the stay')
})

test('endsProtect: a protect on top ends at any new goal or plan answer, including build and dig; stay is not ended', () => {
  const protect = { kind: 'protect', arg: 'player:Steve' }
  for (const kind of ['push_goal', 'plan_item', 'plan_steps', 'plan_build', 'plan_dig', 'plan_blueprint']) assert.equal(endsProtect({ kind }, protect), true, kind)
  for (const kind of ['continue', 'override', 'say', 'cannot', 'edit', 'invalid']) assert.equal(endsProtect({ kind }, protect), false, kind)
  assert.equal(endsProtect({ kind: 'plan_build' }, { kind: 'stay', arg: 'here' }), false)
})
