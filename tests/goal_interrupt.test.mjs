import test from 'node:test'
import assert from 'node:assert/strict'
import { interruptOnRemoval } from '../agent/goals.js'

// "stop" / "you can go" / clearing plans left the running executor going for up to 150 s (final review, Important 5):
// when a goal is removed (popped, its plan step dropped/skipped/cleared, a stay or protect ended) the runner interrupts
// the motor if the running subtask belongs to that goal.
test('interruptOnRemoval: a blueprint goal stops its own executor only', () => {
  const build = { kind: 'build', arg: 'bp2' }, dig = { kind: 'dig', arg: 'bp3' }
  assert.equal(interruptOnRemoval('build_blueprint(bp2)', build), true)
  assert.equal(interruptOnRemoval('build_blueprint(bp1)', build), false, 'another blueprint')
  assert.equal(interruptOnRemoval('dig_blueprint(bp3)', dig), true)
  assert.equal(interruptOnRemoval('mine_stone', build), false, 'a material subtask kev picked')
  assert.equal(interruptOnRemoval('flee(threat)', dig), false)
})

test('interruptOnRemoval: go_to(player) stops go_to_player and linger; receive stops receive', () => {
  const go = { kind: 'go_to', arg: 'player:Steve' }
  assert.equal(interruptOnRemoval('go_to_player(Steve)', go), true)
  assert.equal(interruptOnRemoval('linger(Steve)', go), true)
  assert.equal(interruptOnRemoval('go_to_player(Alex)', go), false)
  assert.equal(interruptOnRemoval('receive(redstone)', { kind: 'receive', arg: 'redstone', count: 4 }), true)
  assert.equal(interruptOnRemoval('gather_wood', { kind: 'gather', arg: 'log', count: 8 }), false)
})

test('interruptOnRemoval: a stay or protect stops any running subtask except a threat response or eating', () => {
  for (const g of [{ kind: 'stay', arg: 'here' }, { kind: 'stay', arg: 'player:Steve' }, { kind: 'protect', arg: 'player:Steve' }]) {
    for (const id of ['stay(here)', 'stay(Steve)', 'protect(Steve)', 'wait', 'mine_stone']) assert.equal(interruptOnRemoval(id, g), true, `${g.kind} ${id}`)
    for (const id of ['flee(threat)', 'fight(threat)', 'pillar_up', 'eat']) assert.equal(interruptOnRemoval(id, g), false, `${g.kind} ${id}`)
  }
})

test('interruptOnRemoval: nothing running, or no goal: false', () => {
  assert.equal(interruptOnRemoval(null, { kind: 'stay', arg: 'here' }), false)
  assert.equal(interruptOnRemoval('stay(here)', null), false)
})
