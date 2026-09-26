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

test('drowning: air at 10/20 or less interrupts once, never a threat response', () => {
  const cur = name => ({ name })
  const base = { hostileDist: null, prevHostileDist: null, healthDrop: 0, dead: false }
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('wait') }), 'drowning')
  assert.equal(interruptFor({ ...base, oxygen: 10, prevOxygen: 11, current: cur('explore_toward') }), 'drowning')
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('flee') }), null)
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('fight') }), null)
  assert.equal(interruptFor({ ...base, oxygen: 8, current: cur('pillar_up') }), null)
  assert.equal(interruptFor({ ...base, oxygen: 7, prevOxygen: 8, current: cur('wait') }), null)   // already low: no repeat
  assert.equal(interruptFor({ ...base, oxygen: 11, current: cur('wait') }), null)
  assert.equal(interruptFor({ ...base, current: cur('wait') }), null)   // no oxygen reading: full air
  assert.equal(interruptFor({ ...base, oxygen: 8, healthDrop: 5, current: cur('wait') }), 'took_damage')
})
