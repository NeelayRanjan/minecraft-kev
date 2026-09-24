import test from 'node:test'
import assert from 'node:assert/strict'
import { techStep, teacherSubtask, teacherThreat } from '../agent/teacher.js'
import { options } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

const log = { name: 'oak_log', dist: 10, dir: 'north', dy: 0, reachable: true }
const stone = { name: 'stone', dist: 5, dir: 'south', dy: -1, reachable: true }
const table = { crafting_table: { dist: 2, dir: 'east', dy: 0 }, furnace: null }

test('steps follow the tech tree', () => {
  assert.equal(techStep(baseObs()).index, 1)
  assert.equal(techStep(baseObs({ inventory: { oak_log: 5 } })).index, 2)
  assert.equal(techStep(baseObs({ inventory: { oak_log: 3, crafting_table: 1 } })).index, 3)
  assert.equal(techStep(baseObs({ inventory: { oak_log: 3 }, base: table })).index, 3)
  assert.equal(techStep(baseObs({ inventory: { wooden_pickaxe: 1 } })).index, 4)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1 } })).index, 5)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3 } })).index, 6)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1, iron_ingot: 3 } })).index, 7)
  assert.equal(techStep(baseObs({ inventory: { iron_pickaxe: 1 } })).index, 8)
  assert.equal(techStep(baseObs()).of, 7)
  assert.equal(techStep(baseObs({ inventory: { stone_pickaxe: 1 } })).text, 'find and mine 3 iron ore')
})

test('no tree in sight: explore the surface, never wait', () => {
  assert.equal(teacherSubtask(baseObs()), 'explore_toward(surface)')
})

test('step 1 gathers wood when a log is visible', () => {
  assert.equal(teacherSubtask(baseObs({ blocks: [log] })), 'gather_wood')
})

test('step 2-3 crafts planks, table, sticks, wooden pickaxe in order', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 5 } })), 'craft(planks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 4, oak_planks: 4 } })), 'craft(crafting_table)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 4, crafting_table: 1 } })), 'craft(planks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 3, oak_planks: 4, crafting_table: 1 } })), 'craft(sticks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 3, oak_planks: 4, stick: 4, crafting_table: 1 } })), 'craft(wooden_pickaxe)')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_log: 3, oak_planks: 2, stick: 4, crafting_table: 1 } })), 'craft(planks)')
})

test('step 4 mines stone then crafts the stone pickaxe', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2 }, blocks: [stone] })), 'mine_stone')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2 } })), 'explore_toward(down)')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, stick: 2, cobblestone: 11 }, base: table })), 'craft(stone_pickaxe)')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, cobblestone: 11, oak_planks: 2 }, base: table })), 'craft(sticks)')
  assert.equal(teacherSubtask(baseObs({ inventory: { wooden_pickaxe: 1, cobblestone: 11, stick: 2, oak_planks: 4 } })), 'craft(crafting_table)')
})

test('step 5 prefers visible iron, then coal, then furnace stone, then digging down', () => {
  const iron = { name: 'iron_ore', dist: 8, dir: 'west', dy: -2, reachable: true }
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1 }, blocks: [iron, stone] })), 'mine_iron')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1 }, blocks: [{ name: 'coal_ore', dist: 6, dir: 'west', dy: 0, reachable: true }, stone] })), 'mine_coal')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, cobblestone: 2 }, blocks: [stone] })), 'mine_stone')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, cobblestone: 9, coal: 1 }, blocks: [stone] })), 'explore_toward(down)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, cobblestone: 9, coal: 1 }, blocks: [{ name: 'cave', dist: 10, dir: 'west', dy: 0, reachable: false }] })), 'explore_toward(cave)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1 }, memory: { ironSeen: { dist: 30, dir: 'west', dy: -5, agoS: 60 }, lastPath: null, deaths: 0, heading: 'north' } })), 'mine_iron')
})

test('step 6-7 furnace, smelt, iron pickaxe', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, cobblestone: 9, coal: 1, crafting_table: 1 } })), 'craft(furnace)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, cobblestone: 2, coal: 1 }, blocks: [stone] })), 'mine_stone')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, coal: 1, furnace: 1 } })), 'smelt(iron_ingot)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, furnace: 1, oak_log: 1 } })), 'smelt(iron_ingot)')  // a log is furnace fuel
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3, furnace: 1 }, blocks: [log] })), 'gather_wood')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, iron_ingot: 3, stick: 2, crafting_table: 1 } })), 'craft(iron_pickaxe)')
  assert.equal(teacherSubtask(baseObs({ inventory: { stone_pickaxe: 1, iron_ingot: 3, oak_planks: 2, crafting_table: 1 } })), 'craft(sticks)')
})

test('after the goal: shelter at night on the surface, otherwise wait', () => {
  assert.equal(teacherSubtask(baseObs({ inventory: { iron_pickaxe: 1, cobblestone: 4 }, phase: 'night' })), 'build_shelter')
  assert.equal(teacherSubtask(baseObs({ inventory: { iron_pickaxe: 1, cobblestone: 4 }, phase: 'night', underground: true })), 'wait')
  assert.equal(teacherSubtask(baseObs({ inventory: { iron_pickaxe: 1 } })), 'wait')
})

test('threat rules', () => {
  const z = (d, over = {}) => baseObs({ nearestHostile: { name: 'zombie', dist: d, dir: 'west', dy: 0 }, inventory: { cobblestone: 5 }, ...over })
  assert.equal(teacherThreat(z(6)), 'fight')
  assert.equal(teacherThreat(z(14)), 'ignore')
  assert.equal(teacherThreat(baseObs({ nearestHostile: { name: 'creeper', dist: 6, dir: 'west', dy: 0 } })), 'flee')
  assert.equal(teacherThreat(baseObs({ health: 6, nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 } })), 'flee')
  assert.equal(teacherThreat(baseObs({ nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 },
    entities: [1, 2, 3].map(i => ({ name: 'zombie', kind: 'hostile', dist: 4 + i, dir: 'west', dy: 0 })), inventory: { cobblestone: 5 } })), 'pillar_up')
  assert.equal(teacherThreat(baseObs({ nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 },
    entities: [1, 2, 3].map(i => ({ name: 'zombie', kind: 'hostile', dist: 4 + i, dir: 'west', dy: 0 })) })), 'flee')
  assert.equal(teacherThreat(baseObs()), 'ignore')
  assert.equal(teacherSubtask(z(6)), 'fight(threat)')
  assert.equal(teacherSubtask(z(14, { blocks: [log] })), 'gather_wood')  // 14 m away is ignored; carry on
})

test('hunger beats the tech tree when food is on hand', () => {
  assert.equal(teacherSubtask(baseObs({ food: 5, inventory: { bread: 1, oak_log: 5 } })), 'eat')
})

test('teacher pick is always an offered option', () => {
  const cases = [baseObs(), baseObs({ blocks: [log] }), baseObs({ inventory: { oak_log: 5 } }), baseObs({ inventory: { wooden_pickaxe: 1 } }),
    baseObs({ inventory: { stone_pickaxe: 1 }, pos: { x: 0, y: 12, z: 0 } }), baseObs({ inventory: { iron_pickaxe: 1 }, phase: 'night' }),
    baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 3 } }), baseObs({ inventory: { oak_planks: 3 } }),
    baseObs({ inventory: { wooden_pickaxe: 1, cobblestone: 3 } }), baseObs({ nearestHostile: { name: 'creeper', dist: 3, dir: 'east', dy: 0 } })]
  for (const o of cases) assert.ok(options(o).some(x => x.id === teacherSubtask(o)), `${teacherSubtask(o)} not offered`)
})
