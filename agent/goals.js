// Typed goals and the goal stack (pure). The leader (an LLM, steered from chat) pushes typed goals from a declared
// list onto a stack; kev keeps picking primitives from the option list under the top goal. Each kind declares a
// completion predicate over obs, an option filter (only ever removes; never wait or the threat responses), a step
// function for the forecast question and the timeline, where scriptable a teacher, a describe line and a stuck rule
// (no step progress for stuckS seconds pops the goal with goal_failed).
// The bottom of the stack is the default entry: `chain` (chain mode, agent/stages.js) or `iron_pickaxe`
// (experiment 1, teacher.js's techStep). With only the default entry every output equals today's functions exactly.
import { stageOf, chainStep, describeChain, INGOTS, DIAMONDS, STICKS } from './stages.js'
import { techStep, teacherSubtask, teacherThreat } from './teacher.js'
import { counts, options, optionId, canCraft, hasFuel, tableNear, furnaceNear, nightOnSurface, shelterSoon, TABLE_ITEMS,
  NIGHT_REFUGES, LOW_AIR, isLog, isStone, isCoal, isIron, isDiamond, isGravel, isObsidian, isWater, isLava } from './subtasks.js'
// A cycle (recipes.js imports this module's tables): recipes' exports are read only inside functions here.
import { MINE, SMELT, HUNT, producerOf, isItem } from './recipes.js'

// Ingredient tables for every item the option layer can craft (CRAFTABLE + CHAIN_CRAFTABLE); keys are the option
// args (planks, sticks), values the ingredients per craft. YIELD: items one craft makes (planks 4 per log, sticks 4).
const toolRecipe = (primary, table) => Object.fromEntries(Object.keys(table).map(item =>
  [item, { [primary]: table[item], ...(STICKS[item] ? { sticks: STICKS[item] } : {}) }]))
export const RECIPES = {
  planks: { log: 1 },
  sticks: { planks: 2 },
  crafting_table: { planks: 4 },
  wooden_pickaxe: { planks: 3, sticks: 2 },
  stone_pickaxe: { cobblestone: 3, sticks: 2 },
  furnace: { cobblestone: 8 },
  iron_pickaxe: { iron_ingot: 3, sticks: 2 },
  ...toolRecipe('iron_ingot', { iron_sword: INGOTS.iron_sword, iron_axe: INGOTS.iron_axe, iron_helmet: INGOTS.iron_helmet,
    iron_chestplate: INGOTS.iron_chestplate, iron_leggings: INGOTS.iron_leggings, iron_boots: INGOTS.iron_boots, bucket: INGOTS.bucket }),
  flint_and_steel: { iron_ingot: INGOTS.flint_and_steel, flint: 1 },
  ...toolRecipe('diamond', DIAMONDS),
}
const YIELD = { planks: 4, sticks: 4 }

// gather(item, count): the items a gather goal may name and the option that produces each (logs by species).
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
export const PRODUCERS = {
  log: 'gather_wood', ...Object.fromEntries(WOODS.map(w => [`${w}_log`, 'gather_wood'])),
  planks: 'craft(planks)', stick: 'craft(sticks)', cobblestone: 'mine_stone', coal: 'mine_coal', raw_iron: 'mine_iron',
  iron_ingot: 'smelt(iron_ingot)', diamond: 'mine_diamond', flint: 'mine_gravel', obsidian: 'mine_obsidian',
}
export const DECLARED_FINDABLE = ['diamond_ore', 'lava', 'water', 'cave', 'village', 'iron_ore', 'coal_ore']
export const FINDABLE_NOW = DECLARED_FINDABLE.filter(b => b !== 'village')   // village: no detector until roadmap item 5
export const PLACES = ['base', 'surface', 'diamond_level']
// go_to also accepts arg 'y:<int>' (an absolute height, -64..320: the world's build limits), for a leader that wants
// a specific depth PLACES does not name. Pure parse; null when arg is not that form.
export const goToY = arg => { const m = /^y:(-?\d+)$/.exec(arg ?? ''); return m ? Number(m[1]) : null }
export const STRUCTURES = { portal_frame: { executor: true }, house: { executor: false } }
const FIND_MATCH = {
  diamond_ore: isDiamond, iron_ore: isIron, coal_ore: isCoal, lava: isLava, water: isWater, cave: n => n === 'cave',
  village: n => n === 'bell' || n === 'hay_block',
}
export const FIND_RANGE = 16
export const NEAR_BASE = 6
export const DIAMOND_LEVEL_Y = -50

const humanize = s => s.replace(/_/g, ' ')
const THREAT = new Set(['fight(threat)', 'flee(threat)', 'pillar_up'])
const ALWAYS = new Set([...THREAT, 'eat', 'build_shelter', 'wait'])
const isMove = id => id.startsWith('explore_toward(') || id === 'return_to_base'
const keepOnly = (options, keep) => options.filter(o => keep.has(o.id) || ALWAYS.has(o.id))

// The option hook for the plugin primitives (hunt(<mob>), mine(<block>), smelt_item(<item>), receive(<item>),
// go_to_player(<name>), craft_item(<item>)): a provider (obs, goal) -> [{ id, name, arg, desc }] registered by the
// plugin registry. The new kinds' filters add the provider's options that serve the goal (`relevant`) to the kept
// set; a provider that throws offers nothing. As go_to does, they keep the night refuges at dusk/night on the surface
// and, under low air, only the way out of the water (no plugin options: options() withholds all but the escapes).
let optionProvider = () => []
export function registerOptionProvider(fn) { optionProvider = typeof fn === 'function' ? fn : () => [] }
export function pluginOptions(obs, goal) {
  try { return optionProvider(obs, goal) || [] } catch { return [] }
}
const goalOf = (kind, arg, count, g) => ({ kind, arg, count, ...(g?.from ? { from: g.from } : {}) })
function keepWithPlugins(obs, goal, opts, keep, relevant) {
  const own = new Set(opts.map(o => o.id))
  if ((obs.oxygen ?? 20) <= LOW_AIR) return keepOnly(opts, new Set(['explore_toward(surface)']))
  const kept = keepOnly(opts, new Set([...keep, ...opts.map(o => o.id).filter(relevant), ...(nightOnSurface(obs) ? NIGHT_REFUGES : [])]))
  return [...kept, ...pluginOptions(obs, goal).filter(o => relevant(o.id) && !own.has(o.id))]
}
const firstPlugin = (obs, goal, relevant) => pluginOptions(obs, goal).map(o => o.id).find(relevant) ?? null
const fifths = (n, count) => 1 + Math.floor(5 * Math.min(n, count) / count)
// The legacy crafting and gathering options (a non-legacy craft keeps them: its ingredients may need them)
const LEGACY_WORK = new Set(Object.values(PRODUCERS))
const isLegacyWork = o => LEGACY_WORK.has(o.id) || o.name === 'craft'

// How much of an item the bot has, in the option layer's arithmetic (logs and planks of any species, deepslate
// cobble counts as cobblestone, worn armor counts, a water bucket is a bucket).
export function have(obs, item) {
  const c = counts(obs), inv = obs.inventory || {}
  if (item === 'log' || item.endsWith('_log')) return c.logs
  if (item === 'planks' || item.endsWith('_planks')) return c.planks
  if (item === 'sticks' || item === 'stick') return c.sticks
  if (item === 'cobblestone') return c.cobble
  if (item === 'coal') return c.coal
  if (item === 'bucket') return (inv.bucket || 0) + (inv.water_bucket || 0)
  return (inv[item] || 0) + (obs.armor?.[item] || 0)
}
const seen = (obs, pred, d) => (obs.blocks || []).some(b => pred(b.name) && b.dist <= d)
const tableHandy = (obs, c) => tableNear(obs) || c.table >= 1

// The option ids that make `n` more of `item` than held (recursively through the ingredient tables, the tools a mine
// needs, the crafting table, the furnace and fuel). Adds into `out`; `depth` bounds the recursion.
function wanted(obs, item, n, out, depth = 0) {
  if (depth > 8 || n <= 0) return out
  const c = counts(obs)
  const recipe = RECIPES[item]
  if (recipe) {
    out.add(optionId('craft', item))
    const crafts = Math.ceil(n / (YIELD[item] || 1))
    for (const [ing, q] of Object.entries(recipe)) wanted(obs, ing, q * crafts - have(obs, ing), out, depth + 1)
    if (TABLE_ITEMS.has(item) && !tableHandy(obs, c)) wanted(obs, 'crafting_table', 1, out, depth + 1)
    return out
  }
  switch (item) {
    case 'log': out.add('gather_wood'); break
    case 'cobblestone': out.add('mine_stone'); if (!c.hasPickaxe) wanted(obs, 'wooden_pickaxe', 1, out, depth + 1); break
    case 'coal': out.add('mine_coal'); break
    case 'raw_iron': out.add('mine_iron'); if (!c.hasStonePickaxe) wanted(obs, 'stone_pickaxe', 1, out, depth + 1); break
    case 'iron_ingot':
      out.add('smelt(iron_ingot)'); out.add('mine_coal')
      wanted(obs, 'raw_iron', n - c.rawIron, out, depth + 1)
      if (!furnaceNear(obs) && c.furnace === 0) wanted(obs, 'furnace', 1, out, depth + 1)
      if (!hasFuel(c)) wanted(obs, 'planks', 2, out, depth + 1)
      break
    case 'diamond': out.add('mine_diamond'); if (!c.hasIronPickaxe) wanted(obs, 'iron_pickaxe', 1, out, depth + 1); break
    case 'flint': out.add('mine_gravel'); break
    case 'obsidian': out.add('mine_obsidian'); out.add('cast_obsidian'); out.add('fill_bucket(water)'); break
    default: if (item.endsWith('_log')) out.add('gather_wood'); else if (item === 'stick') wanted(obs, 'sticks', n, out, depth)
  }
  return out
}

// A scripted route to one more `item` (the chain teacher's craftNext/getIron shape, generalised over the tables).
function acquire(obs, item, depth = 0) {
  if (depth > 8) return null
  const c = counts(obs)
  const dig = () => c.hasPickaxe && obs.pos.y > 14 ? 'explore_toward(down)' : 'explore_toward(surface)'
  const recipe = RECIPES[item]
  if (recipe) {
    for (const [ing, q] of Object.entries(recipe)) if (have(obs, ing) < q) return acquire(obs, ing, depth + 1)
    if (TABLE_ITEMS.has(item) && !tableHandy(obs, c)) {
      if (obs.base?.crafting_table && c.planks < 4) return 'return_to_base'
      return acquire(obs, 'crafting_table', depth + 1)
    }
    return optionId('craft', item)
  }
  if (item === 'log' || item.endsWith('_log')) return seen(obs, isLog, 48) ? 'gather_wood' : 'explore_toward(surface)'
  if (item === 'stick') return acquire(obs, 'sticks', depth + 1)
  switch (item) {
    case 'cobblestone': return !c.hasPickaxe ? acquire(obs, 'wooden_pickaxe', depth + 1) : seen(obs, isStone, 16) ? 'mine_stone' : dig()
    case 'coal': return seen(obs, isCoal, 32) ? 'mine_coal' : dig()
    case 'raw_iron':
      if (!c.hasStonePickaxe) return acquire(obs, 'stone_pickaxe', depth + 1)
      return seen(obs, isIron, 32) || obs.memory?.ironSeen ? 'mine_iron' : dig()
    case 'iron_ingot': {
      if (c.rawIron === 0) return acquire(obs, 'raw_iron', depth + 1)
      if (!furnaceNear(obs) && c.furnace === 0) return acquire(obs, 'furnace', depth + 1)
      if (!hasFuel(c)) return seen(obs, isCoal, 32) ? 'mine_coal' : acquire(obs, 'planks', depth + 1)
      return 'smelt(iron_ingot)'
    }
    case 'diamond':
      if (!c.hasIronPickaxe) return acquire(obs, 'iron_pickaxe', depth + 1)
      return seen(obs, isDiamond, 32) || obs.memory?.diamondSeen ? 'mine_diamond' : 'explore_toward(deep)'
    case 'flint': return seen(obs, isGravel, 16) ? 'mine_gravel' : 'explore_toward(surface)'
    case 'obsidian':
      if (c.hasDiamondPickaxe && seen(obs, isObsidian, 16)) return 'mine_obsidian'
      if (c.waterBucket && (seen(obs, isLava, 24) || obs.memory?.lavaSeen)) return 'cast_obsidian'
      if (c.bucket && (seen(obs, isWater, 24) || obs.memory?.waterSeen)) return 'fill_bucket(water)'
      return 'explore_toward(deep)'
    default: return null
  }
}

const tableDist = obs => obs.base?.crafting_table?.dist ?? null
const nearBase = obs => { const d = tableDist(obs); return d != null && d <= NEAR_BASE }
function baseStep(obs, label) {
  const d = tableDist(obs)
  const local = d == null ? 1 : d > 64 ? 1 : d > 32 ? 2 : d > 16 ? 3 : d > NEAR_BASE ? 4 : 5
  return { index: local, of: 4, text: d == null ? `${label} (no base known)` : `${label} (${Math.round(d)} m away)` }
}
const DAY = new Set(['morning', 'midday', 'afternoon'])
// Plan-book vocabularies (agent/recipes.js): a species of planks is counted exactly (a wood-specific recipe never
// plans on another wood's planks); MINE items come through the plugin's mine(<block>) options; a non-legacy craft
// through craft_item(<item>).
const exactPlanks = item => item !== 'planks' && item.endsWith('_planks')
const gHave = (obs, item) => exactPlanks(item) ? (obs.inventory?.[item] || 0) : have(obs, item)
const mined = item => !!MINE[item]
const mineRelevant = item => { const ids = new Set(MINE[item].blocks.map(b => `mine(${b})`)); return id => ids.has(id) }
const legacyCraft = item => !!RECIPES[item]
const moves = opts => opts.map(o => o.id).filter(isMove)
const huntVerb = item => HUNT[item]?.via === 'shear' ? 'shear' : 'hunt'
const playerOf = arg => { const m = /^player:(\w{1,16})$/.exec(arg ?? ''); return m ? m[1] : null }
const giver = g => g?.from ?? 'a player'

// Each kind: done(obs, arg, count), filter(obs, arg, options, count), step(obs, arg, count) -> {index, of, text} with
// index of+1 meaning done, teacher(obs, arg, count) -> id|null (optional), describe(obs, arg, count) -> text, stuckS
// (seconds, or a function of (arg, count)). The two defaults are never pushed. The stack passes the goal entry as a
// last argument to each (receive's describe reads g.from; the plugin filters hand it to the option provider).
export const GOAL_KINDS = {
  chain: {
    done: obs => stageOf(obs).done, filter: (obs, arg, opts) => opts, step: obs => chainStep(obs),
    teacher: obs => teacherSubtask(obs), describe: obs => describeChain(obs), stuckS: Infinity,
  },
  iron_pickaxe: {
    done: obs => !!obs.inventory?.iron_pickaxe, filter: (obs, arg, opts) => opts, step: obs => techStep(obs),
    teacher: obs => teacherSubtask(obs), describe: () => null, stuckS: Infinity,   // serialize.js keeps its experiment-1 line
  },
  // A legacy RECIPES key keeps experiment 1 / chain behaviour (count ignored); any other minecraft-data recipe is
  // crafted by the plugin's craft_item(<item>) option, its ingredients coming from earlier plan steps.
  craft_item: {
    done: (obs, item, count) => have(obs, item) >= (legacyCraft(item) ? 1 : count ?? 1),
    filter: (obs, item, opts, count, g) => legacyCraft(item)
      ? keepOnly(opts, new Set([...wanted(obs, item, 1, new Set()), ...opts.map(o => o.id).filter(isMove)]))
      : keepWithPlugins(obs, goalOf('craft_item', item, count, g), opts, new Set([...opts.filter(isLegacyWork).map(o => o.id), ...moves(opts)]),
        id => id === `craft_item(${item})`),
    // 1..4 by the share of the direct ingredients held, 5 once craftable (6 = done); non-legacy: 1..4 by the count held
    step: (obs, item, count) => {
      if (!legacyCraft(item)) {
        const n = have(obs, item), c = count ?? 1
        if (n >= c) return { index: 6, of: 5, text: `${humanize(item)} crafted` }
        return { index: 1 + Math.min(3, Math.floor(4 * n / c)), of: 5, text: `craft ${c > 1 ? `${c} ` : ''}${humanize(item)} (have ${n})` }
      }
      if (have(obs, item) >= 1) return { index: 6, of: 5, text: `${humanize(item)} crafted` }
      const recipe = Object.entries(RECIPES[item] || {})
      const total = recipe.reduce((n, [, q]) => n + q, 0)
      const held = recipe.reduce((n, [ing, q]) => n + Math.min(q, have(obs, ing)), 0)
      if (held >= total) return { index: 5, of: 5, text: `craft ${humanize(item)}` }
      const short = recipe.filter(([ing, q]) => have(obs, ing) < q).map(([ing, q]) => `${q} ${humanize(ing)} (have ${have(obs, ing)})`)
      return { index: 1 + Math.min(3, Math.floor(4 * held / Math.max(1, total))), of: 5, text: `get the ingredients for ${humanize(item)}: ${short.join(', ')}` }
    },
    teacher: (obs, item, count, g) => legacyCraft(item) ? acquire(obs, item)
      : firstPlugin(obs, goalOf('craft_item', item, count, g), id => id === `craft_item(${item})`),
    describe: (obs, item, count) => legacyCraft(item) ? `craft ${humanize(item)}`
      : `craft ${(count ?? 1) > 1 ? `${count} ` : ''}${humanize(item)} (have ${have(obs, item)})`,
    stuckS: 300,
  },
  gather: {
    done: (obs, item, count) => gHave(obs, item) >= count,
    filter: (obs, item, opts, count, g) => mined(item)
      ? keepWithPlugins(obs, goalOf('gather', item, count, g), opts, new Set(moves(opts)), mineRelevant(item))
      : exactPlanks(item) ? keepOnly(opts, new Set(['gather_wood', 'craft(planks)', ...moves(opts)]))
      : keepOnly(opts, new Set([PRODUCERS[item], ...wanted(obs, item, count - have(obs, item), new Set()), ...moves(opts)])),
    // fifths of the count held: 1..5 (6 = done)
    step: (obs, item, count) => ({ index: fifths(gHave(obs, item), count), of: 5,
      text: `gather ${count} ${humanize(item)} (have ${gHave(obs, item)})` }),
    teacher: (obs, item, count, g) => mined(item) ? firstPlugin(obs, goalOf('gather', item, count, g), mineRelevant(item))
      : exactPlanks(item) ? (have(obs, 'log') > 0 ? 'craft(planks)' : acquire(obs, 'log')) : acquire(obs, item),
    describe: (obs, item, count) => `gather ${count} ${humanize(item)} (have ${gHave(obs, item)})`,
    stuckS: (item, count) => Math.max(300, Math.min(600, 20 * count)),
  },
  find: {
    done: (obs, block) => seen(obs, FIND_MATCH[block] || (n => n === block), FIND_RANGE),
    filter: (obs, block, opts) => keepOnly(opts, new Set(['mine_stone', ...opts.map(o => o.id).filter(isMove)])),
    step: (obs, block) => GOAL_KINDS.find.done(obs, block) ? { index: 2, of: 1, text: `${humanize(block)} found` } : { index: 1, of: 1, text: `find ${humanize(block)}` },
    // diamond ore: explore_toward(deep) digs down and, at diamond level, tunnels along it (never back to the surface)
    teacher: (obs, block) => block === 'diamond_ore' ? 'explore_toward(deep)'
      : block === 'iron_ore' || block === 'coal_ore' || block === 'lava' ? 'explore_toward(down)' : 'explore_toward(surface)',
    describe: (obs, block) => `find ${humanize(block)}`,
    stuckS: 480,
  },
  // go_to(player:<name>): walk to a player (the plugin's go_to_player(<name>)), done within 3 m (obs.players).
  go_to: {
    done: (obs, place) => {
      const who = playerOf(place)
      if (who) return (obs.players?.[who]?.dist ?? Infinity) <= 3
      const y = goToY(place)
      if (y != null) return Math.abs((obs.pos?.y ?? 0) - y) <= 2
      return place === 'base' ? nearBase(obs) : place === 'surface' ? !obs.underground : (obs.pos?.y ?? 0) <= DIAMOND_LEVEL_Y
    },
    // The night refuges stay at dusk/night on the surface (options() withholds the surface work because one is offered)
    // and explore_toward(surface) stays under low air (it is the way out of the water): never only wait.
    filter: (obs, place, opts, count, g) => {
      const who = playerOf(place)
      if (who) return keepWithPlugins(obs, goalOf('go_to', place, count, g), opts, new Set(), id => id === `go_to_player(${who})`)
      const y = goToY(place)
      const above = y != null ? (obs.pos?.y ?? 0) > y : place !== 'surface'
      return keepOnly(opts, new Set(place === 'base' ? opts.map(o => o.id).filter(isMove)
        : [...(above ? ['explore_toward(deep)', 'explore_toward(down)'] : ['explore_toward(surface)']),
          ...(nightOnSurface(obs) ? NIGHT_REFUGES : []), ...((obs.oxygen ?? 20) <= LOW_AIR ? ['explore_toward(surface)'] : [])]))
    },
    step: (obs, place) => {
      const who = playerOf(place)
      if (who) {
        const d = obs.players?.[who]?.dist
        if (d != null && d <= 3) return { index: 5, of: 4, text: `with ${who}` }
        return { index: d == null || d > 64 ? 1 : d > 32 ? 2 : d > 16 ? 3 : 4, of: 4, text: d == null ? `go to ${who} (not in sight)` : `go to ${who} (${Math.round(d)} m away)` }
      }
      const y = goToY(place)
      if (y != null) {
        const cur = obs.pos?.y ?? 0
        return Math.abs(cur - y) <= 2 ? { index: 2, of: 1, text: `at y ${y}` } : { index: 1, of: 1, text: `go to y ${y}, now at y ${Math.round(cur)}` }
      }
      if (place === 'base') return baseStep(obs, 'go to base')
      if (place === 'surface') return obs.underground ? { index: 1, of: 1, text: 'go to the surface' } : { index: 2, of: 1, text: 'on the surface' }
      // every 16 m of descent from y 64 is a step: 1..8, 9 at diamond level
      const cur = obs.pos?.y ?? 0
      if (cur <= DIAMOND_LEVEL_Y) return { index: 9, of: 8, text: 'at diamond level' }
      return { index: 1 + Math.max(0, Math.min(7, Math.floor((64 - cur) / 16))), of: 8, text: `go down to diamond level (y -58), now at y ${Math.round(cur)}` }
    },
    teacher: (obs, place) => {
      if (playerOf(place)) return `go_to_player(${playerOf(place)})`
      const y = goToY(place)
      if (y != null) return (obs.pos?.y ?? 0) > y ? (counts(obs).hasIronPickaxe ? 'explore_toward(deep)' : 'explore_toward(down)') : 'explore_toward(surface)'
      return place === 'base' ? 'return_to_base' : place === 'surface' ? 'explore_toward(surface)'
        : counts(obs).hasIronPickaxe ? 'explore_toward(deep)' : 'explore_toward(down)'
    },
    describe: (obs, place) => {
      if (playerOf(place)) return `go to ${playerOf(place)}`
      const y = goToY(place)
      if (y != null) return `go to y ${y}`
      return place === 'diamond_level' ? 'go to diamond level' : place === 'base' ? 'go to base' : 'go to the surface'
    },
    stuckS: place => playerOf(place) ? 120 : 240,
  },
  survive_night: {
    done: obs => DAY.has(obs.phase),
    filter: (obs, arg, opts) => opts,   // the night protocol already shapes the list
    step: obs => DAY.has(obs.phase) ? { index: 2, of: 1, text: 'morning' } : { index: 1, of: 1, text: 'wait out the night' },
    teacher: obs => teacherSubtask(obs),
    describe: () => 'survive the night',
    stuckS: Infinity,
  },
  return_to_base: {
    done: obs => nearBase(obs),
    filter: (obs, arg, opts) => opts,
    step: obs => baseStep(obs, 'return to base'),
    teacher: () => 'return_to_base',
    describe: () => 'return to base',
    stuckS: 180,
  },
  build: {
    done: (obs, s) => s === 'portal_frame' && !!obs.portalFrame,
    filter: (obs, s, opts) => keepOnly(opts, new Set(['build_portal', 'light_portal', 'mine_obsidian', 'cast_obsidian', 'fill_bucket(water)',
      'mine_gravel', ...opts.filter(o => o.name === 'craft').map(o => o.id), ...opts.map(o => o.id).filter(isMove)])),
    // obsidian held plus placed, 1..11 (12 = frame complete)
    step: obs => {
      if (obs.portalFrame) return { index: 12, of: 11, text: 'portal frame built' }
      const n = Math.min(10, (obs.inventory?.obsidian || 0) + (obs.memory?.portal?.placed || 0))
      return { index: 1 + n, of: 11, text: `build a nether portal frame (${n} of 10 obsidian)` }
    },
    teacher: obs => teacherSubtask(obs),   // the chain teacher's stage 4; outside it the pick is usually filtered out (null)
    describe: () => 'build a nether portal frame',
    stuckS: 600,
  },
  // hunt(<drop>, n): arg is the drop (recipes.HUNT key: white_wool, leather, ...); the plugin's hunt(<mob>) options.
  hunt: {
    done: (obs, item, count) => have(obs, item) >= count,
    filter: (obs, item, opts, count, g) => keepWithPlugins(obs, goalOf('hunt', item, count, g), opts, new Set(moves(opts)),
      id => HUNT[item].mobs.some(m => id === `hunt(${m})`)),
    step: (obs, item, count) => ({ index: fifths(have(obs, item), count), of: 5, text: GOAL_KINDS.hunt.describe(obs, item, count) }),
    teacher: (obs, item, count, g) => firstPlugin(obs, goalOf('hunt', item, count, g), id => HUNT[item].mobs.some(m => id === `hunt(${m})`))
      ?? `hunt(${HUNT[item].mobs[0]})`,
    describe: (obs, item, count) => `${huntVerb(item)} ${HUNT[item].mobs[0]} for ${count} ${humanize(item)} (have ${have(obs, item)})`,
    stuckS: 300,
  },
  // smelt_item(<product>, n): recipes.SMELT products (iron_ingot stays gather(iron_ingot)); a furnace, fuel, then the
  // plugin's smelt_item(<product>). The input comes from an earlier plan step.
  smelt_item: {
    done: (obs, item, count) => have(obs, item) >= count,
    filter: (obs, item, opts, count, g) => {
      const keep = new Set(['gather_wood', 'mine_coal', ...moves(opts)]), noFurnace = !furnaceNear(obs) && counts(obs).furnace === 0
      if (noFurnace) wanted(obs, 'furnace', 1, keep)
      return keepWithPlugins(obs, goalOf('smelt_item', item, count, g), opts, keep,
        id => id === `smelt_item(${item})` || (noFurnace && id === 'craft_item(furnace)'))
    },
    step: (obs, item, count) => ({ index: fifths(have(obs, item), count), of: 5, text: `smelt ${count} ${humanize(item)} (have ${have(obs, item)})` }),
    teacher: (obs, item) => {
      const c = counts(obs)
      if (!furnaceNear(obs) && c.furnace === 0) return acquire(obs, 'furnace')
      if (!hasFuel(c)) return seen(obs, isCoal, 32) ? 'mine_coal' : acquire(obs, 'log')
      return have(obs, SMELT[item]) >= 1 ? `smelt_item(${item})` : null
    },
    describe: (obs, item, count) => `smelt ${count} ${humanize(item)} (have ${have(obs, item)})`,
    stuckS: 300,
  },
  // receive(<item>, n) from a player (goal.from): the plugin's receive(<item>) waits for the drop and picks it up.
  receive: {
    done: (obs, item, count) => have(obs, item) >= count,
    filter: (obs, item, opts, count, g) => keepWithPlugins(obs, goalOf('receive', item, count, g), opts, new Set(), id => id === `receive(${item})`),
    step: (obs, item, count, g) => ({ index: fifths(have(obs, item), count), of: 5, text: GOAL_KINDS.receive.describe(obs, item, count, g) }),
    teacher: (obs, item) => `receive(${item})`,
    describe: (obs, item, count, g) => `get ${count} ${humanize(item)} from ${giver(g)} (have ${have(obs, item)})`,
    stuckS: 90,
  },
}
const stuckOf = (k, g) => typeof GOAL_KINDS[k].stuckS === 'function' ? GOAL_KINDS[k].stuckS(g.arg, g.count) : GOAL_KINDS[k].stuckS
const DEFAULTS = new Set(['chain', 'iron_pickaxe'])

// The option layer's gathering caps (agent/subtasks.js options()): a gather goal above them could never finish, so
// its count is clamped. Logs count as log-equivalents there (woodEq < 12).
export const GATHER_CAPS = { log: 12, cobblestone: 32, obsidian: 10 }
const capOf = item => item === 'log' || item.endsWith('_log') ? GATHER_CAPS.log : GATHER_CAPS[item] ?? null
// Stage gates (chain stage index, agent/stages.js): mine_gravel is offered only at stage 4 and explore_toward(deep) /
// mine_diamond only from stage 3, so goals that need them are refused earlier (with obs; without obs, not checked).
const DIAMOND_GOAL = (kind, arg) => (kind === 'gather' && arg === 'diamond') || (kind === 'go_to' && arg === 'diamond_level')
  || (kind === 'find' && arg === 'diamond_ore')

// {ok: true} | {ok: true, goal, note} (the goal clamped; note says why, for the chat reply) | {ok: false, reason}
// (reason phrased for the audience). obs (optional) enables the stage gates.
const countOk = n => Number.isInteger(n) && n >= 1 && n <= 64
const BAD_COUNT = { ok: false, reason: 'count must be an integer from 1 to 64' }
// Items the MINE table knows but a gather goal refuses (emerald ore: mountains only, too rare to search for).
const NOT_GATHERED = { emerald: 'cannot gather emerald (too rare)' }
export function validateGoal({ kind, arg, count, from } = {}, obs = null) {
  if (!GOAL_KINDS[kind]) return { ok: false, reason: `unknown goal kind ${kind}` }
  if (DEFAULTS.has(kind)) return { ok: false, reason: `${kind} is the default goal and cannot be pushed` }
  const stage = obs ? stageOf(obs).index : null
  if (stage != null && DIAMOND_GOAL(kind, arg) && stage < 3)
    return { ok: false, reason: obs.inventory?.iron_pickaxe ? 'needs iron tools and full iron armor first' : 'needs an iron pickaxe first' }
  switch (kind) {
    case 'craft_item':
      if (RECIPES[arg]) return { ok: true }
      if (!isItem(arg)) return { ok: false, reason: `unknown item ${arg}` }
      if (producerOf(arg)?.kind !== 'craft_item') return { ok: false, reason: `cannot craft ${humanize(arg)}` }
      return count == null || countOk(count) ? { ok: true } : BAD_COUNT
    case 'gather': {
      if (NOT_GATHERED[arg]) return { ok: false, reason: NOT_GATHERED[arg] }
      if (!PRODUCERS[arg] && producerOf(arg)?.kind !== 'gather') return { ok: false, reason: `cannot gather ${arg}` }
      if (!countOk(count)) return BAD_COUNT
      if (arg === 'flint' && stage != null && stage < 4) return { ok: false, reason: 'flint comes later, when the bot builds the portal' }
      const cap = capOf(arg)
      if (cap != null && count > cap) return { ok: true, goal: { kind, arg, count: cap }, note: `capped at ${cap} ${humanize(arg)}` }
      return { ok: true }
    }
    case 'find':
      if (FINDABLE_NOW.includes(arg)) return { ok: true }
      return { ok: false, reason: DECLARED_FINDABLE.includes(arg) ? 'no detector yet' : `cannot find ${arg}` }
    case 'build':
      if (!STRUCTURES[arg]) return { ok: false, reason: `cannot build ${arg}` }
      return STRUCTURES[arg].executor ? { ok: true } : { ok: false, reason: 'no executor yet' }
    case 'hunt':
      if (!HUNT[arg]) return { ok: false, reason: 'hunt needs a hunted drop (white_wool, leather, ...)' }
      return countOk(count) ? { ok: true } : BAD_COUNT
    case 'smelt_item':
      if (!SMELT[arg]) return { ok: false, reason: `cannot smelt ${arg}` }
      return countOk(count) ? { ok: true } : BAD_COUNT
    case 'receive':
      if (!isItem(arg)) return { ok: false, reason: `unknown item ${arg}` }
      if (!countOk(count)) return BAD_COUNT
      return typeof from === 'string' && /^\w{1,16}$/.test(from) ? { ok: true } : { ok: false, reason: 'receive needs the name of the player giving it' }
    case 'go_to': {
      if (PLACES.includes(arg) || playerOf(arg)) return { ok: true }
      const y = goToY(arg)
      if (y != null) return y >= -64 && y <= 320 ? { ok: true } : { ok: false, reason: 'y must be between -64 and 320' }
      return { ok: false, reason: `cannot go to ${arg}` }
    }
    default: return { ok: true }   // survive_night, return_to_base: no argument
  }
}

// The night rule for pushes: gather, find and go_to(surface) at dusk or night on the surface would send the bot into
// the night protocol's withheld work; the runner answers them as cannot ("until morning") instead of pushing.
export const isDuskOrNight = obs => obs?.phase === 'dusk' || obs?.phase === 'night'
export function nightBlocksGoal({ kind, arg } = {}, obs) {
  if (!obs || !isDuskOrNight(obs) || obs.underground) return false
  return kind === 'gather' || kind === 'find' || (kind === 'go_to' && arg === 'surface')
}

// The stuck clock pauses at dusk/night on the surface while the filtered list offers no producer of the top goal:
// nothing but the always-kept options and the night refuges (the night protocol withheld the work).
export function nightPaused(obs, filtered) {
  if (!isDuskOrNight(obs) || obs.underground) return false
  const refuge = new Set(NIGHT_REFUGES)
  return !filtered.some(o => !ALWAYS.has(o.id) && !refuge.has(o.id))
}

const sourceText = src => !src ? 'Goal' : src === 'leader' ? 'Goal from the leader'
  : src.startsWith('audience:') ? `Goal from the audience (${src.slice('audience:'.length)})` : `Goal (${src})`
// plan_id, step_index and from appear only on plan-book and receive goals (the leader's own goals keep their shape).
const pub = g => ({ kind: g.kind, arg: g.arg ?? null, count: g.count ?? null, source: g.source, id: g.id,
  ...(g.plan_id != null || g.from != null ? { plan_id: g.plan_id ?? null, step_index: g.step_index ?? null, from: g.from ?? null } : {}) })

// The stack: entries [default, ...pushed], top last. update() pops finished (goal_done) and stuck (goal_failed) goals.
export class GoalStack {
  constructor({ goal = 'iron_pickaxe' } = {}) {
    const kind = goal === 'nether' ? 'chain' : 'iron_pickaxe'
    this.stack = [{ kind, arg: null, count: null, source: kind, id: 0, t: 0, best: null, progressT: null }]
    this.nextId = 1
  }
  top() { return this.stack[this.stack.length - 1] }
  depth() { return this.stack.length - 1 }
  push({ kind, arg = null, count = null, source = 'leader', t = null, obs = null, plan_id = null, step_index = null, from = null }) {
    const v = validateGoal({ kind, arg, count, from }, obs)
    if (!v.ok) throw new Error(`invalid goal ${kind}(${arg ?? ''}): ${v.reason}`)
    if (v.goal) count = v.goal.count   // clamped
    const g = { kind, arg, count, source, id: this.nextId++, t, best: null, progressT: t, lastT: t, plan_id, step_index, from }
    this.stack.push(g)
    return g
  }
  pop(reason = null) {
    if (this.stack.length <= 1) return null
    const g = this.stack.pop()
    g.popReason = reason
    this.top().progressT = null   // the goal underneath restarts its stuck clock at the next update
    this.top().best = null
    return g
  }
  update(obs, t) {
    const events = []
    while (this.stack.length > 1) {
      const g = this.top(), K = GOAL_KINDS[g.kind]
      if (K.done(obs, g.arg, g.count, g)) { this.pop('done'); events.push({ kind: 'goal_done', goal: pub(g), t }); continue }
      const s = K.step(obs, g.arg, g.count, g).index
      if (g.best == null || s > g.best || g.progressT == null) {
        if (g.best == null || s > g.best) g.best = s
        g.progressT = t
      } else if (g.lastT != null && nightPaused(obs, K.filter(obs, g.arg, options(obs), g.count, g))) g.progressT += t - g.lastT   // the night rule: the clock stands still
      g.lastT = t
      if (t - g.progressT >= stuckOf(g.kind, g)) { this.pop('stuck'); events.push({ kind: 'goal_failed', goal: pub(g), t, reason: 'stuck' }); continue }
      break
    }
    return events
  }
  step(obs) {
    const g = this.top()
    const s = GOAL_KINDS[g.kind].step(obs, g.arg, g.count, g)
    return { ...s, index: 100 * this.depth() + s.index, goal_id: g.id }
  }
  describe(obs) {
    const base = GOAL_KINDS[this.stack[0].kind].describe(obs)
    if (this.stack.length === 1) return base
    const parts = this.stack.slice(1).reverse().map(g => `${sourceText(g.source)}: ${GOAL_KINDS[g.kind].describe(obs, g.arg, g.count, g)}.`)
    if (base) parts.push(base)
    return parts.join(' Then: ')
  }
  filter(obs, opts) {
    const g = this.top()
    return GOAL_KINDS[g.kind].filter(obs, g.arg, opts, g.count, g)
  }
  // The default entry's teacher as is (teacherSubtask validates against options itself). A pushed goal: threats, food
  // and the night protocol first, then the kind's teacher; null when the pick is not in the filtered list.
  teacher(obs) {
    const g = this.top(), K = GOAL_KINDS[g.kind]
    if (this.stack.length === 1) return K.teacher(obs, g.arg, g.count)
    if (!K.teacher) return null
    const offered = new Set(this.filter(obs, options(obs)).map(o => o.id))
    const th = teacherThreat(obs)
    const threat = th === 'fight' ? 'fight(threat)' : th === 'flee' ? 'flee(threat)' : th === 'pillar_up' ? 'pillar_up' : null
    if (threat && offered.has(threat)) return threat
    if (obs.food < 8 && offered.has('eat')) return 'eat'
    if ((nightOnSurface(obs) || shelterSoon(obs)) && offered.has('build_shelter')) return 'build_shelter'
    if (nightOnSurface(obs)) { const r = ['explore_toward(down)', 'return_to_base'].find(id => offered.has(id)); if (r) return r }
    const id = K.teacher(obs, g.arg, g.count, g)
    return id && offered.has(id) ? id : null
  }
}
