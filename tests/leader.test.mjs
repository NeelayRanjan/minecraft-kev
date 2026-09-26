import test from 'node:test'
import assert from 'node:assert/strict'
import { TRIGGERS, LeaderTrigger, buildLeaderMessages, leaderSchema, applyAnswer, parseLeaderAnswer, pickEvent, subtaskStats, recentFailure, LEADER_SYSTEM } from '../agent/leader.js'
import { EpisodeLog } from '../agent/logger.js'

// ---- trigger policies ------------------------------------------------------------------------------------------
test('the three trigger modes, exactly', () => {
  assert.deepEqual(TRIGGERS, ['periodic15', 'events', 'periodic30_interrupts'])
  assert.throws(() => new LeaderTrigger('often'), /mode/)
})

test('periodic15: first call at t >= 20, then every 15 s after the last ask', () => {
  const tr = new LeaderTrigger('periodic15')
  assert.equal(tr.due({ t: 5 }), false)
  assert.equal(tr.due({ t: 19 }), false)
  assert.equal(tr.due({ t: 20 }), true)
  tr.asked(20)
  assert.equal(tr.due({ t: 34 }), false)
  assert.equal(tr.due({ t: 35 }), true)
  assert.equal(tr.due({ t: 30, event: 'death' }), false, 'events do not trigger the periodic15 mode')
})

test('events: due on subtask end, subtask error or death, never on a plain tick or an interrupt', () => {
  const tr = new LeaderTrigger('events')
  assert.equal(tr.due({ t: 1, event: 'subtask_done' }), true, 'the first event counts, no 20 s wait')
  assert.equal(tr.due({ t: 100 }), false)
  assert.equal(tr.due({ t: 100, event: 'interrupt' }), false)
  for (const e of ['subtask_done', 'subtask_error', 'death']) assert.equal(tr.due({ t: 100, event: e }), true, e)
})

test('periodic30_interrupts: every 30 s (first at t >= 20) or on an interrupt or a death', () => {
  const tr = new LeaderTrigger('periodic30_interrupts')
  assert.equal(tr.due({ t: 10 }), false)
  assert.equal(tr.due({ t: 10, event: 'interrupt' }), true)
  assert.equal(tr.due({ t: 20 }), true)
  tr.asked(20)
  assert.equal(tr.due({ t: 49 }), false)
  assert.equal(tr.due({ t: 49, event: 'subtask_done' }), false)
  assert.equal(tr.due({ t: 25, event: 'death' }), true)
  assert.equal(tr.reason, 'death')
  assert.equal(tr.due({ t: 50 }), true)
  assert.equal(tr.reason, 'periodic')
  assert.equal(tr.due({ t: 50, event: 'subtask_done' }), true)
  assert.equal(tr.reason, 'periodic', 'an event this mode ignores does not label a periodic call')
})

test('never due while a call is in flight, in any mode', () => {
  for (const mode of TRIGGERS) {
    const tr = new LeaderTrigger(mode)
    assert.equal(tr.due({ t: 500, event: 'death', inFlight: true }), false, mode)
  }
})

test('pickEvent keeps the most important event of a tick', () => {
  assert.equal(pickEvent([]), null)
  assert.equal(pickEvent(['subtask_done', 'death', 'interrupt']), 'death')
  assert.equal(pickEvent(['subtask_done', 'interrupt']), 'interrupt')
  assert.equal(pickEvent(['subtask_done', 'subtask_error']), 'subtask_error')
})

// ---- applying an answer -----------------------------------------------------------------------------------------
const offered = [{ id: 'mine_iron' }, { id: 'explore_toward(deep)' }, { id: 'wait' }]

test('applyAnswer: continue, override, invalid, stale', () => {
  assert.deepEqual(applyAnswer({ answer: { action: 'continue' }, currentId: 'mine_iron', askedCurrentId: 'mine_iron', offered }), { kind: 'continue', id: null })
  assert.deepEqual(applyAnswer({ answer: { action: 'mine_iron' }, currentId: 'mine_iron', askedCurrentId: 'mine_iron', offered }), { kind: 'continue', id: null }, 'the running subtask is a continue')
  assert.deepEqual(applyAnswer({ answer: { action: 'explore_toward(deep)' }, currentId: 'mine_iron', askedCurrentId: 'mine_iron', offered }), { kind: 'override', id: 'explore_toward(deep)' })
  assert.deepEqual(applyAnswer({ answer: { action: 'fly(moon)' }, currentId: 'mine_iron', askedCurrentId: 'mine_iron', offered }), { kind: 'invalid', id: 'fly(moon)' })
  assert.deepEqual(applyAnswer({ answer: { action: null }, currentId: 'mine_iron', askedCurrentId: 'mine_iron', offered }).kind, 'invalid')
  assert.deepEqual(applyAnswer({ answer: null, currentId: null, askedCurrentId: null, offered }).kind, 'invalid')
})

test('applyAnswer pins stale: once the subtask the leader judged has ended, any answer is dropped', () => {
  assert.equal(applyAnswer({ answer: { action: 'explore_toward(deep)' }, currentId: 'wait', askedCurrentId: 'mine_iron', offered }).kind, 'stale')
  assert.equal(applyAnswer({ answer: { action: 'explore_toward(deep)' }, currentId: null, askedCurrentId: 'mine_iron', offered }).kind, 'stale')
  assert.equal(applyAnswer({ answer: { action: 'continue' }, currentId: 'explore_toward(deep)', askedCurrentId: 'mine_iron', offered }).kind, 'stale')
  // asked while idle, still idle: the override applies at the next decision
  assert.deepEqual(applyAnswer({ answer: { action: 'mine_iron' }, currentId: null, askedCurrentId: null, offered }), { kind: 'override', id: 'mine_iron' })
})

// ---- guards -------------------------------------------------------------------------------------------------------
const guardOffered = [{ id: 'mine_iron' }, { id: 'mine_stone' }, { id: 'flee(threat)' }, { id: 'fight(threat)' }, { id: 'pillar_up' }, { id: 'explore_toward(down)' }]

test('threat guard: no override away from fight, flee or pillar_up while a hostile is near', () => {
  const base = { askedCurrentId: 'flee(threat)', currentId: 'flee(threat)', offered: guardOffered }
  assert.deepEqual(applyAnswer({ ...base, answer: { action: 'mine_iron' }, threatNear: true }), { kind: 'blocked', id: 'mine_iron', reason: 'threat' })
  assert.deepEqual(applyAnswer({ ...base, answer: { action: 'mine_iron' }, threatNear: false }), { kind: 'override', id: 'mine_iron' })
  assert.deepEqual(applyAnswer({ ...base, answer: { action: 'continue' }, threatNear: true }), { kind: 'continue', id: null })
  for (const cur of ['fight(threat)', 'pillar_up'])
    assert.equal(applyAnswer({ answer: { action: 'mine_stone' }, currentId: cur, askedCurrentId: cur, offered: guardOffered, threatNear: true }).kind, 'blocked', cur)
  // switching INTO a threat response is allowed
  assert.deepEqual(applyAnswer({ answer: { action: 'flee(threat)' }, currentId: 'mine_stone', askedCurrentId: 'mine_stone', offered: guardOffered, threatNear: true }), { kind: 'override', id: 'flee(threat)' })
  // stale and invalid still win over the guard
  assert.equal(applyAnswer({ ...base, currentId: 'mine_stone', answer: { action: 'mine_iron' }, threatNear: true }).kind, 'stale')
})

test('recent-failure guard: no re-push of an id whose last or second-to-last attempt failed to path', () => {
  const base = { answer: { action: 'mine_iron' }, currentId: 'mine_stone', askedCurrentId: 'mine_stone', offered: guardOffered }
  for (const r of ['no_path', 'target_gone', 'timeout', 'not_found'])
    assert.deepEqual(applyAnswer({ ...base, recentResults: [{ id: 'mine_iron', result: r }] }), { kind: 'blocked', id: 'mine_iron', reason: 'recent_failure' }, r)
  // failure in the second-to-last attempt of that id (other ids in between) still blocks
  assert.equal(applyAnswer({ ...base, recentResults: [{ id: 'mine_iron', result: 'no_path' }, { id: 'mine_stone', result: 'ok' }, { id: 'mine_iron', result: 'ok' }] }).kind, 'blocked')
  // ok, then no_path three attempts of that id ago, ok most recently: the last two attempts are ok, ok
  assert.deepEqual(applyAnswer({ ...base, recentResults: [{ id: 'mine_iron', result: 'no_path' }, { id: 'mine_iron', result: 'ok' }, { id: 'mine_iron', result: 'ok' }] }), { kind: 'override', id: 'mine_iron' })
  // other failure kinds and other ids do not block
  assert.equal(applyAnswer({ ...base, recentResults: [{ id: 'mine_iron', result: 'took_damage' }, { id: 'mine_iron', result: 'interrupted' }] }).kind, 'override')
  assert.equal(applyAnswer({ ...base, recentResults: [{ id: 'mine_stone', result: 'no_path' }] }).kind, 'override')
  assert.equal(applyAnswer({ ...base }).kind, 'override', 'no recentResults: no guard')
  // continue is never blocked, even when the running subtask failed before
  assert.equal(applyAnswer({ ...base, answer: { action: 'continue' }, recentResults: [{ id: 'mine_stone', result: 'no_path' }] }).kind, 'continue')
})

test('recentFailure: the failing result among the last two attempts of an id, or null', () => {
  assert.equal(recentFailure('mine_iron', [{ id: 'mine_iron', result: 'timeout' }, { id: 'mine_iron', result: 'ok' }]), 'timeout')
  assert.equal(recentFailure('mine_iron', [{ id: 'mine_iron', result: 'ok' }]), null)
  assert.equal(recentFailure('mine_iron', null), null)
})

test('parseLeaderAnswer reads the JSON and validates the action against the offered ids', () => {
  assert.deepEqual(parseLeaderAnswer('{"action": "continue", "why": "fine"}', offered), { action: 'continue', why: 'fine' })
  assert.deepEqual(parseLeaderAnswer('<think>x</think>{"action":"mine_iron"}', offered), { action: 'mine_iron', why: '' })
  assert.deepEqual(parseLeaderAnswer('{"action": "dig_to_china", "why": "x"}', offered), { action: null, why: 'x' })
  assert.deepEqual(parseLeaderAnswer('nope', offered), { action: null, why: '' })
})

test('leaderSchema: action is continue or an offered id; why is a string', () => {
  const s = leaderSchema(offered)
  assert.deepEqual(s.properties.action.enum, ['continue', 'mine_iron', 'explore_toward(deep)', 'wait'])
  assert.equal(s.properties.why.type, 'string')
  assert.deepEqual(s.required, ['action'])
})

// ---- the prompt -------------------------------------------------------------------------------------------------
const ctx = {
  stateText: 'STATE TEXT HERE',
  chainText: 'Goal chain: iron tools (done), iron armor (1 of 4 pieces), diamond tools, lit nether portal. Current stage: iron armor, step 21 of 47: get 19 iron ingots (have 3).',
  need: { ingots: 16, diamonds: 0, sticks: 0, obsidian: 0, flint: 0, missing: ['iron_chestplate', 'iron_leggings', 'iron_boots'] },
  options: [{ id: 'mine_iron', desc: 'walk to the nearest known iron ore and mine it' }, { id: 'explore_toward(down)', desc: 'dig a staircase down' }, { id: 'wait', desc: 'stand still' }],
  current: { id: 'explore_toward(down)', elapsedS: 42, lastResult: { id: 'mine_iron', result: 'no_path', repeats: 2 } },
  history: [
    { t: 100, kind: 'subtask_start', id: 'mine_iron', source: 'kev' },
    { t: 110, kind: 'subtask_done', id: 'mine_iron', result: 'no_path' },
    { t: 111, kind: 'interrupt', reason: 'threat' },
    { t: 120, kind: 'stage_done', stage: 2 },
    { t: 130, kind: 'leader_override', from: 'wait', to: 'mine_iron', why: 'iron is close' },
    { t: 140, kind: 'leader_continue', why: 'progressing' },
    { t: 150, kind: 'death' },
  ],
  forecasts: { subgoal_succeeds_60s: 0.21, damage_major_or_death: 0.05 },
  forecastTrend: { subgoal_succeeds_60s: [0.62, 0.5, 0.4, 0.3, 0.21], damage_major_or_death: [0.05] },
  kevPick: { t: 139, top: [['explore_toward(down)', 0.7], ['mine_iron', 0.2]] },
  subtaskStats: { mine_iron: { attempts: 5, ok: 2, fails: { no_path: 3 } }, 'explore_toward(down)': { attempts: 1, ok: 1, fails: {} } },
  ownHistory: [{ t: 130, action: 'mine_iron', kind: 'override', why: 'iron is close' }, { t: 140, action: 'continue', kind: 'continue', why: 'progressing' }],
  minutesLeft: 37.5, deaths: 1,
}

test('buildLeaderMessages: system + user; every section present, in order', () => {
  const msgs = buildLeaderMessages(ctx)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system'); assert.equal(msgs[1].role, 'user')
  assert.equal(msgs[0].content, LEADER_SYSTEM)
  const u = msgs[1].content
  const heads = ['STATE', 'GOAL CHAIN', 'CURRENT SUBTASK', 'RECENT EVENTS (oldest first)', 'SUBTASK STATS THIS EPISODE', 'KEV FORECASTS', 'YOUR PREVIOUS DECISIONS', 'TIME', 'SUBTASKS OFFERED NOW']
  const lines = u.split('\n')
  const at = heads.map(h => lines.indexOf(h))
  heads.forEach((h, k) => assert.ok(at[k] >= 0, `heading ${h}`))
  for (let k = 1; k < at.length; k++) assert.ok(at[k] > at[k - 1], `${heads[k]} after ${heads[k - 1]}`)
})

test('buildLeaderMessages carries the chain, the arithmetic, the options, the forecast trend, events, stats and own history', () => {
  const u = buildLeaderMessages(ctx)[1].content
  assert.match(u, /STATE TEXT HERE/)
  assert.match(u, /step 21 of 47: get 19 iron ingots/)
  assert.match(u, /16 iron ingots/)
  assert.match(u, /iron chestplate/)
  assert.match(u, /explore_toward\(down\).*42 s/)
  assert.match(u, /mine_iron -> no_path/)
  assert.match(u, /- mine_iron: walk to the nearest known iron ore/)
  assert.match(u, /- explore_toward\(down\): dig a staircase down/)
  assert.match(u, /step done in 60 s: 0\.21 \(was 0\.62 → 0\.50 → 0\.40 → 0\.30 → 0\.21, falling\)/)
  assert.match(u, /explore_toward\(down\) 0\.70/)
  assert.match(u, /interrupted: threat/)
  assert.match(u, /stage 2/)
  assert.match(u, /leader override: wait -> mine_iron/)
  assert.match(u, /DIED/)
  assert.doesNotMatch(u, /subtask_start/)
  assert.match(u, /mine_iron: 5 attempts, 2 ok, most common failure no_path \(3\)/)
  assert.match(u, /t=130s mine_iron \(override\): iron is close/)
  assert.match(u, /t=140s continue/)
  assert.match(u, /37\.5 minutes left/)
  assert.match(u, /deaths so far: 1/)
  assert.match(u, /"action"/)
})

test('buildLeaderMessages marks offered ids that failed recently', () => {
  const u = buildLeaderMessages({ ...ctx, recentResults: [{ id: 'mine_iron', result: 'no_path' }, { id: 'explore_toward(down)', result: 'ok' }] })[1].content
  assert.match(u, /^- mine_iron: walk to the nearest known iron ore and mine it \(failed recently: no_path, do not pick\)$/m)
  assert.match(u, /^- explore_toward\(down\): dig a staircase down$/m)
  assert.doesNotMatch(buildLeaderMessages(ctx)[1].content, /failed recently/)
})

test('buildLeaderMessages caps events at 30 and stats at 20 ids', () => {
  const history = Array.from({ length: 80 }, (_, i) => ({ t: i, kind: 'subtask_done', id: `x${i}`, result: 'ok' }))
  const subtaskStats = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`id${i}`, { attempts: 40 - i, ok: 1, fails: {} }]))
  const u = buildLeaderMessages({ ...ctx, history, subtaskStats })[1].content
  assert.equal((u.match(/ x\d+ -> ok/g) || []).length, 30)
  assert.match(u, / x79 -> ok/); assert.doesNotMatch(u, / x49 -> ok/)
  assert.equal((u.match(/^id\d+: /gm) || []).length, 20)
  assert.match(u, /^id0: 40 attempts/m)
})

test('buildLeaderMessages tolerates an idle bot and empty histories', () => {
  const u = buildLeaderMessages({ stateText: 's', chainText: 'c', options: offered.map(o => ({ ...o, desc: 'd' })), current: null }) [1].content
  assert.match(u, /none/)
  assert.match(u, /\(none yet\)/)
})

test('the system prompt: role, recipes, continue, override rules, wear, night, answer format', () => {
  const s = LEADER_SYSTEM
  assert.match(s, /kev/)
  assert.match(s, /"continue"/)
  assert.match(s, /iron sword.*2/i)
  assert.match(s, /chestplate.*8/i)
  assert.match(s, /diamond pickaxe.*3 diamonds/i)
  assert.match(s, /flint and steel/i)
  assert.match(s, /10 obsidian/)
  assert.match(s, /never override into wait/i)
  assert.match(s, /500 blocks/)
  assert.match(s, /night/i)
  assert.match(s, /\{"action": "continue" \| "<subtask id>", "why": "<one sentence>"\}/)
})

test('the system prompt carries the four run-1 rules', () => {
  const s = LEADER_SYSTEM
  assert.ok(s.includes('Never override fight, flee or pillar_up while a hostile is within 16 m; at night the bot must be underground or in a shelter before doing anything else.'))
  assert.ok(s.includes('Never pick a subtask whose last attempt ended no_path, target_gone, timeout or not_found; pick something that changes the situation instead (explore_toward(down), return_to_base, mine_stone).'))
  assert.ok(s.includes('Pickaxes wear out after about 500 blocks: when the bot has an iron pickaxe and cobblestone, having a spare stone pickaxe before a long dig is worth an override to craft(stone_pickaxe); losing the iron pickaxe resets the whole chain.'))
  assert.ok(s.includes('Override rarely: `continue` is the right answer whenever kev\'s current subtask makes progress on the current step.'))
  assert.doesNotMatch(s, /Do not repeat an override that just failed/)
})

test('subtaskStats counts attempts, successes and failures per id from the events', () => {
  const st = subtaskStats([
    { kind: 'subtask_done', id: 'a', result: 'ok' }, { kind: 'subtask_done', id: 'a', result: 'no_path' },
    { kind: 'subtask_error', id: 'a' }, { kind: 'subtask_done', id: 'b', result: 'ok' }, { kind: 'death' },
  ])
  assert.deepEqual(st.a, { attempts: 3, ok: 1, fails: { no_path: 1, error: 1 } })
  assert.deepEqual(st.b, { attempts: 1, ok: 1, fails: {} })
})

test('the episode log serialises leader calls and a decision record keeps its leader field', () => {
  const log = new EpisodeLog({ seed: 1 })
  log.leader.push({ t_asked: 1, action: 'continue', kind: 'continue' })
  log.decision({ t: 2, state_text: 's', decision: true, qs: {}, labels: {}, answers: {}, chosen: 'mine_iron', source: 'leader', leader: { t_asked: 1, action: 'mine_iron' } })
  const j = log.toJSON()
  assert.equal(j.leader.length, 1)
  assert.equal(j.decisions[0].source, 'leader')
  assert.deepEqual(j.decisions[0].leader, { t_asked: 1, action: 'mine_iron' })
})
