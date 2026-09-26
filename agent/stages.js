// The goal chain beyond the iron pickaxe: iron tools -> iron armor -> diamond tools -> lit nether portal.
// Pure function of obs (lesson 8-style: relational, no I/O). Later tasks use this for option filtering,
// the teacher, and the chain-progress forecast question. Stage 0 (iron pickaxe) reuses teacher.js's techStep.
import { Vec3 } from 'vec3'
import { techStep } from './teacher.js'

// A nether portal frame standing on `origin` (the bottom-left corner) in the plane along `axis` ('x' | 'z'): the 10
// obsidian, the 4 corner fillers (any block counts there) and the lowest inside cell (frame cell (1,1)). Pure; shared
// by the motor layer (building) and summary (is the frame complete).
export function portalLayout(origin, axis) {
  const at = (u, v) => axis === 'x' ? new Vec3(origin.x + u, origin.y + v, origin.z) : new Vec3(origin.x, origin.y + v, origin.z + u)
  return {
    obsidian: [[1, 0], [2, 0], [0, 1], [0, 2], [0, 3], [3, 1], [3, 2], [3, 3], [1, 4], [2, 4]].map(([u, v]) => at(u, v)),
    filler: [[0, 0], [3, 0], [0, 4], [3, 4]].map(([u, v]) => at(u, v)),
    inside: at(1, 1),
  }
}

export const STAGES = ['iron_pickaxe', 'iron_tools', 'iron_armor', 'diamond_tools', 'nether_portal']
export const IRON_TOOLS = ['iron_pickaxe', 'iron_sword', 'iron_axe']
export const ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
export const DIAMOND_TOOLS = ['diamond_pickaxe', 'diamond_sword', 'diamond_axe']
export const INGOTS = { iron_sword: 2, iron_axe: 3, iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4, bucket: 3, flint_and_steel: 1 }
export const DIAMONDS = { diamond_pickaxe: 3, diamond_sword: 2, diamond_axe: 3 }
export const STICKS = { iron_sword: 1, iron_axe: 2, diamond_pickaxe: 2, diamond_sword: 1, diamond_axe: 2 }

const STAGE_LABELS = { iron_pickaxe: 'iron pickaxe', iron_tools: 'iron tools', iron_armor: 'iron armor', diamond_tools: 'diamond tools', nether_portal: 'lit nether portal' }
const PORTAL_TEXT = { 41: 'craft a bucket', 42: 'fill the bucket with water', 45: 'get flint and craft flint and steel',
  46: 'build the frame', 47: 'light the portal' }   // 43/44 (obsidian) carry their own text, see portalStep

// Inventory count plus worn armor: a helmet on the head counts the same as one in the pack.
const owns = (obs, item) => (obs.inventory?.[item] || 0) + (obs.armor?.[item] || 0)
const humanize = item => item.replace(/_/g, ' ')

// Which chain stage is in progress (0..4), and whether the whole chain (a lit portal) is done.
export function stageOf(obs) {
  const ownsAll = items => items.every(i => owns(obs, i) > 0)
  let index
  if (!obs.inventory?.iron_pickaxe) index = 0
  else if (!ownsAll(['iron_sword', 'iron_axe'])) index = 1
  else if (!ownsAll(ARMOR)) index = 2
  else if (!ownsAll(DIAMOND_TOOLS)) index = 3
  else index = 4
  const done = index === 4 && !!obs.portalLit
  return { index, id: STAGES[index], done }
}

// The item ids still to craft for the stage currently in progress. bucket counts as had once filled (water_bucket).
function stageItems(index) {
  switch (index) {
    case 1: return ['iron_sword', 'iron_axe']
    case 2: return ARMOR
    case 3: return DIAMOND_TOOLS
    case 4: return ['bucket', 'flint_and_steel']
    default: return []
  }
}
function craftedOrOwned(obs, item) {
  if (item === 'bucket') return owns(obs, 'bucket') > 0 || (obs.inventory?.water_bucket || 0) > 0
  return owns(obs, item) > 0
}

// Resources still needed for the missing items of the current stage (net of what is already held).
export function needs(obs) {
  const { index } = stageOf(obs)
  const missing = stageItems(index).filter(item => !craftedOrOwned(obs, item))
  const inv = obs.inventory || {}
  const sum = map => missing.reduce((n, item) => n + (map[item] || 0), 0)
  const ingots = Math.max(0, sum(INGOTS) - (inv.iron_ingot || 0))
  const sticks = Math.max(0, sum(STICKS) - (inv.stick || 0))
  const diamonds = Math.max(0, sum(DIAMONDS) - (inv.diamond || 0))
  const inPortal = index === 4
  const obsidian = inPortal ? Math.max(0, 10 - (inv.obsidian || 0)) : 0
  const flint = inPortal && missing.includes('flint_and_steel') ? Math.max(0, 1 - (inv.flint || 0)) : 0
  return { ingots, diamonds, sticks, obsidian, flint, missing }
}

// Whether the held ingots/diamonds (and sticks) are enough to craft this one item right now.
function canCraftItem(obs, item) {
  const inv = obs.inventory || {}
  const sticksOk = (inv.stick || 0) >= (STICKS[item] || 0)
  if (item.startsWith('diamond_')) return (inv.diamond || 0) >= (DIAMONDS[item] || 0) && sticksOk
  return (inv.iron_ingot || 0) >= (INGOTS[item] || 0) && sticksOk
}

// Stages 1-3 index by how many of the stage's items are already owned (k), so crafting any item, in any order,
// moves the step forward and nothing in ordinary progress moves it back: stage 1 is 11 + 2k (+1 once a missing item is
// craftable), stage 2 is 21 + 2k (+1), stage 3 is 31 + 3k (reach diamond level), 32 + 3k (mine), 33 + 3k (craft).
// The craft text names the first craftable missing item (the teacher's pick), else the first missing one.
function itemStep(obs, items, base, stride, stageId) {
  const n = needs(obs)
  const k = items.filter(i => owns(obs, i) > 0).length
  const affordable = n.missing.find(i => canCraftItem(obs, i))
  if (affordable) return { index: base + stride * k + stride - 1, of: 47, text: `craft ${humanize(affordable)}`, stage: stageId }
  return { index: base + stride * k + stride - 2, of: 47, k, next: n.missing[0], n, stage: stageId }
}
const primaryShort = (obs, item) => item.startsWith('diamond_')
  ? (obs.inventory?.diamond || 0) < (DIAMONDS[item] || 0)
  : (obs.inventory?.iron_ingot || 0) < (INGOTS[item] || 0)

function ironStep(obs, items, base, stageId) {
  const s = itemStep(obs, items, base + 1, 2, stageId)
  if (s.text) return s
  const held = obs.inventory?.iron_ingot || 0
  const text = primaryShort(obs, s.next) ? `get ${s.n.ingots + held} iron ingots (have ${held})` : 'make sticks'
  return { index: s.index, of: 47, text, stage: stageId }
}

function diamondStep(obs) {
  const s = itemStep(obs, DIAMOND_TOOLS, 31, 3, STAGES[3])
  if (s.text) return s
  if (!primaryShort(obs, s.next)) return { index: s.index, of: 47, text: 'make sticks', stage: STAGES[3] }
  const y = obs.pos?.y ?? 0
  const known = (obs.blocks || []).some(b => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore') || !!obs.memory?.diamondSeen
  if (y > -50 && !known) return { index: s.index - 1, of: 47, text: 'reach diamond level (y -58)', stage: STAGES[3] }
  return { index: s.index, of: 47, text: `mine ${s.n.diamonds} diamonds`, stage: STAGES[3] }
}

// Stage 4, in the order the steps are done. A complete frame is 47 and a frame build in progress 46 whatever the
// buckets hold (the placed obsidian has left the inventory). Once any obsidian is held the bucket state no longer
// matters: 43 below 5 obsidian, 44 from 5 to 9 (the text says whether obsidian is in sight to mine or must be cast),
// so seeing or losing sight of obsidian never moves the step.
function portalStep(obs) {
  const inv = obs.inventory || {}
  const obsidian = inv.obsidian || 0
  const flintSteel = inv.flint_and_steel || 0
  const step = (i, text = PORTAL_TEXT[i]) => ({ index: i, of: 47, text, stage: STAGES[4] })
  if (obs.portalFrame) return step(47)
  if (obs.memory?.portal) return step(46)
  if (obsidian >= 10) return flintSteel ? step(46) : step(45)
  if (obsidian > 0 || inv.water_bucket) {
    const obsidianSeen = (obs.blocks || []).some(b => b.name === 'obsidian')
    return step(obsidian >= 5 ? 44 : 43, `${obsidianSeen ? 'mine' : 'make'} 10 obsidian${obsidianSeen ? '' : ' from lava'} (have ${obsidian})`)
  }
  if (!inv.bucket) return step(41)
  return step(42)
}

// Monotone step 1..47 across the whole chain (48 = done); stage 0 delegates to the tech-tree teacher.
export function chainStep(obs) {
  const { index, done } = stageOf(obs)
  if (done) return { index: 48, of: 47, text: 'chain done', stage: STAGES[4] }
  if (index === 0) {
    const t = techStep(obs)
    return { index: t.index, of: 47, text: t.text, stage: STAGES[0] }
  }
  if (index === 1) return ironStep(obs, ['iron_sword', 'iron_axe'], 10, STAGES[1])
  if (index === 2) return ironStep(obs, ARMOR, 20, STAGES[2])
  if (index === 3) return diamondStep(obs)
  return portalStep(obs)
}

export function describeChain(obs) {
  const { index: currentIdx, done } = stageOf(obs)
  const effectiveCurrent = done ? 5 : currentIdx
  const parts = STAGES.slice(1).map((id, i) => {
    const stageIdx = i + 1
    const label = STAGE_LABELS[id]
    if (stageIdx < effectiveCurrent) return `${label} (done)`
    if (stageIdx === 2 && stageIdx === currentIdx) {
      const ownedCount = ARMOR.filter(item => owns(obs, item) > 0).length
      if (ownedCount > 0) return `${label} (${ownedCount} of 4 pieces)`
    }
    return label
  })
  const step = chainStep(obs)
  const stageLabel = STAGE_LABELS[step.stage] || step.stage
  return `Goal chain: ${parts.join(', ')}. Current stage: ${stageLabel}, step ${step.index} of 47: ${step.text}.`
}
