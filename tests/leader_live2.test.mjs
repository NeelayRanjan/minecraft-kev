// The second live stress session (live_retry, 2026-09-27): leader-side fixes (brief items 4, 5, 9-16, 18, 19).
import test from 'node:test'
import assert from 'node:assert/strict'
import { leaderSchema, parseLeaderAnswer, settleKind, RequestBook, leaderSystemGoals, LEADER_SYSTEM, buildLeaderMessages, applyAnswer } from '../agent/leader.js'
import { baseCtx, goalCtx } from './fixtures/leader_prompt_ctx.mjs'

const opts = [{ id: 'mine_iron', desc: 'x' }, { id: 'wait', desc: 'z' }]
const q = [{ t: 1, name: 'Steve', text: 'are you coming?' }]

// 4: talking and acting are not exclusive: every goals-mode answer may carry a reply the runner sends.
test('item 4: the goals schema has an optional reply for every action; the chain schema is unchanged', () => {
  const s = leaderSchema(opts, { goals: true, requests: q })
  assert.deepEqual(s.properties.reply, { type: 'string' })
  assert.ok(!s.required.includes('reply'))
  assert.equal(leaderSchema(opts).properties.reply, undefined)
  assert.deepEqual(Object.keys(leaderSchema(opts).properties), ['action', 'why'])
  const raw = JSON.stringify({ action: 'push_goal', goal: { kind: 'go_to', arg: 'player:Steve' }, reply: 'On my way!', why: 'asked' })
  assert.equal(parseLeaderAnswer(raw, opts, { goals: true }).reply, 'On my way!')
  assert.equal(parseLeaderAnswer(JSON.stringify({ action: 'continue', reply: 'coming' }), opts, { goals: true }).reply, 'coming')
  assert.equal(parseLeaderAnswer(JSON.stringify({ action: 'continue' }), opts, { goals: true }).reply, null)
  assert.deepEqual(parseLeaderAnswer(raw, opts), { action: null, why: 'asked' }, 'chain mode: {action, why} only')
  assert.deepEqual(Object.keys(parseLeaderAnswer(JSON.stringify({ action: 'wait', reply: 'x', why: 'w' }), opts)), ['action', 'why'])
})
test('item 4: a continue or override that carries a reply answers the requests shown; without one it does not', () => {
  assert.equal(settleKind({ kind: 'continue', id: null }, true, 'on my way'), 'reply')
  assert.equal(settleKind({ kind: 'override', id: 'wait' }, true, 'hold on'), 'reply')
  assert.equal(settleKind({ kind: 'continue', id: null }, true, '  '), 'continue')
  assert.equal(settleKind({ kind: 'continue', id: null }, false, 'hi'), 'continue')
  assert.equal(settleKind({ kind: 'stale', id: null }, true, 'hi'), 'stale')
  const b = new RequestBook(); const r = b.add({ t: 1, name: 'Steve', text: 'are you coming?' })
  b.shown([r.id]); b.settle([r.id], 'reply', 2)
  assert.equal(r.answered.kind, 'reply')
})
test('item 4: the goals prompt asks for a reply whenever the leader acts on a request; the chain prompt is unchanged', () => {
  const sys = leaderSystemGoals()
  assert.match(sys, /Add a short reply for the player whenever you act on a request/)
  assert.match(sys, /"reply": "<short line for the player>"/)
  assert.doesNotMatch(LEADER_SYSTEM, /reply/)
  assert.match(buildLeaderMessages(goalCtx)[1].content, /"reply" \(any action\)/)
  assert.doesNotMatch(buildLeaderMessages(baseCtx)[1].content, /reply/)
})
test('item 4: a say whose line came in reply instead of text is accepted', () => {
  const r = applyAnswer({ answer: { action: 'say', text: '', reply: 'I am 12 m east of you' }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true,
    requests: [{ t: 1, name: 'Steve', text: 'where are you?' }], recentSays: [] })
  assert.deepEqual(r, { kind: 'say', id: null, text: 'I am 12 m east of you' })
})
