// craft_item(<item>): one craft of any minecraft-data recipe the inventory satisfies (oak_stairs, compass, shears, a
// bed...), in the 2x2 grid when a recipe fits it, else at a crafting table (the nearby or remembered one, else the
// carried one placed), through Motor.craftAny (shared with craft(<item>)). Typed failures: no_materials, no_table.
// The legacy items (subtasks CRAFTABLE / CHAIN_CRAFTABLE) stay craft(<item>): refused here so no list shows both.
import mcDataFor from 'minecraft-data'
import { CRAFTABLE, CHAIN_CRAFTABLE, tableNear } from '../subtasks.js'

const md = mcDataFor('1.20.4')
const LEGACY = new Set([...CRAFTABLE, ...CHAIN_CRAFTABLE, 'stick'])

// The first minecraft-data recipe for `item` whose ingredients `inventory` holds (one craft): { table } (a 3x3 grid
// is needed), preferring one that fits the 2x2 grid; null when none is held. Pure.
export function heldRecipe(item, inventory = {}) {
  const id = md.itemsByName[item]?.id
  if (id === undefined) return null
  let best = null
  for (const r of md.recipes[id] || []) {
    const cells = r.inShape ? r.inShape.flat() : r.ingredients || []
    const need = {}
    for (const c of cells) if (c !== null && c !== undefined) { const n = md.items[c]?.name; if (!n) continue; need[n] = (need[n] || 0) + 1 }
    if (!Object.entries(need).every(([n, q]) => (inventory[n] || 0) >= q)) continue
    const table = r.inShape ? r.inShape.length > 2 || r.inShape.some(row => row.length > 2) : cells.length > 4
    if (!table) return { table: false }
    best = best ?? { table: true }
  }
  return best
}

const plugin = {
  id: 'craft_item',
  timeout: 30,
  breaker: false,
  options(obs, goal) {
    if (goal?.kind !== 'craft_item' || typeof goal.arg !== 'string') return []
    return [{ arg: goal.arg, desc: `craft ${goal.arg.replace(/_/g, ' ')}` }]
  },
  // Not a legacy item; a recipe whose ingredients are held; a table near or carried when that recipe needs one.
  preconditions(obs, arg) {
    if (typeof arg !== 'string' || LEGACY.has(arg) || arg.endsWith('_planks')) return false
    const inv = obs.inventory || {}
    const r = heldRecipe(arg, inv)
    return !!r && (!r.table || tableNear(obs) || (inv.crafting_table || 0) >= 1)
  },
  async run(motor, arg) {
    const id = motor.md.itemsByName[arg]?.id
    if (id == null) return { result: 'failed', detail: `unknown item ${arg}` }
    await motor.settleInventory()
    let table = null
    if (!motor.bot.recipesFor(id, null, 1, null).length) {
      if (!motor.bot.recipesFor(id, null, 1, true).length) return { result: 'no_materials', detail: `no recipe for ${arg} with the inventory` }
      table = await motor.craftingTable()
      if (!table) return { result: 'no_table' }
      motor.check()
    }
    return motor.craftAny(arg, 1, table)
  },
}
export default plugin
