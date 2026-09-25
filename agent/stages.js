// The goal chain beyond the iron pickaxe: iron tools -> iron armor -> diamond tools -> lit nether portal.
// Pure function of obs (lesson 8-style: relational, no I/O). Later tasks use this for option filtering,
// the teacher, and the chain-progress forecast question. Stage 0 (iron pickaxe) reuses teacher.js's techStep.
import { techStep } from './teacher.js'

export const STAGES = ['iron_pickaxe', 'iron_tools', 'iron_armor', 'diamond_tools', 'nether_portal']
export const IRON_TOOLS = ['iron_pickaxe', 'iron_sword', 'iron_axe']
export const ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
export const DIAMOND_TOOLS = ['diamond_pickaxe', 'diamond_sword', 'diamond_axe']
export const INGOTS = { iron_sword: 2, iron_axe: 3, iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4, bucket: 3, flint_and_steel: 1 }
export const DIAMONDS = { diamond_pickaxe: 3, diamond_sword: 2, diamond_axe: 3 }
export const STICKS = { iron_sword: 1, iron_axe: 2, diamond_pickaxe: 2, diamond_sword: 1, diamond_axe: 2 }

const STAGE_LABELS = { iron_pickaxe: 'iron pickaxe', iron_tools: 'iron tools', iron_armor: 'iron armor', diamond_tools: 'diamond tools', nether_portal: 'lit nether portal' }
const PORTAL_TEXT = { 41: 'craft a bucket', 42: 'fill the bucket with water', 43: 'make 10 obsidian from lava',
  44: 'mine 10 obsidian', 45: 'get flint and craft flint and steel', 46: 'build the frame', 47: 'light the portal' }

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

function ironToolsStep(obs) {
  const n = needs(obs)
  const next = n.missing[0]
  if (!canCraftItem(obs, next)) {
    return { index: 11, of: 47, text: `get ${n.ingots} iron ingots (have ${obs.inventory?.iron_ingot || 0})`, stage: STAGES[1] }
  }
  return { index: 11 + IRON_TOOLS.indexOf(next), of: 47, text: `craft ${humanize(next)}`, stage: STAGES[1] }
}

function armorStep(obs) {
  const n = needs(obs)
  const next = n.missing[0]
  if (!canCraftItem(obs, next)) {
    return { index: 21, of: 47, text: `get ${n.ingots} iron ingots (have ${obs.inventory?.iron_ingot || 0})`, stage: STAGES[2] }
  }
  return { index: 22 + ARMOR.indexOf(next), of: 47, text: `craft ${humanize(next)}`, stage: STAGES[2] }
}

function diamondStep(obs) {
  const n = needs(obs)
  const next = n.missing[0]
  const y = obs.pos?.y ?? 0
  const diamondSeen = (obs.blocks || []).some(b => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore')
  if (y > -50 && !diamondSeen) return { index: 31, of: 47, text: 'reach diamond level (y -58)', stage: STAGES[3] }
  if (!canCraftItem(obs, next)) return { index: 32, of: 47, text: `mine ${n.diamonds} diamonds`, stage: STAGES[3] }
  return { index: 33 + DIAMOND_TOOLS.indexOf(next), of: 47, text: `craft ${humanize(next)}`, stage: STAGES[3] }
}

function portalStep(obs) {
  const inv = obs.inventory || {}
  const bucket = inv.bucket || 0
  const waterBucket = inv.water_bucket || 0
  const obsidian = inv.obsidian || 0
  const flintSteel = inv.flint_and_steel || 0
  const obsidianSeen = (obs.blocks || []).some(b => b.name === 'obsidian')
  const step = i => ({ index: i, of: 47, text: PORTAL_TEXT[i], stage: STAGES[4] })
  // obsidian target reached: go straight to flint/frame/light, whatever the bucket state (the tolerant case).
  if (obsidian >= 10) {
    if (!flintSteel) return step(45)
    if (!obs.portalFrame) return step(46)
    return step(47)
  }
  if (!bucket && !waterBucket) return step(41)
  if (bucket && !waterBucket) return step(42)
  if (obsidianSeen) return step(44)
  return step(43)   // water_bucket held, no obsidian seen nearby: make it from lava
}

// Monotone step 1..47 across the whole chain (48 = done); stage 0 delegates to the tech-tree teacher.
export function chainStep(obs) {
  const { index, done } = stageOf(obs)
  if (done) return { index: 48, of: 47, text: 'chain done', stage: STAGES[4] }
  if (index === 0) {
    const t = techStep(obs)
    return { index: t.index, of: 47, text: t.text, stage: STAGES[0] }
  }
  if (index === 1) return ironToolsStep(obs)
  if (index === 2) return armorStep(obs)
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
