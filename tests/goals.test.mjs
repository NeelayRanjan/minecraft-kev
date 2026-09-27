import test from 'node:test'
import assert from 'node:assert/strict'
import { GoalStack, GOAL_KINDS, validateGoal, DECLARED_FINDABLE, FINDABLE_NOW, RECIPES } from '../agent/goals.js'
import { chainStep, describeChain } from '../agent/stages.js'
import { techStep, teacherSubtask } from '../agent/teacher.js'
import { options } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'
import mcDataFor from 'minecraft-data'

const chain = over => baseObs({ goal: 'nether', armor: {}, portalLit: false, ...over })
const ironKit = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }
const armorKit = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
const diamondKit = { diamond_pickaxe: 1, diamond_sword: 1, diamond_axe: 1 }
const allTools = { ...ironKit, ...diamondKit }
const deep = { x: 0, y: -58, z: 0 }, high = { x: 0, y: 70, z: 0 }
const table = { crafting_table: { dist: 3 }, furnace: { dist: 4 } }
const stone = [{ name: 'stone', dist: 3 }], logs = [{ name: 'oak_log', dist: 10 }]

// The chain fixtures of tests/stages.test.mjs (plus a few with blocks, a base, a hostile and night) for byte identity.
const CHAIN_FIXTURES = [
  {}, { inventory: { oak_log: 3 }, blocks: logs }, { inventory: { oak_planks: 8, stick: 2 }, base: table, blocks: stone },
  { inventory: { iron_pickaxe: 1 } },
  { inventory: { iron_pickaxe: 1, iron_ingot: 2, stick: 3 }, base: table },
  { inventory: { iron_pickaxe: 1, iron_sword: 1, stick: 2 } },
  { inventory: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 3, stick: 2 }, base: table },
  { inventory: ironKit }, { inventory: { ...ironKit, iron_ingot: 5 } },
  { inventory: ironKit, armor: { iron_helmet: 1 } },
  { inventory: { ...ironKit, iron_ingot: 8 }, armor: { iron_helmet: 1 }, base: table },
  { inventory: ironKit, armor: armorKit, pos: high }, { inventory: ironKit, armor: armorKit, pos: deep },
  { inventory: { ...ironKit, diamond: 3, stick: 5 }, armor: armorKit, pos: deep, base: table },
  { inventory: { ...allTools, bucket: 1 }, armor: armorKit },
  { inventory: { ...allTools, water_bucket: 1, obsidian: 3 }, armor: armorKit },
  { inventory: { ...allTools, water_bucket: 1, obsidian: 10, flint_and_steel: 1, cobblestone: 4 }, armor: armorKit },
  { inventory: { ...allTools, water_bucket: 1, flint_and_steel: 1 }, armor: armorKit, memory: { portal: { placed: 10 } }, portalFrame: true },
  { inventory: { ...allTools, water_bucket: 1, flint_and_steel: 1 }, armor: armorKit, portalFrame: true, portalLit: true },
  { inventory: { iron_pickaxe: 1, cobblestone: 5 }, nearestHostile: { name: 'zombie', dist: 6 }, entities: [{ kind: 'hostile', dist: 6 }] },
  { inventory: { iron_pickaxe: 1, cobblestone: 5 }, phase: 'night', blocks: stone },
].map(chain)

test('the default nether stack is the chain, byte for byte', () => {
  for (const o of CHAIN_FIXTURES) {
    const s = new GoalStack({ goal: 'nether' })
    assert.equal(s.top().kind, 'chain')
    assert.deepEqual(s.step(o), { ...chainStep(o), goal_id: 0 })
    assert.equal(s.describe(o), describeChain(o))
    const opts = options(o)
    assert.deepEqual(s.filter(o, opts), opts)
    assert.equal(s.teacher(o), teacherSubtask(o))
    assert.deepEqual(s.update(o, 1000), [])
  }
})

test('the default iron_pickaxe stack is experiment 1 (describe null: serialize keeps its text)', () => {
  for (const over of [{}, { inventory: { oak_log: 6 }, blocks: logs }, { inventory: { stone_pickaxe: 1 }, blocks: stone }, { inventory: { iron_pickaxe: 1 } }]) {
    const o = baseObs(over)
    const s = new GoalStack({ goal: 'iron_pickaxe' })
    assert.equal(s.top().kind, 'iron_pickaxe')
    assert.deepEqual(s.step(o), { ...techStep(o), goal_id: 0 })
    assert.equal(s.describe(o), null)
    assert.deepEqual(s.filter(o, options(o)), options(o))
    assert.equal(s.teacher(o), teacherSubtask(o))
  }
})

test('push gather(cobblestone, 8): described, filtered, done at 8, pops back to the chain', () => {
  const s = new GoalStack({ goal: 'nether' })
  const g = s.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:alice', t: 0 })
  assert.equal(g.id, 1)
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 3, oak_planks: 8, stick: 2 }, base: table, blocks: [...stone, ...logs] })
  assert.match(s.describe(o), /^Goal from the audience \(alice\): gather 8 cobblestone \(have 3\)\. Then: Goal chain: /)
  assert.ok(s.describe(o).endsWith(describeChain(o)))
  const st = s.step(o)
  assert.equal(st.goal_id, 1)
  assert.ok(st.index > 100 && st.index < 200)
  assert.match(st.text, /gather 8 cobblestone \(have 3\)/)
  const opts = options(o), ids = opts.map(x => x.id)
  assert.ok(ids.includes('craft(sticks)') && ids.includes('gather_wood') && ids.includes('craft(stone_pickaxe)'))
  const kept = s.filter(o, opts).map(x => x.id)
  assert.ok(kept.includes('mine_stone') && kept.includes('wait') && kept.includes('explore_toward(surface)'))
  for (const dropped of ['craft(sticks)', 'gather_wood', 'craft(stone_pickaxe)', 'craft(crafting_table)']) assert.ok(!kept.includes(dropped), dropped)
  assert.equal(s.teacher(o), 'mine_stone')
  assert.deepEqual(s.update(o, 5), [])
  const full = chain({ ...o, inventory: { ...o.inventory, cobblestone: 8 } })
  const ev = s.update(full, 10)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'goal_done')
  assert.deepEqual(ev[0].goal, { kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:alice', id: 1 })
  assert.equal(ev[0].t, 10)
  assert.equal(s.top().kind, 'chain')
  assert.deepEqual(s.step(full), { ...chainStep(full), goal_id: 0 })
})

test('stuck: a goal that can never complete pops after stuckS without step progress (Review Focus 2)', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'diamond', count: 64, source: 'audience:bob', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1 } })
  assert.equal(GOAL_KINDS.gather.stuckS('diamond', 64), 600)
  assert.deepEqual(s.update(o, 0), [])
  assert.deepEqual(s.update(o, 599), [])
  const ev = s.update(o, 600)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'goal_failed')
  assert.equal(ev[0].reason, 'stuck')
  assert.equal(s.top().kind, 'chain')
})

test('step progress resets the stuck timer', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'leader', t: 0 })
  const have = n => chain({ inventory: { iron_pickaxe: 1, cobblestone: n }, blocks: stone })
  assert.deepEqual(s.update(have(0), 0), [])
  assert.deepEqual(s.update(have(2), 200), [])   // fifths: 2 of 8 advances the step
  assert.deepEqual(s.update(have(2), 450), [])
  assert.equal(s.update(have(2), 500)[0].kind, 'goal_failed')
})

test('step is based by depth, goal_id increments per push, and the default is never popped', () => {
  const s = new GoalStack({ goal: 'nether' })
  const o = chain({ inventory: { iron_pickaxe: 1 }, base: { crafting_table: { dist: 40 }, furnace: null } })
  s.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'leader', t: 0 })
  s.push({ kind: 'go_to', arg: 'base', source: 'leader', t: 0 })
  const st = s.step(o)
  assert.equal(st.goal_id, 2)
  assert.ok(st.index > 200 && st.index < 300)
  assert.match(s.describe(o), /^Goal from the leader: go to base\. Then: Goal from the leader: gather 8 cobblestone \(have 0\)\. Then: Goal chain/)
  assert.equal(s.pop('leader').kind, 'go_to')
  assert.equal(s.step(o).goal_id, 1)
  assert.equal(s.pop('leader').kind, 'gather')
  assert.equal(s.pop('leader'), null)
  assert.equal(s.top().kind, 'chain')
  s.push({ kind: 'return_to_base', source: 'leader', t: 0 })
  assert.equal(s.step(o).goal_id, 3)
})

test('the filter never removes wait or threat responses and never adds options', () => {
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 5, oak_planks: 8 }, base: table, blocks: stone,
    nearestHostile: { name: 'zombie', dist: 6 }, entities: [{ kind: 'hostile', dist: 6 }] })
  const opts = options(o), ids = new Set(opts.map(x => x.id))
  for (const g of [{ kind: 'gather', arg: 'diamond', count: 3 }, { kind: 'craft_item', arg: 'iron_sword' }, { kind: 'find', arg: 'lava' },
    { kind: 'go_to', arg: 'surface' }, { kind: 'build', arg: 'portal_frame' }, { kind: 'survive_night' }, { kind: 'return_to_base' }]) {
    const s = new GoalStack({ goal: 'nether' })
    s.push({ ...g, source: 'leader', t: 0 })
    const kept = s.filter(o, opts).map(x => x.id)
    for (const id of kept) assert.ok(ids.has(id), `${g.kind} added ${id}`)
    for (const id of ['wait', 'fight(threat)', 'flee(threat)', 'pillar_up']) assert.ok(kept.includes(id), `${g.kind} dropped ${id}`)
  }
})

test('craft_item: ingredients and their producers stay, the rest goes; teacher crafts when it can', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'craft_item', arg: 'iron_sword', source: 'leader', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1, stone_pickaxe: 1, raw_iron: 2, coal: 2, oak_log: 2, cobblestone: 10 }, base: table,
    blocks: [...stone, ...logs, { name: 'iron_ore', dist: 12 }] })
  const kept = s.filter(o, options(o)).map(x => x.id)
  for (const id of ['smelt(iron_ingot)', 'craft(planks)', 'wait']) assert.ok(kept.includes(id), id)
  // 2 raw iron already cover the sword's 2 ingots, a furnace and a table are near: no mining, no furnace, no stone
  for (const id of ['mine_iron', 'craft(furnace)', 'mine_stone', 'gather_wood']) assert.ok(options(o).some(x => x.id === id) && !kept.includes(id), id)
  assert.equal(s.teacher(o), 'smelt(iron_ingot)')
  assert.match(s.step(o).text, /iron sword/)
  const ready = chain({ inventory: { iron_pickaxe: 1, iron_ingot: 2, stick: 1 }, base: table })
  assert.equal(s.teacher(ready), 'craft(iron_sword)')
  assert.ok(s.step(ready).index > s.step(o).index)
  assert.equal(s.update(chain({ inventory: { iron_pickaxe: 1, iron_sword: 1 } }), 5)[0].kind, 'goal_done')
})

test('craft_item done counts worn armor; teacher is null when its pick is not offered', () => {
  assert.equal(GOAL_KINDS.craft_item.done(chain({ armor: { iron_helmet: 1 } }), 'iron_helmet'), true)
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'flint', count: 1, source: 'leader', t: 0 })
  // no gravel in sight: the teacher wants explore_toward(surface), which the night protocol withholds on the surface at night
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 5 }, phase: 'night' })
  assert.ok(!options(o).some(x => x.id === 'explore_toward(surface)'))
  assert.equal(s.teacher(o), 'build_shelter')
  const day = chain({ inventory: { iron_pickaxe: 1 } })
  assert.equal(s.teacher(day), 'explore_toward(surface)')
  // go_to(diamond_level) with no pickaxe: explore_toward(down) is not offered, so the teacher has nothing (the runner falls back)
  const g = new GoalStack({ goal: 'nether' })
  g.push({ kind: 'go_to', arg: 'diamond_level', source: 'leader', t: 0 })
  assert.equal(g.teacher(chain({})), null)
})

test('done predicates of the other kinds', () => {
  const K = GOAL_KINDS
  assert.equal(K.find.done(chain({ blocks: [{ name: 'lava', dist: 12 }] }), 'lava'), true)
  assert.equal(K.find.done(chain({ blocks: [{ name: 'lava', dist: 20 }] }), 'lava'), false)
  assert.equal(K.find.done(chain({ blocks: [{ name: 'deepslate_diamond_ore', dist: 5 }] }), 'diamond_ore'), true)
  assert.equal(K.find.done(chain({ blocks: [{ name: 'bell', dist: 9 }] }), 'village'), true)
  assert.equal(K.go_to.done(chain({ base: table }), 'base'), true)
  assert.equal(K.go_to.done(chain({ underground: true }), 'surface'), false)
  assert.equal(K.go_to.done(chain({ pos: deep }), 'diamond_level'), true)
  assert.equal(K.survive_night.done(chain({ phase: 'night' })), false)
  assert.equal(K.survive_night.done(chain({ phase: 'morning' })), true)
  assert.equal(K.return_to_base.done(chain({ base: { crafting_table: { dist: 7 } } })), false)
  assert.equal(K.build.done(chain({ portalFrame: true }), 'portal_frame'), true)
  assert.equal(K.gather.done(chain({ inventory: { oak_log: 2, birch_log: 3 } }), 'oak_log', 5), true)
  assert.equal(K.gather.done(chain({ inventory: { oak_planks: 2, spruce_planks: 2 } }), 'planks', 4), true)
  assert.equal(K.survive_night.stuckS, Infinity)
})

test('validateGoal against the declared vocabularies', () => {
  assert.deepEqual(validateGoal({ kind: 'gather', arg: 'iron_ingot', count: 5 }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'craft_item', arg: 'iron_sword' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'find', arg: 'diamond_ore' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'go_to', arg: 'surface' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'build', arg: 'portal_frame' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'survive_night' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'return_to_base' }), { ok: true })
  for (const bad of [{ kind: 'find', arg: 'village_house' }, { kind: 'find', arg: 'village' }, { kind: 'build', arg: 'house' },
    { kind: 'chain' }, { kind: 'iron_pickaxe' }, { kind: 'teleport' }, { kind: 'craft_item', arg: 'netherite_sword' },
    { kind: 'gather', arg: 'cobblestone', count: 0 }, { kind: 'gather', arg: 'cobblestone', count: 65 }, { kind: 'gather', arg: 'cobblestone' },
    { kind: 'gather', arg: 'ender_pearl', count: 3 }, { kind: 'go_to', arg: 'nether' }]) {
    const r = validateGoal(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.equal(typeof r.reason, 'string')
  }
  assert.equal(validateGoal({ kind: 'build', arg: 'house' }).reason, 'no executor yet')
  assert.ok(DECLARED_FINDABLE.includes('village') && !FINDABLE_NOW.includes('village'))
  assert.equal(RECIPES.iron_axe.iron_ingot, 3)
  assert.throws(() => new GoalStack({ goal: 'nether' }).push({ kind: 'build', arg: 'house', source: 'leader', t: 0 }))
})

test('survive_night pushed by day is done at once; by night it waits for morning', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'survive_night', source: 'leader', t: 0 })
  assert.equal(s.update(chain({ phase: 'night' }), 100).length, 0)
  assert.equal(s.update(chain({ phase: 'night' }), 5000).length, 0)   // no stuck rule
  assert.equal(s.update(chain({ phase: 'morning' }), 5001)[0].kind, 'goal_done')
})

// ---- final review fixes: clamps, stage gates, the night rule (I2) and the go_to filters (M-c) -----------------------
import { nightBlocksGoal, nightPaused, GATHER_CAPS } from '../agent/goals.js'

test('validateGoal clamps gather counts to the option layer caps and says so', () => {
  assert.deepEqual(GATHER_CAPS, { log: 12, cobblestone: 32, obsidian: 10 })
  for (const [arg, n, cap] of [['log', 20, 12], ['birch_log', 64, 12], ['cobblestone', 40, 32], ['obsidian', 14, 10]]) {
    const v = validateGoal({ kind: 'gather', arg, count: n })
    assert.equal(v.ok, true)
    assert.deepEqual(v.goal, { kind: 'gather', arg, count: cap })
    assert.match(v.note, new RegExp(`capped at ${cap}`))
  }
  assert.deepEqual(validateGoal({ kind: 'gather', arg: 'log', count: 12 }), { ok: true })   // at the cap: unchanged
  assert.deepEqual(validateGoal({ kind: 'gather', arg: 'coal', count: 64 }), { ok: true })  // no cap
  const s = new GoalStack({ goal: 'nether' })
  assert.equal(s.push({ kind: 'gather', arg: 'cobblestone', count: 64, source: 'leader', t: 0 }).count, 32)
})

test('validateGoal stage gates (with obs): flint at stage 4 only, diamonds from stage 3 (after the iron pickaxe)', () => {
  const st0 = chain({}), st1 = chain({ inventory: { iron_pickaxe: 1 } })
  const st3 = chain({ inventory: ironKit, armor: armorKit })
  const st4 = chain({ inventory: allTools, armor: armorKit })
  for (const goal of [{ kind: 'gather', arg: 'diamond', count: 3 }, { kind: 'go_to', arg: 'diamond_level' }, { kind: 'find', arg: 'diamond_ore' }]) {
    const r0 = validateGoal(goal, st0)
    assert.equal(r0.ok, false, JSON.stringify(goal)); assert.equal(r0.reason, 'needs an iron pickaxe first')
    assert.equal(validateGoal(goal, st1).ok, false); assert.match(validateGoal(goal, st1).reason, /armor first/)
    assert.equal(validateGoal(goal, st3).ok, true)
    assert.equal(validateGoal(goal).ok, true, 'without obs the gates are not checked')
  }
  assert.equal(validateGoal({ kind: 'gather', arg: 'flint', count: 1 }, st3).ok, false)
  assert.equal(typeof validateGoal({ kind: 'gather', arg: 'flint', count: 1 }, st3).reason, 'string')
  assert.equal(validateGoal({ kind: 'gather', arg: 'flint', count: 1 }, st4).ok, true)
  assert.throws(() => new GoalStack({ goal: 'nether' }).push({ kind: 'go_to', arg: 'diamond_level', t: 0, obs: st0 }))
})

test('night rule for pushes: gather, find and go_to(surface) at dusk/night on the surface wait for morning', () => {
  const night = chain({ phase: 'night' }), dusk = chain({ phase: 'dusk' }), below = chain({ phase: 'night', underground: true }), day = chain({})
  for (const g of [{ kind: 'gather', arg: 'log', count: 1 }, { kind: 'find', arg: 'water' }, { kind: 'go_to', arg: 'surface' }]) {
    assert.equal(nightBlocksGoal(g, night), true); assert.equal(nightBlocksGoal(g, dusk), true)
    assert.equal(nightBlocksGoal(g, below), false); assert.equal(nightBlocksGoal(g, day), false)
  }
  for (const g of [{ kind: 'go_to', arg: 'base' }, { kind: 'survive_night' }, { kind: 'craft_item', arg: 'planks' }]) assert.equal(nightBlocksGoal(g, night), false)
})

test('night rule for the stuck clock: paused while the night protocol withholds every producer (r3 gather(log, 1))', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'log', count: 1, source: 'audience:bob', t: 0 })
  // r3: night on the surface, a table 31 m away, a tree in sight: gather_wood withheld, [return_to_base, wait] offered
  const night = chain({ phase: 'night', blocks: logs, base: { crafting_table: { dist: 31 }, furnace: null } })
  assert.deepEqual(s.filter(night, options(night)).map(o => o.id).sort(), ['return_to_base', 'wait'])
  assert.equal(nightPaused(night, s.filter(night, options(night))), true)
  assert.deepEqual(s.update(night, 0), [])
  assert.deepEqual(s.update(night, 1000), [])   // the whole night: no stuck pop
  const morning = chain({ phase: 'morning', base: { crafting_table: { dist: 31 }, furnace: null } })   // no tree in sight
  assert.deepEqual(s.update(morning, 1010), [])
  assert.deepEqual(s.update(morning, 1290), [])
  assert.equal(s.update(morning, 1300)[0]?.reason, 'stuck', 'the clock runs again by day: 300 s after the last night tick')
  // by day a producer is offered: never paused
  const day = chain({ blocks: logs })
  assert.equal(nightPaused(day, s.filter(day, options(day))), false)
})

test('go_to filters keep the night refuges on the surface at night and the surface climb under low air (M-c)', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'go_to', arg: 'diamond_level', t: 0 })
  const night = chain({ inventory: { ...ironKit, cobblestone: 5 }, armor: armorKit, phase: 'night', base: { crafting_table: { dist: 40 }, furnace: null } })
  const ids = s.filter(night, options(night)).map(o => o.id)
  assert.ok(ids.includes('explore_toward(down)') && ids.includes('return_to_base') && ids.includes('build_shelter'), ids.join(' '))
  const wet = chain({ inventory: ironKit, armor: armorKit, inWater: true, oxygen: 6 })
  assert.deepEqual(s.filter(wet, options(wet)).map(o => o.id).sort(), ['explore_toward(surface)', 'wait'])
  // the find(diamond_ore) teacher stays on explore_toward(deep) at diamond level (M-b)
  assert.equal(GOAL_KINDS.find.teacher(chain({ pos: deep }), 'diamond_ore'), 'explore_toward(deep)')
})

test('go_to(y:<n>): validateGoal parses -64..320; done, filter and teacher key off above/below', () => {
  assert.deepEqual(validateGoal({ kind: 'go_to', arg: 'y:12' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'go_to', arg: 'y:-58' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'go_to', arg: 'y:320' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'go_to', arg: 'y:-64' }), { ok: true })
  for (const bad of ['y:321', 'y:-65', 'y:', 'y:abc', 'y']) assert.equal(validateGoal({ kind: 'go_to', arg: bad }).ok, false, bad)

  const K = GOAL_KINDS.go_to
  assert.equal(K.done(chain({ pos: { x: 0, y: 12, z: 0 } }), 'y:12'), true)
  assert.equal(K.done(chain({ pos: { x: 0, y: 14, z: 0 } }), 'y:12'), true, 'within 2')
  assert.equal(K.done(chain({ pos: { x: 0, y: 20, z: 0 } }), 'y:12'), false)

  const above = chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: 20, z: 0 } })
  const below = chain({ inventory: ironKit, armor: armorKit, pos: { x: 0, y: 0, z: 0 }, underground: true, skyLight: 0 })
  const aboveIds = K.filter(above, 'y:12', options(above)).map(o => o.id)
  const belowIds = K.filter(below, 'y:12', options(below)).map(o => o.id)
  assert.ok(aboveIds.includes('explore_toward(deep)') || aboveIds.includes('explore_toward(down)'), aboveIds.join(' '))
  assert.ok(!aboveIds.includes('explore_toward(surface)'), aboveIds.join(' '))
  assert.ok(belowIds.includes('explore_toward(surface)'), belowIds.join(' '))
  assert.ok(!belowIds.includes('explore_toward(deep)') && !belowIds.includes('explore_toward(down)'), belowIds.join(' '))

  assert.equal(K.teacher(above, 'y:12'), 'explore_toward(deep)')
  assert.equal(K.teacher(below, 'y:12'), 'explore_toward(surface)')
  assert.equal(K.describe(above, 'y:12'), 'go to y 12')

  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'go_to', arg: 'y:12', source: 'leader', t: 0 })
  assert.equal(s.update(chain({ pos: { x: 0, y: 12, z: 0 } }), 5)[0].kind, 'goal_done')
})

// ---- Task 3: plans, new goal kinds, plan ids on the stack ---------------------------------------------------------
import { registerOptionProvider, pluginOptions } from '../agent/goals.js'
import { expandItem } from '../agent/recipes.js'

const opt = id => { const m = /^(\w+)(?:\((\w+)\))?$/.exec(id); return { id, name: m[1], arg: m[2] ?? null, desc: `plugin ${id}` } }
function withProvider(ids, fn) {
  registerOptionProvider(() => ids.map(opt))
  try { fn() } finally { registerOptionProvider(null) }
}

test('validateGoal: the new kinds and vocabularies', () => {
  for (const g of [{ kind: 'hunt', arg: 'white_wool', count: 3 }, { kind: 'smelt_item', arg: 'glass', count: 3 },
    { kind: 'receive', arg: 'redstone', count: 4, from: 'Spacers_Choice' }, { kind: 'go_to', arg: 'player:Spacers_Choice' },
    { kind: 'craft_item', arg: 'compass' }, { kind: 'craft_item', arg: 'oak_stairs', count: 4 }, { kind: 'gather', arg: 'redstone', count: 2 },
    { kind: 'gather', arg: 'oak_planks', count: 6 }, { kind: 'gather', arg: 'sand', count: 3 }])
    assert.deepEqual(validateGoal(g), { ok: true }, JSON.stringify(g))
  const reason = g => validateGoal(g).reason
  assert.equal(reason({ kind: 'hunt', arg: 'diamond', count: 1 }), 'hunt needs a hunted drop (white_wool, leather, ...)')
  assert.equal(reason({ kind: 'craft_item', arg: 'grass' }), 'unknown item grass')
  assert.equal(reason({ kind: 'craft_item', arg: 'short_grass' }), 'cannot craft short grass')
  assert.equal(reason({ kind: 'smelt_item', arg: 'diamond', count: 1 }), 'cannot smelt diamond')
  assert.equal(reason({ kind: 'receive', arg: 'redstone', count: 4 }), 'receive needs the name of the player giving it')
  assert.equal(reason({ kind: 'receive', arg: 'redstone', count: 4, from: 'bad name!' }), 'receive needs the name of the player giving it')
  assert.equal(reason({ kind: 'receive', arg: 'grass', count: 4, from: 'bob' }), 'unknown item grass')
  assert.equal(reason({ kind: 'go_to', arg: 'player:' }), 'cannot go to player:')
  assert.equal(reason({ kind: 'gather', arg: 'grass', count: 2 }), 'cannot gather grass')
  for (const g of [{ kind: 'hunt', arg: 'leather' }, { kind: 'smelt_item', arg: 'glass', count: 0 }, { kind: 'receive', arg: 'redstone', count: 65, from: 'bob' },
    { kind: 'craft_item', arg: 'compass', count: 0 }]) assert.equal(reason(g), 'count must be an integer from 1 to 64', JSON.stringify(g))
})

test('the option provider hook: default empty, a throwing provider is ignored', () => {
  assert.deepEqual(pluginOptions(chain({}), { kind: 'hunt', arg: 'white_wool', count: 3 }), [])
  registerOptionProvider(() => { throw new Error('boom') })
  try { assert.deepEqual(pluginOptions(chain({}), { kind: 'hunt', arg: 'white_wool', count: 3 }), []) } finally { registerOptionProvider(null) }
})

test('hunt(white_wool, 3): keeps hunt(sheep) from the provider, drops other work; done by the wool count', () => {
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 5 }, blocks: [...stone, ...logs] })
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'hunt', arg: 'white_wool', count: 3, source: 'leader', t: 0 })
  withProvider(['hunt(sheep)', 'hunt(cow)', 'mine(redstone_ore)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.ok(kept.includes('hunt(sheep)') && kept.includes('wait'), kept.join(' '))
    for (const id of ['hunt(cow)', 'mine(redstone_ore)', 'mine_stone', 'gather_wood']) assert.ok(!kept.includes(id), id)
    assert.equal(s.teacher(o), 'hunt(sheep)')
  })
  assert.equal(s.teacher(o), null, 'no provider: hunt(sheep) is not offered')
  assert.match(s.describe(o), /^Goal from the leader: shear sheep for 3 white wool \(have 0\)\./)
  assert.equal(s.step(o).index, 101)
  assert.equal(GOAL_KINDS.hunt.stuckS, 300)
  assert.equal(s.update(chain({ inventory: { white_wool: 3 } }), 5)[0].kind, 'goal_done')
})

test('smelt_item(glass, 3): furnace first, then fuel, then smelt; done by the count', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'smelt_item', arg: 'glass', count: 3, source: 'leader', t: 0 })
  const noFurnace = chain({ inventory: { iron_pickaxe: 1, cobblestone: 10, sand: 3, coal: 2 }, base: { crafting_table: { dist: 3 }, furnace: null }, blocks: stone })
  withProvider(['smelt_item(glass)', 'smelt_item(stone)'], () => {
    const kept = s.filter(noFurnace, options(noFurnace)).map(x => x.id)
    assert.ok(kept.includes('smelt_item(glass)') && kept.includes('craft(furnace)'), kept.join(' '))
    assert.ok(!kept.includes('smelt_item(stone)'))
    assert.equal(s.teacher(noFurnace), 'craft(furnace)')
    const noFuel = chain({ inventory: { iron_pickaxe: 1, sand: 3 }, base: table, blocks: [...logs, { name: 'coal_ore', dist: 8 }] })
    assert.equal(s.teacher(noFuel), 'mine_coal')
    const ready = chain({ inventory: { iron_pickaxe: 1, sand: 3, coal: 2 }, base: table })
    assert.equal(s.teacher(ready), 'smelt_item(glass)')
  })
  assert.equal(GOAL_KINDS.smelt_item.stuckS, 300)
  assert.equal(s.update(chain({ inventory: { glass: 3 } }), 5)[0].kind, 'goal_done')
})

test('receive(redstone, 4, from): only receive(redstone) and the always-kept options; from reaches pub', () => {
  const s = new GoalStack({ goal: 'nether' })
  const g = s.push({ kind: 'receive', arg: 'redstone', count: 4, from: 'Spacers_Choice', source: 'audience:Spacers_Choice', t: 0, plan_id: 7, step_index: 2 })
  assert.equal(g.from, 'Spacers_Choice'); assert.equal(g.plan_id, 7); assert.equal(g.step_index, 2)
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 5 }, blocks: [...stone, ...logs], base: { crafting_table: { dist: 30 }, furnace: null } })
  withProvider(['receive(redstone)', 'receive(coal)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.deepEqual(kept.filter(id => !['wait', 'eat', 'build_shelter'].includes(id)), ['receive(redstone)'])
    assert.equal(s.teacher(o), 'receive(redstone)')
  })
  assert.match(s.describe(o), /^Goal from the audience \(Spacers_Choice\): get 4 redstone from Spacers_Choice \(have 0\)\./)
  assert.equal(GOAL_KINDS.receive.stuckS, 90)
  const ev = s.update(chain({ inventory: { redstone: 4 } }), 5)
  assert.deepEqual(ev[0].goal, { kind: 'receive', arg: 'redstone', count: 4, source: 'audience:Spacers_Choice', id: 1, plan_id: 7, step_index: 2, from: 'Spacers_Choice' })
})

test('go_to(player:<name>): done within 3 m; filter go_to_player(<name>); stuck after 120 s', () => {
  const K = GOAL_KINDS.go_to
  assert.equal(K.done(chain({ players: { Spacers_Choice: { dist: 2.5 } } }), 'player:Spacers_Choice'), true)
  assert.equal(K.done(chain({ players: { Spacers_Choice: { dist: 10 } } }), 'player:Spacers_Choice'), false)
  assert.equal(K.done(chain({}), 'player:Spacers_Choice'), false)
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'go_to', arg: 'player:Spacers_Choice', source: 'leader', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1 }, blocks: [...stone, ...logs], base: { crafting_table: { dist: 30 }, furnace: null }, players: { Spacers_Choice: { dist: 40 } } })
  withProvider(['go_to_player(Spacers_Choice)', 'go_to_player(bob)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.deepEqual(kept.filter(id => !['wait', 'eat', 'build_shelter'].includes(id)), ['go_to_player(Spacers_Choice)'])
    assert.equal(s.teacher(o), 'go_to_player(Spacers_Choice)')
  })
  assert.match(s.describe(o), /^Goal from the leader: go to Spacers_Choice\./)
  assert.match(s.step(o).text, /Spacers_Choice \(40 m away\)/)
  assert.deepEqual(s.update(o, 0), [])
  assert.equal(s.update(o, 120)[0].reason, 'stuck')
  const keep = new GoalStack({ goal: 'nether' })
  keep.push({ kind: 'go_to', arg: 'base', source: 'leader', t: 0 })
  assert.deepEqual(keep.update(o, 0), []); assert.deepEqual(keep.update(o, 200), [], 'go_to(base) keeps 240 s')
})

test('craft_item(compass): a non-legacy recipe goes through the provider; done by count', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'craft_item', arg: 'oak_stairs', count: 4, source: 'leader', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1, oak_planks: 6 }, blocks: [...stone, ...logs], base: table })
  assert.equal(s.teacher(o), null)
  withProvider(['craft_item(oak_stairs)', 'craft_item(compass)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.ok(kept.includes('craft_item(oak_stairs)') && !kept.includes('craft_item(compass)'), kept.join(' '))
    assert.ok(kept.includes('gather_wood'), 'legacy gathering stays')
    assert.equal(s.teacher(o), 'craft_item(oak_stairs)')
  })
  assert.equal(GOAL_KINDS.craft_item.done(chain({ inventory: { oak_stairs: 3 } }), 'oak_stairs', 4), false)
  assert.equal(GOAL_KINDS.craft_item.done(chain({ inventory: { oak_stairs: 4 } }), 'oak_stairs', 4), true)
  assert.equal(GOAL_KINDS.craft_item.done(chain({ inventory: { compass: 1 } }), 'compass', null), true)
  assert.match(s.describe(o), /craft 4 oak stairs \(have 0\)/)
})

test('gather(redstone) through mine(<block>) plugin options; gather(oak_planks) counts that wood exactly', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'gather', arg: 'redstone', count: 2, source: 'leader', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1 }, blocks: [...stone, ...logs] })
  assert.equal(s.teacher(o), null)
  withProvider(['mine(sand)', 'mine(deepslate_redstone_ore)', 'mine(redstone_ore)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.ok(kept.includes('mine(redstone_ore)') && kept.includes('mine(deepslate_redstone_ore)') && !kept.includes('mine(sand)'), kept.join(' '))
    assert.ok(!kept.includes('mine_stone') && !kept.includes('gather_wood'))
    assert.equal(s.teacher(o), 'mine(deepslate_redstone_ore)')
  })
  const K = GOAL_KINDS.gather
  assert.equal(K.done(chain({ inventory: { oak_planks: 2, birch_planks: 6 } }), 'oak_planks', 4), false)
  assert.equal(K.done(chain({ inventory: { oak_planks: 4 } }), 'oak_planks', 4), true)
  const p = new GoalStack({ goal: 'nether' })
  p.push({ kind: 'gather', arg: 'oak_planks', count: 6, source: 'leader', t: 0 })
  const logsHeld = chain({ inventory: { iron_pickaxe: 1, oak_log: 2 }, blocks: [...stone, ...logs] })
  const kept = p.filter(logsHeld, options(logsHeld)).map(x => x.id)
  assert.ok(kept.includes('gather_wood') && kept.includes('craft(planks)') && !kept.includes('mine_stone'), kept.join(' '))
  assert.equal(p.teacher(logsHeld), 'craft(planks)')
  assert.equal(p.teacher(chain({ inventory: { iron_pickaxe: 1 }, blocks: [...stone, ...logs] })), 'gather_wood')
})

test('push keeps plan_id and step_index; pub shows them only for plan or receive goals', () => {
  const s = new GoalStack({ goal: 'nether' })
  const g = s.push({ kind: 'gather', arg: 'cobblestone', count: 8, source: 'plan', t: 0, plan_id: 3, step_index: 1 })
  assert.equal(g.plan_id, 3); assert.equal(g.step_index, 1)
  const ev = s.update(chain({ inventory: { cobblestone: 8 } }), 4)
  assert.deepEqual(ev[0].goal, { kind: 'gather', arg: 'cobblestone', count: 8, source: 'plan', id: 1, plan_id: 3, step_index: 1, from: null })
})

test('plugin-backed filters: under low air only the surface climb; at night on the surface the refuges stay', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'hunt', arg: 'leather', count: 2, source: 'leader', t: 0 })
  withProvider(['hunt(cow)'], () => {
    const wet = chain({ inventory: ironKit, armor: armorKit, inWater: true, oxygen: 6 })
    assert.deepEqual(s.filter(wet, options(wet)).map(o => o.id).sort(), ['explore_toward(surface)', 'wait'])
    const night = chain({ inventory: { iron_pickaxe: 1, cobblestone: 5 }, phase: 'night', base: { crafting_table: { dist: 40 }, furnace: null } })
    const ids = s.filter(night, options(night)).map(o => o.id)
    assert.ok(ids.includes('return_to_base') && ids.includes('build_shelter') && !ids.includes('hunt(cow)'), ids.join(' '))
  })
})

test('night rule for the plugin kinds: no surface plugin work at dusk/night on the surface, the stuck clock pauses; ore stays', () => {
  const provider = ['hunt(cow)', 'mine(sand)', 'mine(redstone_ore)']
  const night = chain({ inventory: { iron_pickaxe: 1 }, phase: 'night', base: { crafting_table: { dist: 31 }, furnace: null } })
  const dusk = chain({ inventory: { iron_pickaxe: 1 }, phase: 'dusk', base: { crafting_table: { dist: 31 }, furnace: null } })
  const below = chain({ inventory: { iron_pickaxe: 1 }, phase: 'night', underground: true, skyLight: 0 })
  const day = chain({ inventory: { iron_pickaxe: 1 } })
  withProvider(provider, () => {
    for (const [goal, id] of [[{ kind: 'hunt', arg: 'leather', count: 2 }, 'hunt(cow)'], [{ kind: 'gather', arg: 'sand', count: 4 }, 'mine(sand)']]) {
      const s = new GoalStack({ goal: 'nether' })
      s.push({ ...goal, source: 'leader', t: 0 })
      for (const o of [night, dusk]) {
        const f = s.filter(o, options(o))
        assert.ok(!f.some(x => x.id === id), `${id} at ${o.phase}`)
        assert.equal(nightPaused(o, f), true, `${goal.kind} paused at ${o.phase}`)
      }
      assert.deepEqual(s.update(night, 0), []); assert.deepEqual(s.update(night, 1000), [], `${goal.kind}: no stuck pop at night`)
      assert.ok(s.filter(below, options(below)).some(x => x.id === id), `${id} underground at night`)
      assert.ok(s.filter(day, options(day)).some(x => x.id === id), `${id} by day`)
    }
    const ore = new GoalStack({ goal: 'nether' })
    ore.push({ kind: 'gather', arg: 'redstone', count: 2, source: 'leader', t: 0 })
    assert.ok(ore.filter(night, options(night)).some(x => x.id === 'mine(redstone_ore)'), 'ore mining stays offered')
    assert.ok(ore.filter(below, options(below)).some(x => x.id === 'mine(redstone_ore)'))
  })
})

test('every step expandItem emits passes validateGoal', () => {
  for (const [item, n, inv] of [['compass', 1, {}], ['white_bed', 1, {}], ['clock', 1, {}], ['oak_stairs', 4, { birch_planks: 6 }], ['glass', 3, {}], ['torch', 4, {}]]) {
    const { steps, missing } = expandItem(item, n, inv)
    assert.deepEqual(missing, [], item)
    assert.ok(steps.length > 0, item)
    for (const st of steps) assert.deepEqual(validateGoal(st), { ok: true }, `${item}: ${JSON.stringify(st)} ${validateGoal(st).reason ?? ''}`)
  }
  assert.ok(expandItem('white_bed', 1, {}).steps.some(st => st.kind === 'hunt' && st.arg === 'white_wool'))
})

// ---- Task 8: plan steps are net need; the runner pushes an absolute count ------------------------------------------
import { goalHave, planStepGoal, pubGoal } from '../agent/goals.js'

test('goalHave: the same have the goal kind done() reads', () => {
  const o = chain({ inventory: { oak_planks: 3, birch_planks: 2, cobblestone: 5, redstone: 2, compass: 1, oak_log: 1 } })
  assert.equal(goalHave(o, 'gather', 'planks'), 5, 'generic planks: any wood')
  assert.equal(goalHave(o, 'gather', 'oak_planks'), 3, 'a species counted exactly')
  assert.equal(goalHave(o, 'gather', 'cobblestone'), 5)
  assert.equal(goalHave(o, 'receive', 'redstone'), 2)
  assert.equal(goalHave(o, 'craft_item', 'compass'), 1)
  assert.equal(goalHave(o, 'smelt_item', 'glass'), 0)
  assert.equal(goalHave(o, 'hunt', 'white_wool'), 0)
})

test('planStepGoal: count = have + need for the counted kinds, clamped to 64; other kinds unchanged', () => {
  const o = chain({ inventory: { cobblestone: 5, redstone: 2, oak_planks: 3, birch_planks: 9 } })
  assert.deepEqual(planStepGoal({ kind: 'gather', arg: 'cobblestone', count: 3 }, o), { kind: 'gather', arg: 'cobblestone', count: 8 })
  assert.deepEqual(planStepGoal({ kind: 'gather', arg: 'oak_planks', count: 4 }, o), { kind: 'gather', arg: 'oak_planks', count: 7 })
  assert.deepEqual(planStepGoal({ kind: 'receive', arg: 'redstone', count: 4, from: 'Steve' }, o), { kind: 'receive', arg: 'redstone', count: 6, from: 'Steve' })
  assert.deepEqual(planStepGoal({ kind: 'smelt_item', arg: 'glass', count: 63 }, chain({ inventory: { glass: 5 } })), { kind: 'smelt_item', arg: 'glass', count: 64 })
  assert.deepEqual(planStepGoal({ kind: 'craft_item', arg: 'compass', count: 1 }, o), { kind: 'craft_item', arg: 'compass', count: 1 })
  assert.deepEqual(planStepGoal({ kind: 'hunt', arg: 'white_wool', count: 3 }, chain({ inventory: { white_wool: 1 } })), { kind: 'hunt', arg: 'white_wool', count: 4 })
  assert.deepEqual(planStepGoal({ kind: 'go_to', arg: 'player:Steve', count: null }, o), { kind: 'go_to', arg: 'player:Steve', count: null })
  assert.deepEqual(planStepGoal({ kind: 'craft_item', arg: 'crafting_table', count: null }, o), { kind: 'craft_item', arg: 'crafting_table', count: null })
  // the pushed goal is not done at once (receive's plugin reads the absolute count)
  const s = new GoalStack({ goal: 'nether' })
  s.push({ ...planStepGoal({ kind: 'receive', arg: 'redstone', count: 4, from: 'Steve' }, o), source: 'audience:Steve', t: 0, obs: o, plan_id: 1, step_index: 0 })
  assert.deepEqual(s.update(o, 1), [])
  assert.deepEqual(pubGoal(s.top()), { kind: 'receive', arg: 'redstone', count: 6, source: 'audience:Steve', id: 1, plan_id: 1, step_index: 0, from: 'Steve' })
  assert.deepEqual(pubGoal(new GoalStack({ goal: 'nether' }).top()), { kind: 'chain', arg: null, count: null, source: 'chain', id: 0 })
})

test('plugin options go through the livelock breaker and the supervisor withhold (an instant failure is not re-offered)', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'go_to', arg: 'player:Steve', source: 'audience:Steve', t: 0 })
  const o = chain({ inventory: { iron_pickaxe: 1 } })
  withProvider(['go_to_player(Steve)'], () => {
    assert.ok(s.filter(o, options(o)).some(x => x.id === 'go_to_player(Steve)'))
    const failed = { ...o, last: { id: 'go_to_player(Steve)', result: 'player_gone', repeats: 3, recent: [] } }
    assert.ok(!s.filter(failed, options(failed)).some(x => x.id === 'go_to_player(Steve)'), 'three in a row: withheld')
    const window = { ...o, last: { id: 'wait', result: 'ok', repeats: 1, recent: ['player_gone', 'ok', 'player_gone', 'ok', 'player_gone'].map(r => ({ id: r === 'ok' ? 'wait' : 'go_to_player(Steve)', result: r })) } }
    assert.ok(!s.filter(window, options(window)).some(x => x.id === 'go_to_player(Steve)'), 'three in the window: withheld')
    const sup = { ...o, withhold: ['go_to_player(Steve)'] }
    assert.ok(!s.filter(sup, options(sup)).some(x => x.id === 'go_to_player(Steve)'), 'supervisor withhold')
  })
})

// Final review, Important 4: gather(<wood>_planks) crafts planks only from that species' logs.
test('gather(oak_planks): craft(planks) only with oak logs held; birch logs alone mean gather_wood', () => {
  const p = new GoalStack({ goal: 'nether' })
  p.push({ kind: 'gather', arg: 'oak_planks', count: 6, source: 'leader', t: 0 })
  assert.equal(p.teacher(chain({ inventory: { iron_pickaxe: 1, birch_log: 3 }, blocks: [...stone, ...logs] })), 'gather_wood')
  assert.equal(p.teacher(chain({ inventory: { iron_pickaxe: 1, birch_log: 3, oak_log: 1 }, blocks: [...stone, ...logs] })), 'craft(planks)')
})

// Final review, Important 3: goals the leader pushes get the plan steps' treatment: counted kinds convert their count to
// held + n, and a gather/craft_item outside the legacy tables whose prerequisites are missing becomes a plan.
import { routePush, checkPlanGates, placedStations } from '../agent/goals.js'
test('routePush: receive/hunt/smelt/non-legacy craft/MINE gather convert the count; missing prerequisites route to a plan', () => {
  const o = chain({ inventory: { redstone: 5, iron_pickaxe: 1, white_wool: 1, glass: 2, cobblestone: 7 } })
  assert.deepEqual(routePush({ kind: 'receive', arg: 'redstone', count: 4, from: 'Steve' }, o),
    { route: 'goal', goal: { kind: 'receive', arg: 'redstone', count: 9, from: 'Steve' } })
  assert.deepEqual(routePush({ kind: 'gather', arg: 'redstone', count: 4 }, o), { route: 'goal', goal: { kind: 'gather', arg: 'redstone', count: 9 } })
  assert.deepEqual(routePush({ kind: 'hunt', arg: 'leather', count: 2 }, o), { route: 'goal', goal: { kind: 'hunt', arg: 'leather', count: 2 } })
  assert.deepEqual(routePush({ kind: 'smelt_item', arg: 'glass', count: 3 }, o), { route: 'goal', goal: { kind: 'smelt_item', arg: 'glass', count: 5 } })
  // legacy kinds keep their absolute meaning (experiment 1 / chain unchanged)
  assert.deepEqual(routePush({ kind: 'gather', arg: 'cobblestone', count: 8 }, o), { route: 'goal', goal: { kind: 'gather', arg: 'cobblestone', count: 8 } })
  assert.deepEqual(routePush({ kind: 'craft_item', arg: 'iron_pickaxe', count: null }, o), { route: 'goal', goal: { kind: 'craft_item', arg: 'iron_pickaxe', count: null } })
  assert.deepEqual(routePush({ kind: 'go_to', arg: 'base', count: null }, o), { route: 'goal', goal: { kind: 'go_to', arg: 'base', count: null } })
  // gather(redstone) without the iron pickaxe: the expander's plan, never a bare goal that stalls 300 s
  const bare = chain({ inventory: {} })
  assert.deepEqual(routePush({ kind: 'gather', arg: 'redstone', count: 4 }, bare), { route: 'plan', item: 'redstone', count: 4 })
  // a craft with every ingredient held and a table near: a bare goal (count = held + n); missing ingredients: a plan
  const tbl = chain({ inventory: { iron_ingot: 4, redstone: 1, compass: 1 }, base: { crafting_table: { dist: 3 }, furnace: null } })
  assert.deepEqual(routePush({ kind: 'craft_item', arg: 'compass', count: 1 }, tbl), { route: 'goal', goal: { kind: 'craft_item', arg: 'compass', count: 2 } })
  assert.deepEqual(routePush({ kind: 'craft_item', arg: 'compass', count: 1 }, chain({ inventory: { compass: 1 } })), { route: 'plan', item: 'compass', count: 1 })
})

test('placedStations: a remembered table or furnace counts only within 32 m (as the motor walks to it)', () => {
  assert.deepEqual(placedStations(chain({ base: { crafting_table: { dist: 20 }, furnace: { dist: 50 } } })), { crafting_table: true, furnace: false })
  assert.deepEqual(placedStations(chain({ base: { crafting_table: null, furnace: null } })), { crafting_table: false, furnace: false })
  assert.deepEqual(placedStations(null), { crafting_table: false, furnace: false })
})

// Final review, Important 5: the plan backstop. Every step, once the steps before it are assumed done, passes
// validateGoal with obs; a gated step (diamond before iron armor, flint before stage 4) refuses the whole plan.
test('checkPlanGates: diamond_sword at stage 0 is refused with the stage reason; compass passes', () => {
  const o = chain({ inventory: {} })
  const sword = checkPlanGates(expandItem('diamond_sword', 1, {}).steps, o)
  assert.ok(sword && /iron armor/.test(sword.reason), JSON.stringify(sword))
  assert.equal(sword.step.arg, 'diamond')
  assert.equal(checkPlanGates(expandItem('compass', 1, {}).steps, o), null)
  const armored = chain({ inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }, armor: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 } })
  assert.equal(checkPlanGates(expandItem('diamond_sword', 1, armored.inventory).steps, armored), null)
})

test('every producible item from stage 0: each step validates, or the plan is refused only by a stage gate', () => {
  const o = chain({ inventory: {} })
  const md = mcDataFor('1.20.4')
  let refused = 0
  for (const { name } of md.itemsArray) {
    const { steps, missing } = expandItem(name, 1, {})
    if (missing.length || !steps.length) continue
    const r = checkPlanGates(steps, o)
    if (!r) continue
    refused++
    assert.ok(['diamond', 'flint', 'obsidian'].includes(r.step.arg) || (r.step.kind === 'find'), `${name}: ${JSON.stringify(r)}`)
  }
  assert.ok(refused > 0)
})

// ---- Blueprints Task 3: build(<bp id>) and dig(<bp id>) through a registered accessor -----------------------------
import { registerBlueprintAccessor } from '../agent/goals.js'

// A stub accessor: blueprints by id, progress from the obs field `bpProgress` (the test's stand-in for the world).
const BPS = { bp4: { id: 'bp4', kind: 'build', template: 'hut' }, bp5: { id: 'bp5', kind: 'dig', template: 'strip_mine' } }
const prog = over => ({ done: 29, total: 100, missing: 71, blocked: 0, layer: 1, layers: 4, segment: 1, segments: 1, finished: false,
  blocksDone: 0, blocksTotal: 71, needs: { cobblestone: 71 }, layerNeeds: { cobblestone: 15 }, surface: true, ...over })
function withBlueprints(fn) {
  registerBlueprintAccessor({ get: id => BPS[id] ?? null, progress: (id, obs) => BPS[id] ? obs.bpProgress?.[id] ?? null : null, advance: () => null })
  try { fn() } finally { registerBlueprintAccessor(null) }
}
const bpObs = (p, over = {}) => chain({ inventory: { stone_pickaxe: 1 }, blocks: [...stone, ...logs], bpProgress: p, ...over })

test('validateGoal: build and dig take a blueprint id the accessor knows; portal_frame unchanged', () => {
  assert.equal(validateGoal({ kind: 'build', arg: 'bp4' }).reason, 'no blueprint bp4', 'the default accessor knows none')
  withBlueprints(() => {
    assert.deepEqual(validateGoal({ kind: 'build', arg: 'bp4' }), { ok: true })
    assert.deepEqual(validateGoal({ kind: 'dig', arg: 'bp5' }), { ok: true })
    assert.deepEqual(validateGoal({ kind: 'build', arg: 'portal_frame' }), { ok: true })
    assert.equal(validateGoal({ kind: 'build', arg: 'house' }).reason, 'no executor yet')
    assert.equal(validateGoal({ kind: 'build', arg: 'bp9' }).reason, 'no blueprint bp9')
    assert.equal(validateGoal({ kind: 'dig', arg: 'bp4' }).reason, 'bp4 is not a dig blueprint')
    assert.equal(validateGoal({ kind: 'build', arg: 'bp5' }).reason, 'bp5 is not a build blueprint')
    assert.equal(validateGoal({ kind: 'dig', arg: 'portal_frame' }).reason, 'cannot dig portal_frame')
  })
  assert.equal(GOAL_KINDS.build.stuckS('portal_frame'), 600)
  assert.equal(GOAL_KINDS.build.stuckS('bp4'), 300)
  assert.equal(GOAL_KINDS.dig.stuckS, 300)
})

test('build(bp4): done when the accessor says finished; filter keeps its option, the material producers and moves', () => {
  withBlueprints(() => {
    const K = GOAL_KINDS.build
    assert.equal(K.done(bpObs({ bp4: prog() }), 'bp4'), false)
    assert.equal(K.done(bpObs({ bp4: prog({ finished: true, missing: 0 }) }), 'bp4'), true)
    assert.equal(K.done(bpObs({}), 'bp4'), false, 'no progress (unknown to the world): not done')
    const s = new GoalStack({ goal: 'nether' })
    s.push({ kind: 'build', arg: 'bp4', source: 'leader', t: 0 })
    const o = bpObs({ bp4: prog() }, { inventory: { stone_pickaxe: 1, cobblestone: 5 } })
    withProvider(['build_blueprint(bp4)', 'build_blueprint(bp7)', 'dig_blueprint(bp5)', 'mine(sand)'], () => {
      const kept = s.filter(o, options(o)).map(x => x.id)
      for (const id of ['build_blueprint(bp4)', 'mine_stone', 'wait']) assert.ok(kept.includes(id), `${id} in ${kept.join(' ')}`)
      for (const id of ['build_blueprint(bp7)', 'dig_blueprint(bp5)', 'mine(sand)', 'gather_wood']) assert.ok(!kept.includes(id), id)
      assert.equal(s.teacher(o), 'mine_stone', '5 held, the next layer takes 15: get cobblestone first')
      const rich = bpObs({ bp4: prog() }, { inventory: { stone_pickaxe: 1, cobblestone: 20 } })
      assert.equal(s.teacher(rich), 'build_blueprint(bp4)')
      const clearing = bpObs({ bp4: prog({ layerNeeds: {} }) })   // the working layer only needs clearing
      assert.equal(s.teacher(clearing), 'build_blueprint(bp4)')
    })
    // a material from the plugins: glass through smelt_item(glass), sand through mine(sand)
    withProvider(['build_blueprint(bp4)', 'smelt_item(glass)', 'mine(sand)', 'mine(gravel)'], () => {
      const g = bpObs({ bp4: prog({ needs: { glass: 4, sand: 2 }, layerNeeds: { glass: 4 } }) })
      const kept = s.filter(g, options(g)).map(x => x.id)
      for (const id of ['build_blueprint(bp4)', 'smelt_item(glass)', 'mine(sand)']) assert.ok(kept.includes(id), `${id} in ${kept.join(' ')}`)
      assert.ok(!kept.includes('mine(gravel)') && !kept.includes('mine_stone'), kept.join(' '))
      assert.equal(s.teacher(g), 'smelt_item(glass)')
    })
    assert.match(s.describe(o), /^Goal from the leader: build hut \(#4\)\. Then: /)
  })
})

test('build(bp4) step: monotone over blocks and segments, done past the last', () => {
  withBlueprints(() => {
    const K = GOAL_KINDS.build
    const st = p => K.step(bpObs({ bp4: p }), 'bp4')
    assert.deepEqual(st(prog()), { index: 3, of: 10, text: 'build hut (#4): 29 of 100 cells' })
    assert.equal(st(prog({ done: 64 })).index, 7)
    assert.equal(st(prog({ done: 100, missing: 0, finished: true })).index, 11)
    const seg = p => st(prog({ segments: 3, ...p })).index
    assert.ok(seg({ segment: 1, done: 99 }) < seg({ segment: 2, done: 0 }))
    assert.ok(seg({ segment: 2, done: 100 }) <= seg({ segment: 3, done: 0 }))
    assert.deepEqual(K.step(bpObs({}), 'bp4'), { index: 1, of: 1, text: 'build bp4 (no progress yet)' })
  })
})

test('night: a surface build is withheld at dusk/night and its stuck clock pauses; an underground one continues', () => {
  withBlueprints(() => {
    const s = new GoalStack({ goal: 'nether' })
    s.push({ kind: 'build', arg: 'bp4', source: 'leader', t: 0 })
    withProvider(['build_blueprint(bp4)'], () => {
      const rich = { stone_pickaxe: 1, cobblestone: 64 }
      const night = bpObs({ bp4: prog() }, { phase: 'night', inventory: rich })
      assert.ok(!s.filter(night, options(night)).some(o => o.id === 'build_blueprint(bp4)'))
      assert.notEqual(s.teacher(night), 'build_blueprint(bp4)')
      const dusk = bpObs({ bp4: prog() }, { phase: 'dusk', inventory: rich })
      assert.ok(!s.filter(dusk, options(dusk)).some(o => o.id === 'build_blueprint(bp4)'))
      // the bot underground at night: a surface build is still withheld (running it would climb out)
      const below = bpObs({ bp4: prog() }, { phase: 'night', underground: true, inventory: rich })
      assert.ok(!s.filter(below, options(below)).some(o => o.id === 'build_blueprint(bp4)'))
      const cave = bpObs({ bp4: prog({ surface: false }) }, { phase: 'night', underground: true, inventory: rich })
      assert.ok(s.filter(cave, options(cave)).some(o => o.id === 'build_blueprint(bp4)'))
      assert.equal(s.teacher(cave), 'build_blueprint(bp4)')
      // the clock: the whole night without a pop, then 300 s by day
      assert.deepEqual(s.update(night, 0), [])
      assert.deepEqual(s.update(below, 500), [])
      assert.deepEqual(s.update(night, 1000), [])
      const day = bpObs({ bp4: prog() }, { inventory: rich })
      assert.deepEqual(s.update(day, 1200), [])
      assert.equal(s.update(day, 1300)[0]?.reason, 'stuck')
    })
  })
})

test('dig(bp5): keeps its option and moves only; teacher digs; withheld at night only on the surface', () => {
  withBlueprints(() => {
    const K = GOAL_KINDS.dig
    assert.equal(K.done(bpObs({ bp5: prog({ finished: true }) }), 'bp5'), true)
    assert.equal(K.done(bpObs({ bp5: prog() }), 'bp5'), false)
    const s = new GoalStack({ goal: 'nether' })
    s.push({ kind: 'dig', arg: 'bp5', source: 'leader', t: 0 })
    withProvider(['dig_blueprint(bp5)', 'dig_blueprint(bp6)', 'build_blueprint(bp4)', 'mine(redstone_ore)'], () => {
      const o = bpObs({ bp5: prog({ surface: false }) })
      const kept = s.filter(o, options(o)).map(x => x.id)
      assert.ok(kept.includes('dig_blueprint(bp5)') && kept.includes('wait'), kept.join(' '))
      for (const id of ['dig_blueprint(bp6)', 'build_blueprint(bp4)', 'mine(redstone_ore)', 'mine_stone', 'gather_wood']) assert.ok(!kept.includes(id), id)
      assert.equal(s.teacher(o), 'dig_blueprint(bp5)')
      assert.match(s.describe(o), /^Goal from the leader: dig strip mine \(#5\)\./)
      const nightDeep = bpObs({ bp5: prog({ surface: false }) }, { phase: 'night', underground: true })
      assert.equal(s.teacher(nightDeep), 'dig_blueprint(bp5)', 'underground digging continues at night')
      const nightTop = bpObs({ bp5: prog({ surface: true }) }, { phase: 'night' })
      assert.ok(!s.filter(nightTop, options(nightTop)).some(x => x.id === 'dig_blueprint(bp5)'))
      assert.equal(GOAL_KINDS.dig.paused(nightTop, 'bp5'), true)
      assert.equal(GOAL_KINDS.dig.paused(nightDeep, 'bp5'), false)
    })
  })
})

test('the portal_frame build keeps its old filter, step and describe', () => {
  const o = chain({ inventory: { ...allTools, water_bucket: 1, obsidian: 3 }, armor: armorKit })
  const K = GOAL_KINDS.build
  assert.equal(K.describe(o, 'portal_frame'), 'build a nether portal frame')
  assert.deepEqual(K.step(o, 'portal_frame'), { index: 4, of: 11, text: 'build a nether portal frame (3 of 10 obsidian)' })
  const kept = K.filter(o, 'portal_frame', options(o)).map(x => x.id)
  assert.deepEqual(kept, ['explore_toward(down)', 'explore_toward(surface)', 'explore_toward(deep)', 'wait'])
  const withObs = chain({ inventory: { ...allTools, water_bucket: 1, obsidian: 10, flint_and_steel: 1, cobblestone: 4 }, armor: armorKit })
  assert.ok(K.filter(withObs, 'portal_frame', options(withObs)).some(x => x.id === 'build_portal'))
})

// Live stress session (item 3): sheltered at night at low health, a pushed goal's plugin options (go_to_player,
// mine(<block>)) would take the bot out as surely as return_to_base.
test('sheltered at night at health <= 6: no plugin options under a pushed goal', () => {
  const s = new GoalStack({ goal: 'nether' })
  s.push({ kind: 'go_to', arg: 'player:Steve', source: 'leader', t: 0 })
  const o = chain({ phase: 'night', health: 3, underground: true, skyLight: 0, inventory: { iron_pickaxe: 1, cobblestone: 4 } })
  withProvider(['go_to_player(Steve)'], () => {
    assert.ok(!s.filter(o, options(o)).map(x => x.id).includes('go_to_player(Steve)'))
    assert.ok(s.filter({ ...o, health: 12 }, options({ ...o, health: 12 })).map(x => x.id).includes('go_to_player(Steve)'))
  })
})

// Live retry session (2026-09-27): a step's target was the inventory at push time plus the need computed when the plan
// was made, so "smelt 2 iron" with 3 held asked for 5 and the white bed plan redid work. refreshPlanStep recomputes a
// step's need with the expander against the inventory now (the plan's item and count); a step no longer needed skips.
import { refreshPlanStep } from '../agent/goals.js'
test('refreshPlanStep: a plan step\'s need is recomputed from the inventory when it is pushed', () => {
  const plan = { id: 3, item: 'shears', count: 1, steps: [] }
  const smelt = { kind: 'gather', arg: 'iron_ingot', count: 2 }
  const table = { kind: 'craft_item', arg: 'crafting_table', count: 1 }
  // 3 ingots held: shears need 2, nothing to smelt
  assert.deepEqual(refreshPlanStep(smelt, plan, baseObs({ inventory: { iron_ingot: 3, crafting_table: 1 } })), { ...smelt, count: 0, skip: true })
  // 1 held with a stone pickaxe: 1 more
  assert.deepEqual(refreshPlanStep(smelt, plan, baseObs({ inventory: { iron_ingot: 1, stone_pickaxe: 1, crafting_table: 1 } })), { ...smelt, count: 1 })
  // a crafting table held: the table step is skipped
  assert.equal(refreshPlanStep(table, plan, baseObs({ inventory: { iron_ingot: 1, crafting_table: 1, stone_pickaxe: 1 } })).skip, true)
  // plans without an item (plan_steps) and uncounted kinds are unchanged
  assert.deepEqual(refreshPlanStep(smelt, { id: 1, title: 'x', steps: [] }, baseObs({ inventory: { iron_ingot: 3 } })), smelt)
  const go = { kind: 'go_to', arg: 'base', count: null }
  assert.deepEqual(refreshPlanStep(go, plan, baseObs({ inventory: {} })), go)
  // a push routed as n MORE (plan.more): the held ones of the plan's own item do not count
  const more = { id: 4, item: 'iron_ingot', count: 2, more: true, base: 3, steps: [] }
  const kit = { raw_iron: 2, stone_pickaxe: 1, furnace: 1, coal: 2 }
  assert.deepEqual(refreshPlanStep(smelt, more, baseObs({ inventory: { iron_ingot: 3, ...kit } })), { ...smelt, count: 2 })
  assert.deepEqual(refreshPlanStep(smelt, more, baseObs({ inventory: { iron_ingot: 4, ...kit } })), { ...smelt, count: 1 }, 'one gained since')
})

// Live retry session: go_to(player) popped as stuck after 120 s on a 200 m walk (the step buckets are 16-64 m wide).
// A distance to the player that shrank by 4 m or more since the last progress mark counts as progress.
test('go_to(player): a distance decrease of 4 m since the last progress mark resets the stuck clock', () => {
  const s = new GoalStack({ goal: 'nether' })
  const at = d => baseObs({ goal: 'nether', players: { Steve: { dist: d, dir: 'north', reported: true } } })
  s.push({ kind: 'go_to', arg: 'player:Steve', source: 'audience:Steve', t: 0, obs: at(200) })
  let d = 200, t = 0
  for (; t <= 400; t += 10) { d -= 3.5; assert.deepEqual(s.update(at(d), t), [], `t ${t}, ${d} m`) }   // 0.35 m/s: slow but closing
  assert.equal(s.depth(), 1, 'still on the stack after 400 s of closing in')
  // no progress (standing still at the same distance) pops it after 120 s
  const e = []
  for (let u = t; u <= t + 130; u += 10) e.push(...s.update(at(d), u))
  assert.equal(e.length, 1); assert.equal(e[0].kind, 'goal_failed')
})

// Live retry session: "come here" ended at 3 m and the bot walked off before the player could hand anything over. On
// arrival the goal lingers LINGER_S (20 s) with the bot near the player, offering linger(<name>) (stay close, pick up
// item drops within 6 m); then done. The player moving well away (over 8 m) restarts the approach.
import { LINGER_S } from '../agent/goals.js'
test('go_to(player): arrival lingers 20 s offering linger(<name>), then done; the player leaving restarts the approach', () => {
  assert.equal(LINGER_S, 20)
  const s = new GoalStack({ goal: 'nether' })
  const at = (d, t) => chain({ t, players: { Steve: { dist: d, dir: 'north' } } })
  s.push({ kind: 'go_to', arg: 'player:Steve', source: 'audience:Steve', t: 0, obs: at(30, 0) })
  withProvider(['go_to_player(Steve)', 'linger(Steve)'], () => {
    assert.deepEqual(s.update(at(30, 0), 0), [])
    assert.ok(s.filter(at(30, 0), options(at(30, 0))).some(o => o.id === 'go_to_player(Steve)'))
    assert.deepEqual(s.update(at(2.5, 10), 10), [], 'arrived: lingering, not done')
    const o = at(2.5, 11)
    const kept = s.filter(o, options(o)).map(x => x.id)
    assert.ok(kept.includes('linger(Steve)') && !kept.includes('go_to_player(Steve)'), kept.join(' '))
    assert.equal(s.teacher(o), 'linger(Steve)')
    assert.match(s.step(o).text, /with Steve/)
    assert.deepEqual(s.update(at(3.5, 20), 20), [], 'within 4 m still lingering')
    assert.deepEqual(s.update(at(12, 25), 25), [], 'the player walked off: approach again')
    assert.ok(s.filter(at(12, 26), options(at(12, 26))).some(o => o.id === 'go_to_player(Steve)'))
    assert.deepEqual(s.update(at(2, 30), 30), [])
    assert.deepEqual(s.update(at(2, 45), 45), [])
    const e = s.update(at(2, 50), 50)
    assert.equal(e.length, 1); assert.equal(e[0].kind, 'goal_done')
  })
})

// Item 19 (the user, 2026-09-27): "wait over here". stay(player:<name>) holds the spot where that player was when the
// bot reached them; stay(here) the bot's own spot. Never done, never stuck, not paused by the night rule; only the
// holding option stay(<name|here>), eat, wait and the threat responses are offered. The leader pops it on release.
test('stay: validate, never done or stuck, filter keeps only the hold, eat, wait and threat responses, teacher', () => {
  assert.deepEqual(validateGoal({ kind: 'stay', arg: 'player:Steve' }), { ok: true })
  assert.deepEqual(validateGoal({ kind: 'stay', arg: 'here' }), { ok: true })
  assert.equal(validateGoal({ kind: 'stay', arg: 'base' }).ok, false)
  assert.equal(validateGoal({ kind: 'stay', arg: null }).ok, false)
  const K = GOAL_KINDS.stay
  assert.equal(K.done(chain({ players: { Steve: { dist: 1 } } }), 'player:Steve'), false)
  assert.equal(K.stuckS, Infinity)
  const s = new GoalStack({ goal: 'nether' })
  const o = chain({ inventory: { iron_pickaxe: 1, cobblestone: 20, bread: 2 }, food: 10, blocks: [...stone, ...logs], phase: 'night', underground: false,
    base: { crafting_table: { dist: 30 }, furnace: null }, players: { Steve: { dist: 2 } }, nearestHostile: { name: 'zombie', dist: 6, dir: 'north' } })
  s.push({ kind: 'stay', arg: 'player:Steve', source: 'audience:Steve', t: 0, obs: o })
  withProvider(['stay(Steve)', 'stay(here)', 'go_to_player(Steve)', 'hunt(sheep)'], () => {
    const kept = s.filter(o, options(o)).map(x => x.id).sort()
    assert.deepEqual(kept, ['eat', 'fight(threat)', 'flee(threat)', 'pillar_up', 'stay(Steve)', 'wait'].sort())
    assert.equal(s.teacher(o), 'fight(threat)', 'threats first')
    const calm = { ...o, nearestHostile: null, food: 18 }
    assert.equal(s.teacher(calm), 'stay(Steve)')
    assert.deepEqual(s.filter(calm, options(calm)).map(x => x.id).sort(), ['stay(Steve)', 'wait'])
  })
  assert.match(s.step(o).text, /^Staying with Steve until you say I can go/)
  for (let t = 0; t <= 3600; t += 300) assert.deepEqual(s.update(o, t), [], `never done or stuck (t ${t})`)
  const h = new GoalStack({ goal: 'nether' })
  h.push({ kind: 'stay', arg: 'here', source: 'leader', t: 0, obs: o })
  assert.match(h.step(o).text, /^Staying here until you say I can go/)
  withProvider(['stay(Steve)', 'stay(here)'], () => assert.equal(h.teacher({ ...o, nearestHostile: null, food: 18 }), 'stay(here)'))
})
