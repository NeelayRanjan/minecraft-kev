import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLeaderMessages, blueprintsRelevant, MAX_SHOWN_EVENTS_GOALS, MAX_SHOWN_STATS_GOALS } from '../agent/leader.js'
import { layerCut } from '../agent/blueprints.js'
import { makeBlueprint } from '../agent/templates.js'
import { DESC } from '../agent/subtasks.js'

// The leader runs with num_ctx 8192 (planner.js askLeader) and num_predict 200. A goals prompt must stay under 7,000
// tokens so the answer and the schema's overhead fit with room to spare. Estimate: characters / 3.2 (the live-retry
// session measured 3.30 chars per prompt token on qwen38-27b; 3.2 is the conservative side).
const CHARS_PER_TOKEN = 3.2, MAX_TOKENS = 7000
const estTokens = msgs => Math.ceil(msgs.map(m => m.content).join('\n').length / CHARS_PER_TOKEN)

const heaviest = JSON.parse(readFileSync(new URL('./fixtures/leader_ctx_live_retry_heaviest.json', import.meta.url), 'utf8')).ctx

test('blueprintsRelevant: build/dig words in a pending request, an active blueprint, a pending feedback', () => {
  const r = text => [{ t: 1, name: 'Steve', text }]
  for (const s of ['build me a small stone hut', 'can you make a house', 'MAKE AN arch please', 'a wall here', 'stairs up 6 blocks', 'dig a 3x3x2 cave',
    'mine down to y 12', 'a tunnel east', 'dig a pit', 'strip mine for diamonds', 'a little room', 'tower of cobble', 'staircase down'])
    assert.equal(blueprintsRelevant({ requests: r(s) }), true, s)
  for (const s of ['come here', 'make me a compass', 'some torches please', 'where are you?', 'I turned on keep inventory'])
    assert.equal(blueprintsRelevant({ requests: r(s) }), false, s)
  assert.equal(blueprintsRelevant({ requests: [] }), false)
  assert.equal(blueprintsRelevant({ requests: [], blueprintGoal: true }), true)
  assert.equal(blueprintsRelevant({ requests: r('come here'), blueprintFeedback: { title: 'arch', reason: 'x' } }), true)
})

test('goals prompt: at most MAX_SHOWN_EVENTS_GOALS events and MAX_SHOWN_STATS_GOALS subtask stats', () => {
  assert.equal(MAX_SHOWN_EVENTS_GOALS, 20)
  assert.equal(MAX_SHOWN_STATS_GOALS, 8)
  const history = Array.from({ length: 40 }, (_, i) => ({ t: i, kind: 'subtask_done', id: `x${i}`, result: 'ok' }))
  const stats = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { attempts: 40 - i, ok: 1, fails: {} }]))
  const user = buildLeaderMessages({ ...heaviest, history, subtaskStats: stats })[1].content
  assert.equal((user.match(/ x\d+ -> ok/g) || []).length, 20)
  assert.ok(user.includes('x39 -> ok') && !user.includes('x19 -> ok'))
  assert.equal((user.match(/^s\d+: \d+ attempts/gm) || []).length, 8)
})

test('the heaviest live_retry leader call (reconstructed) with the blueprint rules on stays under 7,000 estimated tokens', () => {
  const msgs = buildLeaderMessages({ ...heaviest, blueprints: true })
  assert.ok(msgs[0].content.includes('BUILDING AND DIGGING'))
  const n = estTokens(msgs)
  assert.ok(n < MAX_TOKENS, `estimated ${n} tokens`)
})

// The spec's synthetic maximum (3 requests of 200 chars, 8 chat lines, 3 long plans, a 9x9 blueprint cut, the 30
// longest offered options) on top of the heaviest call: more than any live call carried (live_retry offered at most 10
// options), so it is held to the hard limit, not the 7,000 target: the prompt plus num_predict (200) plus 300 tokens of
// headroom fit in num_ctx 8192.
test('a synthetic maximum (3 requests, 8 chat lines, 3 plans, a blueprint cut, 30 options) fits num_ctx 8192 with 300 tokens to spare', () => {
  const bp = makeBlueprint('hut', { w: 9, d: 9, h: 5 }, 'cobblestone', { anchor: { x: 0, y: 64, z: 0 }, facing: 'north' })
  const blueprintCut = { title: 'hut (9x9x5)', layer: 2, of: 6, lines: layerCut(bp, 1, () => null, { x: 0, y: 64, z: -3 }) }
  const t200 = 'kevin could you please build me a big stone house with a tower on the corner and a wall around it, then dig a tunnel to the cave over there and come back to me here after that ok '.slice(0, 200)
  const requests = [1, 2, 3].map(i => ({ t: 1700 + i, name: `Spacers_Choice${i}`, text: t200 }))
  const conversation = Array.from({ length: 8 }, (_, i) => ({ t: 1690 + i, name: i % 2 ? 'Kevin' : 'Spacers_Choice', text: t200 }))
  const plans = [1, 2, 3].map(i => `#${i} hut (9x9x5) (2 of 6 steps): gather cobblestone 64, gather cobblestone 64, gather cobblestone 64, gather cobblestone 40, build hut (9x9x5) in front of you`)
  const options = Object.keys(DESC).sort((a, b) => (b.length + DESC[b].length) - (a.length + DESC[a].length)).slice(0, 30).map(id => ({ id, desc: DESC[id] }))
  assert.equal(options.length, 30)
  const msgs = buildLeaderMessages({ ...heaviest, requests, conversation, plans, options, blueprintCut, blueprints: true })
  const n = estTokens(msgs)
  assert.ok(n + 200 + 300 <= 8192, `estimated ${n} tokens`)
})

test('askLeader sends num_ctx 8192 by default, and the heaviest call leaves room for num_predict plus 300 tokens', async () => {
  const { askLeader } = await import('../agent/planner.js')
  const real = globalThis.fetch
  let body = null
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ message: { content: '{"action": "continue", "why": "x"}' }, done_reason: 'stop' }) } }
  try { await askLeader({ ...heaviest, goals: true, blueprints: true }) } finally { globalThis.fetch = real }
  assert.equal(body.options.num_ctx, 8192)
  assert.ok(estTokens(body.messages) + body.options.num_predict + 300 <= body.options.num_ctx)
})
