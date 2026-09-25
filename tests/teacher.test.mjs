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

test('the tech step never falls just by walking away from the table', () => {
  const far = { crafting_table: { dist: 40, dir: 'east', dy: 0 }, furnace: null }
  assert.equal(techStep(baseObs({ inventory: { oak_log: 1 }, base: far })).index, 3)
  assert.equal(techStep(baseObs({ inventory: { oak_planks: 3, stick: 2 }, base: far })).index, 3)
})

test('far from the base with no spare table and not enough planks, the teacher returns to base', () => {
  const far = { crafting_table: { dist: 40, dir: 'east', dy: 0 }, furnace: null }
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_planks: 3, stick: 2 }, base: far })), 'return_to_base')
  assert.equal(teacherSubtask(baseObs({ inventory: { oak_planks: 8, stick: 2 }, base: far })), 'craft(crafting_table)')
})

test('threat teacher never asks to pillar up in water', () => {
  const o = baseObs({ inWater: true, nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 },
    entities: [1, 2, 3].map(i => ({ name: 'zombie', kind: 'hostile', dist: 4 + i, dir: 'west', dy: 0 })), inventory: { cobblestone: 5 } })
  assert.equal(teacherThreat(o), 'flee')
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

const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }, armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
test('chain teacher: crafts when it can, otherwise gets iron the same way as step 5-6', () => {
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 2, stick: 1, crafting_table: 1 } })), 'craft(iron_sword)')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1, raw_iron: 3, coal: 2, furnace: 1 } })), 'smelt(iron_ingot)')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1 }, blocks: [{ name: 'iron_ore', dist: 10, dir: 'north', dy: 0, reachable: true }] })), 'mine_iron')
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1 }, pos: { x: 0, y: 60, z: 0 } })), 'explore_toward(down)')
})
test('chain teacher: diamonds', () => {
  assert.equal(teacherSubtask(chain({ inventory: kit, armor, pos: { x: 0, y: 30, z: 0 } })), 'explore_toward(deep)')
  assert.equal(teacherSubtask(chain({ inventory: kit, armor, pos: { x: 0, y: -58, z: 0 }, blocks: [{ name: 'diamond_ore', dist: 8, dir: 'east', dy: 0, reachable: true }] })), 'mine_diamond')
  assert.equal(teacherSubtask(chain({ inventory: { ...kit, diamond: 3, stick: 2, crafting_table: 1 }, armor })), 'craft(diamond_pickaxe)')
})
test('chain teacher: portal', () => {
  const d = { ...kit, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
  assert.equal(teacherSubtask(chain({ inventory: { ...d, iron_ingot: 3, crafting_table: 1 }, armor })), 'craft(bucket)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, bucket: 1 }, armor, blocks: [{ name: 'water', dist: 6, dir: 'east', dy: 0, reachable: true }] })), 'fill_bucket(water)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, water_bucket: 1 }, armor, blocks: [{ name: 'lava', dist: 6, dir: 'east', dy: 0, reachable: true }] })), 'cast_obsidian')
  assert.equal(teacherSubtask(chain({ inventory: d, armor, blocks: [{ name: 'obsidian', dist: 3, dir: 'east', dy: 0, reachable: true }] })), 'mine_obsidian')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, iron_ingot: 1 }, armor, blocks: [{ name: 'gravel', dist: 5, dir: 'east', dy: 0, reachable: true }] })), 'mine_gravel')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, iron_ingot: 1, flint: 1, crafting_table: 1 }, armor })), 'craft(flint_and_steel)')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, obsidian: 10, cobblestone: 4, flint_and_steel: 1 }, armor })), 'build_portal')
  assert.equal(teacherSubtask(chain({ inventory: { ...d, flint_and_steel: 1 }, armor, portalFrame: { dist: 2, dir: 'north', dy: 0 } })), 'light_portal')
})
test('chain teacher: getIron and the diamond fallback only return offered ids (review fix round 1)', () => {
  // stage 1, raw iron on hand but no furnace, no cobblestone and no stone in view: mine_stone was never offered here.
  assert.equal(teacherSubtask(chain({ inventory: { iron_pickaxe: 1, raw_iron: 3 }, pos: { x: 0, y: 60, z: 0 } })), 'explore_toward(down)')
  // stage 3 at diamond level (y -58): explore_toward(deep) used to be gated to y > -50 in options(), so the
  // teacher's answer was never offered once the bot actually reached depth.
  assert.equal(teacherSubtask(chain({ inventory: kit, armor, pos: { x: 0, y: -58, z: 0 } })), 'explore_toward(deep)')
})
