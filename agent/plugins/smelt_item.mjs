// smelt_item(<product>): smelt up to 8 of recipes.SMELT[product] at a furnace (the nearby or remembered one, else the
// carried one placed) with fuel from Motor's fuelPlan, through Motor.smeltAny (shared with smelt(iron_ingot)).
// Typed failures: no_materials (no input, or the fuel ran out), no_fuel, no_furnace. iron_ingot stays smelt(iron_ingot).
import { SMELT } from '../recipes.js'
import { counts, hasFuel, furnaceNear } from '../subtasks.js'
import { have } from '../goals.js'

export const MAX_PER_CALL = 8

// The exact inventory item smelted for `input`: a generic 'log' (charcoal) is the most-held log species.
export function inputItem(input, inventory = {}) {
  if (input !== 'log') return input
  const logs = Object.entries(inventory).filter(([k, v]) => k.endsWith('_log') && v > 0).sort((a, b) => b[1] - a[1])
  return logs[0]?.[0] ?? 'oak_log'
}

const plugin = {
  id: 'smelt_item',
  timeout: 120,   // ~10 s per item for 8 items, plus the walk to the furnace
  breaker: false,
  options(obs, goal) {
    if (goal?.kind !== 'smelt_item' || !SMELT[goal.arg]) return []
    return [{ arg: goal.arg, desc: `smelt ${SMELT[goal.arg].replace(/_/g, ' ')} into ${goal.arg.replace(/_/g, ' ')} in a furnace` }]
  },
  // A SMELT product (not iron_ingot, the legacy smelt), its input held, fuel held, a furnace near or carried.
  preconditions(obs, arg) {
    const input = SMELT[arg]
    if (!input) return false
    const c = counts(obs)
    return have(obs, input) >= 1 && hasFuel(c) && (furnaceNear(obs) || c.furnace >= 1)
  },
  async run(motor, arg) {
    const input = SMELT[arg]
    if (!input) return { result: 'failed', detail: `cannot smelt ${arg}` }
    const inv = {}
    for (const i of motor.bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const r = await motor.smeltAny(inputItem(input, inv), arg, MAX_PER_CALL)
    return { result: r.result, detail: r.detail }
  },
}
export default plugin
