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
export const RESULTS = ['ok', 'no_path', 'timeout', 'target_gone', 'took_damage', 'interrupted', 'not_found', 'no_table', 'no_furnace', 'no_materials', 'failed', 'died']
const INTERRUPT_RESULT = { threat: 'interrupted', took_damage: 'took_damage', died: 'died' }
const IRON_Y = 16
const DIAMOND_Y = -58
const ARMOR_SLOT = { iron_helmet: 'head', iron_chestplate: 'torso', iron_leggings: 'legs', iron_boots: 'feet' }
const HEADINGS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = detail => ({ result: 'ok', detail })
const fail = (result, detail) => ({ result, detail })

class Abort extends Error { constructor(why) { super(why); this.name = 'Abort' } }

// The liquid ('lava' / 'water') in the cells a staircase step digs (head, feet, step-down ahead) or in the cell the bot
// would stand on after the step, else null. Liquids have an empty bounding box, so they must be checked by name.
export function liquidAround(blockAt, ahead) {
  for (const dy of [1, 0, -1, -2]) {
    const b = blockAt(ahead.offset(0, dy, 0))
    if (b && (b.name === 'lava' || b.name === 'water')) return b.name
  }
  return null
}

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
    // Short approaches next to a frame or a pool: no digging, no scaffolding (the pathfinder would tower with the
    // corner cobblestone, inside the frame), no parkour.
    this.walkMovements = new Movements(bot, mcData)
    this.walkMovements.canDig = false
    this.walkMovements.allow1by1towers = false
    this.walkMovements.allowParkour = false
    this.walkMovements.scafoldingBlocks = []
    this.walkMovements.maxDropDown = 2
    if (bot.collectBlock) bot.collectBlock.movements = this.movements   // collectblock re-applies its own Movements on every collect()
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
    const exec = this.exec[name]
    if (!exec) return fail('failed', `unknown subtask ${name}`)
    this.busy = true; this.interrupted = null
    const gen = ++this.gen
    const timeoutS = this.timeouts[name] ?? 30
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
    if (['gather_wood', 'mine_stone', 'mine_coal', 'mine_iron', 'mine_diamond', 'mine_gravel', 'mine_obsidian', 'explore_toward', 'return_to_base', 'flee'].includes(name)) {
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

  mapError(e) {
    if (e instanceof Abort) return e.message.startsWith('liquid') ? fail('failed', e.message) : fail(e.message === 'timeout' ? 'timeout' : 'interrupted', e.message)
    const n = e?.name || ''
    if (n === 'NoPath') return fail('no_path')
    if (n === 'NoHarvestTool' || n === 'NoItem') return fail('no_materials', e.message)
    if (n === 'Timeout' || n === 'PathStopped' || n === 'GoalChanged') return fail('timeout', n)
    return fail('failed', `${n}: ${e?.message}`.slice(0, 120))
  }

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
      try { await this.bot.dig(block); return }
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
    const order = ['north', 'east', 'south', 'west']
    this.mem.heading = order[(order.indexOf(this.mem.heading) + 1) % 4]
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
    async mine_obsidian() { return this.mineKind(this.obsidianIds, 16, 10, n => n === 'obsidian', 'obsidian') },

    async craft(item) {
      const md = this.md
      let target = item
      let logName = null
      if (item === 'planks') {
        const byType = {}
        for (const i of this.bot.inventory.items()) if (i.name.endsWith('_log')) byType[i.name] = (byType[i.name] || 0) + i.count
        logName = Object.keys(byType).sort((a, b) => byType[b] - byType[a])[0]
        if (!logName) return fail('no_materials', 'no logs')
        target = logName.replace('_log', '_planks')
      } else if (item === 'sticks') target = 'stick'
      const id = md.itemsByName[target]?.id
      if (id == null) return fail('failed', `unknown item ${target}`)
      let table = null
      if (TABLE_ITEMS.has(item)) {
        table = await this.findStation('crafting_table', 'table')
        if (!table) table = await this.placeNear('crafting_table')
        if (!table) table = await this.findStation('crafting_table', 'table', true)
        if (!table) return fail('no_table')
        this.mem.setBase('table', table.position)
      }
      await this.settleInventory()
      const recipes = this.bot.recipesFor(id, null, 1, table)
      if (!recipes.length) return fail('no_materials', `no recipe for ${target} with the inventory`)
      const times = item === 'planks' ? Math.min(this.count(logName), 2) : 1
      const before = this.count(target)
      // mineflayer's grabResult shift-clicks the output slot as soon as the grid is filled; if the server has not
      // computed the result yet the click is a no-op and the ingredients come back when the window closes. Retry,
      // but only after a long settle, since the resync burst can hide a success for a moment.
      let got = 0
      for (let attempt = 0; attempt < 3 && got <= 0; attempt++) {
        this.check()
        if (attempt) await this.settleInventory(6)
        await this.bot.craft(recipes[0], times, table)
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
    },

    async smelt(item) {
      const md = this.md
      if (item !== 'iron_ingot') return fail('failed', `cannot smelt ${item}`)
      const raw = this.count('raw_iron')
      if (raw === 0) return fail('no_materials', 'no raw iron')
      let furnace = await this.findStation('furnace', 'furnace')
      if (!furnace) furnace = await this.placeNear('furnace')
      if (!furnace) furnace = await this.findStation('furnace', 'furnace', true)
      if (!furnace) return fail('no_furnace')
      this.mem.setBase('furnace', furnace.position)
      const fuel = this.count('coal') ? ['coal', Math.ceil(raw / 8)] : this.countBy(n => n.endsWith('_planks')) >= 2 ? [this.bot.inventory.items().find(i => i.name.endsWith('_planks')).name, Math.ceil(raw / 1.5)]
        : this.countBy(n => n.endsWith('_log')) ? [this.bot.inventory.items().find(i => i.name.endsWith('_log')).name, Math.ceil(raw / 1.5)] : null
      if (!fuel) return fail('no_materials', 'no fuel')
      await this.settleInventory()
      const f = await this.bot.openFurnace(furnace)
      try {
        if (!f.fuelItem() || f.fuelItem().count < 1) await f.putFuel(md.itemsByName[fuel[0]].id, null, Math.min(fuel[1], this.count(fuel[0])))
        await f.putInput(md.itemsByName.raw_iron.id, null, raw)
        const want = raw + (f.outputItem()?.count || 0)
        while ((f.outputItem()?.count || 0) < want) { this.check(); await sleep(1000) }
        await f.takeOutput()
      } finally { try { f.close() } catch {} }
      return ok(`+${raw} iron ingots`)
    },

    async explore_toward(target) {
      const me = this.bot.entity.position
      const [fx, fz] = this.headingVec()
      if (target === 'cave') {
        const p = this.bot.findBlocks({ matching: this.md.blocksByName.cave_air.id, maxDistance: 32, count: 1 })[0]
        if (!p) return fail('target_gone', 'no cave in range')
        await this.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
        return ok('at the cave')
      }
      if (target === 'down') {
        await this.equipBestPickaxe()
        if (me.y > IRON_Y) {
          const g = new goals.GoalNear(Math.floor(me.x) + 6 * fx, Math.floor(me.y) - 4, Math.floor(me.z) + 6 * fz, 1)
          try { await this.goto(g) } catch (e) { if (e?.name === 'NoPath') { this.rotateHeading(); await this.digStaircase(4) } else throw e }
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
        try { await this.goto(new goals.GoalXZ(Math.floor(me.x) + 12 * fx, Math.floor(me.z) + 12 * fz)) } catch (e) { if (e?.name === 'NoPath') this.rotateHeading(); throw e }
        return ok(`tunnelled at y ${this.bot.entity.position.y.toFixed(0)}`)
      }
      // surface
      if (this.mem.lastPath && this.mem.lastPath !== 'ok') this.rotateHeading()
      const [sx, sz] = this.headingVec()
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
      const p = h ? h.position : obs?.nearestHostile?.pos
      if (!p) return fail('target_gone')
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

    async wait() { await sleep(Math.max(10, this.timeouts.wait * 1000 - 200)); return ok() },

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
      const src = this.pickLavaSource(24)
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

  async mineKind(ids, maxDistance, n, gainedPred, what) {
    await this.equipBestPickaxe()
    const before = this.countBy(gainedPred)
    let lastErr = null, found = false
    for (let i = 0; i < n; i++) {
      this.check()
      const block = this.pickBlock(ids, maxDistance)
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
  pickBlock(ids, maxDistance) {
    const cands = this.bot.findBlocks({ matching: ids, maxDistance, count: 256 })
    if (!cands.length) return null
    const me = this.bot.entity.position
    cands.sort((a, b) => me.distanceTo(a) - me.distanceTo(b))
    for (const p of cands) { const b = this.bot.blockAt(p); if (b && this.bot.canSeeBlock(b)) return b }
    return this.bot.blockAt(cands[0])
  }

  unsafeToStep(ahead) { return liquidAround(p => this.bot.blockAt(p), ahead) }

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
      await this.goto(new goals.GoalBlock(ahead.x, ahead.y - 1, ahead.z))
    }
  }
}
