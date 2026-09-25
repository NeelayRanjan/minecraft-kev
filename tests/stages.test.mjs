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
  assert.equal(chainStep(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 3, stick: 2 } })).index, 13)
  assert.equal(chainStep(chain({ inventory: ironKit })).index, 21)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: 70, z: 0 } })).index, 31)
  assert.equal(chainStep(chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: -58, z: 0 } })).index, 32)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit })).index, 41)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, water_bucket: 1 }, armor: armorKit })).index, 43)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit, obsidian: 10, flint_and_steel: 1 }, armor: armorKit })).index, 46)
  assert.equal(chainStep(chain({ inventory: { ...ironKit, ...diamondKit }, armor: armorKit, portalLit: true })).index, 48)
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
