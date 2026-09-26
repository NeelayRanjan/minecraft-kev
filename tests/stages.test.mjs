import test from 'node:test'
import assert from 'node:assert/strict'
import { stageOf, needs, chainStep, describeChain, STAGES } from '../agent/stages.js'
import { baseObs } from './fixtures.mjs'

const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const ironKit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
const armorKit = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
const diamondKit = { diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }

test('stages advance with the inventory and worn armor', () => {
  assert.equal(stageOf(chain()).index, 0)
  assert.equal(stageOf(chain({ inventory: { iron_pickaxe: 1 } })).index, 1)
  assert.equal(stageOf(chain({ inventory: ironKit })).index, 2)
  assert.equal(stageOf(chain({ inventory: { ...ironKit, iron_helmet: 1 }, armor: { iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 } })).index, 3)   // worn pieces count
  assert.equal(stageOf(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit })).index, 4)
  assert.equal(stageOf(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit, portalLit: true })).done, true)
})

test('needs counts ingots for the missing items of the current stage only', () => {
  const n = needs(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 1, stick: 1 } }))
  assert.deepEqual(n.missing, ['iron_sword', 'iron_axe'])
  assert.equal(n.ingots, 5 - 1)
  assert.equal(n.sticks, 3 - 1)
  const a = needs(chain({ inventory: ironKit, armor: { iron_helmet: 1 } }))
  assert.equal(a.ingots, 8 + 7 + 4)
  const d = needs(chain({ inventory: { ...ironKit, diamond: 2 }, armor: armorKit }))
  assert.equal(d.diamonds, 8 - 2)
  const p = needs(chain({ inventory: { ...ironKit, ...diamondKit, obsidian: 4, bucket: 1 }, armor: armorKit }))
  assert.equal(p.obsidian, 6); assert.equal(p.ingots, 1); assert.equal(p.flint, 1)
})

test('chainStep is monotone across the chain and reuses the tech tree in stage 0', () => {
  assert.equal(chainStep(chain()).index, 1)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1 } })).index, 11)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 5, stick: 3 } })).index, 12)
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 3, stick: 2 } })).index, 14)   // one tool owned (k=1), the axe craftable
  assert.equal(chainStep(chain({ inventory: ironKit })).index, 21)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: 70, z: 0 } })).index, 31)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: -58, z: 0 } })).index, 32)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit })).index, 41)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, water_bucket: 1 }, armor: armorKit })).index, 43)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, obsidian: 10, flint_and_steel: 1 }, armor: armorKit })).index, 46)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit, portalLit: true })).index, 48)
  // the review's regressions: a crafted item never drops the step, enough diamonds above y -50 is the craft, a
  // complete frame is 47 and a build in progress 46 whatever the buckets hold
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1 } })).index, 13)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: { iron_helmet: 1 } })).index, 23)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, diamond: 3, stick: 2 }, armor: armorKit, pos: { x: 0, y: 70, z: 0 } })).index, 33)
  const kit4 = { ...ironKit, ...diamondKit, flint_and_steel: 1, bucket: 1 }
  assert.equal(chainStep(chain({ inventory: kit4, armor: armorKit, portalFrame: true })).index, 47)
  assert.equal(chainStep(chain({ inventory: { ...kit4, obsidian: 4 }, armor: armorKit, memory: { portal: { placed: 6 } } })).index, 46)
  // losing items drops the step; the labeler treats that as "not advanced"
  assert.ok(chainStep(chain({ inventory: ironKit })).index > chainStep(chain({ inventory: { iron_pickaxe: 1 } })).index)
})

test('the "get N iron ingots" text is gross (still-to-craft cost), not needs().ingots\' net-of-held figure', () => {
  // needs().ingots is net of held ingots (pinned above); the chainStep text must show the total the stage
  // still needs to end up with, i.e. net + held, so "have H" reads against the same N a player would recognise.
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 1 } })).text, 'get 5 iron ingots (have 1)')
  const a = chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_ingot: 3 }, armor: { iron_helmet: 1 } })
  assert.equal(chainStep(a).text, 'get 19 iron ingots (have 3)')   // chestplate+leggings+boots = 8+7+4 = 19, the stage's gross target
})

test('describeChain reads as one line', () => {
  const s = describeChain(chain({ inventory: { ...ironKit, iron_ingot: 3 }, armor: { iron_helmet: 1, iron_chestplate: 1 } }))
  assert.match(s, /^Goal chain: iron tools \(done\), iron armor \(2 of 4 pieces\), diamond tools, lit nether portal\. Current stage: iron armor, step 2[0-9] of 47: /)
  assert.equal(STAGES.length, 5)
})

test('chainStep never goes backwards along the intended progression', () => {
  const deep = { x: 0, y: -58, z: 0 }, high = { x: 0, y: 70, z: 0 }
  const allTools = { ...ironKit, ...diamondKit }
  const seq = [
    ['iron pickaxe', { inventory: { iron_pickaxe: 1 } }],
    ['2 ingots', { inventory: { iron_pickaxe: 1, iron_ingot: 2, stick: 3 } }],
    ['sword', { inventory: { iron_pickaxe: 1, iron_sword: 1, stick: 2 } }],
    ['3 ingots', { inventory: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 3, stick: 2 } }],
    ['axe', { inventory: ironKit }],
    ['5 ingots', { inventory: { ...ironKit, iron_ingot: 5 } }],
    ['helmet', { inventory: ironKit, armor: { iron_helmet: 1 } }],
    ['8 ingots', { inventory: { ...ironKit, iron_ingot: 8 }, armor: { iron_helmet: 1 } }],
    ['chestplate', { inventory: ironKit, armor: { iron_helmet: 1, iron_chestplate: 1 } }],
    ['7 ingots', { inventory: { ...ironKit, iron_ingot: 7 }, armor: { iron_helmet: 1, iron_chestplate: 1 } }],
    ['leggings', { inventory: ironKit, armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1 } }],
    ['4 ingots', { inventory: { ...ironKit, iron_ingot: 4 }, armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1 } }],
    ['boots, on the surface', { inventory: ironKit, armor: armorKit, pos: high }],
    ['diamond level', { inventory: ironKit, armor: armorKit, pos: deep }],
    ['3 diamonds', { inventory: { ...ironKit, diamond: 3, stick: 5 }, armor: armorKit, pos: deep }],
    ['diamond pickaxe, climbed back up', { inventory: { ...ironKit, diamond_pickaxe: 1, stick: 3 }, armor: armorKit, pos: high }],
    ['2 diamonds', { inventory: { ...ironKit, diamond_pickaxe: 1, diamond: 2, stick: 3 }, armor: armorKit, pos: deep }],
    ['diamond sword', { inventory: { ...ironKit, diamond_pickaxe: 1, diamond_sword: 1, stick: 2 }, armor: armorKit, pos: deep }],
    ['3 more diamonds', { inventory: { ...ironKit, diamond_pickaxe: 1, diamond_sword: 1, diamond: 3, stick: 2 }, armor: armorKit, pos: high }],
    ['diamond axe', { inventory: allTools, armor: armorKit }],
    ['bucket', { inventory: { ...allTools, bucket: 1 }, armor: armorKit }],
    ['water bucket', { inventory: { ...allTools, water_bucket: 1 }, armor: armorKit }],
    ['3 obsidian, water taken back', { inventory: { ...allTools, water_bucket: 1, obsidian: 3 }, armor: armorKit }],
    ['6 obsidian, water lost', { inventory: { ...allTools, bucket: 1, obsidian: 6 }, armor: armorKit }],
    ['10 obsidian', { inventory: { ...allTools, water_bucket: 1, obsidian: 10 }, armor: armorKit }],
    ['flint', { inventory: { ...allTools, water_bucket: 1, obsidian: 10, flint: 1 }, armor: armorKit }],
    ['flint and steel', { inventory: { ...allTools, water_bucket: 1, obsidian: 10, flint_and_steel: 1, cobblestone: 4 }, armor: armorKit }],
    ['frame in progress', { inventory: { ...allTools, water_bucket: 1, obsidian: 4, flint_and_steel: 1 }, armor: armorKit, memory: { portal: { placed: 6 } } }],
    ['frame complete', { inventory: { ...allTools, water_bucket: 1, flint_and_steel: 1 }, armor: armorKit, memory: { portal: { placed: 10 } }, portalFrame: true }],
    ['lit', { inventory: { ...allTools, water_bucket: 1, flint_and_steel: 1 }, armor: armorKit, portalFrame: true, portalLit: true }],
  ]
  let prev = 0, prevName = 'start'
  for (const [name, over] of seq) {
    const s = chainStep(chain(over))
    assert.ok(s.index >= prev, `${prevName} (${prev}) -> ${name} (${s.index}: ${s.text})`)
    assert.ok(s.index <= 48)
    prev = s.index; prevName = name
  }
  assert.equal(prev, 48)
})
