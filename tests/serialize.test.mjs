import test from 'node:test'
import assert from 'node:assert/strict'
import { serialize } from '../agent/serialize.js'
import { baseObs } from './fixtures.mjs'

test('golden state text for the spec example', () => {
  const o = baseObs({
    day: 0, timeOfDay: 8800, phase: 'afternoon', secondsToDusk: 160, biome: 'forest', pos: { x: 40, y: 71, z: -37 }, skyLight: 15,
    health: 16, food: 13, inventory: { stone_pickaxe: 1, wooden_pickaxe: 1, cobblestone: 14, oak_planks: 9, coal: 3, bread: 2, crafting_table: 1 },
    holding: 'stone_pickaxe', toolWear: { stone_pickaxe: 40 },
    base: { crafting_table: { dist: 38, dir: 'east', dy: -2 }, furnace: { dist: 38, dir: 'east', dy: -2 } },
    memory: { ironSeen: { dist: 55, dir: 'west', dy: -12, agoS: 180, where: 'a cave mouth' }, lastPath: 'ok', deaths: 0, heading: 'west' },
    blocks: [{ name: 'cave', dist: 22, dir: 'west', dy: 0, reachable: false }, { name: 'coal_ore', dist: 6, dir: 'north', dy: 0, reachable: true }, { name: 'stone', dist: 4, dir: 'south', dy: 0, reachable: true }],
    entities: [{ name: 'cow', kind: 'passive', dist: 12, dir: 'north-east', dy: 0 }],
    current: { name: 'explore_toward', arg: 'cave', elapsedS: 14, progress: 0.6 }, last: { id: 'mine_coal', result: 'ok' },
  })
  assert.equal(serialize(o), [
    'Minecraft survival, day 1. Goal: get an iron pickaxe (step 5 of 7: find and mine 3 iron ore).',
    'time: afternoon, dusk in 2 min 40 s. weather clear. biome: forest.',
    'you: health 16/20, food 13/20, standing on grass at y 71, in the open, light 15.',
    'inventory: stone pickaxe (worn 40%), wooden pickaxe, 14 cobblestone, 9 planks, 3 coal, 2 bread, crafting table. no iron yet.',
    'holding: stone pickaxe.',
    'base: crafting table and furnace 38 m east, 2 m below you. bed: none.',
    'memory: iron ore seen 3 min ago in a cave mouth 55 m west, 12 m below you; path last tried: ok. died: never.',
    'nearby blocks: cave entrance 22 m west (dark inside); coal ore 6 m north, reachable; exposed stone 4 m south, reachable.',
    'nearby creatures: cow 12 m north-east (passive); nearest hostile: none within 32 m.',
    'current subtask: explore toward cave, 14 s so far, 60% of the way. last subtask result: mine coal ok.',
  ].join('\n'))
})

test('empty world and inventory still serializes every line', () => {
  const text = serialize(baseObs())
  assert.equal(text.split('\n').length, 10)
  assert.match(text, /step 1 of 7: gather wood/)
  assert.match(text, /^inventory: nothing\. no iron yet\.$/m)
  assert.match(text, /^holding: nothing\.$/m)
  assert.match(text, /^base: none yet\. bed: none\.$/m)
  assert.match(text, /^memory: no iron seen yet\. died: never\.$/m)
  assert.match(text, /^nearby blocks: none of note\.$/m)
  assert.match(text, /^nearby creatures: nearest hostile: none within 32 m\.$/m)
  assert.match(text, /^current subtask: none\.$/m)
  assert.ok(!text.includes('<|') && !text.includes('|>'))
})

test('night, underground, hostile near, deaths and raw iron read as words', () => {
  const text = serialize(baseObs({ phase: 'night', timeOfDay: 18000, secondsToDusk: null, secondsToMorning: 300, skyLight: 0, blockLight: 3, underground: true,
    inventory: { stone_pickaxe: 1, raw_iron: 2 }, memory: { ironSeen: null, lastPath: 'no_path', deaths: 2, heading: 'north' },
    entities: [{ name: 'zombie', kind: 'hostile', dist: 6, dir: 'west', dy: 0 }], nearestHostile: { name: 'zombie', dist: 6, dir: 'west', dy: 0 },
    current: { name: 'mine_iron', arg: null, elapsedS: 3, progress: null }, last: { id: 'explore_toward(down)', result: 'no_path' } }))
  assert.match(text, /^time: night, morning in 5 min\. weather clear\. biome: forest\.$/m)
  assert.match(text, /underground, light 3\./)
  assert.match(text, /^inventory: stone pickaxe, 2 raw iron\. 2 raw iron, no ingots yet\.$/m)
  assert.match(text, /path last tried: no path\. died: 2 times\./)
  assert.match(text, /^nearby creatures: zombie 6 m west \(hostile\); nearest hostile: zombie 6 m west\.$/m)
  assert.match(text, /^current subtask: mine iron, 3 s so far\. last subtask result: explore toward\(down\) no path\.$/m)
})

test('goal done reads as survive until morning', () => {
  assert.match(serialize(baseObs({ inventory: { iron_pickaxe: 1 } })), /^Minecraft survival, day 1\. Goal: iron pickaxe done; survive until morning\.$/m)
})

test('crowded scene stays under 1400 characters', () => {
  const blocks = Array.from({ length: 20 }, (_, i) => ({ name: i % 2 ? 'stone' : 'oak_log', dist: 3 + i, dir: 'north', dy: 0, reachable: true }))
  const entities = Array.from({ length: 10 }, (_, i) => ({ name: i % 3 ? 'zombie' : 'cow', kind: i % 3 ? 'hostile' : 'passive', dist: 5 + i, dir: 'south', dy: 0 }))
  const inventory = { stone_pickaxe: 1, wooden_pickaxe: 1, cobblestone: 40, oak_planks: 12, stick: 8, coal: 5, raw_iron: 2, crafting_table: 1, furnace: 1, dirt: 20, oak_log: 6, bread: 3, rotten_flesh: 4 }
  const text = serialize(baseObs({ blocks, entities, inventory, nearestHostile: { name: 'zombie', dist: 6, dir: 'south', dy: 0 },
    memory: { ironSeen: { dist: 55, dir: 'west', dy: -12, agoS: 180, where: 'a cave mouth' }, lastPath: 'ok', deaths: 3, heading: 'west' },
    base: { crafting_table: { dist: 38, dir: 'east', dy: -2 }, furnace: { dist: 60, dir: 'north', dy: 5 } },
    current: { name: 'explore_toward', arg: 'surface', elapsedS: 33, progress: 0.4 }, last: { id: 'craft(stone_pickaxe)', result: 'no_materials' } }))
  assert.ok(text.length < 1400, `${text.length} chars`)
})

// ---- chain mode (goal 'nether') --------------------------------------------------------------------------------
const chainObs = () => baseObs({ goal: 'nether', inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_ingot: 3, stick: 2 }, armor: { iron_helmet: 1 },
  blocks: [{ name: 'diamond_ore', dist: 12, dir: 'west', dy: -3, reachable: false }] })

test('chain golden: goal-chain first line, worn armor, diamond ore', () => {
  const text = serialize(chainObs())
  assert.equal(text.split('\n')[0], 'Minecraft survival, day 1. Goal chain: iron tools (done), iron armor (1 of 4 pieces), diamond tools, lit nether portal. Current stage: iron armor, step 23 of 47: get 19 iron ingots (have 3).')
  assert.ok(text.split('\n').includes('wearing: iron helmet.'), text)
  const lines = text.split('\n')
  assert.equal(lines[lines.indexOf('wearing: iron helmet.') - 1].startsWith('holding: '), true)
  assert.ok(text.includes('diamond ore 12 m west, 3 m below you'), text)
})

test('chain mode: armor in head-to-feet order, remembered diamond/lava/water, new block words', () => {
  const text = serialize(baseObs({ goal: 'nether', inventory: { iron_pickaxe: 1, diamond_pickaxe: 1 }, armor: { iron_boots: 1, iron_helmet: 1 },
    memory: { ironSeen: null, lastPath: 'ok', deaths: 0, heading: 'north', diamondSeen: { dist: 40, dir: 'west', dy: -30, agoS: 120 }, lavaSeen: null, waterSeen: { dist: 20, dir: 'south', dy: 0, agoS: 30 } },
    blocks: [{ name: 'gravel', dist: 3, dir: 'north', dy: 0, reachable: true }, { name: 'obsidian', dist: 5, dir: 'east', dy: 0, reachable: true }, { name: 'nether_portal', dist: 8, dir: 'east', dy: 0, reachable: false }] }))
  assert.match(text, /^wearing: iron helmet, iron boots\.$/m)
  assert.match(text, /^inventory: diamond pickaxe, iron pickaxe\./m)
  assert.match(text, /^memory: no iron seen yet; diamond ore seen 2 min ago 40 m west, 30 m below you; water seen 30 s ago 20 m south; path last tried: ok\. died: never\.$/m)
  assert.match(text, /gravel 3 m north, reachable; obsidian 5 m east, reachable; nether portal 8 m east/)
})

test('experiment-1 mode never prints armor or the extra memory', () => {
  const text = serialize(baseObs({ armor: { iron_helmet: 1 }, memory: { ironSeen: null, lastPath: null, deaths: 0, heading: 'north', diamondSeen: { dist: 40, dir: 'west', dy: -30, agoS: 120 }, lavaSeen: null, waterSeen: null } }))
  assert.ok(!text.includes('wearing'))
  assert.ok(!text.includes('diamond'))
  assert.equal(text.split('\n').length, 10)
})

test('in water reads even underground, and low air is said in words', () => {
  const you = o => serialize(baseObs(o)).split('\n').find(l => l.startsWith('you:'))
  assert.match(you({ underground: true, inWater: true, skyLight: 0 }), /, underground, in water, light/)
  assert.match(you({ inWater: true, oxygen: 20 }), /, in water, light/)
  assert.match(you({ inWater: true, oxygen: 6 }), /, in water, running out of air, light/)
  assert.match(you({ underground: true, skyLight: 0 }), /, underground, light/)
})

test('a blueprint goal on top adds its line after the goal line; without one nothing changes', () => {
  const o = baseObs({ goal: 'nether' })
  const plain = serialize(o)
  const line = 'building hut (#4): layer 2 of 3, 41 of 96 blocks, 3 unreachable, need 12 cobblestone'
  const lines = serialize({ ...o, blueprintLine: line }).split('\n')
  assert.equal(lines[1], `${line}.`)
  assert.deepEqual([lines[0], ...lines.slice(2)], plain.split('\n'))
  assert.equal(serialize({ ...o, blueprintLine: null }), plain)
  assert.equal(serialize({ ...o, blueprintLine: '' }), plain)
  const exp1 = serialize({ ...baseObs(), blueprintLine: 'digging strip mine (#5): segment 3 of 4, 22 of 30 cells' }).split('\n')
  assert.equal(exp1[1], 'digging strip mine (#5): segment 3 of 4, 22 of 30 cells.')
  assert.equal(exp1.length, 11)
})
