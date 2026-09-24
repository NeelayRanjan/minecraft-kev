// The declared subtask list. Lesson 6: every option list has an escape (wait; flee when a hostile is near) and only
// offers options whose preconditions hold. Option ids are strings "name" or "name(arg)"; they are the choice
// criteria keys kev sees, the teacher's labels, and what the motor layer executes.
// Not offered in experiment 1: abandon_subgoal (no planner to hand back to) and sleep (no bed is ever crafted).
export const HOSTILE_RANGE = 16
export const TABLE_NEAR = 16      // a remembered table/furnace within this many metres counts as usable (the motor walks to it)
export const REPEAT_LIMIT = 3     // lesson 7: an option that failed the same way this many times in a row is withheld
export const TABLE_ITEMS = new Set(['wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe'])
export const CRAFTABLE = ['planks', 'sticks', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe']
export const FOOD = new Set(['bread', 'apple', 'cooked_beef', 'beef', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton',
  'chicken', 'cooked_chicken', 'carrot', 'potato', 'baked_potato', 'sweet_berries', 'cod', 'cooked_cod', 'rotten_flesh'])

export function counts(obs) {
  const inv = obs.inventory || {}
  const sum = pred => Object.entries(inv).filter(([k]) => pred(k)).reduce((n, [, v]) => n + v, 0)
  return {
    logs: sum(k => k.endsWith('_log')), planks: sum(k => k.endsWith('_planks')), sticks: inv.stick || 0,
    cobble: (inv.cobblestone || 0) + (inv.cobbled_deepslate || 0), rawIron: inv.raw_iron || 0, ingots: inv.iron_ingot || 0,
    coal: (inv.coal || 0) + (inv.charcoal || 0), food: sum(k => FOOD.has(k)), table: inv.crafting_table || 0, furnace: inv.furnace || 0,
    blocks: (inv.cobblestone || 0) + (inv.dirt || 0) + (inv.cobbled_deepslate || 0),
    hasPickaxe: ['wooden', 'stone', 'iron', 'diamond'].some(m => inv[`${m}_pickaxe`]),
    hasStonePickaxe: ['stone', 'iron', 'diamond'].some(m => inv[`${m}_pickaxe`]),
  }
}

export function canCraft(item, c) {
  switch (item) {
    case 'planks': return c.logs >= 1
    case 'sticks': return c.planks >= 2
    case 'crafting_table': return c.planks >= 4
    case 'wooden_pickaxe': return c.planks >= 3 && c.sticks >= 2
    case 'stone_pickaxe': return c.cobble >= 3 && c.sticks >= 2
    case 'furnace': return c.cobble >= 8
    case 'iron_pickaxe': return c.ingots >= 3 && c.sticks >= 2
    default: return false
  }
}
export const hasFuel = c => c.coal >= 1 || c.planks >= 2 || c.logs >= 1
export const tableNear = obs => !!(obs.base?.crafting_table && obs.base.crafting_table.dist <= TABLE_NEAR)
export const furnaceNear = obs => !!(obs.base?.furnace && obs.base.furnace.dist <= TABLE_NEAR)
export const stuckOn = obs => (obs.last && obs.last.result !== 'ok' && (obs.last.repeats || 0) >= REPEAT_LIMIT) ? obs.last.id : null
const seen = (obs, pred, maxDist) => (obs.blocks || []).some(b => pred(b.name) && b.dist <= maxDist)
export const isLog = n => n.endsWith('_log')
export const isStone = n => n === 'stone' || n === 'deepslate' || n === 'cobblestone'
export const isCoal = n => n === 'coal_ore' || n === 'deepslate_coal_ore'
export const isIron = n => n === 'iron_ore' || n === 'deepslate_iron_ore'

export const DESC = {
  gather_wood: 'walk to the nearest tree and mine logs',
  mine_stone: 'mine cobblestone from nearby stone with a pickaxe',
  mine_coal: 'walk to the nearest coal ore and mine it',
  mine_iron: 'walk to the nearest known iron ore and mine it',
  'craft(planks)': 'craft planks from logs (no table needed)',
  'craft(sticks)': 'craft sticks from planks (no table needed)',
  'craft(crafting_table)': 'craft a crafting table from 4 planks',
  'craft(wooden_pickaxe)': 'craft a wooden pickaxe at a crafting table (3 planks, 2 sticks)',
  'craft(stone_pickaxe)': 'craft a stone pickaxe at a crafting table (3 cobblestone, 2 sticks)',
  'craft(furnace)': 'craft a furnace at a crafting table (8 cobblestone)',
  'craft(iron_pickaxe)': 'craft an iron pickaxe at a crafting table (3 iron ingots, 2 sticks)',
  'smelt(iron_ingot)': 'put raw iron and fuel in a furnace and wait for ingots',
  'explore_toward(cave)': 'walk to the nearby cave opening and go in',
  'explore_toward(down)': 'dig a staircase down toward iron level and tunnel there',
  'explore_toward(surface)': 'walk across the surface looking for trees, stone or caves',
  return_to_base: 'walk back to the crafting table',
  eat: 'eat something from the inventory',
  build_shelter: 'dig down two blocks and seal the top to hide until morning',
  'fight(threat)': 'attack the nearest hostile mob with the best tool in hand',
  'flee(threat)': 'run away from the nearest hostile mob',
  pillar_up: 'jump and place blocks underneath to get out of reach',
  wait: 'stand still for a few seconds',
}

export const optionId = (name, arg) => arg ? `${name}(${arg})` : name
export function parseOption(id) {
  const m = /^(\w+)(?:\((\w+)\))?$/.exec(id)
  if (!m) throw new Error(`bad option id ${id}`)
  return { name: m[1], arg: m[2] ?? null }
}

export function options(obs) {
  const c = counts(obs)
  const out = []
  const add = (name, arg = null) => { const id = optionId(name, arg); out.push({ id, name, arg, desc: DESC[id] }) }
  const h = obs.nearestHostile
  if (h && h.dist <= HOSTILE_RANGE) {
    add('fight', 'threat'); add('flee', 'threat')
    if (c.blocks >= 3 && h.dist <= 8 && !obs.inWater) add('pillar_up')
  }
  // Gathering caps: more than the tech tree can use is never offered (a leader without arithmetic would hoard forever).
  const done = !!obs.inventory?.iron_pickaxe
  const woodEq = c.logs + Math.floor(c.planks / 4)
  if (seen(obs, isLog, 48) && (done || woodEq < 12)) add('gather_wood')
  if (c.hasPickaxe && seen(obs, isStone, 16) && (done || c.cobble < 32)) add('mine_stone')
  if (c.hasPickaxe && seen(obs, isCoal, 32)) add('mine_coal')
  if (c.hasStonePickaxe && (seen(obs, isIron, 32) || obs.memory?.ironSeen) && (done || c.rawIron + c.ingots < 6)) add('mine_iron')
  for (const item of CRAFTABLE) {
    if (!canCraft(item, c)) continue
    if (TABLE_ITEMS.has(item) && !tableNear(obs) && c.table === 0) continue
    add('craft', item)
  }
  if (c.rawIron >= 1 && hasFuel(c) && (furnaceNear(obs) || c.furnace >= 1)) add('smelt', 'iron_ingot')
  if (seen(obs, n => n === 'cave', 32)) add('explore_toward', 'cave')
  if (c.hasPickaxe && obs.pos.y > 14) add('explore_toward', 'down')
  add('explore_toward', 'surface')
  if (obs.base?.crafting_table && obs.base.crafting_table.dist > TABLE_NEAR) add('return_to_base')
  if (c.food >= 1 && obs.food < 16) add('eat')
  if (c.blocks >= 1 && c.hasPickaxe && (obs.phase === 'dusk' || obs.phase === 'night')) add('build_shelter')
  add('wait')
  const stuck = stuckOn(obs)
  return stuck && stuck !== 'wait' ? out.filter(o => o.id !== stuck) : out
}
