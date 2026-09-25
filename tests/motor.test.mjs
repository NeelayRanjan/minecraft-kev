import test from 'node:test'
import assert from 'node:assert/strict'
import mcDataFor from 'minecraft-data'
import { Motor } from '../agent/motor.js'
import { EpisodeMemory } from '../agent/summary.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
function fakeBot() {
  const handlers = {}
  return {
    version: '1.20.4', registry: mcDataFor('1.20.4'),
    entity: { position: { x: 0, y: 64, z: 0, floored() { return this }, offset() { return this }, distanceTo() { return 0 } }, yaw: 0, pitch: 0 },
    setMaxListeners() {}, on(n, f) { (handlers[n] ||= []).push(f) }, once() {}, removeListener() {}, waitForTicks: async () => {},
    pathfinder: { setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false, isMining: () => false, goto: async () => {} },
    _client: { on() {} }, clickWindow: async () => {}, inventory: { items: () => [] }, heldItem: null,
    collectBlock: { targets: { clear() {}, empty: true }, movements: null }, pvp: { stop() {} },
    stopDigging() {}, clearControlStates() {}, blockAt: () => null, findBlock: () => null, findBlocks: () => [],
  }
}

test('an executor abandoned by its timeout is aborted at its next check, even after a new run has started', async () => {
  const bot = fakeBot()
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory(), { timeouts: { wait: 0.05, slow: 0.05 } })
  let zombieOutcome = null
  motor.exec.slow = async function () {
    await sleep(120)            // outlives the 50 ms timeout
    try { this.check(); zombieOutcome = 'survived' } catch (e) { zombieOutcome = `aborted:${e.message}` }
    return { result: 'ok' }
  }
  const r1 = await motor.run('slow', {})
  assert.equal(r1.result, 'timeout')
  const r2 = motor.run('wait', {})   // a new run begins while the zombie is still sleeping
  await sleep(150)
  await r2
  assert.match(zombieOutcome, /^aborted/)
})

test('interrupt aborts the running executor and reports the reason', async () => {
  const bot = fakeBot()
  const motor = new Motor(bot, mcDataFor('1.20.4'), new EpisodeMemory(), { timeouts: { slow: 5 } })
  motor.exec.slow = async function () { for (let i = 0; i < 50; i++) { await sleep(20); this.check() } return { result: 'ok' } }
  const p = motor.run('slow', {})
  await sleep(50)
  motor.interrupt('threat')
  const r = await p
  assert.equal(r.result, 'interrupted'); assert.equal(r.detail, 'threat')
  assert.equal(motor.busy, false)
})

import { Vec3 } from 'vec3'
import { liquidAround } from '../agent/motor.js'

// blockAt over a Map keyed "x,y,z"; anything unset is stone.
const world = cells => p => ({ name: cells.get(`${p.x},${p.y},${p.z}`) || 'stone', position: p })

test('liquidAround: dry step is safe', () => {
  assert.equal(liquidAround(world(new Map()), new Vec3(5, 20, 0)), null)
})

test('liquidAround: lava in any of the three dug cells or the cell below the step', () => {
  const ahead = new Vec3(5, 20, 0)
  for (const dy of [1, 0, -1, -2]) {
    const cells = new Map([[`5,${20 + dy},0`, 'lava']])
    assert.equal(liquidAround(world(cells), ahead), 'lava', `lava at dy ${dy}`)
  }
  assert.equal(liquidAround(world(new Map([['5,18,0', 'water']])), ahead), 'water')
})

test('liquidAround: liquid outside the checked column is ignored; unloaded cells are not liquid', () => {
  const ahead = new Vec3(5, 20, 0)
  assert.equal(liquidAround(world(new Map([['5,17,0', 'lava'], ['6,20,0', 'lava'], ['5,22,0', 'lava']])), ahead), null)
  assert.equal(liquidAround(() => null, ahead), null)
})
