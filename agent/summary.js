// bot -> obs: the one place that reads Mineflayer state for the decision layer, plus the episode memory.
// Everything downstream (teacher, serializer, questions) is a pure function of the obs this returns.
import { stageOf, portalLayout } from './stages.js'
export function dirWord(dx, dz) {
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360   // 0 = north (-z), 90 = east (+x)
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8]
}
export function relTo(from, p) {
  const dx = p.x - from.x, dz = p.z - from.z, dy = p.y - from.y
  return { dist: Math.hypot(dx, dy, dz), dir: dirWord(dx, dz), dy }
}
export function phaseOf(timeOfDay) {
  const t = ((timeOfDay % 24000) + 24000) % 24000
  const phase = t < 3000 ? 'morning' : t < 7000 ? 'midday' : t < 12000 ? 'afternoon' : t < 13500 ? 'dusk' : t < 23000 ? 'night' : 'dawn'
  const secondsToDusk = t < 12000 ? Math.round((12000 - t) / 20) : null
  const secondsToMorning = t >= 12000 ? Math.round((24000 - t) / 20) : null
  return { phase, secondsToDusk, secondsToMorning }
}
export function classifyEntity(e, mcData) {
  if (e.type === 'player') return 'player'
  if (!e.name) return null
  if (e.type === 'hostile') return 'hostile'
  if (e.type === 'animal' || e.type === 'passive' || e.type === 'water_creature') return 'passive'
  if (e.type !== 'mob') return null
  const cat = mcData.entitiesByName[e.name]?.category
  return cat === 'Hostile mobs' ? 'hostile' : cat === 'Passive mobs' ? 'passive' : null
}
// obs.attacker (live-session lesson: a player who hit the bot was never a threat, since nearestHostile only ever
// looks at hostile mobs). kind: 'player' when the entity is a player, 'hostile' when it classifies as a hostile
// mob, else 'other' (a passive mob, or anything classifyEntity does not recognise, still standing within 4 m of a
// health drop). Pure given the entity and mcData.
export function attackerKind(e, mcData) {
  if (e.type === 'player') return 'player'
  return classifyEntity(e, mcData) === 'hostile' ? 'hostile' : 'other'
}
// The nearest entity (not the bot itself) within maxDist of `me`, else null. Pure given a bot.entities-shaped map.
export function nearestEntity(entities, meEntity, me, maxDist) {
  let best = null, bestD = maxDist
  for (const e of Object.values(entities)) {
    if (e === meEntity || !e.position) continue
    const d = me.distanceTo(e.position)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best ? { e: best, dist: bestD } : null
}
export class EpisodeMemory {
  constructor() { this.ironSeen = null; this.lastPath = null; this.deaths = 0; this.heading = 'north'; this.base = { table: null, furnace: null }; this.seen = { diamond: null, lava: null, water: null }; this.portal = null; this.spawn = null; this.lastHealth = null; this.attacker = null }
  sawIron(pos, t, where = null) { this.ironSeen = { pos: { x: pos.x, y: pos.y, z: pos.z }, t, where } }
  saw(kind, pos, t) { this.seen[kind] = { pos: { x: pos.x, y: pos.y, z: pos.z }, t } }
  setBase(kind, pos) { this.base[kind] = pos ? { x: pos.x, y: pos.y, z: pos.z } : null }
}

export function biomeName(bot, mcData, pos) {
  try {
    const id = bot.world.getBiome?.(pos)
    const byId = id != null && (mcData.biomes?.[id]?.name || mcData.biomesArray?.find(b => b.id === id)?.name)
    if (byId) return byId
  } catch {}
  const b = bot.blockAt(pos)?.biome
  return (b && b.name && b.name !== 'unknown') ? b.name : 'unknown'
}

const KIND_SCAN = md => [
  ['log', md.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id), 48],
  ['stone', ['stone', 'deepslate', 'cobblestone'].map(n => md.blocksByName[n].id), 16],
  ['coal_ore', ['coal_ore', 'deepslate_coal_ore'].map(n => md.blocksByName[n].id), 32],
  ['iron_ore', ['iron_ore', 'deepslate_iron_ore'].map(n => md.blocksByName[n].id), 32],
  ['diamond_ore', ['diamond_ore', 'deepslate_diamond_ore'].map(n => md.blocksByName[n].id), 32],
  ['gravel', [md.blocksByName.gravel.id], 16],
  ['obsidian', [md.blocksByName.obsidian.id], 16],
  ['nether_portal', [md.blocksByName.nether_portal.id], 16],
  ['water', [md.blocksByName.water.id], 24],
  ['lava', [md.blocksByName.lava.id], 24],
]
// Experiment 1 keeps its original scan in obs.blocks (the kinds and radii mc-v1 was trained on); the chain kinds and
// the wider water/lava radius reach obs.blocks only in chain mode. Memory is recorded in every mode.
const EXP1_RADIUS = { log: 48, stone: 16, coal_ore: 32, iron_ore: 32, water: 12, lava: 12 }
const REMEMBER = { diamond_ore: 'diamond', lava: 'lava', water: 'water' }
const ARMOR_SLOTS = [5, 6, 7, 8]   // head, torso, legs, feet

// A COMPLETE portal frame among the obsidian positions (a Set of "x,y,z"): the anchor (lowest block) of a vertical
// stack of three obsidian that is a side column of a frame whose 10 obsidian (portalLayout) are all present, else
// null. A partly built frame is not a frame (it is reported through memory.portal instead). Pure.
export function portalFrameNear(have) {
  const pos = k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } }
  const key = p => `${p.x},${p.y},${p.z}`
  let best = null
  for (const k of have) {
    const a = pos(k)
    if (!have.has(key({ ...a, y: a.y + 1 })) || !have.has(key({ ...a, y: a.y + 2 }))) continue
    // the column is the frame's left (u 0) or right (u 3) side, along x or z; the origin is the corner below it
    for (const [axis, du] of [['x', 0], ['x', -3], ['z', 0], ['z', -3]]) {
      const origin = axis === 'x' ? { x: a.x + du, y: a.y - 1, z: a.z } : { x: a.x, y: a.y - 1, z: a.z + du }
      if (portalLayout(origin, axis).obsidian.every(p => have.has(key(p))) && (!best || a.y < best.y)) best = a
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null
}
// The frame build in progress (motor's mem.portal) with how many of its 10 obsidian are in place, else null.
function portalBuild(bot, mem) {
  if (!mem.portal) return null
  const { origin, axis } = mem.portal
  const placed = portalLayout(origin, axis).obsidian.filter(p => bot.blockAt(p)?.name === 'obsidian').length
  return { origin: { ...origin }, axis, placed }
}
const seenObs = (me, s, t) => (s ? { ...relTo(me, s.pos), agoS: t - s.t, pos: s.pos } : null)

export function summarize(bot, mcData, mem, ctx) {
  const me = bot.entity.position
  if (!mem.spawn) mem.spawn = { x: me.x, y: me.y, z: me.z }
  const goal = ctx.goal || 'iron_pickaxe'
  const blocks = []
  for (const [kind, matching, maxDistance] of KIND_SCAN(mcData)) {
    const pos = bot.findBlocks({ matching, maxDistance, count: 1 })[0]
    if (!pos) continue
    const b = bot.blockAt(pos)
    const r = relTo(me, pos)
    if (REMEMBER[kind]) mem.saw(REMEMBER[kind], pos, ctx.t)
    if (goal !== 'nether' && !(r.dist <= EXP1_RADIUS[kind])) continue
    const name = kind === 'log' ? b.name : kind === 'stone' ? 'stone' : b.name.replace('deepslate_', '')
    blocks.push({ name, pos: { x: pos.x, y: pos.y, z: pos.z }, ...r, reachable: r.dist <= 6 || bot.canSeeBlock(b) })
    if (kind === 'iron_ore') mem.sawIron(pos, ctx.t, null)
  }
  const caveAir = mcData.blocksByName.cave_air?.id
  if (caveAir != null) {
    const p = bot.findBlocks({ matching: caveAir, maxDistance: 24, count: 1 })[0]
    if (p) blocks.push({ name: 'cave', pos: { x: p.x, y: p.y, z: p.z }, ...relTo(me, p), reachable: false })
  }
  blocks.sort((a, b) => a.dist - b.dist)
  const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.isValid !== false)
    .map(e => ({ name: e.name || e.username || 'unknown', kind: classifyEntity(e, mcData), ...relTo(me, e.position), id: e.id, pos: { x: e.position.x, y: e.position.y, z: e.position.z } }))
    .filter(e => e.kind && e.dist <= 32).sort((a, b) => a.dist - b.dist).slice(0, 6)
  const hostiles = entities.filter(e => e.kind === 'hostile')
  // obs.attacker (live session lesson: a player who hit the bot was never a threat): on a tick health drops with any
  // entity within 4 m, remember it (kind, name, the distance at detection, and its position so flee can run from a
  // player attacker: motor.js's nearestHostileEntity/obs.nearestHostile are mob-only, fix round 1) for 30 s;
  // obs.nearestHostile is unchanged and still only ever hostile mobs.
  const health = bot.health ?? 20
  if (mem.lastHealth != null && health < mem.lastHealth) {
    const near = nearestEntity(bot.entities, bot.entity, me, 4)
    if (near) mem.attacker = { kind: attackerKind(near.e, mcData), name: near.e.name || near.e.username || 'unknown', dist: near.dist,
      pos: { x: near.e.position.x, y: near.e.position.y, z: near.e.position.z }, t: ctx.t }
  }
  mem.lastHealth = health
  const attacker = mem.attacker && ctx.t - mem.attacker.t <= 30
    ? { kind: mem.attacker.kind, name: mem.attacker.name, dist: Math.round(mem.attacker.dist), sinceS: Math.round(ctx.t - mem.attacker.t), pos: mem.attacker.pos } : null
  if (!attacker) mem.attacker = null
  const inv = {}, toolWear = {}
  for (const it of bot.inventory.items()) {
    inv[it.name] = (inv[it.name] || 0) + it.count
    const max = mcData.itemsByName[it.name]?.maxDurability
    if (it.name.endsWith('_pickaxe') && it.durabilityUsed && max) toolWear[it.name] = Math.round(100 * it.durabilityUsed / max)
  }
  const head = me.offset(0, 1, 0).floored()
  let skyLight = 15, blockLight = 0
  try { skyLight = bot.world.getSkyLight(head) ?? 15; blockLight = bot.world.getBlockLight(head) ?? 0 } catch {}
  const below = bot.blockAt(me.offset(0, -0.5, 0).floored())
  const { phase, secondsToDusk, secondsToMorning } = phaseOf(bot.time.timeOfDay)
  const weather = bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear'
  const base = { crafting_table: mem.base.table ? relTo(me, mem.base.table) : null, furnace: mem.base.furnace ? relTo(me, mem.base.furnace) : null }
  const armor = {}
  for (const i of ARMOR_SLOTS) { const it = bot.inventory.slots[i]; if (it?.name) armor[it.name] = 1 }
  const portalLit = !!bot.findBlock({ matching: mcData.blocksByName.nether_portal.id, maxDistance: 16 })
  // count: findBlocks stops at it walking chunk sections nearest-first; a small one can miss part of a frame
  const anchor = portalFrameNear(new Set(bot.findBlocks({ matching: mcData.blocksByName.obsidian.id, maxDistance: 16, count: 256 }).map(p => `${p.x},${p.y},${p.z}`)))
  const portalFrame = anchor ? { ...relTo(me, anchor), pos: anchor } : null
  const ironSeen = mem.ironSeen ? { ...relTo(me, mem.ironSeen.pos), agoS: ctx.t - mem.ironSeen.t, where: mem.ironSeen.where, pos: mem.ironSeen.pos } : null
  return {
    t: ctx.t, day: Number(bot.time.day), timeOfDay: bot.time.timeOfDay, phase, secondsToDusk, secondsToMorning, weather,
    biome: biomeName(bot, mcData, me.floored()), pos: { x: me.x, y: me.y, z: me.z }, standingOn: below?.name || 'air',
    skyLight, blockLight, underground: skyLight < 4, inWater: !!bot.entity.isInWater, oxygen: bot.oxygenLevel ?? 20,
    health, food: bot.food ?? 20, inventory: inv, holding: bot.heldItem?.name || null, toolWear,
    base, memory: { ironSeen, diamondSeen: seenObs(me, mem.seen.diamond, ctx.t), lavaSeen: seenObs(me, mem.seen.lava, ctx.t), waterSeen: seenObs(me, mem.seen.water, ctx.t),
      lastPath: mem.lastPath, deaths: mem.deaths, heading: mem.heading, portal: portalBuild(bot, mem) },
    blocks, entities, nearestHostile: hostiles[0] || null, attacker,
    current: ctx.current || null, last: ctx.last || null, withhold: ctx.withhold || [], goal, armor, portalLit, portalFrame,
    done: goal === 'nether' ? stageOf({ inventory: inv, armor, portalLit }).done : !!inv.iron_pickaxe,
  }
}
