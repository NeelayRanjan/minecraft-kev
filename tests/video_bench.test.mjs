import test from 'node:test'
import assert from 'node:assert/strict'
import { frameSchedule, mosaicLayout, sampleCalls, scoreArm, lastResults, teacherLabelAt, pickShowcase, ageLabel } from '../agent/video_bench.js'

test('frameSchedule: 6 + 10 + 20 = 36 frames by default, oldest first, ages in the window', () => {
  const s = frameSchedule(500)
  assert.equal(s.length, 36)
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t_frame > s[i - 1].t_frame, 'sorted, no duplicates')
  const ages = s.map(f => f.age)
  assert.deepEqual(ages.slice(0, 6), [110, 100, 90, 80, 70, 60])
  assert.deepEqual(ages.slice(6, 16), [56, 52, 48, 44, 40, 36, 32, 28, 24, 20])
  assert.equal(ages.at(-1), 0)
  assert.equal(ages.filter(a => a < 20).length, 20)
  for (const f of s) { assert.ok(f.age >= 0 && f.age < 120); assert.equal(Math.round(f.t_frame * 5), +(f.t_frame * 5).toFixed(6), 'on the 5 fps grid') }
})

test('frameSchedule: never before the start of the video; off-grid t snaps to 0.2 s', () => {
  const s = frameSchedule(30)
  assert.ok(s.every(f => f.t_frame >= 0))
  assert.equal(s.length, 20 + 3)   // ages 0..19, then 20, 24, 28
  const off = frameSchedule(177.7)
  assert.equal(off.length, 36)
  for (const f of off) assert.ok(Math.abs(f.t_frame * 5 - Math.round(f.t_frame * 5)) < 1e-9)
  assert.equal(frameSchedule(500, { windowS: 60 }).length, 30)
})

test('mosaicLayout: 36 -> 6x6 with 224 px tiles; small n still square-ish', () => {
  assert.deepEqual(mosaicLayout(36), { cols: 6, rows: 6, tile: 224 })
  assert.deepEqual(mosaicLayout(23), { cols: 5, rows: 5, tile: 268 })
  assert.deepEqual(mosaicLayout(1), { cols: 1, rows: 1, tile: 1344 })
  assert.equal(ageLabel(85.2), '-85s')
})

const synth = () => {
  const leader = [], events = [], decisions = []
  const call = (t, current_id, kind, id = null) => leader.push({ t_asked: t, t_answered: t + 3, current_id, kind, id, action: id ?? current_id, offered: ['mine_iron', 'mine_coal', 'gather_wood'] })
  // two overrides that end no_path, one away from flee (ends ok), two ending ok, one stale, many continues
  call(10, 'mine_iron', 'override', 'mine_coal'); events.push({ t: 15, kind: 'subtask_done', id: 'mine_coal', result: 'no_path' })
  call(20, 'gather_wood', 'override', 'mine_iron'); events.push({ t: 25, kind: 'subtask_done', id: 'mine_iron', result: 'no_path' })
  call(30, 'flee(threat)', 'override', 'gather_wood'); events.push({ t: 35, kind: 'subtask_done', id: 'gather_wood', result: 'ok' })
  call(40, 'mine_iron', 'override', 'mine_coal'); events.push({ t: 45, kind: 'subtask_done', id: 'mine_coal', result: 'ok' })
  call(50, 'mine_coal', 'stale')
  for (let t = 60; t < 200; t += 10) call(t, 'mine_iron', 'continue')
  for (let t = 0; t < 200; t += 5) decisions.push({ t, teacher_label: t % 2 ? null : `label${t}` })
  return { leader, events, decisions }
}

test('sampleCalls: strata in order, no duplicates, teacher label from the nearest decision at or before t_asked', () => {
  const j = synth()
  const s = sampleCalls(j, 10)
  assert.equal(s.length, 10)
  const by = k => s.filter(c => c.stratum === k).map(c => c.t_asked)
  assert.deepEqual(by('nopath'), [10, 20])
  assert.deepEqual(by('threat'), [30])
  assert.deepEqual(by('ok'), [40])
  assert.equal(by('continue').length, 6)
  assert.ok(!s.some(c => c.kind === 'stale'))
  assert.equal(new Set(s.map(c => c.t_asked)).size, 10)
  assert.deepEqual(s.map(c => c.t_asked), [...s.map(c => c.t_asked)].sort((a, b) => a - b))
  assert.equal(s.find(c => c.t_asked === 10).teacher_label, 'label10')
  assert.equal(s.find(c => c.t_asked === 10).outcome, 'no_path')
  assert.equal(teacherLabelAt(j.decisions, 17), 'label10', 't=15 has no label, so the one before it')
  assert.ok(sampleCalls(j, 40, { maxT: 100 }).every(c => c.t_asked <= 100))
  const show = pickShowcase(s)
  assert.equal(show.length, 6, 'only 3 hard calls exist here, plus 3 continues')
})

test('scoreArm: validity, agreement, bad re-push and leaving a threat response', () => {
  const offered = ['mine_iron', 'mine_coal', 'gather_wood', 'pillar_up']
  const rows = [
    { current_id: 'mine_iron', offered, teacher_label: 'mine_iron', run1_action: 'continue', last_results: {}, answer: { action: 'continue', latency_ms: 1000 } },
    { current_id: 'mine_iron', offered, teacher_label: 'mine_coal', run1_action: 'mine_coal', last_results: { mine_coal: 'no_path' }, answer: { action: 'mine_coal', latency_ms: 2000 } },
    { current_id: 'flee(threat)', offered, teacher_label: 'flee(threat)', run1_action: 'gather_wood', last_results: {}, answer: { action: 'gather_wood', latency_ms: 3000 } },
    { current_id: 'flee(threat)', offered, teacher_label: 'flee(threat)', run1_action: 'continue', last_results: {}, answer: { action: 'pillar_up', latency_ms: 4000 } },
    { current_id: 'mine_iron', offered, teacher_label: 'mine_iron', run1_action: 'continue', last_results: {}, answer: { action: 'nether_portal', latency_ms: 5000 } },
    { current_id: 'mine_iron', offered, teacher_label: 'mine_iron', run1_action: 'continue', last_results: {}, answer: { error: 'timeout' } },
  ]
  const s = scoreArm(rows)
  assert.equal(s.n, 6)
  assert.equal(s.valid, +(4 / 6).toFixed(3))
  assert.equal(s.agree_teacher, 0.5)       // rows 1 and 2 of the 4 valid
  assert.equal(s.same_as_run1, 0.75)       // rows 1, 2, 3
  assert.equal(s.bad_repush, 1)
  assert.equal(s.left_threat, 1)
  assert.equal(s.threat_n, 2)
  assert.equal(s.latency_p50, 3000)
  assert.deepEqual(lastResults([{ t: 1, kind: 'subtask_done', id: 'a', result: 'no_path' }, { t: 2, kind: 'subtask_done', id: 'a', result: 'ok' }], 2), { a: 'no_path' })
})

test('alignLag recovers a growing lag (dropped frames) from motion vs scene change; videoTime maps through it', async () => {
  const { alignLag, videoTime } = await import('../agent/video_bench.js')
  // synthetic: episode 600 s of random motion bursts; the video drops 1 s every 10 s from t = 100 on
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const motion = Array.from({ length: 600 }, () => rnd() < 0.2 ? 3 + rnd() : rnd() * 0.2)
  const trueLag = motion.map((_, s) => s < 100 ? 0 : Math.floor((s - 100) / 10))
  const video = []
  for (let s = 0; s < 600; s++) if (s < 100 || (s - 100) % 10 !== 9) video.push(motion[s] + rnd() * 0.3)
  const z = a => { const m = a.reduce((p, q) => p + q, 0) / a.length, sd = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); return a.map(x => (x - m) / sd) }
  const { lag, score, score0 } = alignLag(z(motion), z(video), { maxLag: 80, pen: 0.1 })
  const err = lag.map((l, s) => Math.abs(l - trueLag[s]))
  assert.ok(err.filter(e => e <= 1).length / err.length > 0.95, 'lag within 1 s almost everywhere')
  assert.ok(score > score0 * 2)
  assert.equal(videoTime(300, lag), +(300 - lag[300]).toFixed(1))
  assert.equal(videoTime(12.34, null), 12.4)
  assert.equal(videoTime(999, null, 500), 499.8, 'clamped to the last frame')
})
