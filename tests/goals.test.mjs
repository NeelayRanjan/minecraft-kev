import test from 'node:test'
import assert from 'node:assert/strict'
import { GoalStack, GOAL_KINDS, validateGoal, DECLARED_FINDABLE, FINDABLE_NOW, RECIPES } from '../agent/goals.js'
import { chainStep, describeChain } from '../agent/stages.js'
import { techStep, teacherSubtask } from '../agent/teacher.js'
import { options } from '../agent/subtasks.js'
import { baseObs } from './fixtures.mjs'

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
    { kind: 'gather', arg: 'emerald', count: 3 }, { kind: 'go_to', arg: 'nether' }]) {
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
