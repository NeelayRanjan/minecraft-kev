import test from 'node:test'
import assert from 'node:assert/strict'
import { options, REPEAT_LIMIT, REPEAT_WINDOW } from '../agent/subtasks.js'
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

// A leader that alternates an unreachable target with other tries never fails the same way three times in a row.
const coal = { name: 'coal_ore', dist: 12, dir: 'north', dy: -3, reachable: false }
const alternating = recent => baseObs({ inventory: { wooden_pickaxe: 1 }, blocks: [coal], last: { ...recent.at(-1), repeats: 1, recent } })
const f = (id, result = 'no_path') => ({ id, result })

test('an option that failed the same way REPEAT_LIMIT times among the last REPEAT_WINDOW attempts is withheld', () => {
  assert.equal(REPEAT_WINDOW, 6)
  const two = [f('mine_coal'), f('wait', 'ok'), f('mine_coal'), f('explore_toward(surface)', 'ok')]
  assert.ok(ids(alternating(two)).includes('mine_coal'))
  const three = [f('mine_coal'), f('wait', 'ok'), f('mine_coal'), f('explore_toward(surface)', 'ok'), f('mine_coal'), f('wait', 'ok')]
  assert.ok(!ids(alternating(three)).includes('mine_coal'))
})

test('failures older than the window, or with different results, do not count toward the window', () => {
  const aged = [f('mine_coal'), f('mine_coal'), f('wait', 'ok'), f('wait', 'ok'), f('wait', 'ok'), f('wait', 'ok'), f('mine_coal'), f('wait', 'ok')]
  assert.ok(ids(alternating(aged)).includes('mine_coal'))   // only one mine_coal failure is within the last 6
  const mixed = [f('mine_coal'), f('wait', 'ok'), f('mine_coal', 'timeout'), f('wait', 'ok'), f('mine_coal', 'target_gone'), f('wait', 'ok')]
  assert.ok(ids(alternating(mixed)).includes('mine_coal'))
})

test('the window can withhold several options at once but never wait', () => {
  const o = baseObs({ inventory: { wooden_pickaxe: 1 }, blocks: [coal, { name: 'stone', dist: 3, dir: 'south', dy: 0, reachable: true }] })
  const recent = [f('mine_coal'), f('mine_stone'), f('mine_coal'), f('mine_stone'), f('mine_coal'), f('mine_stone')]
  const got = ids({ ...o, last: { ...recent.at(-1), repeats: 1, recent } })
  assert.ok(!got.includes('mine_coal') && !got.includes('mine_stone') && got.includes('wait'))
  const waits = [f('wait', 'interrupted'), f('wait', 'interrupted'), f('wait', 'interrupted')]
  assert.ok(ids(baseObs({ last: { ...waits.at(-1), repeats: 3, recent: waits } })).includes('wait'))
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

// Live retry session (2026-09-27): explore_toward(cave) -> ok (at the cave) 7 times in 7 s while health drained near
// lava; the breaker counted only failures. An ok with the same detail OK_LOOP_N times within OK_LOOP_S seconds with no
// progress between the first and the last (the same inventory, within OK_LOOP_M metres, the same goal step) is a loop.
import { okLoop, progressMark, OK_LOOP_N, OK_LOOP_S, OK_LOOP_M } from '../agent/subtasks.js'
test('okLoop: an ok result repeated without progress is withheld; any inventory, position or step change is progress', () => {
  assert.equal(OK_LOOP_N, 5); assert.equal(OK_LOOP_S, 10); assert.equal(OK_LOOP_M, 2)
  const cave = { name: 'cave', dist: 3, dir: 'north', dy: 0 }
  const mark = (t, extra = {}) => ({ t, x: 10, y: 64, z: 10, inv: 'cobblestone:4', step: 3, ...extra })
  const at = (t, extra, detail = 'at the cave') => ({ id: 'explore_toward(cave)', result: 'ok', detail, ...mark(t, extra) })
  const loop = [1, 2, 3, 4, 5].map(t => at(t))
  assert.deepEqual([...okLoop(loop)], ['explore_toward(cave)'])
  const obsWith = recent => baseObs({ inventory: { wooden_pickaxe: 1 }, blocks: [cave], last: { ...recent.at(-1), repeats: 1, recent } })
  assert.ok(!ids(obsWith(loop)).includes('explore_toward(cave)'), 'withheld from the options')
  assert.ok(ids(obsWith(loop.slice(1))).includes('explore_toward(cave)'), 'four times is not yet a loop')
  assert.equal(okLoop([...loop.slice(0, 4), at(12)]).size, 0, 'spread over more than 10 s')
  assert.equal(okLoop([...loop.slice(0, 4), at(5, { inv: 'cobblestone:5' })]).size, 0, 'the inventory changed')
  assert.equal(okLoop([...loop.slice(0, 4), at(5, { x: 12.5 })]).size, 0, 'moved more than 2 m')
  assert.equal(okLoop([...loop.slice(0, 4), at(5, { x: 11.5 })]).size, 1, 'moved 1.5 m: still no progress')
  assert.equal(okLoop([...loop.slice(0, 4), at(5, { step: 4 })]).size, 0, 'the goal step moved on')
  assert.equal(okLoop([...loop.slice(0, 4), at(5, {}, 'other detail')]).size, 0, 'a different detail')
  assert.equal(okLoop(loop.map(e => ({ ...e, id: 'wait' }))).size, 0, 'wait is never withheld')
  assert.equal(okLoop([{ id: 'mine_stone', result: 'ok' }, { id: 'mine_stone', result: 'ok' }, { id: 'mine_stone', result: 'ok' }, { id: 'mine_stone', result: 'ok' }, { id: 'mine_stone', result: 'ok' }]).size, 0,
    'entries without marks (older logs) never count')
  // the mark the runner records
  const m = progressMark({ t: 7, pos: { x: 1.26, y: 64, z: -3.5 }, inventory: { stick: 2, cobblestone: 4, dirt: 0 }, goalStep: { index: 105 } })
  assert.deepEqual(m, { t: 7, x: 1.26, y: 64, z: -3.5, inv: 'cobblestone:4,stick:2', step: 105 })
})
