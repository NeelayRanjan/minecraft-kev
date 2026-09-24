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
