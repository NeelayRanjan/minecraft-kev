// obs -> state text. Relational, rounded, most static first, most volatile last (lesson 8: words, short numbers).
// The same function serves data generation and play; the golden test in tests/serialize.test.mjs is the contract.
import { techStep } from './teacher.js'
import { counts } from './subtasks.js'
import { describeChain, ARMOR } from './stages.js'

const pretty = s => String(s).replace(/_/g, ' ')
const WOODS = /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry)_/
const NAME = { grass_block: 'grass', crafting_table: 'crafting table' }
export const item = n => {
  if (NAME[n]) return NAME[n]
  if (n.endsWith('_planks')) return 'planks'
  if (n.endsWith('_log')) return pretty(n)
  return pretty(n.replace(WOODS, m => m))
}
const mins = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s` }
const rel = (b, withDy = true) => {
  let s = `${Math.round(b.dist)} m ${b.dir}`
  if (withDy && Math.abs(b.dy) >= 2) s += `, ${Math.abs(Math.round(b.dy))} m ${b.dy < 0 ? 'below' : 'above'} you`
  return s
}
const BLOCK_WORD = { cave: 'cave entrance', stone: 'exposed stone', deepslate: 'exposed stone', cobblestone: 'exposed stone', coal_ore: 'coal ore', deepslate_coal_ore: 'coal ore',
  iron_ore: 'iron ore', deepslate_iron_ore: 'iron ore', water: 'water', lava: 'lava',
  diamond_ore: 'diamond ore', gravel: 'gravel', obsidian: 'obsidian', nether_portal: 'nether portal' }

export function describeTime(obs) {
  let when
  if (obs.phase === 'night' || obs.phase === 'dusk' || obs.phase === 'dawn') when = `${obs.phase}, morning in ${mins(obs.secondsToMorning ?? 0)}`
  else when = `${obs.phase}, dusk in ${mins(obs.secondsToDusk ?? 0)}`
  return `time: ${when}. weather ${obs.weather}. biome: ${pretty(obs.biome)}.`
}

export function describeInventory(obs) {
  const inv = obs.inventory || {}
  const order = ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
  const keys = [...order.filter(k => inv[k]), ...Object.keys(inv).filter(k => !order.includes(k) && inv[k] > 0)]
  const parts = keys.map(k => {
    const wear = obs.toolWear?.[k]
    if (k.endsWith('_pickaxe')) return `${item(k)}${wear ? ` (worn ${wear}%)` : ''}`
    return inv[k] > 1 ? `${inv[k]} ${item(k)}` : item(k)
  })
  const c = counts(obs)
  const iron = inv.iron_pickaxe || c.ingots ? '' : c.rawIron ? ` ${c.rawIron} raw iron, no ingots yet.` : ' no iron yet.'
  return `inventory: ${parts.length ? parts.join(', ') : 'nothing'}.${iron}`
}

function describeBase(obs) {
  const t = obs.base?.crafting_table, f = obs.base?.furnace
  let s
  if (!t && !f) s = 'base: none yet'
  else if (t && f && Math.abs(t.dist - f.dist) <= 3 && t.dir === f.dir) s = `base: crafting table and furnace ${rel(t)}`
  else s = 'base: ' + [t && `crafting table ${rel(t)}`, f && `furnace ${rel(f)}`].filter(Boolean).join('; ')
  return `${s}. bed: none.`
}

function describeMemory(obs) {
  const m = obs.memory || {}
  const iron = m.ironSeen ? `iron ore seen ${mins(m.ironSeen.agoS)} ago${m.ironSeen.where ? ` in ${m.ironSeen.where}` : ''} ${rel(m.ironSeen)}` : 'no iron seen yet'
  // chain mode only: the other remembered sightings (experiment 1's text must not change)
  const REMEMBERED = [['diamondSeen', 'diamond ore'], ['lavaSeen', 'lava'], ['waterSeen', 'water']]
  const more = obs.goal === 'nether' ? REMEMBERED.filter(([k]) => m[k]).map(([k, w]) => `; ${w} seen ${mins(m[k].agoS)} ago ${rel(m[k])}`).join('') : ''
  const path = m.lastPath ? `; path last tried: ${pretty(m.lastPath)}` : ''
  const died = m.deaths ? `died: ${m.deaths} time${m.deaths > 1 ? 's' : ''}` : 'died: never'
  return `memory: ${iron}${more}${path}. ${died}.`
}

function describeBlocks(obs) {
  const seenKind = new Set()
  const rows = []
  for (const b of obs.blocks || []) {
    const word = b.name.endsWith('_log') ? 'tree' : BLOCK_WORD[b.name]
    if (!word || seenKind.has(word)) continue
    seenKind.add(word)
    if (word === 'tree') rows.push(`tree ${rel(b, false)}${b.reachable ? ', reachable' : ''}`)
    else if (word === 'cave entrance') rows.push(`cave entrance ${rel(b)} (dark inside)`)
    else rows.push(`${word} ${rel(b)}${b.reachable ? ', reachable' : ''}`)
    if (rows.length >= 5) break
  }
  return `nearby blocks: ${rows.length ? rows.join('; ') : 'none of note'}.`
}

function describeEntities(obs) {
  const rows = (obs.entities || []).slice(0, 4).map(e => `${pretty(e.name)} ${rel(e, false)} (${e.kind})`)
  const h = obs.nearestHostile
  const hostile = h ? `nearest hostile: ${pretty(h.name)} ${rel(h, false)}` : 'nearest hostile: none within 32 m'
  return `nearby creatures: ${rows.length ? rows.join('; ') + '; ' : ''}${hostile}.`
}

function describeSubtask(obs) {
  const c = obs.current
  const cur = c ? `${pretty(c.name)}${c.arg ? ` ${pretty(c.arg)}` : ''}, ${Math.round(c.elapsedS)} s so far${c.progress != null ? `, ${Math.round(c.progress * 100)}% of the way` : ''}` : 'none'
  const rep = obs.last && obs.last.result !== 'ok' && (obs.last.repeats || 0) >= 2 ? `, ${obs.last.repeats} times in a row` : ''
  const last = obs.last ? ` last subtask result: ${pretty(obs.last.id)} ${pretty(obs.last.result)}${rep}.` : ''
  return `current subtask: ${cur}.${last}`
}

// Chain mode: the armor worn, head to feet (null when none, so the line is omitted).
function describeArmor(obs) {
  const worn = ARMOR.filter(k => obs.armor?.[k])
  return worn.length ? `wearing: ${worn.map(item).join(', ')}.` : null
}

export function serialize(obs) {
  const chain = obs.goal === 'nether'
  let first
  // obs.goalText: the runner's GoalStack.describe(obs) (equal to describeChain(obs) while only the chain is on the stack)
  if (chain) first = `Minecraft survival, day ${(obs.day ?? 0) + 1}. ${obs.goalText ?? describeChain(obs)}`
  else {
    const step = techStep(obs)
    const goal = step.index === 8 ? 'iron pickaxe done; survive until morning' : `get an iron pickaxe (step ${step.index} of 7: ${step.text})`
    first = `Minecraft survival, day ${(obs.day ?? 0) + 1}. Goal: ${goal}.`
  }
  // Underground used to hide "in water": the bot drowned in flooded tunnels with the text saying only "underground".
  let where = obs.underground ? (obs.inWater ? 'underground, in water' : 'underground') : obs.inWater ? 'in water' : 'in the open'
  if (obs.inWater && (obs.oxygen ?? 20) <= 10) where += ', running out of air'
  const lines = [
    first,
    describeTime(obs),
    `you: health ${Math.round(obs.health)}/20, food ${Math.round(obs.food)}/20, standing on ${item(obs.standingOn || 'air')} at y ${Math.round(obs.pos.y)}, ${where}, light ${Math.max(obs.skyLight ?? 0, obs.blockLight ?? 0)}.`,
    describeInventory(obs),
    `holding: ${obs.holding ? item(obs.holding) : 'nothing'}.`,
    chain ? describeArmor(obs) : null,
    describeBase(obs),
    describeMemory(obs),
    describeBlocks(obs),
    describeEntities(obs),
    describeSubtask(obs),
  ].filter(l => l != null)
  return lines.join('\n').replace(/<\|/g, '< |').replace(/\|>/g, '| >')
}
