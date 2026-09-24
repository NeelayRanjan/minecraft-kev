import test from 'node:test'
import assert from 'node:assert/strict'
import { dirWord, phaseOf, EpisodeMemory, classifyEntity, relTo } from '../agent/summary.js'

test('compass words (x east, z south; north is -z)', () => {
  assert.equal(dirWord(0, -10), 'north')
  assert.equal(dirWord(10, 0), 'east')
  assert.equal(dirWord(0, 10), 'south')
  assert.equal(dirWord(-10, 0), 'west')
  assert.equal(dirWord(7, -7), 'north-east')
  assert.equal(dirWord(-7, 7), 'south-west')
})

test('relTo gives distance, direction and height difference', () => {
  const r = relTo({ x: 0, y: 64, z: 0 }, { x: 3, y: 60, z: -4 })
  assert.equal(Math.round(r.dist * 100) / 100, Math.round(Math.hypot(3, 4, 4) * 100) / 100)
  assert.equal(r.dir, 'north-east')
  assert.equal(r.dy, -4)
})

test('day phases and seconds to dusk / morning', () => {
  assert.deepEqual(phaseOf(1000), { phase: 'morning', secondsToDusk: 550, secondsToMorning: null })
  assert.equal(phaseOf(6000).phase, 'midday')
  assert.equal(phaseOf(9000).phase, 'afternoon')
  assert.equal(phaseOf(12500).phase, 'dusk')
  assert.equal(phaseOf(15000).phase, 'night')
  assert.equal(phaseOf(23500).phase, 'dawn')
  assert.equal(phaseOf(18000).secondsToMorning, 300)
  assert.equal(phaseOf(18000).secondsToDusk, null)
  assert.equal(phaseOf(24000 + 500).phase, 'morning')
})

test('memory remembers iron and base positions', () => {
  const m = new EpisodeMemory()
  assert.equal(m.ironSeen, null)
  m.sawIron({ x: 1, y: 2, z: 3 }, 10)
  assert.deepEqual(m.ironSeen.pos, { x: 1, y: 2, z: 3 })
  assert.equal(m.ironSeen.t, 10)
  m.setBase('table', { x: 0, y: 0, z: 0 })
  assert.deepEqual(m.base.table, { x: 0, y: 0, z: 0 })
  m.setBase('table', null)
  assert.equal(m.base.table, null)
  assert.equal(m.deaths, 0)
})

test('entity classes', () => {
  const md = { entitiesByName: { zombie: { category: 'Hostile mobs' }, cow: { category: 'Passive mobs' }, item: { category: 'UNKNOWN' } } }
  assert.equal(classifyEntity({ type: 'mob', name: 'zombie' }, md), 'hostile')
  assert.equal(classifyEntity({ type: 'hostile', name: 'zombie' }, md), 'hostile')
  assert.equal(classifyEntity({ type: 'mob', name: 'cow' }, md), 'passive')
  assert.equal(classifyEntity({ type: 'animal', name: 'cow' }, md), 'passive')
  assert.equal(classifyEntity({ type: 'player', name: 'x', username: 'y' }, md), 'player')
  assert.equal(classifyEntity({ type: 'object', name: 'item' }, md), null)
  assert.equal(classifyEntity({ type: 'mob', name: 'unknown_thing' }, md), null)
})
