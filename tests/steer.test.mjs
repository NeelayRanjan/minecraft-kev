import test from 'node:test'
import assert from 'node:assert/strict'
import { STEER_OPTIONS, STEER_DESC, headingWord, steerLabel, steerLine, reachLabel, steerQuestions } from '../agent/steer.js'

test('headingWord: north is -z', () => {
  assert.equal(headingWord(0, -1), 'north')
})

test('STEER_OPTIONS and STEER_DESC: one description per option, in the declared order', () => {
  assert.deepEqual(STEER_OPTIONS, ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'jump', 'dig_ahead', 'stop'])
  for (const id of STEER_OPTIONS) assert.equal(typeof STEER_DESC[id], 'string', `missing STEER_DESC for ${id}`)
})

test('steerLabel: reached overrides everything else', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const path = [{ x: 5, y: 64, z: 0, toBreak: [1], toPlace: [] }]
  assert.equal(steerLabel({ pos, path, goalPos: { x: 5, y: 64, z: 0 }, reached: true }), 'stop')
})

test('steerLabel: the first node needing a dig is dig_ahead', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const path = [{ x: 3, y: 64, z: 0, toBreak: [{}], toPlace: [] }]
  assert.equal(steerLabel({ pos, path, goalPos: { x: 3, y: 64, z: 0 }, reached: false }), 'dig_ahead')
})

test('steerLabel: a node one block higher (no dig needed) is jump', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const path = [{ x: 2, y: 65, z: 0, toBreak: [], toPlace: [] }]
  assert.equal(steerLabel({ pos, path, goalPos: { x: 2, y: 65, z: 0 }, reached: false }), 'jump')
})

test('steerLabel: a flat node straight ahead reads as a heading word', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const path = [{ x: 3, y: 64, z: 0, toBreak: [], toPlace: [] }]
  assert.equal(steerLabel({ pos, path, goalPos: { x: 3, y: 64, z: 0 }, reached: false }), 'east')
})

test('steerLabel: skips path nodes within 0.4 m of pos and uses the first one farther away', () => {
  // pos sits exactly at the centre of the first node (-1,-1) -> (-0.5,-0.5), 0 m away: skipped.
  const pos = { x: -0.5, y: 64, z: -0.5 }
  const path = [
    { x: -1, y: 64, z: -1, toBreak: [], toPlace: [] },
    { x: 4, y: 64, z: 0, toBreak: [], toPlace: [] },
  ]
  assert.equal(steerLabel({ pos, path, goalPos: { x: 4, y: 64, z: 0 }, reached: false }), 'east')
})

test('steerLabel: no path falls back to heading toward the goal', () => {
  const pos = { x: 0, y: 64, z: 0 }
  assert.equal(steerLabel({ pos, path: [], goalPos: { x: 0, y: 64, z: -5 }, reached: false }), 'north')
  assert.equal(steerLabel({ pos, path: null, goalPos: { x: 0, y: 64, z: -5 }, reached: false }), 'north')
})

test('steerLine: exact string for the spec example', () => {
  const line = steerLine({
    targetName: 'cave entrance',
    target: { dist: 14, dir: 'north-east', dy: -3 },
    ahead: { feet: 'stone', head: 'air', below: 'grass' },
    lastMove: { dist: 1, dir: 'north-east' },
  })
  assert.equal(line, 'steering: toward cave entrance 14 m north-east, 3 m below you; ahead: stone at your feet, air at head height, grass below; last half second: moved 1 m north-east.')
})

test('steerLine: small dy is omitted and a near-zero last move reads as did not move', () => {
  const line = steerLine({
    targetName: 'coal ore',
    target: { dist: 6, dir: 'north', dy: 1 },
    ahead: { feet: 'grass', head: 'air', below: 'dirt' },
    lastMove: { dist: 0.1, dir: 'north' },
  })
  assert.equal(line, 'steering: toward coal ore 6 m north; ahead: grass at your feet, air at head height, dirt below; last half second: did not move.')
})

test('steerLine: never emits kev\'s reserved tokens', () => {
  const line = steerLine({
    targetName: '<|weird|>',
    target: { dist: 6, dir: 'north', dy: 0 },
    ahead: { feet: 'grass', head: 'air', below: 'dirt' },
    lastMove: { dist: 1, dir: 'north' },
  })
  assert.ok(!line.includes('<|') && !line.includes('|>'))
})

test('reachLabel: true when a frame inside the horizon lands within 3 m', () => {
  const frames = [
    { t: 0, x: 0, y: 64, z: 0 },
    { t: 15, x: 9.6, y: 64, z: 9.6 },   // 3 m from the centre of block (9,64,9) -> (9.5,64,9.5)
    { t: 30, x: 20, y: 64, z: 20 },
  ]
  assert.equal(reachLabel({ frames, t: 0, targetPos: { x: 9, y: 64, z: 9 }, horizonS: 30, endT: 30 }), true)
})

test('reachLabel: false when the horizon fully elapsed with no frame close enough', () => {
  const frames = [
    { t: 0, x: 0, y: 64, z: 0 },
    { t: 15, x: 1, y: 64, z: 1 },
    { t: 30, x: 2, y: 64, z: 2 },
  ]
  assert.equal(reachLabel({ frames, t: 0, targetPos: { x: 50, y: 64, z: 50 }, horizonS: 30, endT: 30 }), false)
})

test('reachLabel: censored (null) when the episode ended before the horizon and no hit occurred yet', () => {
  const frames = [
    { t: 0, x: 0, y: 64, z: 0 },
    { t: 10, x: 1, y: 64, z: 1 },
  ]
  assert.equal(reachLabel({ frames, t: 0, targetPos: { x: 50, y: 64, z: 50 }, horizonS: 30, endT: 10 }), null)
})

test('steerQuestions: shape matches questionFor conventions', () => {
  const qs = steerQuestions()
  assert.equal(qs.steer.type, 'choice')
  assert.equal(typeof qs.steer.instructions, 'string')
  assert.deepEqual(qs.steer.criteria, STEER_DESC)
  assert.equal(qs.reach_target_30s.type, 'noul')
  assert.equal(typeof qs.reach_target_30s.instructions, 'string')
})
