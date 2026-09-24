import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlannerMessages, parsePlannerAnswer } from '../agent/planner.js'

const options = [{ id: 'mine_stone', desc: 'mine cobblestone' }, { id: 'smelt(iron_ingot)', desc: 'smelt' }, { id: 'wait', desc: 'stand still' }]
const history = [{ t: 100, kind: 'subtask_done', id: 'smelt(iron_ingot)', result: 'no_furnace', repeats: 4 }, { t: 90, kind: 'interrupt', reason: 'threat' }]

test('the prompt carries the state, every option id with its description, recent history and forecasts', () => {
  const msgs = buildPlannerMessages({ stateText: 'STATE TEXT', options, history, forecasts: { subgoal_succeeds_60s: 0.12 } })
  assert.equal(msgs[0].role, 'system'); assert.equal(msgs[1].role, 'user')
  const u = msgs[1].content
  assert.match(u, /STATE TEXT/)
  assert.match(u, /smelt\(iron_ingot\): smelt/)
  assert.match(u, /no_furnace.*4 times in a row/)
  assert.match(u, /threat/)
  assert.match(u, /subgoal_succeeds_60s.*0\.12/)
  assert.match(msgs[0].content, /exactly one/i)
})

test('answers are parsed from JSON, with thinking blocks stripped, and validated against the options', () => {
  assert.deepEqual(parsePlannerAnswer('{"subtask": "mine_stone", "why": "need cobble"}', options), { id: 'mine_stone', why: 'need cobble' })
  assert.deepEqual(parsePlannerAnswer('<think>hmm</think>\n{"subtask":"wait","why":""}', options), { id: 'wait', why: '' })
  assert.equal(parsePlannerAnswer('{"subtask": "fly_away", "why": "x"}', options), null)
  assert.equal(parsePlannerAnswer('not json at all', options), null)
  assert.deepEqual(parsePlannerAnswer('Sure! ```json\n{"subtask": "smelt(iron_ingot)"}\n```', options), { id: 'smelt(iron_ingot)', why: '' })
})
