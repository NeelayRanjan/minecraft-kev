// mine(<block>): dig a recipes.MINE block and pick up its drop. Ores ('ore': redstone, lapis, copper, gold, emerald)
// go through Motor.mineKind (the thriftiest pickaxe that harvests, collectOne's harvest guard) after a pickaxe tier
// check; surface blocks ('surface': sand, gravel, dirt, clay) are dug with a shovel when one is held, else by hand, never
// with a pickaxe. Both variants of an ore (stone and deepslate) count as the same target.
import { MINE, TOOL_TIER, tierHeld } from '../recipes.js'

const RANGE = 32
const ORE_BLOCKS = 3       // ore blocks per call (a redstone ore drops 4-5)
const SURFACE_BLOCKS = 4   // surface blocks per call
const TIER_NAME = { 1: 'wooden', 2: 'stone', 3: 'iron', 4: 'diamond' }
const SHOVELS = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'golden_shovel', 'wooden_shovel']

// block name -> [drop item, MINE entry]
const BY_BLOCK = new Map()
for (const [drop, e] of Object.entries(MINE)) if (e) for (const b of e.blocks) BY_BLOCK.set(b, [drop, e])
export const entryFor = block => BY_BLOCK.get(block) ?? null
// What counts as the drop picked up (gravel may drop flint instead of itself).
const gained = drop => drop === 'gravel' ? n => n === 'gravel' || n === 'flint' : n => n === drop

const plugin = {
  id: 'mine',
  timeout: 90,
  breaker: true,
  // Under gather(<MINE item>): the item's blocks seen within 32 m (obs.blocks names stone-variant ores without the
  // deepslate_ prefix), else its primary block, so the option exists and fails not_found (the breaker withholds it).
  options(obs, goal) {
    if (goal?.kind !== 'gather') return []
    const e = MINE[goal.arg]
    if (!e) return []
    const seen = e.blocks.filter(b => (obs.blocks || []).some(x => x.name === b && x.dist <= RANGE))
    return (seen.length ? seen : [e.blocks[0]]).map(b => ({ arg: b, desc: `mine ${b.replace(/_/g, ' ')} for ${goal.arg.replace(/_/g, ' ')}` }))
  },
  // A MINE block, and a pickaxe of the tier it needs is held.
  preconditions(obs, arg) {
    const hit = entryFor(arg)
    return !!hit && tierHeld(obs.inventory || {}) >= TOOL_TIER[hit[1].tool]
  },
  async run(motor, arg) {
    const hit = entryFor(arg)
    if (!hit) return { result: 'failed', detail: `${arg} is not a mineable block` }
    const [drop, e] = hit
    const ids = motor.ids(e.blocks)
    const need = TOOL_TIER[e.tool]
    if (need > 0) {
      const inv = {}
      for (const i of motor.bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
      if (tierHeld(inv) < need) return { result: 'needs_tool', detail: `${TIER_NAME[need]} pickaxe` }
    }
    if (e.where === 'ore') {
      const r = await motor.mineKind(ids, RANGE, ORE_BLOCKS, gained(drop), arg.replace(/_/g, ' '))
      return r.result === 'ok' ? { result: 'ok', detail: `${r.detail} ${drop}` } : r
    }
    // Surface: a shovel if held, else an empty hand (a pickaxe would only wear down).
    const pred = gained(drop)
    const before = motor.countBy(pred)
    let dug = 0, lastErr = null, found = false
    for (let i = 0; i < SURFACE_BLOCKS; i++) {
      motor.check()
      const block = motor.pickBlock(ids, RANGE)
      if (!block) break
      found = true
      const shovel = SHOVELS.map(n => motor.item(n)).find(Boolean)
      if (shovel) { if (motor.bot.heldItem?.name !== shovel.name) await motor.bot.equip(shovel, 'hand') }
      else if (motor.bot.heldItem) await motor.bot.unequip('hand')
      motor.check()
      try { await motor.collectOne(block) } catch (err) { lastErr = err; break }
      dug++
      motor.current.progress = dug / SURFACE_BLOCKS
    }
    await motor.settleInventory()
    const got = motor.countBy(pred) - before
    if (got > 0) return { result: 'ok', detail: `+${got} ${drop}` }
    if (lastErr) throw lastErr
    return found ? { result: 'failed', detail: `${arg} dug but nothing picked up` } : { result: 'not_found', detail: `no ${arg} within ${RANGE} m` }
  },
}
export default plugin
