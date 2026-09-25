// The scripted tech-tree teacher: labels for next_subtask and threat_response, and the driver during data collection.
// Deterministic function of obs (lesson 1: choice labels from a script saturate; they are for driving).
import { counts, options, optionId, tableNear, furnaceNear, hasFuel, isLog, isStone, isCoal, isIron, isDiamond, isGravel, isObsidian, isWater, isLava, canCraft, TABLE_NEAR } from './subtasks.js'
import { needs, stageOf, IRON_TOOLS, ARMOR, DIAMOND_TOOLS, INGOTS, DIAMONDS, STICKS } from './stages.js'

export const WOOD_NEEDED = 5   // logs (or planks/4): table 1, wooden pickaxe ~1.25, sticks, spare fuel and a spare table
export const STEPS = ['gather wood', 'craft a crafting table', 'craft a wooden pickaxe', 'craft a stone pickaxe',
  'find and mine 3 iron ore', 'smelt the iron', 'craft the iron pickaxe']

export function techStep(obs) {
  const c = counts(obs)
  const woodEq = c.logs + Math.floor(c.planks / 4)
  let index
  if (obs.inventory?.iron_pickaxe) index = 8
  else if (c.ingots >= 3) index = 7
  else if (c.rawIron + c.ingots >= 3) index = 6
  else if (c.hasStonePickaxe) index = 5
  else if (c.hasPickaxe) index = 4
  else if (c.table >= 1 || obs.base?.crafting_table) index = 3   // a table exists (any distance): the step must not fall by walking away
  else if (woodEq >= WOOD_NEEDED) index = 2
  else index = 1
  const text = index === 8 ? 'goal done: survive until morning' : STEPS[index - 1]
  return { index, of: 7, text }
}

export const THREAT_OPTIONS = {
  fight: 'attack the mob with the best tool in hand',
  flee: 'run away from the mob',
  pillar_up: 'jump and place blocks underneath to get out of reach',
  ignore: 'carry on with the current subtask',
}
const MELEE = new Set(['zombie', 'skeleton', 'spider', 'cave_spider', 'husk', 'drowned', 'zombie_villager', 'stray', 'silverfish', 'slime', 'witch', 'pillager'])

export function teacherThreat(obs) {
  const h = obs.nearestHostile
  if (!h || h.dist > 16) return 'ignore'
  const c = counts(obs)
  const close = (obs.entities || []).filter(e => e.kind === 'hostile' && e.dist <= 8).length
  if (h.name === 'creeper') return 'flee'
  if (obs.health < 8) return 'flee'
  if (close >= 3) return c.blocks >= 3 && !obs.inWater ? 'pillar_up' : 'flee'
  if (h.dist <= 10 && MELEE.has(h.name)) return 'fight'
  if (h.dist <= 10) return 'flee'
  return 'ignore'
}

const has = (obs, pred, d) => (obs.blocks || []).some(b => pred(b.name) && b.dist <= d)

function pick(obs) {
  const c = counts(obs)
  const step = techStep(obs).index
  const wood = () => has(obs, isLog, 48) ? 'gather_wood' : 'explore_toward(surface)'
  const craft = item => optionId('craft', item)
  const needTable = item => (tableNear(obs) || c.table >= 1) ? craft(item) : c.planks >= 4 ? craft('crafting_table')
    : (obs.base?.crafting_table && obs.base.crafting_table.dist > TABLE_NEAR) ? 'return_to_base' : c.logs >= 1 ? craft('planks') : wood()
  const sticks = () => c.planks >= 2 ? craft('sticks') : c.logs >= 1 ? craft('planks') : wood()
  const dig = () => c.hasPickaxe && obs.pos.y > 14 ? 'explore_toward(down)' : 'explore_toward(surface)'
  const stone = () => has(obs, isStone, 16) ? 'mine_stone' : dig()
  const ironSeen = has(obs, isIron, 32) || !!obs.memory?.ironSeen
  const th = teacherThreat(obs)
  if (th === 'fight') return 'fight(threat)'
  if (th === 'flee') return 'flee(threat)'
  if (th === 'pillar_up') return 'pillar_up'
  if (obs.food < 8 && c.food >= 1) return 'eat'
  if (obs.goal === 'nether' && stageOf(obs).index >= 1) return pickChain(obs)
  switch (step) {
    case 1: return wood()
    case 2: return c.planks >= 4 ? craft('crafting_table') : craft('planks')
    case 3:
      if (c.sticks < 2) return sticks()
      if (c.planks < 3) return c.logs >= 1 ? craft('planks') : wood()
      return needTable('wooden_pickaxe')
    case 4:
      if (c.cobble < 3) return stone()
      if (c.sticks < 2) return sticks()
      return needTable('stone_pickaxe')
    case 5:
      if (ironSeen) return 'mine_iron'
      if (c.coal === 0 && has(obs, isCoal, 16)) return 'mine_coal'
      if (c.cobble < 8 && has(obs, isStone, 16)) return 'mine_stone'
      if (has(obs, n => n === 'cave', 16) && obs.pos.y > 30) return 'explore_toward(cave)'
      return dig()
    case 6:
      if (!furnaceNear(obs) && c.furnace === 0) return c.cobble >= 8 ? needTable('furnace') : stone()
      if (!hasFuel(c)) return c.logs >= 1 ? craft('planks') : has(obs, isCoal, 32) ? 'mine_coal' : wood()
      return 'smelt(iron_ingot)'
    case 7:
      if (c.sticks < 2) return sticks()
      return needTable('iron_pickaxe')
    default:
      if ((obs.phase === 'dusk' || obs.phase === 'night') && !obs.underground && c.blocks >= 1 && c.hasPickaxe) return 'build_shelter'
      return 'wait'
  }
}

// Chain mode (Task 4): stages 1-4 of agent/stages.js, called from pick() once the iron pickaxe is done.
// Stage 1 (iron tools) and stage 2 (armor) share craftNext/getIron; stage 3 (diamond tools) shares craftNext
// with its own diamond-seeking fallback; stage 4 (nether portal) is its own linear chain.
function pickChain(obs) {
  const c = counts(obs)
  const stage = stageOf(obs).index
  const wood = () => has(obs, isLog, 48) ? 'gather_wood' : 'explore_toward(surface)'
  const craft = item => optionId('craft', item)
  const needTable = item => (tableNear(obs) || c.table >= 1) ? craft(item) : c.planks >= 4 ? craft('crafting_table')
    : (obs.base?.crafting_table && obs.base.crafting_table.dist > TABLE_NEAR) ? 'return_to_base' : c.logs >= 1 ? craft('planks') : wood()
  const sticks = () => c.planks >= 2 ? craft('sticks') : c.logs >= 1 ? craft('planks') : wood()
  const ironSeen = has(obs, isIron, 32) || !!obs.memory?.ironSeen
  const diamondSeen = has(obs, isDiamond, 32) || !!obs.memory?.diamondSeen
  // Same as pick()'s stone(): mine_stone is only offered when stone is actually in view.
  const stone = () => has(obs, isStone, 16) ? 'mine_stone' : (obs.pos.y > 14 ? 'explore_toward(down)' : 'explore_toward(surface)')

  // Same shape as pick()'s step 5-6: smelt what's held, else fix the furnace/fuel gap, else go get more iron.
  const getIron = () => {
    const furnaceHandy = furnaceNear(obs) || c.furnace >= 1
    if (c.rawIron >= 1) {
      if (hasFuel(c) && furnaceHandy) return 'smelt(iron_ingot)'
      if (!furnaceHandy) return c.cobble >= 8 ? needTable('furnace') : stone()
      if (c.logs >= 1) return craft('planks')
      if (has(obs, isCoal, 32)) return 'mine_coal'
      if (has(obs, isLog, 48)) return 'gather_wood'
    }
    if (ironSeen) return 'mine_iron'
    if (c.coal === 0 && has(obs, isCoal, 16)) return 'mine_coal'
    return obs.pos.y > 14 ? 'explore_toward(down)' : 'explore_toward(surface)'
  }

  // Whether the resource that gates crafting `item` (ingots for iron gear, diamonds for diamond gear) is short,
  // as opposed to only sticks being short: the two cases send the bot off to fetch different things.
  const primaryShort = item => item.startsWith('diamond_') ? c.diamonds < (DIAMONDS[item] || 0) : c.ingots < (INGOTS[item] || 0)
  // Craft the first affordable item of this stage; otherwise chase whatever is actually missing for the next one.
  const craftNext = (items, gather) => {
    const missing = needs(obs).missing.filter(i => items.includes(i))
    const affordable = missing.find(i => canCraft(i, c))
    if (affordable) return needTable(affordable)
    const next = missing[0]
    if (!next || primaryShort(next)) return gather()
    if (c.sticks < (STICKS[next] || 0)) return sticks()
    return gather()
  }

  if (stage === 1) return craftNext(IRON_TOOLS, getIron)
  if (stage === 2) return craftNext(ARMOR, getIron)
  if (stage === 3) return craftNext(DIAMOND_TOOLS, () => diamondSeen ? 'mine_diamond' : 'explore_toward(deep)')

  // Stage 4: bucket -> water -> obsidian (cast or mined) -> flint and steel -> frame -> light.
  if (obs.portalFrame) return obs.portalLit ? 'wait' : 'light_portal'
  const build = obs.memory?.portal   // an interrupted frame: finish it while the obsidian still missing is held
  if (build && c.flintAndSteel && c.obsidian >= 10 - build.placed) return 'build_portal'
  if (c.obsidian >= 10) {
    if (!c.flintAndSteel) {
      if (c.flint >= 1) return c.ingots >= 1 ? needTable('flint_and_steel') : getIron()
      return has(obs, isGravel, 16) ? 'mine_gravel' : 'explore_toward(surface)'
    }
    return c.blocks >= 4 ? 'build_portal' : stone()
  }
  if (has(obs, isObsidian, 16)) return 'mine_obsidian'
  if (!c.bucket && !c.waterBucket) return canCraft('bucket', c) ? needTable('bucket') : getIron()
  if (c.bucket && !c.waterBucket) return (has(obs, isWater, 24) || obs.memory?.waterSeen) ? 'fill_bucket(water)' : 'explore_toward(surface)'
  if (c.waterBucket) return (has(obs, isLava, 24) || obs.memory?.lavaSeen) ? 'cast_obsidian' : (obs.pos.y > -50 ? 'explore_toward(deep)' : 'explore_toward(surface)')
  return 'wait'
}

export function teacherSubtask(obs) {
  const id = pick(obs)
  const offered = options(obs).map(o => o.id)
  if (offered.includes(id)) return id
  // A mining subtask withheld underground (the ore did not path three times): look for more below rather than climb
  // out (explore_toward(surface) climbs from underground since the first chain run).
  if (id.startsWith('mine_') && obs.underground && offered.includes('explore_toward(down)')) return 'explore_toward(down)'
  if (id !== 'wait' && offered.includes('explore_toward(surface)')) return 'explore_toward(surface)'
  return 'wait'
}
