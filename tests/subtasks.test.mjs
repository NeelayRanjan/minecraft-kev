import test from 'node:test'
import assert from 'node:assert/strict'
import { options, parseOption, optionId, counts } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

const ids = o => options(o).map(x => x.id)

test('optionId round-trips', () => {
  assert.equal(optionId('craft', 'wooden_pickaxe'), 'craft(wooden_pickaxe)')
  assert.deepEqual(parseOption('craft(wooden_pickaxe)'), { name: 'craft', arg: 'wooden_pickaxe' })
  assert.deepEqual(parseOption('wait'), { name: 'wait', arg: null })
})

test('wait and surface exploration are always offered; nothing else on an empty world with an empty inventory', () => {
  const o = ids(baseObs())
  assert.ok(o.includes('wait'))
  assert.ok(o.includes('explore_toward(surface)'))
  assert.ok(!o.includes('gather_wood'))
  assert.ok(!o.includes('mine_stone'))
  assert.ok(!o.includes('explore_toward(down)'))
})

test('gather_wood needs a log in view; craft(planks) needs a log in inventory', () => {
  assert.ok(ids(baseObs({ blocks: [{ name: 'oak_log', dist: 12, dir: 'north', dy: 0, reachable: true }] })).includes('gather_wood'))
  const o2 = ids(baseObs({ inventory: { oak_log: 2 } }))
  assert.ok(o2.includes('craft(planks)'))
  assert.ok(!o2.includes('craft(crafting_table)'))
})

test('table recipes need a table nearby or in inventory', () => {
  const inv = { oak_planks: 3, stick: 2 }
  assert.ok(!ids(baseObs({ inventory: inv })).includes('craft(wooden_pickaxe)'))
  assert.ok(ids(baseObs({ inventory: { ...inv, crafting_table: 1 } })).includes('craft(wooden_pickaxe)'))
  assert.ok(ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 3, dir: 'east', dy: 0 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
  assert.ok(!ids(baseObs({ inventory: inv, base: { crafting_table: { dist: 30, dir: 'east', dy: 0 }, furnace: null } })).includes('craft(wooden_pickaxe)'))
})

test('mining needs a pickaxe and the block in range; iron also accepts memory', () => {
  const stone = { name: 'stone', dist: 5, dir: 'south', dy: 0, reachable: true }
  assert.ok(!ids(baseObs({ blocks: [stone] })).includes('mine_stone'))
  assert.ok(ids(baseObs({ blocks: [stone], inventory: { wooden_pickaxe: 1 } })).includes('mine_stone'))
  assert.ok(!ids(baseObs({ inventory: { wooden_pickaxe: 1 }, memory: { ironSeen: { dist: 20, dir: 'west', dy: -5, agoS: 10 }, lastPath: null, deaths: 0, heading: 'north' } })).includes('mine_iron'))
  assert.ok(ids(baseObs({ inventory: { stone_pickaxe: 1 }, memory: { ironSeen: { dist: 20, dir: 'west', dy: -5, agoS: 10 }, lastPath: null, deaths: 0, heading: 'north' } })).includes('mine_iron'))
})

test('smelt needs raw iron, fuel and a furnace', () => {
  assert.ok(!ids(baseObs({ inventory: { raw_iron: 3, coal: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(ids(baseObs({ inventory: { raw_iron: 3, coal: 1, furnace: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(!ids(baseObs({ inventory: { raw_iron: 3, furnace: 1 } })).includes('smelt(iron_ingot)'))
  assert.ok(ids(baseObs({ inventory: { raw_iron: 3, oak_planks: 2, furnace: 1 } })).includes('smelt(iron_ingot)'))
})

test('threat options appear only with a hostile within 16 m; pillar_up needs blocks and a close threat', () => {
  const o = ids(baseObs({ nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 }, inventory: { cobblestone: 5 } }))
  assert.ok(o.includes('fight(threat)') && o.includes('flee(threat)') && o.includes('pillar_up'))
  assert.ok(!ids(baseObs({ nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 } })).includes('pillar_up'))
  assert.ok(!ids(baseObs({ nearestHostile: { name: 'zombie', dist: 20, dir: 'west', dy: 0 } })).includes('flee(threat)'))
  assert.ok(!ids(baseObs()).includes('flee(threat)'))
})

test('a player attacker with no hostile mob near offers flee, never fight; a hostile still offers both', () => {
  const o = ids(baseObs({ attacker: { kind: 'player', name: 'Spacers_Choice', dist: 2, sinceS: 3 } }))
  assert.ok(o.includes('flee(threat)'))
  assert.ok(!o.includes('fight(threat)'))
  assert.ok(!o.includes('pillar_up'), 'pillar_up is only offered against a nearby hostile mob')
  const both = ids(baseObs({ attacker: { kind: 'player', name: 'x', dist: 2, sinceS: 1 }, nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 } }))
  assert.ok(both.includes('fight(threat)') && both.includes('flee(threat)'))
  assert.ok(!ids(baseObs({ attacker: { kind: 'other', name: 'cow', dist: 2, sinceS: 1 } })).includes('flee(threat)'), 'a non-player, non-hostile attacker gets no threat options')
})

test('counts merges logs and planks of every wood', () => {
  const c = counts(baseObs({ inventory: { oak_log: 1, birch_log: 2, spruce_planks: 4, stick: 1 } }))
  assert.equal(c.logs, 3)
  assert.equal(c.planks, 4)
  assert.equal(c.sticks, 1)
})

test('every option carries a description', () => {
  const o = baseObs({ inventory: { stone_pickaxe: 1, raw_iron: 1, coal: 1, furnace: 1, oak_log: 1, oak_planks: 4, stick: 2, cobblestone: 8, crafting_table: 1 },
    blocks: [{ name: 'oak_log', dist: 3, dir: 'north', dy: 0, reachable: true }, { name: 'cave', dist: 10, dir: 'west', dy: 0, reachable: false }],
    nearestHostile: { name: 'zombie', dist: 5, dir: 'west', dy: 0 }, phase: 'night', food: 10 })
  for (const x of options(o)) assert.ok(typeof x.desc === 'string' && x.desc.length > 5, `${x.id} has no description`)
})

test('a supervisor-withheld option is dropped for the next decision; wait survives', () => {
  const o = baseObs({ blocks: [{ name: 'oak_log', dist: 12, dir: 'north', dy: 0, reachable: true }] })
  assert.ok(ids(o).includes('gather_wood'))
  assert.ok(!ids({ ...o, withhold: ['gather_wood'] }).includes('gather_wood'))
  assert.ok(ids({ ...o, withhold: ['wait'] }).includes('wait'))
})

const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
test('chain mode: iron tool and armor recipes are offered when the ingots are there and a table is near', () => {
  const o = chain({ inventory: { iron_pickaxe: 1, iron_ingot: 8, stick: 4, crafting_table: 1 } })
  const ids_ = ids(o)
  for (const id of ['craft(iron_sword)', 'craft(iron_axe)', 'craft(iron_helmet)']) assert.ok(ids_.includes(id), id)
  assert.ok(ids_.includes('craft(iron_chestplate)'), 'affordable with 8 ingots')
})
test('chain mode: diamond, gravel, obsidian and the portal steps follow their preconditions', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
  const armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  assert.ok(ids(chain({ inventory: kit, armor, pos: { x: 0, y: 40, z: 0 } })).includes('explore_toward(deep)'))
  assert.ok(ids(chain({ inventory: kit, armor, pos: { x: 0, y: -58, z: 0 } })).includes('explore_toward(deep)'), 'explore_toward(deep) stays offered at diamond level, not just above it')
  assert.ok(ids(chain({ inventory: kit, armor, blocks: [{ name: 'diamond_ore', dist: 9, dir: 'north', dy: 0, reachable: true }] })).includes('mine_diamond'))
  assert.ok(!ids(chain({ inventory: { stone_pickaxe: 1 }, blocks: [{ name: 'diamond_ore', dist: 9, dir: 'north', dy: 0, reachable: true }] })).includes('mine_diamond'), 'diamond needs an iron pickaxe')
  const d = { ...kit, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
  assert.ok(ids(chain({ inventory: { ...d, bucket: 1 }, armor, blocks: [{ name: 'water', dist: 6, dir: 'east', dy: 0, reachable: true }] })).includes('fill_bucket(water)'))
  assert.ok(ids(chain({ inventory: { ...d, water_bucket: 1 }, armor, blocks: [{ name: 'lava', dist: 6, dir: 'east', dy: 0, reachable: true }] })).includes('cast_obsidian'))
  assert.ok(ids(chain({ inventory: d, armor, blocks: [{ name: 'obsidian', dist: 3, dir: 'east', dy: 0, reachable: true }] })).includes('mine_obsidian'))
  assert.ok(ids(chain({ inventory: { ...d, obsidian: 4 }, armor, blocks: [{ name: 'gravel', dist: 5, dir: 'east', dy: 0, reachable: true }] })).includes('mine_gravel'))
  assert.ok(ids(chain({ inventory: { ...d, obsidian: 10, cobblestone: 4, flint_and_steel: 1 }, armor })).includes('build_portal'))
  assert.ok(ids(chain({ inventory: { ...d, flint_and_steel: 1 }, armor, portalFrame: { dist: 2, dir: 'north', dy: 0 } })).includes('light_portal'))
})
test('chain mode: an interrupted frame build stays offered with the obsidian still missing; no light before the frame is complete', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
  const armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  const memory = { portal: { origin: { x: 0, y: 64, z: 0 }, axis: 'x', placed: 6 } }
  const inBuild = over => chain({ armor, memory, portalFrame: null, ...over })
  assert.ok(ids(inBuild({ inventory: { ...kit, obsidian: 4, flint_and_steel: 1 } })).includes('build_portal'), '6 placed + 4 held')
  assert.ok(!ids(inBuild({ inventory: { ...kit, obsidian: 3, flint_and_steel: 1 } })).includes('build_portal'), '6 placed + 3 held is short')
  assert.ok(!ids(inBuild({ inventory: { ...kit, obsidian: 4, flint_and_steel: 1 } })).includes('light_portal'), 'no complete frame yet')
  assert.ok(!ids(chain({ inventory: { ...kit, obsidian: 10, flint_and_steel: 1 }, armor })).includes('build_portal'), 'a fresh frame needs 4 corner blocks')
})
test('chain mode keeps the stage-0 mine_iron cap; from stage 1, needs().ingots (net of held ingots) is compared against raw iron alone', () => {
  const ironSeen = [{ name: 'iron_ore', dist: 10, dir: 'north', dy: 0, reachable: true }]
  assert.ok(ids(chain({ inventory: { stone_pickaxe: 1 }, blocks: ironSeen })).includes('mine_iron'), 'stage 0 in chain mode still offers mine_iron')
  assert.ok(ids(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 3 }, blocks: ironSeen })).includes('mine_iron'), 'stage 1: need 5 ingots, have 3, net 2 > 0 raw iron waiting to be smelted')
  assert.ok(!ids(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 3, raw_iron: 2 }, blocks: ironSeen })).includes('mine_iron'), 'stage 1: the net-2 need is already covered by 2 raw iron in hand')
  assert.ok(!ids(chain({ inventory: { iron_pickaxe: 1, iron_ingot: 5 }, blocks: ironSeen })).includes('mine_iron'), 'stage 1: 5 ingots already covers iron_sword + iron_axe (2+3)')
})
test('chain mode mine_diamond compares the already-net needs().diamonds against zero, not against held diamonds again', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
  const armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  const diamondSeen = [{ name: 'diamond_ore', dist: 9, dir: 'north', dy: 0, reachable: true }]
  assert.ok(ids(chain({ inventory: { ...kit, diamond: 4 }, armor, blocks: diamondSeen })).includes('mine_diamond'), 'stage 3: need 8 diamonds (3+2+3), have 4, net 4 > 0')
  assert.ok(!ids(chain({ inventory: { ...kit, diamond: 8 }, armor, blocks: diamondSeen })).includes('mine_diamond'), 'stage 3: 8 diamonds already covers all three diamond tools')
})
test('experiment-1 mode never offers chain options', () => {
  const o = baseObs({ inventory: { iron_pickaxe: 1, iron_ingot: 8, stick: 4, crafting_table: 1 } })
  assert.ok(!ids(o).some(id => id.includes('iron_sword') || id === 'mine_diamond'))
})
test('chain mode never offers a craft for an item already held or worn; craft(iron_pickaxe) only replaces a lost one', () => {
  const rich = { iron_ingot: 10, stick: 4, crafting_table: 1, diamond: 3 }
  assert.ok(!ids(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, ...rich } })).includes('craft(iron_sword)'), 'sword held')
  assert.ok(ids(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, ...rich } })).includes('craft(iron_axe)'), 'the axe is still missing')
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
  assert.ok(!ids(chain({ inventory: { ...kit, ...rich }, armor: { iron_helmet: 1 } })).includes('craft(iron_helmet)'), 'helmet worn')
  assert.ok(!ids(chain({ inventory: { ...kit, ...rich, water_bucket: 1 } })).includes('craft(bucket)'), 'a full bucket is a bucket')
  assert.ok(!ids(chain({ inventory: { iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, ...rich } })).includes('craft(iron_pickaxe)'), 'iron pickaxe broke, a diamond one is held')
  assert.ok(!ids(chain({ inventory: { ...kit, ...rich } })).includes('craft(iron_pickaxe)'), 'iron pickaxe held')
  assert.ok(ids(chain({ inventory: { stone_pickaxe: 1, iron_sword: 1, ...rich } })).includes('craft(iron_pickaxe)'), 'no iron or better pickaxe left: offered as a replacement')
})
test('chain mode never offers mine_obsidian against a frame being built or complete', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1, flint_and_steel: 1 }
  const armor = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  const blocks = [{ name: 'obsidian', dist: 3, dir: 'east', dy: 0, reachable: true }]
  const memory = { portal: { origin: { x: 0, y: 64, z: 0 }, axis: 'x', placed: 6 } }
  assert.ok(!ids(chain({ inventory: { ...kit, obsidian: 2 }, armor, blocks, memory })).includes('mine_obsidian'), 'build in progress')
  assert.ok(!ids(chain({ inventory: kit, armor, blocks, portalFrame: { dist: 2, dir: 'north', dy: 0 } })).includes('mine_obsidian'), 'frame complete')
})

// Round 2: the night protocol and the spare stone pickaxe (chain mode only).
const logSeen = { name: 'oak_log', dist: 12, dir: 'north', dy: 0, reachable: true }
const ironSeenB = { name: 'iron_ore', dist: 10, dir: 'north', dy: 0, reachable: true }
const stoneSeen = { name: 'stone', dist: 5, dir: 'south', dy: -1, reachable: true }
test('chain mode, night on the surface: surface work withheld; shelter, digging in, wait and threat responses offered', () => {
  const o = chain({ phase: 'night', secondsToDusk: null, inventory: { iron_pickaxe: 1, cobblestone: 4 }, blocks: [logSeen, ironSeenB, stoneSeen] })
  const i = ids(o)
  for (const id of ['gather_wood', 'explore_toward(surface)', 'mine_iron', 'mine_stone']) assert.ok(!i.includes(id), `${id} offered at night on the surface`)
  for (const id of ['build_shelter', 'explore_toward(down)', 'wait']) assert.ok(i.includes(id), `${id} not offered`)
  const t = ids({ ...o, nearestHostile: { name: 'zombie', dist: 7, dir: 'west', dy: 0 } })
  assert.ok(t.includes('flee(threat)') && t.includes('fight(threat)'))
  assert.ok(!ids({ ...o, phase: 'dusk' }).includes('gather_wood'), 'dusk counts as night')
})
test('chain mode, night underground: mining stays offered', () => {
  const o = chain({ phase: 'night', underground: true, skyLight: 0, pos: { x: 0, y: 30, z: 0 }, inventory: { iron_pickaxe: 1 }, blocks: [ironSeenB] })
  assert.ok(ids(o).includes('mine_iron'))
})
test('experiment-1 mode, night on the surface: options unchanged', () => {
  const o = baseObs({ phase: 'night', inventory: { stone_pickaxe: 1, cobblestone: 4 }, blocks: [logSeen, ironSeenB] })
  const i = ids(o)
  assert.ok(i.includes('gather_wood') && i.includes('mine_iron') && i.includes('explore_toward(surface)'))
  assert.ok(!ids(baseObs({ phase: 'afternoon', secondsToDusk: 45, inventory: { stone_pickaxe: 1, cobblestone: 4 } })).includes('build_shelter'))
})
test('chain mode, last minute before dusk on the surface: build_shelter offered early, nothing withheld', () => {
  const o = chain({ phase: 'afternoon', secondsToDusk: 45, inventory: { iron_pickaxe: 1, cobblestone: 4 }, blocks: [logSeen] })
  assert.ok(ids(o).includes('build_shelter'))
  assert.ok(ids(o).includes('gather_wood'))
  assert.ok(!ids({ ...o, secondsToDusk: 120 }).includes('build_shelter'))
})
test('chain mode: a spare stone pickaxe is offered at stage >= 1 when none is held', () => {
  const inv = { iron_pickaxe: 1, cobblestone: 3, stick: 2, crafting_table: 1 }
  assert.ok(ids(chain({ inventory: inv })).includes('craft(stone_pickaxe)'))
  assert.equal(ids(chain({ inventory: inv })).filter(id => id === 'craft(stone_pickaxe)').length, 1, 'offered once')
  assert.ok(!ids(chain({ inventory: { ...inv, stone_pickaxe: 1 } })).includes('craft(stone_pickaxe)'))
})

test('chain mode, night on the surface: surface work is withheld only when a refuge is offered (fix round 1)', () => {
  const bare = ids(chain({ phase: 'night', inventory: {}, blocks: [logSeen] }))
  assert.ok(bare.includes('gather_wood') && bare.includes('explore_toward(surface)'), 'no pickaxe, no blocks, no base: nothing withheld')
  const armed = ids(chain({ phase: 'night', inventory: { stone_pickaxe: 1, cobblestone: 4 }, blocks: [logSeen] }))
  assert.ok(!armed.includes('gather_wood') && armed.includes('build_shelter'))
  // a refuge the supervisor just withheld does not count
  const w = ids(chain({ phase: 'night', inventory: { iron_pickaxe: 1 }, pos: { x: 0, y: 10, z: 0 }, blocks: [logSeen] }))
  assert.ok(w.includes('gather_wood'), 'too deep for explore_toward(down), no blocks, no base')
})
test('chain mode: build_shelter by hand on dirt/grass/sand with a block and no pickaxe; experiment 1 unchanged', () => {
  const hand = ids(chain({ phase: 'night', standingOn: 'grass_block', inventory: { dirt: 2 }, blocks: [logSeen] }))
  assert.ok(hand.includes('build_shelter') && !hand.includes('gather_wood'))
  assert.ok(!ids(chain({ phase: 'night', standingOn: 'stone', inventory: { dirt: 2 } })).includes('build_shelter'), 'stone needs a pickaxe')
  assert.ok(!ids(baseObs({ phase: 'night', standingOn: 'grass_block', inventory: { dirt: 2 } })).includes('build_shelter'), 'experiment 1 keeps the pickaxe rule')
})

test('low air (10/20 or less) offers only the ways out and the threat responses (not eat: it would be interrupted at once); wait always', () => {
  const log = { name: 'oak_log', dist: 5, dir: 'north', dy: 0, reachable: true }
  const ids = o => options(baseObs(o)).map(x => x.id)
  const low = ids({ oxygen: 8, inWater: true, blocks: [log], inventory: { stone_pickaxe: 1, bread: 2 }, food: 10,
    nearestHostile: { name: 'drowned', dist: 6, dir: 'west', dy: 0 } })
  assert.ok(!low.includes('gather_wood') && !low.includes('explore_toward(down)'), low.join(' '))
  for (const id of ['wait', 'explore_toward(surface)', 'fight(threat)', 'flee(threat)']) assert.ok(low.includes(id), id)
  assert.ok(!low.includes('eat'), 'eat is not an escape')
  assert.ok(ids({ oxygen: 8, blocks: [log] }).includes('wait'))
  assert.ok(ids({ oxygen: 11, blocks: [log] }).includes('gather_wood'))
  assert.ok(ids({ blocks: [log] }).includes('gather_wood'))   // no reading: full air (stored records)
  assert.ok(ids({ goal: 'nether', oxygen: 8, blocks: [log] }).every(id => ['wait', 'explore_toward(surface)'].includes(id)))
})
