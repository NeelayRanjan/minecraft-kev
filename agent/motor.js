// The scripted motor layer. One subtask at a time on Mineflayer + pathfinder + collectblock + pvp; each returns a typed
// result, has a hard timeout, and can be interrupted by the runner (threat, damage, death). Never learned.
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { parseOption, FOOD, TABLE_ITEMS, counts } from './subtasks.js'
import { portalLayout } from './stages.js'

const { Movements, goals } = pathfinderPkg
export const TIMEOUTS = { gather_wood: 60, mine_stone: 45, mine_coal: 60, mine_iron: 90, craft: 20, smelt: 90, explore_toward: 40,
  return_to_base: 60, eat: 10, build_shelter: 20, fight: 25, flee: 20, pillar_up: 10, wait: 3,
  mine_diamond: 120, mine_gravel: 60, mine_obsidian: 150, fill_bucket: 40, cast_obsidian: 60, build_portal: 90, light_portal: 20 }
export const RESULTS = ['ok', 'no_path', 'timeout', 'target_gone', 'took_damage', 'interrupted', 'not_found', 'no_table', 'no_furnace', 'no_materials', 'no_fuel', 'needs_tool', 'player_gone', 'failed', 'died']
const INTERRUPT_RESULT = { threat: 'interrupted', took_damage: 'took_damage', died: 'died', drowning: 'interrupted' }
const WAIT_IN_WATER_S = 12   // a wait that starts in water swims to shore (or floats) for this long instead of 3 s
const IRON_Y = 16
const DIAMOND_Y = -58
const ARMOR_SLOT = { iron_helmet: 'head', iron_chestplate: 'torso', iron_leggings: 'legs', iron_boots: 'feet' }
const HEADINGS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const HEADING_ORDER = ['north', 'east', 'south', 'west']
// The cardinal heading pointing away from `hostilePos`, from `botPos` (whichever axis has the larger separation
// decides north/south vs east/west). Pure; used by flee before it commits to a direction.
export function fleeHeading(hostilePos, botPos) {
  const dx = botPos.x - hostilePos.x, dz = botPos.z - hostilePos.z
  return Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
}
// The point flee() runs from: a hostile mob's position when one is found, else (fix round 1: flee never fled a
// player-only attacker, since nearestHostileEntity/obs.nearestHostile are mob-only) the attacker's live entity
// position when it's a player still tracked in bot.players, else the position recorded in obs.attacker at
// detection. null when there is nothing to flee from. Pure given the already-resolved inputs.
export function fleeTargetPos({ hostilePos, attacker, livePlayerPos } = {}) {
  return hostilePos ?? livePlayerPos ?? attacker?.pos ?? null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = detail => ({ result: 'ok', detail })
const fail = (result, detail) => ({ result, detail })

class Abort extends Error { constructor(why) { super(why); this.name = 'Abort' } }
// A thrown error -> a typed result (Motor.run; the plugin registry counts only the 'failed' ones as plugin bugs).
export function mapError(e) {
  if (e instanceof Abort) return /^(liquid|drop ahead)/.test(e.message) ? fail('failed', e.message) : fail(e.message === 'timeout' ? 'timeout' : 'interrupted', e.message)
  const n = e?.name || ''
  if (n === 'NoPath') return fail('no_path')
  if (n === 'NoHarvestTool' || n === 'NoItem') return fail('no_materials', e.message)
  if (n === 'Timeout' || n === 'PathStopped' || n === 'GoalChanged') return fail('timeout', n)
  return fail('failed', `${n}: ${e?.message}`.slice(0, 120))
}

// The liquid ('lava' / 'water') in the cells a staircase step digs (head, feet, step-down ahead) or in the cell the bot
// would stand on after the step, else null. Liquids have an empty bounding box, so they must be checked by name.
export function liquidAround(blockAt, ahead) {
  for (const dy of [1, 0, -1, -2]) {
    const b = blockAt(ahead.offset(0, dy, 0))
    if (b && (b.name === 'lava' || b.name === 'water')) return b.name
  }
  return null
}

// Standing blocks a bot in water swims to (motor.leaveWater). A shore cell is one of them with two passable cells above
// (no water, lava or water plants): its top is above the water line.
export const SHORE_BLOCKS = ['grass_block', 'sand', 'dirt', 'stone', 'gravel', 'coarse_dirt', 'podzol', 'red_sand', 'sandstone',
  'granite', 'diorite', 'andesite', 'deepslate', 'cobblestone', 'clay', 'tuff']
const WET = new Set(['water', 'lava', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column'])
const passable = b => !!b && b.boundingBox === 'empty' && !WET.has(b.name)
export function isShore(blockAt, pos, names = SHORE_BLOCKS) {
  const b = blockAt(pos)
  return !!b && names.includes(b.name) && passable(blockAt(pos.offset(0, 1, 0))) && passable(blockAt(pos.offset(0, 2, 0)))
}

// How far the bot would drop through `floor` (the cell it is about to stand on): drop 0 when floor is solid, else the
// number of non-solid cells from floor down to the first solid one (max `max`; an unloaded cell counts as a drop).
// liquid: the first water/lava met on the way (or, for a solid floor, water/lava right under it). Pure.
export function dropBelow(blockAt, floor, max = 4) {
  for (let drop = 0; drop < max; drop++) {
    const b = blockAt(floor.offset(0, -drop, 0))
    if (!b) return { drop: max, liquid: null }
    if (b.name === 'water' || b.name === 'lava') return { drop, liquid: b.name }
    if (b.boundingBox === 'block') {
      if (drop > 0) return { drop, liquid: null }
      const u = blockAt(floor.offset(0, -1, 0))
      return { drop: 0, liquid: u && (u.name === 'water' || u.name === 'lava') ? u.name : null }
    }
  }
  return { drop: max, liquid: null }
}
// The down staircase steps onto ahead-1, standing on ahead-2: its floor must be there (r2 runs: a staircase from a
// beach opened into water and undercut ground).
export const dropAhead = (blockAt, ahead) => dropBelow(blockAt, ahead.offset(0, -2, 0))
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])
export const isGravityBlock = b => !!b && (GRAVITY.has(b.name) || b.name.endsWith('_concrete_powder'))

// A fluid block of the given name that is a source (level 0), not a flowing one. Pure.
export function isFluidSource(block, fluid) {
  if (!block || block.name !== fluid) return false
  const level = block.getProperties?.().level ?? block.metadata
  return Number(level) === 0
}
export const isLavaSource = block => isFluidSource(block, 'lava')

export { portalLayout }   // lives in stages.js (summary uses it too); re-exported for the motor tests

// True when the segment from -> to reaches the cell `target` before any cell whose block `blocks(block, yInCell)`
// says stops the ray (sampled every 0.05 m). Mirrors the server's bucket raycast closely enough to pick an aim. Pure.
export function rayClear(blockAt, from, to, target, blocks) {
  const d = to.minus(from), n = Math.max(1, Math.ceil(d.norm() / 0.05))
  for (let i = 1; i <= n; i++) {
    const p = from.plus(d.scaled(i / n)), c = p.floored()
    if (c.x === target.x && c.y === target.y && c.z === target.z) return true
    const b = blockAt(c)
    if (b && blocks(b, p.y - c.y)) return false
  }
  return true
}
// Pickaxes from the one to spend first to the one to keep. For a pickaxe block, dig with the first held pickaxe that
// can harvest it: tunnelling (pathfinder digs, staircases, mine_stone) wore the iron pickaxe out in 10 minutes of the
// first chain run and dropped the chain back to stage 0. The iron pickaxe then only digs what needs it (diamond ore).
// null when the block is not a pickaxe block or nothing held harvests it (the caller's default applies). Pure.
export const PICKAXE_THRIFT = ['stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']
export function thriftyPickaxe(block, items) {
  if (!block || block.material !== 'mineable/pickaxe') return null
  for (const name of PICKAXE_THRIFT) {
    const it = items.find(i => i.name === name)
    if (it && (!block.harvestTools || block.harvestTools[it.type])) return it
  }
  return null
}
// Items smelted per fuel item. Sticks are left out on purpose (they are what the chain is short of).
export const fuelValue = name => name === 'coal' || name === 'charcoal' ? 8 : name.endsWith('_planks') || name.endsWith('_log') ? 1.5 : 0
// How to fuel a furnace for `raw` items given the inventory `items` [{name, count}] and the fuel slot `slot`
// ({name, count} | null): {take: empty the slot first, put: {name, count} | null, smelt: how many raw items the fuel
// covers}. The first chain run's smelt timeouts came from a leftover plank in the slot (1.5 items) being trusted to
// cover three, and from one log (1.5 items) put in for four raw iron: the smelt then waited the full 90 s. Pure.
export function fuelPlan(raw, items, slot) {
  const have = slot ? slot.count * fuelValue(slot.name) : 0
  if (have >= raw) return { take: false, put: null, smelt: raw }
  const held = {}
  for (const i of items) if (fuelValue(i.name) > 0) held[i.name] = (held[i.name] || 0) + i.count
  const rank = n => n === slot?.name ? 0 : fuelValue(n) >= 8 ? 1 : n.endsWith('_planks') ? 2 : 3
  let best = { take: false, put: null, smelt: Math.min(raw, Math.floor(have)) }
  for (const name of Object.keys(held).sort((a, b) => rank(a) - rank(b))) {
    const v = fuelValue(name), same = name === slot?.name
    const base = same || !slot ? have : 0
    const count = Math.min(held[name], Math.ceil((raw - base) / v))
    const plan = { take: !same && !!slot, put: { name, count }, smelt: Math.min(raw, Math.floor(base + count * v)) }
    if (plan.smelt >= raw) return plan
    if (plan.smelt > best.smelt) best = plan
  }
  return best
}
const FILLERS = ['cobblestone', 'cobbled_deepslate', 'dirt']
const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air')

// GoalNear that only ends on a cell level with or above `minY` (pouring onto lava from below is not possible).
class GoalNearAbove extends goals.GoalNear {
  constructor(x, y, z, range, minY) { super(x, y, z, range); this.minY = minY }
  isEnd(node) { return node.y >= this.minY && super.isEnd(node) }
}

export class Motor {
  constructor(bot, mcData, mem, { log = () => {}, timeouts = {} } = {}) {
    this.bot = bot; this.md = mcData; this.mem = mem; this.log = log
    this.timeouts = { ...TIMEOUTS, ...timeouts }
    this.busy = false; this.current = null; this.last = null; this.interrupted = null; this.deadline = 0
    this.gen = 0   // per-run generation: an executor abandoned by a timeout/interrupt is aborted at its next check()
    bot.setMaxListeners(64)   // abandoned collect/goto calls leave listeners behind briefly; the default of 10 warns
    this.movements = new Movements(bot, mcData)
    this.movements.canDig = true
    this.movements.allow1by1towers = true
    this.movements.maxDropDown = 3
    for (const n of ['crafting_table', 'furnace']) this.movements.blocksCantBreak.add(mcData.blocksByName[n].id)
    bot.pathfinder.setMovements(this.movements)
    // explore_toward(down)'s walk: the same, but swimming costs 25 per cell so the path stays out of lakes (r2_kev t=642).
    this.dryMovements = new Movements(bot, mcData)
    Object.assign(this.dryMovements, { canDig: true, allow1by1towers: true, maxDropDown: 3, liquidCost: 25 })
    for (const n of ['crafting_table', 'furnace']) this.dryMovements.blocksCantBreak.add(mcData.blocksByName[n].id)
    // Short approaches next to a frame or a pool: no digging, no scaffolding (the pathfinder would tower with the
    // corner cobblestone, inside the frame), no parkour.
    this.walkMovements = new Movements(bot, mcData)
    this.walkMovements.canDig = false
    this.walkMovements.allow1by1towers = false
    this.walkMovements.allowParkour = false
    this.walkMovements.scafoldingBlocks = []
    this.walkMovements.maxDropDown = 2
    if (bot.collectBlock) bot.collectBlock.movements = this.movements   // collectblock re-applies its own Movements on every collect()
    // Every dig picks the thriftiest pickaxe that works (thriftyPickaxe): the pathfinder's own digs, collectblock's
    // (via mineflayer-tool) and digSafe.
    if (bot.pathfinder.bestHarvestTool) {
      const fastest = bot.pathfinder.bestHarvestTool
      bot.pathfinder.bestHarvestTool = block => thriftyPickaxe(block, bot.inventory.items()) ?? fastest(block)
    }
    if (bot.tool?.equipForBlock) {
      const equipFastest = bot.tool.equipForBlock.bind(bot.tool)
      bot.tool.equipForBlock = async (block, options, cb) => {
        const it = thriftyPickaxe(block, bot.inventory.items())
        if (!it) return equipFastest(block, options, cb)
        if (bot.heldItem?.name !== it.name) await bot.equip(it, 'hand')
        cb?.()
      }
    }
    bot.pathfinder.thinkTimeout = 4000
    bot.pathfinder.searchRadius = 64   // unlimited (-1) lets A* with digging enabled allocate gigabytes on a buried goal; 32 starves walks over hills
    // Paper answers every craft/click with a burst of full-inventory resyncs (window_items) whose first snapshot can
    // show items missing; counts read or clicks sent inside the burst are wrong or rejected. settleInventory() waits
    // until no inventory packet has arrived for a few ticks.
    this.lastInvPacket = 0; this.invPacketSeq = 0
    const touch = () => { this.lastInvPacket = Date.now(); this.invPacketSeq++ }
    bot._client.on('set_slot', touch)
    bot._client.on('window_items', touch)
    // mineflayer sends window clicks back to back with one state id shared across windows; Paper sees a stale id on
    // every click and replies with a full resync, and when that resync lands between two clicks it resets the client's
    // cursor item, so mineflayer's craft re-clicks a source slot (merging the cursor stack back) and the recipe never
    // completes (~60% of 3x3 crafts). Serialising the clicks behind the server's reply makes the local view consistent.
    const origClick = bot.clickWindow.bind(bot)
    bot.clickWindow = async (...args) => {
      const seq = this.invPacketSeq
      const r = await origClick(...args)
      for (let i = 0; i < 6 && this.invPacketSeq === seq; i++) await bot.waitForTicks(1)
      await bot.waitForTicks(1)
      return r
    }
    this.ids = names => names.map(n => mcData.blocksByName[n]?.id).filter(x => x != null)
    this.logIds = mcData.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id)
    this.stoneIds = this.ids(['stone', 'deepslate', 'cobblestone'])
    this.coalIds = this.ids(['coal_ore', 'deepslate_coal_ore'])
    this.ironIds = this.ids(['iron_ore', 'deepslate_iron_ore'])
    this.diamondIds = this.ids(['diamond_ore', 'deepslate_diamond_ore'])
    this.gravelIds = this.ids(['gravel'])
    this.obsidianIds = this.ids(['obsidian'])
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------
  async run(id, obs) {
    if (this.busy) throw new Error(`motor busy with ${this.current.id}`)
    const { name, arg } = parseOption(id)
    // A built-in executor first, then a plugin from the registry (agent/plugins.js; the runner sets motor.plugins). The
    // plugin object is taken once here: a hot reload during the run does not change the code this run executes.
    const builtin = this.exec[name]
    const plugin = builtin ? null : this.plugins?.get(name) ?? null
    if (!builtin && !plugin) return fail('failed', `unknown subtask ${name}`)
    const exec = builtin ?? function (a, o) { return plugin.run(this, a, o) }
    this.busy = true; this.interrupted = null
    const gen = ++this.gen
    const timeoutS = plugin ? (plugin.timeout ?? 30)
      : name === 'wait' && this.bot.entity.isInWater ? Math.max(this.timeouts.wait, WAIT_IN_WATER_S) : (this.timeouts[name] ?? 30)
    this.current = { id, name, arg, t0: Date.now(), y0: this.bot.entity.position.y, progress: null, gen }
    this.deadline = Date.now() + timeoutS * 1000
    const ctx = Object.create(this)   // executors run with this = ctx so check() can compare their run generation
    ctx.runGen = gen
    let out, timer
    try {
      out = await Promise.race([
        exec.call(ctx, arg, obs).catch(e => this.mapError(e)),
        new Promise(r => { timer = setTimeout(() => r(fail('timeout')), timeoutS * 1000) }),
        new Promise(r => { this._onInterrupt = r }),
      ])
    } finally {
      clearTimeout(timer)
      this._onInterrupt = null
      this.stopAll()
    }
    await sleep(150)   // let the pathfinder's path_stop / goal_updated events from stopAll() drain before the next goto listens
    if (this.interrupted) out = fail(INTERRUPT_RESULT[this.interrupted] || 'interrupted', this.interrupted)
    if (plugin?.breaker || ['gather_wood', 'mine_stone', 'mine_coal', 'mine_iron', 'mine_diamond', 'mine_gravel', 'mine_obsidian', 'explore_toward', 'return_to_base', 'flee'].includes(name)) {
      this.mem.lastPath = out.result === 'ok' ? 'ok' : ['no_path', 'timeout'].includes(out.result) ? out.result : this.mem.lastPath
    }
    this.last = { id, result: out.result }
    this.busy = false; this.current = null
    return out
  }

  interrupt(reason) {
    if (!this.busy) return
    this.interrupted = reason
    this.stopAll()
    if (this._onInterrupt) this._onInterrupt(fail(INTERRUPT_RESULT[reason] || 'interrupted', reason))
  }

  // Never call bot.pathfinder.stop() here: it only sets a flag the tick consumes while a path exists; with the path
  // already cleared the flag survives and the next goto dies instantly with PathStopped (collectblock's cancelTask does
  // exactly that, so its target list is cleared directly instead). setGoal(null) ends movement, the abandoned goto's
  // promise (GoalChanged) and any A* still thinking.
  stopAll() {
    const b = this.bot
    try { b.collectBlock.targets.clear() } catch {}
    try { b.pathfinder.setGoal(null) } catch {}
    try { b.stopDigging() } catch {}
    try { b.pvp.stop() } catch {}
    try { b.clearControlStates() } catch {}
  }

  progress() {
    const c = this.current
    if (!c) return null
    if (c.name === 'explore_toward' && c.arg === 'down') return Math.max(0, Math.min(1, (c.y0 - this.bot.entity.position.y) / Math.max(1, c.y0 - IRON_Y)))
    if (c.name === 'explore_toward' && c.arg === 'deep') return Math.max(0, Math.min(1, (c.y0 - this.bot.entity.position.y) / Math.max(1, c.y0 - DIAMOND_Y)))
    return c.progress
  }

  elapsedS() { return this.current ? (Date.now() - this.current.t0) / 1000 : 0 }

  check() {
    if (this.runGen != null && this.runGen !== this.gen) throw new Abort('superseded')
    if (this.interrupted) throw new Abort(this.interrupted)
    if (Date.now() > this.deadline) throw new Abort('timeout')
  }

  mapError(e) { return mapError(e) }

  // ---- helpers ---------------------------------------------------------------------------------------------------
  count(name) { return this.bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0) }
  countBy(pred) { return this.bot.inventory.items().filter(i => pred(i.name)).reduce((n, i) => n + i.count, 0) }
  item(name) { return this.bot.inventory.items().find(i => i.name === name) }

  async settleInventory(quietTicks = 4, maxTicks = 60) {
    const t0 = Date.now()
    while (Date.now() - t0 < maxTicks * 50) {
      await this.bot.waitForTicks(1)
      if (Date.now() - this.lastInvPacket >= quietTicks * 50) return
    }
  }

  async equipBestPickaxe() {
    for (const m of ['diamond', 'iron', 'stone', 'wooden']) {
      const it = this.item(`${m}_pickaxe`)
      if (it) { if (this.bot.heldItem?.name !== it.name) await this.bot.equip(it, 'hand'); return it }
    }
    return null
  }

  async equipWeapon() {
    for (const n of ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'iron_axe', 'stone_axe']) {
      const it = this.item(n); if (it) { await this.bot.equip(it, 'hand'); return it }
    }
    return this.equipBestPickaxe()
  }

  async goto(goal, movements = null) {
    this.bot.pathfinder.setGoal(null)   // drains a stale stop flag (emits path_stop now, before goto listens)
    await this.bot.waitForTicks(1)
    this.check()
    if (!movements) return this.bot.pathfinder.goto(goal)
    this.bot.pathfinder.setMovements(movements)
    try { await this.bot.pathfinder.goto(goal) } finally { this.bot.pathfinder.setMovements(this.movements) }
  }
  walkTo(goal) { return this.goto(goal, this.walkMovements) }

  // mineflayer-collectblock asks mineflayer-tool for a harvesting tool with getFromChest on; with no chests and no
  // tool that recurses forever in a microtask loop (4 GB heap in a minute). Never hand it a block we cannot harvest.
  async collectOne(block) {
    if (!block.canHarvest(this.bot.heldItem?.type ?? null)) { const e = new Error(`no tool to harvest ${block.name}`); e.name = 'NoHarvestTool'; throw e }
    for (let attempt = 0; ; attempt++) {
      await this.resetCollect()
      try { await this.bot.collectBlock.collect(block, { ignoreNoPath: false }); return }
      catch (e) {
        // "Digging aborted": collectblock started its dig while the pathfinder was still breaking a block on the path.
        if (attempt < 2 && /Digging aborted/.test(e?.message || '')) { this.check(); this.log(`collect ${block.name}: dig aborted, retrying`); await this.waitDigIdle(); continue }
        throw e
      }
    }
  }

  // collect() with a lingering previous task calls cancelTask -> pathfinder.stop(), whose flag then kills the next
  // goto (PathStopped / GoalChanged). Empty the target list ourselves and drain the goal before every collect.
  async resetCollect() {
    const cb = this.bot.collectBlock
    if (!cb.targets.empty) { cb.targets.clear(); await Promise.race([new Promise(r => this.bot.once('collectBlock_finished', r)), this.bot.waitForTicks(10)]) }
    this.bot.pathfinder.setGoal(null)
    await this.bot.waitForTicks(1)
  }

  async waitDigIdle() {
    for (let i = 0; i < 40 && (this.bot.targetDigBlock || this.bot.pathfinder.isMining()); i++) await this.bot.waitForTicks(1)
    await this.bot.waitForTicks(4)
  }

  async digSafe(block) {
    for (let attempt = 0; ; attempt++) {
      try {
        const it = thriftyPickaxe(block, this.bot.inventory.items())
        if (it && this.bot.heldItem?.name !== it.name) await this.bot.equip(it, 'hand')
        await this.bot.dig(block); return
      }
      catch (e) {
        if (attempt < 2 && /Digging aborted/.test(e?.message || '')) { this.check(); await this.waitDigIdle(); continue }
        throw e
      }
    }
  }

  // A crafting table or furnace the bot can use: one in reach, else the remembered one if it is within 32 m (walk
  // there and re-check; forget it if it is gone). Returns the block, positioned within reach, or null. A bot carrying
  // one does not walk unless placing it failed (a climb back to the surface table ate the whole 20 s craft timeout).
  async findStation(blockName, memKey, walk = !this.count(blockName)) {
    const id = this.md.blocksByName[blockName].id
    let block = this.bot.findBlock({ matching: id, maxDistance: 8 })
    const remembered = this.mem.base[memKey]
    if (!block && remembered && walk && this.bot.entity.position.distanceTo(new Vec3(remembered.x, remembered.y, remembered.z)) <= 32) {
      try { await this.goto(new goals.GoalNear(remembered.x, remembered.y, remembered.z, 2)) } catch (e) { if (e instanceof Abort) throw e; this.log(`${blockName}: cannot reach the remembered one (${e?.name})`) }
      this.check()
      block = this.bot.findBlock({ matching: id, maxDistance: 6 })
      if (!block) { this.mem.setBase(memKey, null); this.log(`${blockName}: remembered one is gone`) }
    }
    if (block && this.bot.entity.position.distanceTo(block.position) > 3.5) { await this.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)); this.check() }
    return block
  }

  // Place `itemName` from the inventory on a solid block with air above, within 3 m; returns the placed block or null.
  // In a tunnel with no free cell it makes one: digs a solid block at feet level and places on the block under it.
  async placeNear(itemName) {
    const placed = await this.placeNearPass(itemName, false)
    if (placed) return placed
    return this.placeNearPass(itemName, true)
  }

  async placeNearPass(itemName, makeRoom) {
    const it = this.item(itemName)
    if (!it) return null
    const feet = this.bot.entity.position.floored()
    const offsets = []
    for (const dy of [0, -1, 1]) for (const dx of [-2, -1, 0, 1, 2]) for (const dz of [-2, -1, 0, 1, 2]) {
      if (dx === 0 && dz === 0) continue
      offsets.push([dx, dy, dz, Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 0.5])
    }
    offsets.sort((a, b) => a[3] - b[3])
    const isLiquid = b => b.name === 'water' || b.name === 'lava'
    let tried = 0
    for (const [dx, dy, dz] of offsets) {
      if (makeRoom && (dy !== 0 || Math.abs(dx) + Math.abs(dz) !== 1)) continue   // room is only made in the four adjacent cells at feet level
      const target = feet.offset(dx, dy, dz)
      const ref = this.bot.blockAt(target.offset(0, -1, 0)), at = this.bot.blockAt(target)
      if (!ref || !at || ref.boundingBox !== 'block' || isLiquid(at) || isLiquid(ref)) continue
      if (makeRoom ? (at.boundingBox !== 'block' || !this.bot.canDigBlock(at) || at.name === 'crafting_table' || at.name === 'furnace') : at.boundingBox !== 'empty') continue
      tried++
      try {
        if (makeRoom) { await this.equipBestPickaxe(); await this.digSafe(at); await this.bot.waitForTicks(4); this.check() }
        else if (at.name !== 'air' && at.name !== 'cave_air') { await this.digSafe(at); await this.bot.waitForTicks(2) }   // grass, flowers: clear first
        await this.bot.equip(it, 'hand')
        await this.bot.placeBlock(ref, new Vec3(0, 1, 0))
        await this.bot.waitForTicks(2)
        const placed = this.bot.blockAt(target)
        if (placed && placed.name === itemName) { await this.settleInventory(); return placed }
      } catch (e) { this.log(`placeNear ${itemName} at ${target}: ${e.message}`) }
      this.check()
      if (tried >= 6) break
    }
    this.log(`placeNear ${itemName}${makeRoom ? ' (making room)' : ''}: no spot (${tried} tried) around ${feet}`)
    return null
  }

  // Walk within `range` of pos (a block position) unless already there.
  async standNear(pos, range) {
    if (this.bot.entity.position.distanceTo(pos.offset(0.5, 0, 0.5)) <= range + 0.5) return
    await this.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range))
    this.check()
  }

  // Nearest source block of `fluid` within maxDistance, else null.
  fluidSource(fluid, maxDistance) {
    const id = this.md.blocksByName[fluid]?.id
    if (id == null) return null
    const me = this.bot.entity.position
    // findBlocks walks chunk sections nearest-first and stops at `count`: a lake in the bot's own section would fill a
    // small count before a nearer pool in the next section is reached.
    const cands = this.bot.findBlocks({ matching: id, maxDistance, count: 1024 }).sort((a, b) => me.distanceTo(a) - me.distanceTo(b))
    for (const p of cands) { const b = this.bot.blockAt(p); if (isFluidSource(b, fluid)) return b }
    return null
  }
  pickLavaSource(maxDistance) { return this.fluidSource('lava', maxDistance) }

  // Look at `point` and use the held item (a bucket); the server raycasts from the rotation it last received, so the
  // look packet must go out (next physics tick) before the use packet.
  async useHeldAt(point) {
    await this.bot.lookAt(point, true)
    await this.bot.waitForTicks(2)
    this.bot.activateItem()
    await this.bot.waitForTicks(4)
    await this.settleInventory()
  }

  eye() { return this.bot.entity.position.offset(0, 1.62, 0) }   // entity.height is the 1.8 m hitbox, not the eye

  // An aim point on `cellPos` the server's bucket ray (5 m from the eye) reaches before anything `blocks` it, else null.
  aimAt(cellPos, points, blocks) {
    const eye = this.eye(), at = p => this.bot.blockAt(p)
    for (const [dx, dy, dz] of points) {
      const pt = cellPos.offset(dx, dy, dz)
      if (eye.distanceTo(pt) <= 4.8 && rayClear(at, eye, pt, pt.floored(), blocks)) return pt
    }
    return null
  }

  // Scoop the fluid source at `pos` with the empty bucket (the empty bucket's ray stops at solid blocks and at fluid
  // sources: a lava source in the way would fill it with lava). Walks closer (no digging) when no aim is clear.
  async scoop(pos, fluid) {
    const full = `${fluid}_bucket`, before = this.count(full)
    const blocks = (b, y) => b.boundingBox === 'block' || (b.name === 'lava' && fluid !== 'lava' && isFluidSource(b, 'lava') && y < 0.9)
    const points = [[0.5, 0.85, 0.5], [0.5, 0.5, 0.5], [0.2, 0.85, 0.5], [0.8, 0.85, 0.5], [0.5, 0.85, 0.2], [0.5, 0.85, 0.8]]
    for (let attempt = 0; attempt < 2; attempt++) {
      this.check()
      let aim = attempt === 0 ? this.aimAt(pos, points, blocks) : null
      if (!aim) {
        // The first miss (or no clear aim): step up next to the source (onto the rim) for a steep ray, else just closer.
        for (const g of [new GoalNearAbove(pos.x, pos.y, pos.z, 1.5, pos.y + 1), new GoalNearAbove(pos.x, pos.y, pos.z, 2, pos.y)]) {
          try { await this.walkTo(g); break } catch (e) { if (e instanceof Abort) throw e; this.log(`scoop ${fluid}: cannot get closer (${e?.name})`) }
        }
        this.check()
        aim = this.aimAt(pos, points, blocks) || pos.offset(0.5, 0.85, 0.5)
      }
      const bucket = this.item('bucket')
      if (!bucket) return false
      await this.bot.equip(bucket, 'hand')
      await this.useHeldAt(aim)
      if (this.count(full) > before) return true
      this.log(`scoop ${fluid} at ${pos}: missed from ${this.bot.entity.position.floored()} (aim ${aim})`)
      if (!isFluidSource(this.bot.blockAt(pos), fluid)) return false
    }
    return false
  }

  // Place `itemName` at pos against any solid neighbour; true when the block at pos is `itemName` afterwards.
  async placeAt(pos, itemName) {
    const b = this.bot
    if (b.blockAt(pos)?.name === itemName) return true
    const it = this.item(itemName)
    if (!it) return false
    let ref = null
    for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const r = b.blockAt(pos.offset(...d))
      if (r && r.boundingBox === 'block') { ref = r; break }
    }
    if (!ref) { this.log(`placeAt ${itemName} at ${pos}: no solid neighbour`); return false }
    if (this.eye().distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5) { await this.walkTo(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); this.check() }
    try {
      await b.equip(it, 'hand')
      await b.placeBlock(ref, pos.minus(ref.position))
    } catch (e) { this.log(`placeAt ${itemName} at ${pos}: ${e.message}`) }
    await b.waitForTicks(2)
    this.check()
    return b.blockAt(pos)?.name === itemName
  }

  // A portal site: the 4x5 plane standing on a solid 4-wide row, `dist` ahead along a heading, perpendicular to it.
  portalSiteOk(origin, axis) {
    const L = portalLayout(origin, axis)
    const cells = [...L.obsidian, ...L.filler]
    for (let u = 1; u <= 2; u++) for (let v = 1; v <= 3; v++) cells.push(axis === 'x' ? origin.offset(u, v, 0) : origin.offset(0, v, u))
    const ground = [0, 1, 2, 3].map(u => this.bot.blockAt(axis === 'x' ? origin.offset(u, -1, 0) : origin.offset(0, -1, u)))
    return ground.every(g => g && g.boundingBox === 'block') && cells.every(c => isAir(this.bot.blockAt(c)))
  }

  // A partly built frame from an earlier (interrupted) attempt is resumed while its cells hold only air or the right block.
  portalSiteResumable(origin, axis) {
    const L = portalLayout(origin, axis)
    const inside = []
    for (let u = 1; u <= 2; u++) for (let v = 1; v <= 3; v++) inside.push(axis === 'x' ? origin.offset(u, v, 0) : origin.offset(0, v, u))
    return L.obsidian.every(p => { const n = this.bot.blockAt(p)?.name; return isAir(this.bot.blockAt(p)) || n === 'obsidian' })
      && L.filler.every(p => { const b = this.bot.blockAt(p); return isAir(b) || b?.boundingBox === 'block' })
      && inside.every(p => isAir(this.bot.blockAt(p)) || this.bot.blockAt(p)?.name === 'nether_portal')
  }

  // The frame around a column anchor from summarize() (the lowest obsidian of a vertical stack of three): its axis and
  // lowest inside cell, found from the bottom-row obsidian next to the anchor's foot.
  frameFromAnchor(a) {
    const anchor = new Vec3(a.x, a.y, a.z)
    for (const [axis, du] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
      const foot = axis === 'x' ? anchor.offset(du, -1, 0) : anchor.offset(0, -1, du)
      if (this.bot.blockAt(foot)?.name === 'obsidian') return { axis, inside: axis === 'x' ? anchor.offset(du, 0, 0) : anchor.offset(0, 0, du) }
    }
    return null
  }

  headingVec() { return HEADINGS[this.mem.heading] || HEADINGS.north }
  rotateHeading() {
    this.mem.heading = HEADING_ORDER[(HEADING_ORDER.indexOf(this.mem.heading) + 1) % 4]
  }

  // Rotate through up to 4 cardinal headings, starting at `startHeading` (default this.mem.heading), until
  // goalAtFn([hx, hz]) (a goal cell, headingVec()'s shape) is dry (wetNear false), or all 4 are wet. Used by
  // explore_toward(down), explore_toward(surface) and flee, which all had this same rotate-until-dry loop (fix
  // round 1). Returns {heading, turns} (turns === 4: every heading was wet, heading is back to startHeading).
  // commit (default true, explore_toward's persistent heading so the next call resumes from here): write
  // mem.heading on every turn; false (flee) tries headings locally and leaves committing the result to the caller.
  turnUntilDry(goalAtFn, { commit = true, startHeading = this.mem.heading } = {}) {
    let heading = startHeading, turns = 0
    while (turns < 4 && this.wetNear(goalAtFn(HEADINGS[heading]))) {
      heading = HEADING_ORDER[(HEADING_ORDER.indexOf(heading) + 1) % 4]
      turns++
      if (commit) this.mem.heading = heading
    }
    return { heading, turns }
  }

  // ---- executors -------------------------------------------------------------------------------------------------
  exec = {
    async gather_wood() {
      const before = this.countBy(n => n.endsWith('_log'))
      let lastErr = null
      for (let i = 0; i < 3; i++) {
        this.check()
        const block = this.bot.findBlock({ matching: this.logIds, maxDistance: 48 })
        if (!block) break
        this.log(`gather_wood: ${block.name} at ${block.position} (${this.bot.entity.position.distanceTo(block.position).toFixed(0)} m)`)
        try { await this.collectOne(block) } catch (e) { lastErr = e; this.log(`gather_wood: ${e?.name}: ${e?.message}`); if (e?.name === 'NoPath') this.rotateHeading(); break }
      }
      const got = this.countBy(n => n.endsWith('_log')) - before
      if (got > 0) return ok(`+${got} logs`)
      if (lastErr) throw lastErr
      return fail('not_found', 'no log within 48 m')
    },

    async mine_stone() { return this.mineKind(this.stoneIds, 16, 4, n => n === 'cobblestone' || n === 'cobbled_deepslate', 'stone') },
    async mine_coal() { return this.mineKind(this.coalIds, 32, 3, n => n === 'coal', 'coal ore') },
    async mine_iron() {
      let block = this.bot.findBlock({ matching: this.ironIds, maxDistance: 32 })
      if (!block && this.mem.ironSeen) {
        const p = this.mem.ironSeen.pos
        await this.goto(new goals.GoalNear(p.x, p.y, p.z, 4))
        this.check()
        block = this.bot.findBlock({ matching: this.ironIds, maxDistance: 16 })
        if (!block) { this.mem.ironSeen = null; return fail('target_gone', 'no iron at the remembered spot') }
      }
      if (!block) return fail('not_found', 'no iron known')
      return this.mineKind(this.ironIds, 32, 3, n => n === 'raw_iron', 'iron ore')
    },

    async mine_diamond() {
      let block = this.bot.findBlock({ matching: this.diamondIds, maxDistance: 32 })
      if (!block && this.mem.seen?.diamond) {
        const p = this.mem.seen.diamond.pos
        await this.goto(new goals.GoalNear(p.x, p.y, p.z, 4))
        this.check()
        block = this.bot.findBlock({ matching: this.diamondIds, maxDistance: 16 })
        if (!block) { this.mem.seen.diamond = null; return fail('target_gone', 'no diamond at the remembered spot') }
      }
      if (!block) return fail('not_found', 'no diamond known')
      return this.mineKind(this.diamondIds, 32, 4, n => n === 'diamond', 'diamond ore')
    },

    // Gravel drops flint 10% of the time: dig up to 12 gravel blocks nearby, stop at the first flint.
    async mine_gravel() {
      const before = this.count('flint')
      let dug = 0, lastErr = null
      while (dug < 12) {
        this.check()
        const block = this.pickBlock(this.gravelIds, 16)
        if (!block) break
        try { await this.collectOne(block) } catch (e) { lastErr = e; break }
        dug++
        this.current.progress = dug / 12
        await this.settleInventory()
        if (this.count('flint') > before) return ok('+1 flint')
      }
      if (this.count('flint') > before) return ok('+1 flint')
      if (!dug && lastErr) throw lastErr
      if (!dug) return fail('not_found', 'no gravel within 16 m')
      return fail('failed', `no flint from ${dug} gravel`)
    },

    // collectOne refuses obsidian without a diamond pickaxe (NoHarvestTool -> no_materials).
    // The bot's own frame (mem.portal, built or half built) is never a candidate.
    async mine_obsidian() {
      const mp = this.mem.portal
      const frame = mp ? new Set(portalLayout(new Vec3(mp.origin.x, mp.origin.y, mp.origin.z), mp.axis).obsidian.map(v => `${v.x},${v.y},${v.z}`)) : null
      return this.mineKind(this.obsidianIds, 16, 10, n => n === 'obsidian', 'obsidian', frame)
    },

    async craft(item) {
      let target = item
      let logName = null
      if (item === 'planks') {
        const byType = {}
        for (const i of this.bot.inventory.items()) if (i.name.endsWith('_log')) byType[i.name] = (byType[i.name] || 0) + i.count
        logName = Object.keys(byType).sort((a, b) => byType[b] - byType[a])[0]
        if (!logName) return fail('no_materials', 'no logs')
        target = logName.replace('_log', '_planks')
      } else if (item === 'sticks') target = 'stick'
      if (this.md.itemsByName[target]?.id == null) return fail('failed', `unknown item ${target}`)
      let table = null
      if (TABLE_ITEMS.has(item)) {
        table = await this.craftingTable()
        if (!table) return fail('no_table')
      }
      return this.craftAny(target, () => item === 'planks' ? Math.min(this.count(logName), 2) : 1, table)
    },

    async smelt(item) {
      if (item !== 'iron_ingot') return fail('failed', `cannot smelt ${item}`)
      const r = await this.smeltAny('raw_iron', 'iron_ingot')
      if (r.result === 'no_fuel') return fail('no_materials', 'no fuel')
      return r.result === 'ok' ? ok(`+${r.count} iron ingots`) : r
    },

    async explore_toward(target, obs) {
      const me = this.bot.entity.position
      const [fx, fz] = this.headingVec()
      if (target === 'cave') {
        const p = this.bot.findBlocks({ matching: this.md.blocksByName.cave_air.id, maxDistance: 32, count: 1 })[0]
        if (!p) return fail('target_gone', 'no cave in range')
        await this.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
        return ok('at the cave')
      }
      if (['down', 'deep', 'surface'].includes(target) && this.bot.entity.isInWater) {
        // r2 runs: the bot drowned at the bottom of a lake while the pathfinder dug down (5x slower under water, and
        // again off the ground) or walked along the bottom. Get out first; the driver repeats the subtask from dry land.
        const r = await this.leaveWater()
        if (r === 'left') return ok('left water')
        if (target !== 'surface') return fail('failed', r === 'no_shore' ? 'in water, no shore' : 'in water, could not reach the shore')
      }
      if (target === 'down') {
        await this.equipBestPickaxe()
        if (me.y > IRON_Y) {
          // r2_kev t=642: the goal 6 m ahead and 4 m down lay in a lake; the bot sank to the bottom and drowned while
          // the pathfinder dug under water. Turn away from a wet goal (up to four headings); all wet: the staircase,
          // which stops at liquid itself.
          const goalAt = ([hx, hz]) => new Vec3(Math.floor(me.x) + 6 * hx, Math.floor(me.y) - 4, Math.floor(me.z) + 6 * hz)
          const { heading, turns } = this.turnUntilDry(goalAt)
          if (turns > 0) this.log(`down: water at the goal, ${turns === 4 ? 'every heading wet' : `turned ${heading}`}`)
          if (turns === 4) { await this.digStaircase(4); return ok(`y ${this.bot.entity.position.y.toFixed(0)}`) }
          const c = goalAt(HEADINGS[heading])
          try { await this.goto(new goals.GoalNear(c.x, c.y, c.z, 1), this.dryMovements) } catch (e) { if (e?.name === 'NoPath') { this.rotateHeading(); await this.digStaircase(4) } else throw e }
          return ok(`y ${this.bot.entity.position.y.toFixed(0)}`)
        }
        try { await this.goto(new goals.GoalXZ(Math.floor(me.x) + 12 * fx, Math.floor(me.z) + 12 * fz)) } catch (e) { if (e?.name === 'NoPath') { this.rotateHeading(); throw e } throw e }
        return ok(`tunnelled to y ${this.bot.entity.position.y.toFixed(0)}`)
      }
      if (target === 'deep') {
        await this.equipBestPickaxe()
        if (me.y > IRON_Y) return this.exec.explore_toward.call(this, 'down')
        if (me.y > DIAMOND_Y + 4) {
          // 4 steps per call (the driver repeats the subtask); a blocked heading is rotated and tried once more.
          try { await this.digStaircase(4) } catch (e) { if (e?.name === 'NoPath') { this.rotateHeading(); await this.digStaircase(4) } else throw e }
          return ok(`y ${this.bot.entity.position.y.toFixed(0)}`)
        }
        // A* stops at cost h(start) + searchRadius. Twelve steps of deepslate at 2 digs each cost ~80 with a diamond
        // pickaxe and more with the stone one thriftyPickaxe spends first, past the usual 64: when the search finished
        // before the bot set off on a partial path (a fast CPU), the tunnel was noPath every time. Widen it here only.
        const radius = this.bot.pathfinder.searchRadius
        this.bot.pathfinder.searchRadius = 160
        try { await this.goto(new goals.GoalXZ(Math.floor(me.x) + 12 * fx, Math.floor(me.z) + 12 * fz)) } catch (e) { if (e?.name === 'NoPath') this.rotateHeading(); throw e }
        finally { this.bot.pathfinder.searchRadius = radius }
        return ok(`tunnelled at y ${this.bot.entity.position.y.toFixed(0)}`)
      }
      // surface. Underground (no sky light) it climbs first: the first chain run walked 24 m sideways at y 50 over and
      // over while the only tree was 16 m above it (gather_wood no_path, explore_toward(surface) ok, repeat for 5 min).
      // The pathfinder digs up and towers with carried blocks; the driver repeats the subtask until the sky is open.
      // A pathfinder GoalY stood still for 2 minutes in run 2 (towering in a 2-high tunnel: the jump hits the ceiling),
      // so the climb is a manual staircase up; a blocked heading (liquid, bedrock, nothing to step on) is rotated.
      if (obs?.underground ?? this.underground()) {
        const y0 = me.y
        try { await this.digStaircaseUp(8) } catch (e) { if (e?.name !== 'Abort') throw e; this.log(`climb: ${e.message}`) }
        const y = this.bot.entity.position.y
        return y > y0 + 0.5 ? ok(`climbed to y ${y.toFixed(0)}`) : fail('no_path', 'no way up here')
      }
      if (this.mem.lastPath && this.mem.lastPath !== 'ok') this.rotateHeading()
      // The live session waded into the sea on this walk too: turn away from a wet goal first, like explore_toward(down).
      const goalAt = ([hx, hz]) => new Vec3(Math.floor(me.x) + 24 * hx, Math.floor(me.y), Math.floor(me.z) + 24 * hz)
      const { heading, turns: wetTurns } = this.turnUntilDry(goalAt)
      if (wetTurns > 0) this.log(`surface: water ahead, ${wetTurns === 4 ? 'every heading wet' : `turned ${heading}`}`)
      if (wetTurns === 4) return fail('no_path', 'water ahead')
      const [sx, sz] = HEADINGS[heading]
      try { await this.goto(new goals.GoalXZ(Math.floor(me.x) + 24 * sx, Math.floor(me.z) + 24 * sz)) } catch (e) { this.rotateHeading(); throw e }
      return ok('walked 24 m')
    },

    async return_to_base() {
      const p = this.mem.base.table
      if (!p) return fail('target_gone', 'no base')
      await this.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
      return ok()
    },

    async eat() {
      const it = this.bot.inventory.items().find(i => FOOD.has(i.name))
      if (!it) return fail('no_materials', 'no food')
      await this.bot.equip(it, 'hand')
      await this.bot.consume()
      return ok(`ate ${it.name}`)
    },

    async build_shelter() {
      const b = this.bot
      const blockItem = () => b.inventory.items().find(i => i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'cobbled_deepslate')
      if (!blockItem()) return fail('no_materials', 'no blocks to seal with')
      if (b.entity.isInWater) {   // digging in and sealing the top under water is a grave: swim to shore first
        const r = await this.leaveWater()
        if (r === 'no_shore') return fail('failed', 'in water, no shore')
        if (r !== 'left') return fail('failed', 'in water, could not reach the shore')
        this.check()
      }
      await this.equipBestPickaxe()
      for (let i = 0; i < 2; i++) {
        this.check()
        const below = b.blockAt(b.entity.position.offset(0, -1, 0).floored())
        if (!below || below.boundingBox !== 'block') break
        await this.digSafe(below)
        await sleep(700)
      }
      const head = b.entity.position.floored().offset(0, 2, 0)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ref = b.blockAt(head.offset(dx, 0, dz))
        if (!ref || ref.boundingBox !== 'block') continue
        try { await b.equip(blockItem(), 'hand'); await b.placeBlock(ref, new Vec3(-dx, 0, -dz)); return ok('sealed in') } catch (e) { this.log(`seal: ${e.message}`) }
      }
      return fail('failed', 'could not seal the top')
    },

    async fight() {
      const b = this.bot
      const target = this.nearestHostileEntity()
      if (!target) return fail('target_gone')
      await this.equipWeapon()
      b.pvp.attack(target)
      const t0 = Date.now()
      while (Date.now() - t0 < this.timeouts.fight * 1000) {
        this.check()
        if (!target.isValid || !b.entities[target.id]) return ok('killed or gone')
        if (b.entity.position.distanceTo(target.position) > 24) return fail('target_gone', 'out of range')
        await sleep(250)
      }
      return fail('timeout')
    },

    async flee(_, obs) {
      const h = this.nearestHostileEntity()
      const attacker = obs?.attacker
      // A player attacker has no entry in nearestHostileEntity/obs.nearestHostile (mob-only): bot.players tracks
      // its live position while the player is still around; obs.attacker.pos (set when the hit landed) is the
      // fallback once they've gone out of range or logged off.
      const livePlayerPos = !h && attacker?.kind === 'player' ? this.bot.players[attacker.name]?.entity?.position : null
      const p = fleeTargetPos({ hostilePos: h ? h.position : obs?.nearestHostile?.pos, attacker, livePlayerPos })
      if (!p) return fail('target_gone')
      // r2_leader: fleeing waded straight into the sea when the direction away from the hostile happened to be
      // wet (GoalInvert does not know about water). Try the heading pointing away from the hostile first, then
      // rotate (like explore_toward's wet checks) until one is dry 8 m out; if every heading is wet, refuse to
      // flee at all so the breaker withholds it and the other threat responses (fight, pillar_up) stay offered.
      const me = this.bot.entity.position
      const goalAt = ([hx, hz]) => me.floored().offset(hx * 8, 0, hz * 8)
      const { heading, turns } = this.turnUntilDry(goalAt, { commit: false, startHeading: fleeHeading(p, me) })
      if (turns > 0) this.log(`flee: water away from the hostile, ${turns === 4 ? 'every heading wet' : `turned to ${heading}`}`)
      if (turns === 4) return fail('no_path', 'water all around')
      this.mem.heading = heading
      await this.goto(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 20)))
      return ok('out of range')
    },

    async pillar_up() {
      const b = this.bot
      const blockItem = () => b.inventory.items().find(i => i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'cobbled_deepslate')
      let placed = 0
      for (let i = 0; i < 3 && blockItem(); i++) {
        this.check()
        const feet = b.entity.position.floored()
        const below = b.blockAt(feet.offset(0, -1, 0))
        if (!below || below.boundingBox !== 'block') { this.log(`pillar: below is ${below?.name} (${below?.boundingBox}) at ${feet}`); break }
        // In a 2-high tunnel the jump hits the ceiling and every placement is refused: open the block above the head first.
        const ceiling = b.blockAt(feet.offset(0, 2, 0))
        if (ceiling && ceiling.boundingBox === 'block') {
          if (!b.canDigBlock(ceiling)) { this.log(`pillar: cannot open the ceiling (${ceiling.name})`); break }
          await this.equipBestPickaxe(); await this.digSafe(ceiling); this.check()
        }
        await b.equip(blockItem(), 'hand')
        await b.lookAt(feet.offset(0.5, -1, 0.5), true)
        b.setControlState('jump', true)
        const y0 = b.entity.position.y, tj = Date.now()
        while (b.entity.position.y < y0 + 1.0 && Date.now() - tj < 500) await sleep(20)   // wait for the jump apex (~1.25 blocks)
        try { await b.placeBlock(below, new Vec3(0, 1, 0)); placed++ } catch (e) { this.log(`pillar: ${e.message}`) }
        b.setControlState('jump', false)
        await sleep(500)
      }
      return placed > 0 ? ok(`+${placed} blocks`) : fail('failed', 'placed nothing')
    },

    // A bot with no control held sinks: five r2 deaths were waits at the bottom of a lake (drowned in ~20 s). In water,
    // swim to the nearest shore within 12 m, else hold jump (float) for the rest of the wait (run() gives it 12 s).
    async wait() {
      const b = this.bot
      if (!b.entity.isInWater) { await sleep(Math.max(10, this.timeouts.wait * 1000 - 200)); return ok() }
      const end = this.deadline - 1500
      let r = 'no_shore'
      try {
        r = await Promise.race([this.leaveWater(), sleep(Math.max(0, end - Date.now())).then(() => 'slow')])
      } catch (e) { if (!(e instanceof Abort) || e.message !== 'timeout') throw e; r = 'slow' }
      if (r === 'left') return ok('left water')
      try { b.pathfinder.setGoal(null) } catch {}
      b.setControlState('jump', true)
      while (Date.now() < end) { this.check(); await sleep(100) }
      b.setControlState('jump', false)
      return ok('floated')
    },

    // Walk to the nearest source of `fluid` ('water' | 'lava') and fill the empty bucket from it.
    async fill_bucket(fluid = 'water') {
      if (!['water', 'lava'].includes(fluid)) return fail('failed', `cannot fill a bucket with ${fluid}`)
      if (!this.item('bucket')) return fail('no_materials', 'no empty bucket')
      let src = this.fluidSource(fluid, 24)
      const seen = this.mem.seen?.[fluid]
      if (!src && seen) {
        await this.goto(new goals.GoalNear(seen.pos.x, seen.pos.y, seen.pos.z, 3))
        this.check()
        src = this.fluidSource(fluid, 16)
        if (!src) { this.mem.seen[fluid] = null; return fail('target_gone', `no ${fluid} source at the remembered spot`) }
      }
      if (!src) return fail('not_found', `no ${fluid} source within 24 m`)
      await this.standNear(src.position, 2)
      this.log(`fill_bucket: ${fluid} source at ${src.position}, standing at ${this.bot.entity.position.floored()}`)
      const full = `${fluid}_bucket`
      if (await this.scoop(src.position, fluid)) return ok(`+1 ${full}`)
      const again = this.fluidSource(fluid, 5)   // the source may have flowed away or been refilled next to it
      if (again && await this.scoop(again.position, fluid)) return ok(`+1 ${full}`)
      return fail('failed', `the bucket did not fill at ${src.position}`)
    },

    // Pour the water bucket onto a lava source (it and the lava sources next to it become obsidian), then take the
    // water back. The bot stands level with or above the lava, 2-3 m away.
    async cast_obsidian() {
      const b = this.bot
      if (!this.item('water_bucket')) return fail('no_materials', 'no water bucket')
      let src = this.pickLavaSource(24)
      const seen = this.mem.seen?.lava
      if (!src && seen) {   // like mine_iron and fill_bucket: walk to the remembered lava, and forget it if it is gone
        // or cannot be reached, so the teacher goes looking again (explore_toward(deep)) instead of retrying it forever
        try { await this.goto(new goals.GoalNear(seen.pos.x, seen.pos.y, seen.pos.z, 4)) } catch (e) { if (!(e instanceof Abort)) this.mem.seen.lava = null; throw e }
        this.check()
        src = this.pickLavaSource(16)
        if (!src) { this.mem.seen.lava = null; return fail('target_gone', 'no lava source at the remembered spot') }
      }
      if (!src) return fail('target_gone', 'no lava source within 24 m')
      const p = src.position
      if (b.entity.position.floored().y < p.y || b.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) > 3.5) {
        await this.goto(new GoalNearAbove(p.x, p.y, p.z, 3, p.y))
        this.check()
      }
      const countObsidian = () => b.findBlocks({ matching: this.obsidianIds, maxDistance: 6, count: 64 }).length
      const before = countObsidian()
      await b.equip(this.item('water_bucket'), 'hand')
      // The full bucket's ray passes through fluids: aim at the top face of the block under the source, so the water
      // replaces the source itself and the lava sources beside it turn to obsidian. Else the source's top face.
      const solid = bl => bl.boundingBox === 'block'
      const aim = this.aimAt(p.offset(0, -1, 0), [[0.5, 0.97, 0.5], [0.15, 0.97, 0.5], [0.85, 0.97, 0.5], [0.5, 0.97, 0.15], [0.5, 0.97, 0.85]], solid)
      await this.useHeldAt(aim || p.offset(0.5, 1, 0.5))
      if (this.item('water_bucket')) return fail('failed', `the water was not poured at ${p}`)
      for (let i = 0; i < 4; i++) { await b.waitForTicks(10); this.check() }
      const got = countObsidian() - before
      // Take the water back: where it was poured, else the nearest water source within 4 m.
      const water = isFluidSource(b.blockAt(p), 'water') ? b.blockAt(p) : this.fluidSource('water', 4)
      const back = water ? await this.scoop(water.position, 'water') : false
      this.log(`cast_obsidian: +${got} obsidian at ${p} (aim ${aim ? 'clear' : 'fallback'}), water ${back ? 'taken back' : `left${water ? ` at ${water.position}` : ''}`}`)
      return got > 0 ? ok(`+${got} obsidian cast`) : fail('failed', 'no obsidian formed')
    },

    // Build the 10-obsidian frame (corners from cobblestone / cobbled deepslate / dirt) 3 m ahead on flat ground,
    // perpendicular to the heading; no digging or filling. Bottom row, then the columns, then the top corners and row.
    async build_portal() {
      const b = this.bot
      if (this.count('obsidian') < 10 && !this.mem.portal) return fail('no_materials', `${this.count('obsidian')} obsidian, 10 needed`)
      const fillerItem = () => FILLERS.find(n => this.count(n) > 0)
      let site = null
      const mp = this.mem.portal
      if (mp) {
        const o = new Vec3(mp.origin.x, mp.origin.y, mp.origin.z)
        if (b.entity.position.distanceTo(o) <= 24 && this.portalSiteResumable(o, mp.axis)) site = { origin: o, axis: mp.axis }
      }
      if (!site) {
        if (this.count('obsidian') < 10) return fail('no_materials', `${this.count('obsidian')} obsidian, 10 needed`)
        if (FILLERS.reduce((n, f) => n + this.count(f), 0) < 4) return fail('no_materials', 'fewer than 4 blocks for the corners')
        const feet = b.entity.position.floored()
        const order = ['north', 'east', 'south', 'west'], h0 = order.indexOf(this.mem.heading)
        search: for (let k = 0; k < 4; k++) {
          const [hx, hz] = HEADINGS[order[(Math.max(0, h0) + k) % 4]]
          const axis = hx === 0 ? 'x' : 'z'
          for (const d of [3, 4, 2]) {
            // origin = the frame's left corner, the frame centred on the cell d ahead
            const origin = axis === 'x' ? feet.offset(hx * d - 1, 0, hz * d) : feet.offset(hx * d, 0, hz * d - 1)
            if (this.portalSiteOk(origin, axis)) { site = { origin, axis }; break search }
          }
        }
        if (!site) return fail('failed', 'no flat spot')
      }
      const { origin, axis } = site
      this.mem.portal = { origin: { x: origin.x, y: origin.y, z: origin.z }, axis }
      const L = portalLayout(origin, axis)
      // Stand 2 m in front of the frame's middle, on the side the bot is on, so every cell is within reach.
      const n = axis === 'x' ? new Vec3(0, 0, Math.sign(b.entity.position.z - (origin.z + 0.5)) || 1) : new Vec3(Math.sign(b.entity.position.x - (origin.x + 0.5)) || 1, 0, 0)
      const stand = L.inside.offset(0, -1, 0).plus(n.scaled(2))
      if (!b.entity.position.floored().equals(stand)) {
        try { await this.walkTo(new goals.GoalBlock(stand.x, stand.y, stand.z)) } catch (e) { if (e instanceof Abort) throw e; this.log(`build_portal: cannot reach the stand cell ${stand} (${e?.name})`) }
        this.check()
      }
      const [o0, o1, c0, c1, c2, d0, d1, d2, t0, t1] = L.obsidian, [f0, f1, f2, f3] = L.filler
      const plan = [[f0, 'f'], [f1, 'f'], [o0, 'o'], [o1, 'o'], [c0, 'o'], [d0, 'o'], [c1, 'o'], [d1, 'o'], [c2, 'o'], [d2, 'o'], [f2, 'f'], [f3, 'f'], [t0, 'o'], [t1, 'o']]
      let done = 0
      for (const [pos, kind] of plan) {
        this.check()
        const at = b.blockAt(pos)
        if (kind === 'f' && at && at.boundingBox === 'block') { done++; continue }
        const name = kind === 'o' ? 'obsidian' : fillerItem()
        if (!name) return fail('no_materials', 'out of corner blocks')
        if (!(await this.placeAt(pos, name))) return fail('failed', `could not place ${name} at ${pos} (${done}/14 placed)`)
        done++
        this.current.progress = done / plan.length
      }
      await this.settleInventory()
      const have = L.obsidian.filter(p => b.blockAt(p)?.name === 'obsidian').length
      return have === 10 ? ok(`frame at ${origin} along ${axis}`) : fail('failed', `${have}/10 obsidian in the frame`)
    },

    // Light the frame: flint and steel on the top face of the bottom obsidian under the inside cell.
    async light_portal(_, obs) {
      const b = this.bot
      if (!this.item('flint_and_steel')) return fail('no_materials', 'no flint and steel')
      let frame = null
      const mp = this.mem.portal
      if (mp) {
        const L = portalLayout(new Vec3(mp.origin.x, mp.origin.y, mp.origin.z), mp.axis)
        if (b.blockAt(L.obsidian[0])?.name === 'obsidian') frame = { axis: mp.axis, inside: L.inside }
      }
      if (!frame && obs?.portalFrame?.pos) frame = this.frameFromAnchor(obs.portalFrame.pos)
      if (!frame) return fail('target_gone', 'no portal frame')
      const portalId = this.md.blocksByName.nether_portal.id
      const lit = () => !!b.findBlock({ matching: portalId, maxDistance: 6 })
      const { axis, inside } = frame
      const n = axis === 'x' ? new Vec3(0, 0, Math.sign(b.entity.position.z - (inside.z + 0.5)) || 1) : new Vec3(Math.sign(b.entity.position.x - (inside.x + 0.5)) || 1, 0, 0)
      const front = inside.offset(0, -1, 0).plus(n.scaled(2))
      if (b.entity.position.distanceTo(front.offset(0.5, 0, 0.5)) > 1.5) {
        try { await this.walkTo(new goals.GoalNear(front.x, front.y, front.z, 1)) } catch (e) { if (e instanceof Abort) throw e; this.log(`light_portal: cannot reach the front of the frame (${e?.name})`) }
        this.check()
      }
      if (lit()) return ok('already lit')
      const side = axis === 'x' ? inside.offset(-1, 0, 0) : inside.offset(0, 0, -1)
      const tries = [[inside.offset(0, -1, 0), new Vec3(0, 1, 0)], [side, axis === 'x' ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1)]]
      for (const [pos, face] of tries) {
        this.check()
        const blk = b.blockAt(pos)
        if (!blk || blk.name !== 'obsidian') continue
        await b.equip(this.item('flint_and_steel'), 'hand')
        await b.activateBlock(blk, face)
        await b.waitForTicks(20)
        if (lit()) return ok('portal lit')
      }
      const cells = []
      for (let u = 0; u <= 1; u++) for (let v = 0; v <= 2; v++) cells.push(b.blockAt(axis === 'x' ? inside.offset(u, v, 0) : inside.offset(0, v, u))?.name)
      return fail('failed', `the portal did not light (inside: ${cells.join(' ')})`)
    },
  }

  // A crafting table in reach: the nearby or remembered one, else the carried one placed, else a walk to the remembered
  // one after all (placing failed). Remembered as the base table. null when there is none.
  async craftingTable() {
    let table = await this.findStation('crafting_table', 'table')
    if (!table) table = await this.placeNear('crafting_table')
    if (!table) table = await this.findStation('crafting_table', 'table', true)
    if (table) this.mem.setBase('table', table.position)
    return table
  }

  // The same for a furnace.
  async furnaceStation() {
    let furnace = await this.findStation('furnace', 'furnace')
    if (!furnace) furnace = await this.placeNear('furnace')
    if (!furnace) furnace = await this.findStation('furnace', 'furnace', true)
    if (furnace) this.mem.setBase('furnace', furnace.position)
    return furnace
  }

  // Craft `target` (an exact item name) `times` times (a number, or a function read after the inventory settled) with
  // the first recipe the inventory satisfies, at `table` (a crafting table block) or in the 2x2 grid when null. Worn
  // at once when it is iron armor. Shared by craft(<item>) and the craft_item plugin.
  async craftAny(target, times = 1, table = null) {
    const id = this.md.itemsByName[target]?.id
    if (id == null) return fail('failed', `unknown item ${target}`)
    await this.settleInventory()
    const recipes = this.bot.recipesFor(id, null, 1, table)
    if (!recipes.length) return fail('no_materials', `no recipe for ${target} with the inventory`)
    const n = typeof times === 'function' ? times() : times
    const before = this.count(target)
    // mineflayer's grabResult shift-clicks the output slot as soon as the grid is filled; if the server has not
    // computed the result yet the click is a no-op and the ingredients come back when the window closes. Retry,
    // but only after a long settle, since the resync burst can hide a success for a moment.
    let got = 0
    for (let attempt = 0; attempt < 3 && got <= 0; attempt++) {
      this.check()
      if (attempt) await this.settleInventory(6)
      await this.bot.craft(recipes[0], n, table)
      await this.bot.waitForTicks(3)
      await this.settleInventory(6)
      got = this.count(target) - before
      if (got <= 0) { await this.bot.waitForTicks(20); got = this.count(target) - before }
    }
    if (got > 0 && ARMOR_SLOT[target]) {
      await this.bot.equip(this.item(target), ARMOR_SLOT[target])
      await this.settleInventory()
      return ok(`+${got} ${target}, worn`)
    }
    return got > 0 ? ok(`+${got} ${target}`) : fail('failed', `craft ${target} produced nothing (table ${table ? `${table.name}@${table.position}` : 'none'})`)
  }

  // Smelt up to `max` of `inputName` (an exact item name) into `productName` at a furnace (findStation, placing a
  // carried one), fuelled by fuelPlan. When the input is itself a fuel (logs for charcoal) the fuel is planned on what
  // the input leaves. A foreign item in the input or output slot is taken out first. Returns ok with `count` (the
  // items smelted), or no_materials (no input, fuel ran out), no_fuel, no_furnace. Shared by smelt(iron_ingot) and the
  // smelt_item plugin.
  async smeltAny(inputName, productName, max = Infinity) {
    const md = this.md
    const have = this.count(inputName)
    if (have === 0) return fail('no_materials', `no ${inputName.replace(/_/g, ' ')}`)
    const furnace = await this.furnaceStation()
    if (!furnace) return fail('no_furnace')
    await this.settleInventory()
    const f = await this.bot.openFurnace(furnace)
    let n = 0
    try {
      const s = f.fuelItem()
      const slot = s ? { name: s.name, count: s.count } : null
      const items = this.bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
      const without = k => { let left = k; return items.map(i => { if (i.name !== inputName) return i; const t = Math.min(left, i.count); left -= t; return { ...i, count: i.count - t } }) }
      let want = Math.min(this.count(inputName), max)
      let plan = fuelPlan(want, fuelValue(inputName) > 0 ? without(want) : items, slot)
      // An input that is also fuel: smelt fewer until what is left of it (and the rest) covers them.
      if (fuelValue(inputName) > 0) while (want > 0 && plan.smelt < want) { want--; plan = fuelPlan(want, without(want), slot) }
      if (plan.smelt === 0) return fail('no_fuel')
      const inSlot = f.inputItem(), outSlot = f.outputItem()
      if (inSlot && inSlot.name !== inputName) { await f.takeInput(); await this.settleInventory() }
      if (outSlot && outSlot.name !== productName) { await f.takeOutput(); await this.settleInventory() }
      if (plan.take) { await f.takeFuel(); await this.settleInventory() }
      if (plan.put) await f.putFuel(md.itemsByName[plan.put.name].id, null, plan.put.count)
      n = plan.smelt
      await f.putInput(md.itemsByName[inputName].id, null, n)
      const target = n + (f.outputItem()?.count || 0)
      // ~10 s per item; a furnace that has stopped burning with output still missing will not finish (give up at 15 s idle)
      let lastOut = -1, idleSince = Date.now()
      while ((f.outputItem()?.count || 0) < target) {
        this.check(); await sleep(1000)
        const out = f.outputItem()?.count || 0
        if (out !== lastOut || f.fuel > 0) { lastOut = out; idleSince = Date.now() }
        else if (Date.now() - idleSince > 15_000) break
      }
      const got = f.outputItem()?.count || 0
      if (got) await f.takeOutput()
      if (got < n) return fail('no_materials', `fuel ran out: +${got} of ${n}`)
    } finally { try { f.close() } catch {} }
    return { result: 'ok', detail: `+${n} ${productName}`, count: n }
  }

  nearestHostileEntity() {
    const me = this.bot.entity.position
    let best = null, bestD = 32
    for (const e of Object.values(this.bot.entities)) {
      if (e === this.bot.entity || !e.position || !e.name) continue
      const hostile = e.type === 'hostile' || (e.type === 'mob' && this.md.entitiesByName[e.name]?.category === 'Hostile mobs')
      if (!hostile) continue
      const d = me.distanceTo(e.position)
      if (d < bestD) { best = e; bestD = d }
    }
    return best
  }

  async mineKind(ids, maxDistance, n, gainedPred, what, exclude = null) {
    await this.equipBestPickaxe()
    const before = this.countBy(gainedPred)
    let lastErr = null, found = false
    for (let i = 0; i < n; i++) {
      this.check()
      const block = this.pickBlock(ids, maxDistance, exclude)
      if (!block) break
      found = true
      try { await this.collectOne(block) } catch (e) { lastErr = e; break }
      this.current.progress = (i + 1) / n
    }
    const got = this.countBy(gainedPred) - before
    if (got > 0) return ok(`+${got}`)
    if (lastErr) throw lastErr
    return fail(found ? 'failed' : 'not_found', found ? `${what} mined but nothing picked up` : `no ${what} within ${maxDistance} m`)
  }

  // Nearest exposed block of the kind (one the bot can see), else the nearest at all. The count is large because
  // findBlocks stops at it while walking chunk sections nearest-first, so a small count misses a nearer block in the
  // next section (natural gravel in the bot's own section hid a patch 4 m away).
  // `exclude`: a Set of "x,y,z" keys never to pick (the bot's own portal frame).
  pickBlock(ids, maxDistance, exclude = null) {
    let cands = this.bot.findBlocks({ matching: ids, maxDistance, count: 256 })
    if (exclude) cands = cands.filter(p => !exclude.has(`${p.x},${p.y},${p.z}`))
    if (!cands.length) return null
    const me = this.bot.entity.position
    cands.sort((a, b) => me.distanceTo(a) - me.distanceTo(b))
    for (const p of cands) { const b = this.bot.blockAt(p); if (b && this.bot.canSeeBlock(b)) return b }
    return this.bot.blockAt(cands[0])
  }

  unsafeToStep(ahead) { return liquidAround(p => this.bot.blockAt(p), ahead) }

  // Water in the 3 x 4 x 3 cells around `c` (dy -1..2).
  wetNear(c) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
      if (this.bot.blockAt(c.offset(dx, dy, dz))?.name === 'water') return true
    }
    return false
  }

  // The nearest shore block (isShore) within maxDistance of the bot, or null.
  shoreBlock(maxDistance = 12) {
    const b = this.bot, at = p => b.blockAt(p)
    const me = b.entity.position
    // The shore test runs inside the search: a count cap over all stone/dirt would fill up with buried blocks first.
    const cands = b.findBlocks({ matching: this.ids(SHORE_BLOCKS), maxDistance, count: 64, useExtraInfo: blk => isShore(at, blk.position) })
    cands.sort((p, q) => me.distanceTo(p.offset(0.5, 1, 0.5)) - me.distanceTo(q.offset(0.5, 1, 0.5)))
    return cands.length ? b.blockAt(cands[0]) : null
  }

  // Swim to the nearest shore within maxDistance and stand on it (the pathfinder holds jump in water). 'dry' (not in
  // water), 'left', 'no_shore' or 'stuck' (no path, or still in water). Used by wait, build_shelter and explore_toward.
  // The live session found open water wider than the old 12 m search: with none in range, swim toward the
  // remembered base (its crafting table) or, with no base yet, the spawn point, for up to 30 s, then look again
  // (drifting toward land the bot has already seen beats floating in place, which is all the old 'no_shore' did).
  async leaveWater(maxDistance = 48) {
    const b = this.bot
    if (!b.entity.isInWater) return 'dry'
    let shore = this.shoreBlock(maxDistance)
    if (!shore) {
      const t = this.mem.base?.table ?? this.mem.spawn
      if (t) {
        this.log(`leave water: no shore within ${maxDistance} m, swimming toward ${this.mem.base?.table ? 'the base' : 'spawn'} at ${t.x} ${t.y} ${t.z}`)
        await this.swimToward(new Vec3(t.x, t.y, t.z))
        this.check()
        if (!b.entity.isInWater) return 'left'
        shore = this.shoreBlock(maxDistance)
      }
      if (!shore) { this.log(`leave water: no shore within ${maxDistance} m`); return 'no_shore' }
    }
    const p = shore.position
    this.log(`leave water: swimming to ${shore.name} at ${p}`)
    // The pathfinder never jumps out of water (no jump-up move from a liquid node), so a rim level with the water line
    // is NoPath: it swims the long way when there is one, and the last stretch is swum by hand.
    try { await this.goto(new goals.GoalBlock(p.x, p.y + 1, p.z)) } catch (e) { if (e instanceof Abort) throw e; this.log(`leave water: pathfinder ${e?.name}, swimming straight`) }
    if (b.entity.isInWater) await this.swimTo(p)
    return b.entity.isInWater ? 'stuck' : 'left'
  }

  // Swim toward `target` (any point, however far) holding forward and jump (in water, jump rises and a horizontal
  // collision lifts the bot out onto a rim at the water line), for at most `ms`. Returns once out of the water and
  // on the ground, else after ms. Used directly by leaveWater when no shore is within its search radius, and by
  // swimTo (the last stretch to a specific shore rim) below.
  async swimToward(target, ms = 30_000) {
    const b = this.bot, t0 = Date.now()
    try {
      while (Date.now() - t0 < ms) {
        this.check()
        if (!b.entity.isInWater && b.entity.onGround) return true
        const pos = b.entity.position
        await b.look(Math.atan2(-(target.x - pos.x), -(target.z - pos.z)), 0, true)
        b.setControlState('forward', true); b.setControlState('jump', true)
        await sleep(100)
      }
    } finally { b.setControlState('forward', false); b.setControlState('jump', false) }
    return !b.entity.isInWater
  }

  // Swim straight at the top of block `p` (fix round 1: was a near-duplicate of swimToward's loop; now delegates).
  swimTo(p, ms = 8000) { return this.swimToward(p.offset(0.5, 1.5, 0.5), ms) }

  // Place a filler block in the empty cell `cell` against its solid neighbour below or beside it; true when the cell is
  // solid afterwards. false without a filler or a neighbour to place against.
  // climb_check with this method's logging turned on (Task 1) never exercised the failure path: in every terrain the
  // check builds, `cell`'s own neighbours are found and placed against on the first try. The one reproduction that did
  // fail (a cave chamber wide enough that no neighbour of `cell` is solid in any direction) is a real limit of a
  // 1-block-radius search, not a placement rejection; two further repros with a solid neighbour 1 m from the bot both
  // succeeded. Absent direct evidence of the "placeBlock against a neighbour the bot is in the way of" mechanism, this
  // still applies the brief's fix defensively: back off one step before placing when the target is close enough for
  // that to matter, but only onto ground already confirmed solid and clear, so it can never make things worse.
  async placeFloor(cell) {
    const b = this.bot
    const feet = b.entity.position.floored()
    const away = new Vec3(Math.sign(feet.x - cell.x) || 0, 0, Math.sign(feet.z - cell.z) || 0)
    if (Math.abs(away.x) + Math.abs(away.z) > 0 && b.entity.position.distanceTo(cell.offset(0.5, 0, 0.5)) < 1.6) {
      const behind = feet.offset(away.x, 0, away.z)
      const solidBehind = b.blockAt(behind.offset(0, -1, 0))?.boundingBox === 'block'
      const clearBehind = b.blockAt(behind)?.boundingBox !== 'block' && b.blockAt(behind.offset(0, 1, 0))?.boundingBox !== 'block'
      if (solidBehind && clearBehind) {
        this.log(`place floor at ${cell}: stepping back to ${behind} first`)
        try { await b.lookAt(behind.offset(0.5, 1, 0.5), true); b.setControlState('forward', true); await b.waitForTicks(4) }
        finally { b.setControlState('forward', false) }
        await b.waitForTicks(2)
      }
    }
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const filler = b.inventory.items().find(it => FILLERS.includes(it.name))
      if (!filler) { this.log(`place floor at ${cell}: no filler`); return false }
      const ref = b.blockAt(cell.offset(dx, dy, dz))
      if (!ref || ref.boundingBox !== 'block') { this.log(`place floor at ${cell}: no solid neighbour at ${dx},${dy},${dz} (${ref?.name ?? 'unloaded'})`); continue }
      try { await b.equip(filler, 'hand'); await b.placeBlock(ref, new Vec3(-dx, -dy, -dz)); await b.waitForTicks(2) }
      catch (e) { this.log(`place floor at ${cell}: placeBlock: ${e.message}`) }
      if (b.blockAt(cell)?.boundingBox === 'block') return true
      this.log(`place floor at ${cell}: placed against ${dx},${dy},${dz} but the cell is still ${b.blockAt(cell)?.name ?? 'unloaded'}`)
    }
    return false
  }

  // Dig `p` until it stays open: sand and gravel above it fall in (as an entity for ~10 ticks, so a cell that reads
  // as air right after the dig is refilled a moment later). Throws Abort when the block cannot be dug.
  async openCell(p) {
    const b = this.bot
    for (let k = 0; k < 8; k++) {
      const blk = b.blockAt(p)
      if (!blk || blk.boundingBox !== 'block') {
        if (k === 0 || !isGravityBlock(b.blockAt(p.offset(0, 1, 0))) && !this.fallingNear(p)) return
        await b.waitForTicks(12); continue   // something may still be falling into it
      }
      if (!b.canDigBlock(blk) || blk.name === 'bedrock') { this.rotateHeading(); throw new Abort(`cannot dig ${blk.name}`) }
      const gravityAbove = isGravityBlock(b.blockAt(p.offset(0, 1, 0)))
      await this.digSafe(blk); this.check(); await b.waitForTicks(gravityAbove ? 12 : 2)
    }
  }
  // Open the cell over the head. Sand or gravel above it falls into the bot's own cells (r2_leader t=323 suffocated
  // under a sand layer): dig them out as soon as it lands, until nothing more falls.
  async openOverhead(feet) {
    const b = this.bot, p = feet.offset(0, 2, 0)
    for (let k = 0; k < 12; k++) {
      await this.digOut(feet)
      const blk = b.blockAt(p)
      if (blk && blk.boundingBox === 'block') {
        if (!b.canDigBlock(blk) || blk.name === 'bedrock') { this.rotateHeading(); throw new Abort(`cannot dig ${blk.name}`) }
        await this.digSafe(blk); this.check(); await b.waitForTicks(3); continue
      }
      if (!isGravityBlock(b.blockAt(p.offset(0, 1, 0))) && !this.fallingNear(feet)) return
      await b.waitForTicks(3)
    }
  }
  // Dig out the bot's own cells (head first) when a falling block landed in them.
  async digOut(feet) {
    const b = this.bot
    for (let k = 0; k < 6; k++) {
      const cell = [feet.offset(0, 1, 0), feet].find(p => b.blockAt(p)?.boundingBox === 'block')
      if (!cell) return
      const blk = b.blockAt(cell)
      if (!b.canDigBlock(blk)) return
      this.log(`climb: ${blk.name} fell in at ${cell}, digging out`)
      await this.digSafe(blk); await b.waitForTicks(isGravityBlock(b.blockAt(cell.offset(0, 1, 0))) ? 10 : 2)
    }
  }
  fallingNear(p) {
    const c = p.offset(0.5, 0, 0.5)
    return Object.values(this.bot.entities).some(e => e.name === 'falling_block' && Math.abs(e.position.x - c.x) < 1 && Math.abs(e.position.z - c.z) < 1 && e.position.y >= p.y - 0.5)
  }
  underground() { try { return (this.bot.world.getSkyLight(this.bot.entity.position.floored().offset(0, 1, 0)) ?? 15) < 4 } catch { return false } }

  // Manual staircase up: open the block above the head and the two cells ahead one level up, make sure there is a
  // step to stand on (a filler block if not), step up, repeat; stops at open sky. Stops (and turns) before a cell
  // with or under a liquid, or one that cannot be dug.
  async digStaircaseUp(steps) {
    const b = this.bot
    let turns = 0
    for (let i = 0; i < steps && this.underground(); i++) {
      this.check()
      const [fx, fz] = this.headingVec()
      const feet = b.entity.position.floored()
      const ahead = feet.offset(fx, 0, fz)
      // Sand or gravel that fell onto the head suffocates the bot (r2_leader t=323: 2 hp/s at y 57 under a sand
      // layer, the climb repeating from the same cell): open the head cell first.
      await this.digOut(feet)
      const open = [ahead.offset(0, 2, 0), ahead.offset(0, 1, 0), feet.offset(0, 2, 0)]
      for (const p of [...open, feet.offset(0, 3, 0), ahead.offset(0, 3, 0)]) {
        const n = b.blockAt(p)?.name
        if (n === 'lava' || n === 'water') { this.rotateHeading(); throw new Abort(`liquid above (${n})`) }
      }
      // The ahead column first (sand above it falls onto the step and is dug again), the cell over the head last: sand
      // above that one falls onto the bot, which then digs itself out at once.
      for (const p of open.slice(0, 2)) await this.openCell(p)
      await this.openOverhead(feet)
      for (const p of open.slice(0, 2)) await this.openCell(p)
      // Never step onto nothing: the step `ahead` must be solid (a filler placed against its floor or a side), else
      // turn and try the next heading (four turns without a step end the climb).
      const step = b.blockAt(ahead)
      if (!step || step.boundingBox !== 'block') {
        if (!(await this.placeFloor(ahead))) {
          this.rotateHeading()
          if (++turns >= 4) throw new Abort('nothing to step on')
          this.log(`climb: nothing to step on, turning ${this.mem.heading}`)
          i--; continue
        }
        this.check()
      }
      turns = 0
      await this.goto(new goals.GoalBlock(ahead.x, ahead.y + 1, ahead.z), this.walkMovements)
    }
  }

  // Manual staircase: dig head, feet and step-down ahead, walk onto the step, repeat. Stops (and turns) before a step
  // that would open into lava or water or stand on it.
  async digStaircase(steps) {
    const b = this.bot
    const [fx, fz] = this.headingVec()
    for (let i = 0; i < steps; i++) {
      this.check()
      const feet = b.entity.position.floored()
      const ahead = feet.offset(fx, 0, fz)
      const liquid = this.unsafeToStep(ahead)
      if (liquid) { this.rotateHeading(); throw new Abort(`liquid ahead (${liquid})`) }
      for (const p of [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)]) {
        const blk = b.blockAt(p)
        if (blk && blk.boundingBox === 'block' && b.canDigBlock(blk)) await this.digSafe(blk)
      }
      // The step's floor (ahead-2) must be there and dry underneath. A one-block hole is a harmless extra step down
      // (left alone, as before); a drop of two or more (a cave, an undercut beach) gets a filler block as the floor,
      // and without one it stops the staircase and turns it, like a liquid.
      const fall = dropAhead(p => b.blockAt(p), ahead)
      if (fall.liquid) { this.rotateHeading(); throw new Abort(`liquid under the step (${fall.liquid})`) }
      if (fall.drop >= 2 && !(await this.placeFloor(ahead.offset(0, -2, 0)))) { this.rotateHeading(); throw new Abort('drop ahead') }
      this.check()
      await this.goto(new goals.GoalBlock(ahead.x, ahead.y - 1, ahead.z))
    }
  }
}
