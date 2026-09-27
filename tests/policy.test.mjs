import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseAction, interruptFor } from '../agent/policy.js'

const qs = { next_subtask: { type: 'choice', criteria: { gather_wood: 'g', 'explore_toward(surface)': 'e', wait: 'w' } } }
const labels = { next_subtask: 'gather_wood' }

test('teacher policy follows the teacher label', () => {
  assert.deepEqual(chooseAction({ policy: 'teacher', qs, labels, answers: {}, rng: () => 0.9, epsAction: 0 }), { id: 'gather_wood', source: 'teacher' })
})

test('kev policy takes the argmax choice', () => {
  const answers = { next_subtask: { choice: 'explore_toward(surface)', probabilities: { gather_wood: 0.2, 'explore_toward(surface)': 0.7, wait: 0.1 } } }
  assert.deepEqual(chooseAction({ policy: 'kev', qs, labels, answers, rng: () => 0.9, epsAction: 0 }), { id: 'explore_toward(surface)', source: 'kev' })
})

test('epsilon picks a random offered option', () => {
  const r = chooseAction({ policy: 'teacher', qs, labels, answers: {}, rng: () => 0.01, epsAction: 0.1, pick: opts => opts[2] })
  assert.deepEqual(r, { id: 'wait', source: 'random' })
})

test('a choice outside the offered options falls back to wait', () => {
  const answers = { next_subtask: { choice: 'mine_iron', probabilities: {} } }
  assert.deepEqual(chooseAction({ policy: 'kev', qs, labels, answers, rng: () => 0.9, epsAction: 0 }), { id: 'wait', source: 'fallback' })
  assert.deepEqual(chooseAction({ policy: 'teacher', qs, labels: { next_subtask: 'craft(sticks)' }, answers: {}, rng: () => 0.9, epsAction: 0 }), { id: 'wait', source: 'fallback' })
})

test('interrupts: a new hostile within 16 m, unless already fighting or fleeing; a 4 hp drop; death', () => {
  const cur = name => ({ name })
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: cur('gather_wood'), healthDrop: 0, dead: false }), 'threat')
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 12, current: cur('gather_wood'), healthDrop: 0, dead: false }), null)
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: cur('fight'), healthDrop: 0, dead: false }), null)
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: cur('flee'), healthDrop: 0, dead: false }), null)
  assert.equal(interruptFor({ hostileDist: null, prevHostileDist: null, current: cur('gather_wood'), healthDrop: 5, dead: false }), 'took_damage')
  assert.equal(interruptFor({ hostileDist: null, prevHostileDist: null, current: cur('gather_wood'), healthDrop: 2, dead: false }), null)
  assert.equal(interruptFor({ hostileDist: null, prevHostileDist: null, current: cur('gather_wood'), healthDrop: 0, dead: true }), 'died')
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: null, healthDrop: 0, dead: false }), null)
})

test('drowning: while air is 10/20 or less, every tick, for any subtask that is not an escape', () => {
  const cur = (name, arg = null) => ({ name, arg })
  const base = { hostileDist: null, prevHostileDist: null, healthDrop: 0, dead: false }
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('mine_stone') }), 'drowning')
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('mine_stone') }), 'drowning', 'again on the next tick')
  assert.equal(interruptFor({ ...base, oxygen: 10, current: cur('explore_toward', 'down') }), 'drowning')
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('explore_toward', 'surface') }), null)
  for (const n of ['wait', 'flee', 'fight', 'pillar_up']) assert.equal(interruptFor({ ...base, oxygen: 8, current: cur(n) }), null, n)
  assert.equal(interruptFor({ ...base, oxygen: 11, current: cur('mine_stone') }), null)
  assert.equal(interruptFor({ ...base, current: cur('mine_stone') }), null)   // no oxygen reading: full air
  assert.equal(interruptFor({ ...base, oxygen: 8, healthDrop: 5, current: cur('mine_stone') }), 'took_damage')
})

test('a new attacker (a player who just hit the bot) fires threat like a hostile crossing 16 m', () => {
  const cur = name => ({ name })
  const base = { hostileDist: null, prevHostileDist: null, healthDrop: 0, dead: false }
  const player = { kind: 'player', name: 'Spacers_Choice', sinceS: 0 }
  assert.equal(interruptFor({ ...base, current: cur('gather_wood'), attacker: player }), 'threat')
  assert.equal(interruptFor({ ...base, current: cur('mine_stone'), attacker: { ...player, sinceS: 3 } }), null, 'only on the tick of the hit')
  assert.equal(interruptFor({ ...base, current: cur('mine_stone'), attacker: null }), null)
  for (const n of ['fight', 'flee', 'pillar_up']) assert.equal(interruptFor({ ...base, current: cur(n), attacker: player }), null, n)
  assert.equal(interruptFor({ ...base, current: null, attacker: player }), null)
})

// Final review, Important 1: a mob hit (or any non-player attacker) keeps main's behaviour exactly: only the 16 m
// crossing and the cumulative 4 hp drop interrupt; a player hit with a hostile already within 16 m adds nothing.
test('a mob attacker never fires threat; a player attacker with a hostile already near does not either', () => {
  const cur = name => ({ name })
  const base = { hostileDist: null, prevHostileDist: null, healthDrop: 1, dead: false }
  for (const kind of ['hostile', 'other']) {
    assert.equal(interruptFor({ ...base, current: cur('eat'), attacker: { kind, name: 'zombie', sinceS: 0 } }), null, kind)
    assert.equal(interruptFor({ ...base, current: cur('build_shelter'), attacker: { kind, name: 'zombie', sinceS: 0 } }), null, kind)
  }
  const player = { kind: 'player', name: 'x', sinceS: 0 }
  assert.equal(interruptFor({ ...base, hostileDist: 6, prevHostileDist: 6, current: cur('eat'), attacker: player }), null)
  assert.equal(interruptFor({ ...base, current: cur('eat'), attackerNew: true }), null, 'the old boolean is gone: an unattributed hit is not a threat')
})

test('a threat crossing on the same tick as low air is not lost; drowning fires on the next tick', () => {
  const cur = { name: 'mine_stone', arg: null }
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: cur, healthDrop: 0, dead: false, oxygen: 8 }), 'threat')
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 10, current: cur, healthDrop: 0, dead: false, oxygen: 8 }), 'drowning')
  assert.equal(interruptFor({ hostileDist: 10, prevHostileDist: 30, current: cur, healthDrop: 0, dead: true, oxygen: 8 }), 'died')
})

import { goalGuard } from '../agent/policy.js'
test('goalGuard: under a pushed goal the teacher\'s plugin pick replaces kev\'s; threat, eat and the same id keep kev\'s; none at depth 0', () => {
  const plugins = new Set(['build_blueprint', 'dig_blueprint', 'mine', 'craft_item'])
  const offered = ['build_blueprint(bp1)', 'explore_toward(surface)', 'eat', 'flee(threat)', 'fight(threat)', 'pillar_up', 'mine_stone', 'wait']
  const g = (kevPick, teacherPick, depth = 1) => goalGuard({ kevPick, teacherPick, offered, depth, plugins })
  assert.equal(g('explore_toward(surface)', 'build_blueprint(bp1)'), 'build_blueprint(bp1)')
  assert.equal(g('wait', 'build_blueprint(bp1)'), 'build_blueprint(bp1)')
  for (const k of ['flee(threat)', 'fight(threat)', 'pillar_up', 'eat']) assert.equal(g(k, 'build_blueprint(bp1)'), null, k)
  assert.equal(g('build_blueprint(bp1)', 'build_blueprint(bp1)'), null, 'kev already picked it')
  assert.equal(g('explore_toward(surface)', 'build_blueprint(bp1)', 0), null, 'no guard at depth 0')
  assert.equal(g('explore_toward(surface)', 'mine_stone'), null, 'a legacy option is not guarded')
  assert.equal(g('explore_toward(surface)', 'dig_blueprint(bp9)'), null, 'not offered')
  assert.equal(g('explore_toward(surface)', null), null)
})

test('goalGuard backs off when the teacher\'s plugin pick failed in 2 of its last 3 attempts', () => {
  const plugins = new Set(['dig_blueprint'])
  const offered = ['dig_blueprint(bp3)', 'explore_toward(down)']
  const g = recent => goalGuard({ kevPick: 'explore_toward(down)', teacherPick: 'dig_blueprint(bp3)', offered, depth: 1, plugins, recent })
  const a = (id, result) => ({ id, result })
  assert.equal(g([]), 'dig_blueprint(bp3)')
  assert.equal(g([a('dig_blueprint(bp3)', 'unreachable')]), 'dig_blueprint(bp3)', 'one failure: still guarded')
  assert.equal(g([a('dig_blueprint(bp3)', 'unreachable'), a('explore_toward(down)', 'ok'), a('dig_blueprint(bp3)', 'no_path')]), null)
  assert.equal(g([a('dig_blueprint(bp3)', 'ok'), a('dig_blueprint(bp3)', 'unreachable'), a('dig_blueprint(bp3)', 'ok')]), 'dig_blueprint(bp3)')
  // only its last 3 attempts count
  assert.equal(g([a('dig_blueprint(bp3)', 'failed'), a('dig_blueprint(bp3)', 'failed'), a('dig_blueprint(bp3)', 'ok'), a('dig_blueprint(bp3)', 'ok'), a('dig_blueprint(bp3)', 'ok')]), 'dig_blueprint(bp3)')
  assert.equal(g([a('dig_blueprint(bp3)', 'interrupted'), a('dig_blueprint(bp3)', 'timeout')]), null, 'any non-ok result counts')
})
