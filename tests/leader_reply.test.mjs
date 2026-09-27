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
