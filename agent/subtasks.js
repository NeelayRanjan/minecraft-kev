// The declared subtask list. Lesson 6: every option list has an escape (wait; flee when a hostile is near) and only
// offers options whose preconditions hold. Option ids are strings "name" or "name(arg)"; they are the choice
// criteria keys kev sees, the teacher's labels, and what the motor layer executes.
// Not offered in experiment 1: abandon_subgoal (no planner to hand back to) and sleep (no bed is ever crafted).
// Chain mode (obs.goal === 'nether', Task 2): options for the goal chain beyond the iron pickaxe (iron tools,
// iron armor, diamond tools, nether portal). Never offered in experiment 1; agent/stages.js is the pure model
// of what's needed at each stage, shared with the teacher and the chain-progress question.
import { needs, stageOf, INGOTS, DIAMONDS, STICKS } from './stages.js'

export const HOSTILE_RANGE = 16
export const TABLE_NEAR = 16      // a remembered table/furnace within this many metres counts as usable (the motor walks to it)
export const REPEAT_LIMIT = 3     // lesson 7: an option that failed the same way this many times in a row is withheld
export const REPEAT_WINDOW = 6    // ... or this many times among the last REPEAT_WINDOW attempts (a leader alternated coal with other tries 51 times)
export const CHAIN_CRAFTABLE = ['iron_sword', 'iron_axe', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'bucket', 'flint_and_steel', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe']
export const TABLE_ITEMS = new Set(['wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe', ...CHAIN_CRAFTABLE])
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
    diamonds: inv.diamond || 0, obsidian: inv.obsidian || 0, flint: inv.flint || 0,
    bucket: inv.bucket || 0, waterBucket: inv.water_bucket || 0, flintAndSteel: inv.flint_and_steel || 0,
    hasIronPickaxe: ['iron', 'diamond'].some(m => inv[`${m}_pickaxe`]), hasDiamondPickaxe: !!inv.diamond_pickaxe,
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
    case 'iron_sword': return c.ingots >= INGOTS.iron_sword && c.sticks >= (STICKS.iron_sword || 0)
    case 'iron_axe': return c.ingots >= INGOTS.iron_axe && c.sticks >= (STICKS.iron_axe || 0)
    case 'iron_helmet': return c.ingots >= INGOTS.iron_helmet
    case 'iron_chestplate': return c.ingots >= INGOTS.iron_chestplate
    case 'iron_leggings': return c.ingots >= INGOTS.iron_leggings
    case 'iron_boots': return c.ingots >= INGOTS.iron_boots
    case 'bucket': return c.ingots >= INGOTS.bucket
    case 'flint_and_steel': return c.ingots >= INGOTS.flint_and_steel && c.flint >= 1
    case 'diamond_pickaxe': return c.diamonds >= DIAMONDS.diamond_pickaxe && c.sticks >= (STICKS.diamond_pickaxe || 0)
    case 'diamond_sword': return c.diamonds >= DIAMONDS.diamond_sword && c.sticks >= (STICKS.diamond_sword || 0)
    case 'diamond_axe': return c.diamonds >= DIAMONDS.diamond_axe && c.sticks >= (STICKS.diamond_axe || 0)
    default: return false
  }
}
export const hasFuel = c => c.coal >= 1 || c.planks >= 2 || c.logs >= 1
export const tableNear = obs => !!(obs.base?.crafting_table && obs.base.crafting_table.dist <= TABLE_NEAR)
export const furnaceNear = obs => !!(obs.base?.furnace && obs.base.furnace.dist <= TABLE_NEAR)
// The ids the livelock breaker withholds: failed with the same result REPEAT_LIMIT times in a row (obs.last.repeats) or
// among the last REPEAT_WINDOW attempts (obs.last.recent, oldest first, kept by the runner). wait is never withheld.
export function stuckOn(obs) {
  const l = obs.last, out = new Set()
  if (!l) return out
  if (l.result !== 'ok' && (l.repeats || 0) >= REPEAT_LIMIT) out.add(l.id)
  const n = new Map()
  for (const a of (l.recent || []).slice(-REPEAT_WINDOW)) {
    if (a.result === 'ok') continue
    const k = `${a.id} ${a.result}`
    n.set(k, (n.get(k) || 0) + 1)
    if (n.get(k) >= REPEAT_LIMIT) out.add(a.id)
  }
  out.delete('wait')
  return out
}
const seen = (obs, pred, maxDist) => (obs.blocks || []).some(b => pred(b.name) && b.dist <= maxDist)
export const isLog = n => n.endsWith('_log')
export const isStone = n => n === 'stone' || n === 'deepslate' || n === 'cobblestone'
export const isCoal = n => n === 'coal_ore' || n === 'deepslate_coal_ore'
export const isIron = n => n === 'iron_ore' || n === 'deepslate_iron_ore'
export const isDiamond = n => n === 'diamond_ore' || n === 'deepslate_diamond_ore'
export const isGravel = n => n === 'gravel'
export const isObsidian = n => n === 'obsidian'
export const isWater = n => n === 'water'
export const isLava = n => n === 'lava'

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
  'craft(iron_sword)': 'craft an iron sword at a crafting table (2 iron ingots, 1 stick)',
  'craft(iron_axe)': 'craft an iron axe at a crafting table (3 iron ingots, 2 sticks)',
  'craft(iron_helmet)': 'craft an iron helmet at a crafting table (5 iron ingots)',
  'craft(iron_chestplate)': 'craft an iron chestplate at a crafting table (8 iron ingots)',
  'craft(iron_leggings)': 'craft iron leggings at a crafting table (7 iron ingots)',
  'craft(iron_boots)': 'craft iron boots at a crafting table (4 iron ingots)',
  'craft(bucket)': 'craft a bucket at a crafting table (3 iron ingots)',
  'craft(flint_and_steel)': 'craft flint and steel at a crafting table (1 iron ingot, 1 flint)',
  'craft(diamond_pickaxe)': 'craft a diamond pickaxe at a crafting table (3 diamonds, 2 sticks)',
  'craft(diamond_sword)': 'craft a diamond sword at a crafting table (2 diamonds, 1 stick)',
  'craft(diamond_axe)': 'craft a diamond axe at a crafting table (3 diamonds, 2 sticks)',
  mine_diamond: 'walk to the nearest known diamond ore and mine it with an iron or better pickaxe',
  mine_gravel: 'mine gravel nearby (a source of flint)',
  mine_obsidian: 'mine obsidian with a diamond pickaxe',
  'explore_toward(deep)': 'dig a staircase down to diamond level (y -58), or tunnel along it once there',
  'fill_bucket(water)': 'walk to water and fill the bucket',
  cast_obsidian: 'pour the water bucket onto lava to make obsidian',
  build_portal: 'place the obsidian frame for a nether portal (10 obsidian)',
  light_portal: 'light the nether portal frame with flint and steel',
}

export const optionId = (name, arg) => arg ? `${name}(${arg})` : name
export function parseOption(id) {
  const m = /^(\w+)(?:\((\w+)\))?$/.exec(id)
  if (!m) throw new Error(`bad option id ${id}`)
  return { name: m[1], arg: m[2] ?? null }
}

// Chain-mode-only options (Task 2): the goal chain beyond the iron pickaxe. Appended by options() only when
// obs.goal === 'nether', after every experiment-1 option and before the final wait/breaker filtering, so
// experiment-1 data (obs.goal !== 'nether') serialises identically to before this option list existed.
function addChain(obs, out, c) {
  const add = (name, arg = null) => { const id = optionId(name, arg); out.push({ id, name, arg, desc: DESC[id] }) }
  const need = needs(obs)
  const stage = stageOf(obs).index
  for (const item of CHAIN_CRAFTABLE) {
    if (!canCraft(item, c)) continue
    if (TABLE_ITEMS.has(item) && !tableNear(obs) && c.table === 0) continue
    add('craft', item)
  }
  // needs().diamonds is already net of held diamonds (diamond ore drops diamond directly, no smelting), so
  // the raw ">0" check is correct as-is: comparing a held quantity against it again would be self-referential.
  if (c.hasIronPickaxe && (seen(obs, isDiamond, 32) || obs.memory?.diamondSeen) && need.diamonds > 0) add('mine_diamond')
  if (c.hasIronPickaxe && stage >= 3) add('explore_toward', 'deep')
  if (stage === 4 && c.flint === 0 && !c.flintAndSteel && seen(obs, isGravel, 16)) add('mine_gravel')
  if (c.bucket >= 1 && (seen(obs, isWater, 24) || obs.memory?.waterSeen)) add('fill_bucket', 'water')
  if (c.waterBucket >= 1 && (seen(obs, isLava, 24) || obs.memory?.lavaSeen) && c.obsidian < 10) add('cast_obsidian')
  if (c.hasDiamondPickaxe && seen(obs, isObsidian, 16) && c.obsidian < 10) add('mine_obsidian')
  // A build in progress (memory.portal) stays offered with the obsidian still missing; corner blocks are only
  // required for a fresh frame (an interrupted one may already have them).
  const build = obs.memory?.portal
  if (c.flintAndSteel && !obs.portalLit && !obs.portalFrame && (build ? c.obsidian >= 10 - build.placed : c.obsidian >= 10 && c.blocks >= 4)) add('build_portal')
  if (obs.portalFrame && !obs.portalLit && c.flintAndSteel) add('light_portal')
}

export function options(obs) {
  const c = counts(obs)
  const chainMode = obs.goal === 'nether'
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
  // Chain mode keeps the flat experiment-1 cap (6) at stage 0 (the iron pickaxe itself isn't in needs()'s
  // model). From stage 1 on: needs(obs).ingots is already net of held ingots, so it's compared against
  // rawIron alone (iron waiting to be smelted into ingots), not against rawIron + ingots again, capped at 40.
  const stage0Cap = done || c.rawIron + c.ingots < 6
  const mineIronOk = chainMode && stageOf(obs).index >= 1
    ? needs(obs).ingots > c.rawIron && c.rawIron + c.ingots < 40
    : stage0Cap
  if (c.hasStonePickaxe && (seen(obs, isIron, 32) || obs.memory?.ironSeen) && mineIronOk) add('mine_iron')
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
  if (chainMode) addChain(obs, out, c)
  add('wait')
  const stuck = stuckOn(obs)
  for (const id of obs.withhold || []) if (id !== 'wait') stuck.add(id)   // a subtask the supervisor just abandoned (agent/supervisor.js)
  return out.filter(o => !stuck.has(o.id))
}
