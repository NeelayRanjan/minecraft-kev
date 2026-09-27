// Producer tables and the recipe expander (pure). expandItem('compass', 1, inventory) turns a request into an ordered
// list of typed goal steps, net of the inventory, so the LLM leader never does the arithmetic.
//
// Producers, in priority order (producerOf): the legacy producers (goals.PRODUCERS: logs, planks, sticks, cobblestone,
// coal, raw_iron, iron_ingot, diamond, flint, obsidian; each is a `gather(<item>, n)` step whose option layer handles
// its own tools), the legacy recipes (goals.RECIPES: `craft_item` expanded through those tables, never through
// minecraft-data), then MINE (a gather step with a pickaxe tier), SMELT, HUNT, and finally a minecraft-data 1.20.4
// recipe. On the legacy path planks of any wood count toward `planks` (gathered as `planks`), logs likewise as `log`,
// and `sticks` is the item `stick`; a minecraft-data recipe with one variant per wood (a chest: any planks) is read on
// those generic names too (collapseWoods); only a recipe specific to one wood (oak_stairs) names its species, counted
// and gathered exactly (`gather(oak_planks, n)`; only the goals.WOODS species are producible).
//
// Ordering rule: tools first. A dry walk finds every tool the whole tree needs (the highest pickaxe tier of its MINE
// steps, a crafting table for a 3x3 recipe, a furnace for a smelt, shears for a shearing hunt); the real walk acquires
// them in that order before any material, so a plan reads "pickaxes, table, furnace, shears, materials, the item".
// Then the walk is post-order. A step is emitted after every step its inputs need: for a craft, first its
// ingredients in recipe order (first appearance in the grid, row by row; held units by exact name, so the
// variant whose wood the bot holds wins), then the crafting table if the grid is
// larger than 2x2; for a smelt, its input then the furnace; for a hunt, the shears (a hunt step names the drop and
// the drops needed, the goal kind's form: hunt(white_wool, 3)); for a MINE gather, the pickaxe
// tiers it lacks (to reach tier t the walk first reaches tier t-1: wooden before stone before iron). Steps with the
// same (kind, arg) merge: the count adds up and the step keeps the position of its first emission.
// The walk consumes a copy of the inventory as it allocates, and adds what it produces (surplus of a craft yield or a
// hunt, the crafted table, furnace, shears and pickaxes), so every quantity is net.
//
// Legacy ore gathers hoist their pickaxe tier like MINE steps (LEGACY_TIER: iron stone, diamond iron, obsidian diamond).
// Not modelled: furnace fuel (the smelt goal handles it), tools other than pickaxes and shears, deepslate variants.
// goals.js may import this module (a cycle): the goals tables are only read inside functions, never at load time.
import mcDataFor from 'minecraft-data'
import { PRODUCERS, RECIPES, WOODS } from './goals.js'
import { TABLE_ITEMS } from './subtasks.js'
import { materials, validate, cells } from './blueprints.js'
import { TEMPLATES, templateMaterials } from './templates.js'

const md = mcDataFor('1.20.4')

export const MINE = {   // drop item -> how to get it (items already produced by a legacy option are NOT here: see goals.PRODUCERS)
  raw_copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], tool: 'stone', where: 'ore' },
  raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], tool: 'iron', where: 'ore' },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], tool: 'iron', where: 'ore' },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], tool: 'stone', where: 'ore' },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], tool: 'iron', where: 'ore' },
  sand: { blocks: ['sand'], tool: 'none', where: 'surface' }, gravel: { blocks: ['gravel'], tool: 'none', where: 'surface' },
  dirt: { blocks: ['dirt', 'grass_block'], tool: 'none', where: 'surface' }, clay_ball: { blocks: ['clay'], tool: 'none', where: 'surface' },
  cobblestone: null, coal: null, raw_iron: null, diamond: null, flint: null, obsidian: null,   // legacy: goals.PRODUCERS
}
export const SMELT = { copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', glass: 'sand', stone: 'cobblestone', charcoal: 'log', brick: 'clay_ball',
  smooth_stone: 'stone', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton' }   // iron_ingot stays legacy smelt(iron_ingot)
export const HUNT = { white_wool: { mobs: ['sheep'], via: 'shear', tool: 'shears', per: 2 }, mutton: { mobs: ['sheep'], via: 'kill', per: 1 },
  leather: { mobs: ['cow'], via: 'kill', per: 1 }, beef: { mobs: ['cow'], via: 'kill', per: 2 }, porkchop: { mobs: ['pig'], via: 'kill', per: 2 },
  feather: { mobs: ['chicken'], via: 'kill', per: 1 }, chicken: { mobs: ['chicken'], via: 'kill', per: 1 }, string: { mobs: ['spider'], via: 'kill', per: 1 },
  ink_sac: { mobs: ['squid'], via: 'kill', per: 2 } }
export const TOOL_TIER = { none: 0, wood: 1, stone: 2, iron: 3, diamond: 4 }
const PICKAXE_TIER = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 4 }
const PICKAXE_FOR = { 1: 'wooden_pickaxe', 2: 'stone_pickaxe', 3: 'iron_pickaxe', 4: 'diamond_pickaxe' }
const MAX_COUNT = 64
// The pickaxe tier a legacy ore gather needs (final review: gather(diamond) was planned with no iron pickaxe hoisted,
// and the stage gate refused it later). cobblestone and coal keep the legacy option layer's own wooden pickaxe.
const LEGACY_TIER = { raw_iron: 2, iron_ingot: 2, diamond: 3, obsidian: 4, flint: 0 }

// Wood: the generic names `log`, `planks`, `sticks`/`stick` (the legacy path: goals.RECIPES ingredients, the legacy
// gathers, charcoal's input) accept any species, held units counted over every `*_log` / `*_planks`. A species name
// (`oak_planks`, what every minecraft-data recipe names, one variant recipe per wood for tag ingredients) is counted
// and gathered by its exact name, so a wood-specific recipe (oak_stairs, oak_boat) never plans on birch planks.
const GENERIC = { log: 'log', planks: 'planks', sticks: 'stick', stick: 'stick' }
const group = item => GENERIC[item] ?? (item.endsWith('_log') ? 'log' : item.endsWith('_planks') ? 'planks' : item)
const isSpecies = item => item.endsWith('_log') || item.endsWith('_planks')
const woodOk = item => WOODS.some(w => item === `${w}_log` || item === `${w}_planks`)   // gather_wood can reach it

export function tierHeld(inventory = {}) {
  let best = 0
  for (const [name, t] of Object.entries(PICKAXE_TIER)) if ((inventory[name] || 0) > 0 && t > best) best = t
  return best
}

export const isItem = name => typeof name === 'string' && md.itemsByName[name] !== undefined

// minecraft-data recipes as { ingredients: [[name, perCraft]] in recipe order, yield, table }.
const recipeCache = new Map()
function mdRecipes(item) {
  if (recipeCache.has(item)) return recipeCache.get(item)
  const id = md.itemsByName[item]?.id
  const out = (id === undefined ? [] : md.recipes[id] || []).map(r => {
    const cells = r.inShape ? r.inShape.flat() : r.ingredients || []
    const q = new Map()
    for (const c of cells) if (c !== null && c !== undefined) { const n = md.items[c].name; q.set(n, (q.get(n) || 0) + 1) }
    const table = r.inShape ? r.inShape.length > 2 || r.inShape.some(row => row.length > 2) : cells.length > 4
    return { ingredients: [...q], yield: r.result.count || 1, table }
  })
  const collapsed = collapseWoods(out)
  recipeCache.set(item, collapsed)
  return collapsed
}
// Tag recipes (a chest, a barrel, a crafting table: "any planks") come from minecraft-data as one variant per wood.
// Variants that differ only in the wood species collapse into one recipe on the generic names (planks, log), so a
// plan gathers whatever wood grows nearby (final review: a chest in a birch forest asked for oak planks and never
// progressed). A recipe with a single variant (oak_stairs, oak_boat) keeps its exact species. Pure.
function collapseWoods(recipes) {
  const generic = n => n.endsWith('_planks') ? 'planks' : n.endsWith('_log') ? 'log' : n
  const sig = r => JSON.stringify([r.ingredients.map(([n, q]) => [generic(n), q]), r.yield, r.table])
  const groups = new Map()
  for (const r of recipes) { const k = sig(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r) }
  const out = [], done = new Set()
  for (const r of recipes) {
    const k = sig(r)
    if (done.has(k)) continue
    done.add(k)
    const g = groups.get(k)
    if (g.length < 2) { out.push(r); continue }
    const q = new Map()
    for (const [n, c] of r.ingredients) { const gn = generic(n); q.set(gn, (q.get(gn) || 0) + c) }
    out.push({ ingredients: [...q], yield: r.yield, table: r.table })
  }
  return out
}

export function producerOf(item) {
  if (typeof item !== 'string') return null
  if (GENERIC[item]) return { kind: 'gather', item: GENERIC[item] }
  if (isSpecies(item)) return woodOk(item) ? { kind: 'gather', item } : null
  if (PRODUCERS[item]) return { kind: 'gather', item }
  if (RECIPES[item]) return { kind: 'craft_item', item, legacy: true }
  if (MINE[item]) return { kind: 'gather', item, mine: MINE[item] }
  if (SMELT[item]) return { kind: 'smelt_item', item, input: SMELT[item] }
  if (HUNT[item]) return { kind: 'hunt', item, ...HUNT[item] }
  const recipes = mdRecipes(item)
  return recipes.length ? { kind: 'craft_item', item, recipes: recipes.length } : null
}

// Which items can be produced at all: a least fixed point over the whole recipe graph, computed once (a recipe counts
// when all its ingredients are producible), so cycles (iron_nugget <-> iron_ingot, bed and wool dyeing) terminate.
let producibleSet = null
function producible(item) {
  if (!producibleSet) {
    producibleSet = new Set()
    const pending = []
    for (const { name } of md.itemsArray) {
      const p = producerOf(name)
      if (!p) continue
      if (p.kind === 'craft_item' && !p.legacy) pending.push(name); else producibleSet.add(name)
    }
    // Smelt inputs and legacy recipe ingredients are all producers already; only minecraft-data recipes iterate.
    for (let changed = true; changed;) {
      changed = false
      for (let i = pending.length - 1; i >= 0; i--) {
        const name = pending[i]
        if (mdRecipes(name).some(r => r.ingredients.every(([n]) => producible(n)))) { producibleSet.add(name); pending.splice(i, 1); changed = true }
      }
    }
  }
  return producibleSet.has(item) || !!GENERIC[item]
}

// The first leaf that cannot be produced, descending through the first recipe of an unproducible item.
function missingLeaf(item, seen = new Set()) {
  if (seen.has(item)) return item
  seen.add(item)
  if (!producerOf(item)) return item
  for (const [n] of mdRecipes(item)[0]?.ingredients || []) if (!producible(n)) return missingLeaf(n, seen)
  return item
}

export function expandItem(item, count, inventory = {}, { placed = { crafting_table: false, furnace: false } } = {}) {
  if (typeof item !== 'string' || !item) return { steps: [], missing: [String(item)], tree: '' }
  const n0 = Math.floor(Number(count))
  if (!Number.isFinite(n0) || n0 <= 0) return { steps: [], missing: [], tree: '' }   // 0, negatives, NaN: nothing to do
  const want = Math.min(MAX_COUNT, n0)
  // Two walks: a dry one finds the tools the whole tree needs (the pickaxe tier of its MINE steps, a crafting table, a
  // furnace, shears); the real one acquires them first, in that order, then walks the materials.
  return walk([[item, want]], inventory, placed)
}

// The materials of `count` of an item without the final craft (live retry session: "enough leather for a leather
// helmet, don't craft it" planned 1 leather): the ingredients of its recipe (legacy table, else the minecraft-data
// recipe that uses the most held ingredients), times the crafts, expanded net of the inventory as expandItem does; a
// smelted item's input; any other item (mined, hunted, gathered) is its own material (expandItem). No station for the
// final craft is planned. -> { steps, missing, tree }
export function expandMaterials(item, count, inventory = {}, { placed = { crafting_table: false, furnace: false } } = {}) {
  const p = producerOf(item)
  const n = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(count)) || 1))
  if (p?.kind === 'smelt_item') return walk([[p.input, n]], inventory, placed)
  if (p?.kind !== 'craft_item') return expandItem(item, n, inventory, { placed })
  let recipe
  if (p.legacy) recipe = { ingredients: Object.entries(RECIPES[item]).map(([k, q]) => [GENERIC[k] === 'stick' ? 'stick' : k, q]), yield: 1 }
  else {
    const usable = mdRecipes(item).filter(rc => rc.ingredients.every(([k]) => producible(k)))
    if (!usable.length) return { steps: [], missing: [missingLeaf(item)], tree: '' }
    const held = k => inventory[k] || 0
    recipe = usable.reduce((best, rc) => rc.ingredients.reduce((s, [k, q]) => s + Math.min(held(k), q), 0) > best.ingredients.reduce((s, [k, q]) => s + Math.min(held(k), q), 0) ? rc : best)
  }
  const crafts = Math.ceil(n / (recipe.yield || 1))
  return walk(recipe.ingredients.map(([k, q]) => [k, q * crafts]), inventory, placed)
}

// The two walks over a list of targets [[item, n]] (in order), with extra tools to hoist (a dig's pickaxe tier).
function walk(targets, inventory, placed, extra = {}) {
  const dry = walkTree(targets, inventory, placed, null)
  if (dry.missing) return { steps: [], missing: [dry.missing], tree: dry.lines.join('\n') + `\n(missing: ${dry.missing})` }
  const tools = { ...dry.tools, tier: Math.max(dry.tools.tier, extra.tier ?? 0) }
  const r = walkTree(targets, inventory, placed, tools)
  if (r.missing) return { steps: [], missing: [r.missing], tree: r.lines.join('\n') + `\n(missing: ${r.missing})` }
  return { steps: r.steps, missing: [], tree: r.lines.join('\n') }
}

// Pricing a blueprint (agent/blueprints.js): a build takes its materials (a streamed template: every segment,
// templates.templateMaterials) plus `foundationCount` blocks of its material (the runner counts foundation(bp, blockAt)),
// through the same walk as expandItem (net of the inventory, tools hoisted), then the step build(<id>); a dig takes a
// stone pickaxe unless one of that tier is held, then dig(<id>). The id is the book's (`bp<n>`), passed in as opts.id.
// The blueprint is validated first: the 150-block cap only for free-form blueprints (no template); a streamed template
// skips the size caps per segment as validate's `streamed` does. -> { steps, missing, tree } | { steps: [], missing: [],
// reason } when the blueprint is refused.
export function expandBlueprint(bp, inventory = {}, { placed = { crafting_table: false, furnace: false }, foundationCount = 0, id = bp?.id } = {}) {
  const t = bp?.template && Object.hasOwn(TEMPLATES, bp.template) ? TEMPLATES[bp.template] : null
  const v = validate(bp, { maxBlocks: t ? Infinity : 150, streamed: !!t?.streamed })
  if (!v.ok) return { steps: [], missing: [], reason: v.reason }
  const last = { kind: bp.kind, arg: id, count: null }
  if (bp.kind === 'dig') {
    const r = walk([], inventory, placed, { tier: TOOL_TIER.stone })
    return r.missing.length ? r : { ...r, steps: [...r.steps, last] }
  }
  const mats = { ...(t?.streamed ? templateMaterials(bp.template, bp.params, bp.material) : materials(bp)) }
  if (foundationCount > 0) {
    const m = bp.material ?? majority(cells(bp).filter(c => c.layer === 0 && c.want !== 'air').map(c => c.want)) ?? Object.keys(mats)[0]
    if (m) mats[m] = (mats[m] ?? 0) + foundationCount
  }
  const r = walk(Object.entries(mats), inventory, placed)
  return r.missing.length ? r : { ...r, steps: [...r.steps, last] }
}
function majority(names) {
  const n = new Map()
  for (const x of names) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function walkTree(targets, inventory, placed, hoist) {
  const tools = { tier: 0, crafting_table: false, furnace: false, shears: false }
  const inv = { ...inventory }
  const steps = [], index = new Map(), lines = []
  const held = name => {
    const g = GENERIC[name]
    if (g)
      return Object.entries(inv).reduce((s, [k, v]) => s + (group(k) === g ? v : 0), 0)
    return inv[name] || 0
  }
  const take = (name, n) => {   // consume n (<= held) from the copy: the exact name first, then (generic names) any species
    const g = GENERIC[name]
    for (const k of [name, ...(g ? Object.keys(inv).filter(k => k !== name && group(k) === g) : [])]) {
      const t = Math.min(n, inv[k] || 0)
      inv[k] = (inv[k] || 0) - t; n -= t
      if (n === 0) return
    }
  }
  const give = (name, n) => { if (n > 0) inv[name] = (inv[name] || 0) + n }
  const emit = (kind, arg, n) => {
    const key = `${kind}(${arg})`
    if (index.has(key)) steps[index.get(key)].count += n
    else { index.set(key, steps.length); steps.push({ kind, arg, count: n }) }
  }
  const stack = new Set()
  let missing = null

  // Make `n` of `name` available in the copy, then consume them. Returns false (and sets `missing`) on a dead end.
  function need(name, n, depth) {
    if (missing) return false
    const have = Math.min(held(name), n)
    let r = n - have
    const pad = '  '.repeat(depth)
    if (have) take(name, have)
    if (r <= 0) { lines.push(`${pad}${name} x${n}: held`); return true }
    r -= unpack(name, r, pad)
    if (r <= 0) return true
    const p = producerOf(name)
    if (!p || !producible(name) || stack.has(name)) { missing = missingLeaf(name); return false }
    lines.push(`${pad}${name} x${r}${have ? ` (held ${have})` : ''} <- ${p.kind}`)
    stack.add(name)
    const ok = produce(name, r, p, depth + 1)
    stack.delete(name)
    return ok
  }
  // A held item that one 2x2 recipe turns into `name` (a storage block: redstone_block -> 9 redstone, iron_block -> 9
  // iron_ingot, coal_block -> 9 coal; live stress session: redstone blocks were offered for a compass and the plan mined
  // redstone) is crafted first, before any producer. Wood keeps the legacy path. Returns how many of the r it made.
  function unpack(name, r, pad) {
    if (GENERIC[name] || isSpecies(name)) return 0
    for (const rc of mdRecipes(name)) {
      if (rc.table || rc.ingredients.length !== 1) continue
      const [ing, q] = rc.ingredients[0]
      if (GENERIC[ing] || isSpecies(ing) || ing === name || stack.has(ing)) continue
      const crafts = Math.min(Math.floor(held(ing) / q), Math.ceil(r / rc.yield))
      if (crafts <= 0) continue
      const made = crafts * rc.yield, used = Math.min(r, made)
      take(ing, crafts * q)
      give(name, made - used)
      lines.push(`${pad}${name} x${used} <- craft_item from ${crafts * q} held ${ing}`)
      emit('craft_item', name, used)
      return used
    }
    return 0
  }
  const hasStation = s => !!placed?.[s] || held(s) > 0
  const station = (s, depth) => { tools[s] = true; return hasStation(s) || (need(s, 1, depth) && (give(s, 1), true)) }
  function tier(t, depth) {   // hold a pickaxe of tier >= t, reaching tier t-1 first
    if (tierHeld(inv) >= t) return true
    if (t > 1 && !tier(t - 1, depth)) return false
    const pick = PICKAXE_FOR[t]
    if (!need(pick, 1, depth)) return false
    give(pick, 1)
    return true
  }
  function produce(name, r, p, depth) {
    if (p.kind === 'gather') {
      const t = p.mine ? TOOL_TIER[p.mine.tool] : LEGACY_TIER[p.item] ?? 0
      if (t > 0) tools.tier = Math.max(tools.tier, t)
      if (t > 0 && !tier(t, depth)) return false
      emit('gather', p.item, r)
      return true
    }
    if (p.kind === 'smelt_item') {
      if (!need(p.input, r, depth) || !station('furnace', depth)) return false
      emit('smelt_item', name, r)
      return true
    }
    if (p.kind === 'hunt') {
      if (p.tool) tools.shears = true
      if (p.tool && !(held(p.tool) > 0 || (need(p.tool, 1, depth) && (give(p.tool, 1), true)))) return false
      const mobs = Math.ceil(r / p.per)
      give(name, mobs * p.per - r)
      emit('hunt', name, r)   // the goal kind's form: hunt(<drop>, <drops needed>) (goals.js)
      return true
    }
    // craft_item: the legacy table (yield 1: planks and sticks are gathered) or the best minecraft-data recipe
    let recipe
    if (p.legacy) recipe = { ingredients: Object.entries(RECIPES[name]).map(([n, q]) => [group(n), q]), yield: 1, table: TABLE_ITEMS.has(name) }
    else {
      const usable = mdRecipes(name).filter(rc => rc.ingredients.every(([n]) => producible(n) && !stack.has(n)))
      if (!usable.length) { missing = missingLeaf(name); return false }
      const score = rc => { const c = Math.ceil(r / rc.yield); return rc.ingredients.reduce((s, [n, q]) => s + Math.min(held(n), q * c), 0) }
      recipe = usable.reduce((best, rc) => score(rc) > score(best) ? rc : best)
    }
    const crafts = Math.ceil(r / recipe.yield)
    for (const [ing, q] of recipe.ingredients) if (!need(ing, q * crafts, depth)) return false
    if (recipe.table && !station('crafting_table', depth)) return false
    give(name, crafts * recipe.yield - r)
    emit('craft_item', name, r)
    return true
  }

  if (hoist) {   // the tools first: pickaxe tiers, then the table, the furnace, the shears
    if (hoist.tier > 0) tier(hoist.tier, 0)
    if (hoist.crafting_table) station('crafting_table', 0)
    if (hoist.furnace) station('furnace', 0)
    if (hoist.shears && !(held('shears') > 0)) need('shears', 1, 0) && give('shears', 1)
  }
  for (const [item, want] of targets) if (!need(item, want, 0)) break
  return { steps, missing, lines, tools }
}
