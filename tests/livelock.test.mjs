import test from 'node:test'
import assert from 'node:assert/strict'
import { options, REPEAT_LIMIT } from '../agent/subtasks.js'
import { teacherSubtask } from '../agent/teacher.js'
import { serialize } from '../agent/serialize.js'
import { baseObs } from './fixtures.mjs'

const ids = o => options(o).map(x => x.id)
const stuckSmelt = repeats => baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, furnace: 1, coal: 1 }, last: { id: 'smelt(iron_ingot)', result: 'no_furnace', repeats } })

test('an option that just failed the same way REPEAT_LIMIT times in a row is withheld', () => {
  assert.ok(ids(stuckSmelt(REPEAT_LIMIT - 1)).includes('smelt(iron_ingot)'))
  assert.ok(!ids(stuckSmelt(REPEAT_LIMIT)).includes('smelt(iron_ingot)'))
  assert.ok(!ids(stuckSmelt(20)).includes('smelt(iron_ingot)'))
})

test('a repeated success is never withheld, and wait is always offered', () => {
  const o = baseObs({ blocks: [{ name: 'oak_log', dist: 5, dir: 'north', dy: 0, reachable: true }], last: { id: 'gather_wood', result: 'ok', repeats: 10 } })
  assert.ok(ids(o).includes('gather_wood'))
  assert.ok(ids(baseObs({ last: { id: 'wait', result: 'ok', repeats: 50 } })).includes('wait'))
})

test('the teacher picks something else once its choice is withheld', () => {
  assert.equal(teacherSubtask(stuckSmelt(0)), 'smelt(iron_ingot)')
  const alt = teacherSubtask(stuckSmelt(REPEAT_LIMIT))
  assert.notEqual(alt, 'smelt(iron_ingot)')
  assert.notEqual(alt, 'wait')
})

test('gather_wood withheld after repeated no_path leaves surface exploration for the teacher', () => {
  const o = baseObs({ blocks: [{ name: 'oak_log', dist: 30, dir: 'north', dy: 0, reachable: false }], last: { id: 'gather_wood', result: 'no_path', repeats: 3 } })
  assert.equal(teacherSubtask(o), 'explore_toward(surface)')
})

test('the state text says how many times in a row the last subtask failed', () => {
  assert.match(serialize(stuckSmelt(5)), /last subtask result: smelt\(iron ingot\) no furnace, 5 times in a row\./)
  assert.match(serialize(baseObs({ last: { id: 'wait', result: 'ok', repeats: 3 } })), /last subtask result: wait ok\./)
})

test('gathering is capped: no gather_wood past 12 logs, no mine_stone past 32 cobblestone, no mine_iron past 6 iron before the pickaxe', () => {
  const log = { name: 'oak_log', dist: 5, dir: 'north', dy: 0, reachable: true }, stone = { name: 'stone', dist: 3, dir: 'south', dy: 0, reachable: true }
  const iron = { name: 'iron_ore', dist: 6, dir: 'west', dy: 0, reachable: true }
  assert.ok(ids(baseObs({ blocks: [log], inventory: { oak_log: 11 } })).includes('gather_wood'))
  assert.ok(!ids(baseObs({ blocks: [log], inventory: { oak_log: 8, oak_planks: 16 } })).includes('gather_wood'))
  assert.ok(ids(baseObs({ blocks: [stone], inventory: { wooden_pickaxe: 1, cobblestone: 31 } })).includes('mine_stone'))
  assert.ok(!ids(baseObs({ blocks: [stone], inventory: { wooden_pickaxe: 1, cobblestone: 32 } })).includes('mine_stone'))
  assert.ok(ids(baseObs({ blocks: [iron], inventory: { stone_pickaxe: 1, raw_iron: 5 } })).includes('mine_iron'))
  assert.ok(!ids(baseObs({ blocks: [iron], inventory: { stone_pickaxe: 1, raw_iron: 3, iron_ingot: 3 } })).includes('mine_iron'))
  assert.ok(ids(baseObs({ blocks: [iron], inventory: { iron_pickaxe: 1, raw_iron: 9 } })).includes('mine_iron'))   // after the goal, mining is unrestricted
})

test('table crafts are offered when the remembered table is within 16 m, and the teacher walks back when it is farther', () => {
  const inv = { oak_planks: 3, stick: 2 }
  assert.ok(ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 14, dir: 'east', dy: 6 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
  assert.ok(!ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 20, dir: 'east', dy: 6 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
  assert.equal(teacherSubtask(baseObs({ inventory: inv, base: { crafting_table: { dist: 20, dir: 'east', dy: 6 }, furnace: null } })), 'return_to_base')
})
