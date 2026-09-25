import test from 'node:test'
import assert from 'node:assert/strict'
import { Supervisor, DEFAULTS } from '../agent/supervisor.js'

// A subtask running from t=0 with the forecast p(step done in 60 s) sampled once a second.
const feed = (sup, ps, { t0 = 0, busy = true, id = 'mine_iron' } = {}) => {
  const fires = []
  ps.forEach((p, i) => { const r = sup.observe({ t: t0 + i, p, busy, subtaskId: id }); if (r) fires.push({ t: t0 + i, ...r }) })
  return fires
}

test('defaults match the design of record: replan when p < 0.25 for 15 s', () => {
  assert.equal(DEFAULTS.threshold, 0.25); assert.equal(DEFAULTS.holdS, 15)
})

test('off never fires', () => {
  const sup = new Supervisor({ mode: 'off' })
  sup.onSubtaskStart(0)
  assert.deepEqual(feed(sup, Array(40).fill(0.05)), [])
})

test('real: fires once the forecast has stayed below the threshold for holdS seconds, not before', () => {
  const sup = new Supervisor({ mode: 'real' })
  sup.onSubtaskStart(0)
  const fires = feed(sup, Array(20).fill(0.1))
  assert.equal(fires.length, 1)
  assert.equal(fires[0].t, 15)
  assert.equal(fires[0].id, 'mine_iron')
  assert.equal(fires[0].p, 0.1)
})

test('real: a forecast back above the threshold resets the clock', () => {
  const sup = new Supervisor({ mode: 'real' })
  sup.onSubtaskStart(0)
  const ps = [...Array(10).fill(0.1), 0.6, ...Array(14).fill(0.1)]   // 10 low, one high, 14 low: never 15 in a row
  assert.deepEqual(feed(sup, ps), [])
  const f = feed(sup, [0.1, 0.1], { t0: 25 })
  assert.equal(f.length, 1); assert.equal(f[0].t, 26)                  // 15 s after the low run began at t=11
})

test('real: idle (no subtask) and missing forecasts never count', () => {
  const sup = new Supervisor({ mode: 'real' })
  sup.onSubtaskStart(0)
  assert.deepEqual(feed(sup, Array(30).fill(0.1), { busy: false }), [])
  assert.deepEqual(feed(sup, Array(30).fill(null), { t0: 30 }), [])
})

test('real: a new subtask resets the clock; a cooldown stops back-to-back replans', () => {
  const sup = new Supervisor({ mode: 'real', cooldownS: 30 })
  sup.onSubtaskStart(0)
  assert.equal(feed(sup, Array(16).fill(0.1)).length, 1)              // fires at t=15
  sup.onSubtaskStart(16)
  const again = feed(sup, Array(40).fill(0.1), { t0: 16, id: 'explore_toward(down)' })
  assert.equal(again.length, 1)
  assert.ok(again[0].t >= 15 + 30, `cooldown respected, fired at ${again[0].t}`)
  assert.equal(again[0].id, 'explore_toward(down)')
})

test('shuffled: uses values drawn from the pool instead of the live forecast, so it fires at the pool rate', () => {
  let k = 0
  const lowPool = new Supervisor({ mode: 'shuffled', pool: [0.05, 0.1], rng: () => (k++ % 2) / 2 })
  lowPool.onSubtaskStart(0)
  const fires = feed(lowPool, Array(20).fill(0.99))                     // live forecast says fine; pool says stuck
  assert.equal(fires.length, 1)
  assert.equal(fires[0].shuffled, true)
  const highPool = new Supervisor({ mode: 'shuffled', pool: [0.9, 0.95], rng: () => 0 })
  highPool.onSubtaskStart(0)
  assert.deepEqual(feed(highPool, Array(20).fill(0.01)), [])            // live forecast says stuck; pool says fine
})

test('shuffled: holds one drawn value per subtask and redraws every holdS seconds (an independent draw per second would never fire)', () => {
  // rng alternates high / low every call: a per-second draw could never stay low for 15 s; a per-block draw fires on the low block.
  let k = 0
  const sup = new Supervisor({ mode: 'shuffled', pool: [0.9, 0.1], rng: () => (k++ % 2) / 2, cooldownS: 0 })
  sup.onSubtaskStart(0)
  const fires = feed(sup, Array(60).fill(0.99))
  assert.ok(fires.length >= 1, 'fires on a low block')
  assert.equal(fires[0].t, 31)                                         // block 1 (t 0-15) drew 0.9, block 2 (from t 16) drew 0.1, fires 15 s later
  assert.equal(k, 4)                                                   // one draw per 15 s block
  sup.onSubtaskStart(60)
  feed(sup, [0.99], { t0: 60 })
  assert.equal(k, 5)                                                   // a new subtask draws afresh
})

test('shuffled needs a pool', () => {
  assert.throws(() => new Supervisor({ mode: 'shuffled' }), /pool/)
})

test('counts its replans', () => {
  const sup = new Supervisor({ mode: 'real', cooldownS: 0 })
  sup.onSubtaskStart(0); feed(sup, Array(16).fill(0.1))
  sup.onSubtaskStart(16); feed(sup, Array(16).fill(0.1), { t0: 16 })
  assert.equal(sup.fires, 2)
})
