// The scripted motor layer. One subtask at a time on Mineflayer + pathfinder + collectblock + pvp; each returns a typed
// result, has a hard timeout, and can be interrupted by the runner (threat, damage, death). Never learned.
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { parseOption, FOOD, TABLE_ITEMS, counts } from './subtasks.js'

const { Movements, goals } = pathfinderPkg
export const TIMEOUTS = { gather_wood: 60, mine_stone: 45, mine_coal: 60, mine_iron: 90, craft: 20, smelt: 90, explore_toward: 40,
  return_to_base: 60, eat: 10, build_shelter: 20, fight: 25, flee: 20, pillar_up: 10, wait: 3 }
export const RESULTS = ['ok', 'no_path', 'timeout', 'target_gone', 'took_damage', 'interrupted', 'not_found', 'no_table', 'no_furnace', 'no_materials', 'failed', 'died']
const INTERRUPT_RESULT = { threat: 'interrupted', took_damage: 'took_damage', died: 'died' }
const IRON_Y = 16
const HEADINGS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = detail => ({ result: 'ok', detail })
const fail = (result, detail) => ({ result, detail })

class Abort extends Error { constructor(why) { super(why); this.name = 'Abort' } }

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
    if (['gather_wood', 'mine_stone', 'mine_coal', 'mine_iron', 'explore_toward', 'return_to_base', 'flee'].includes(name)) {
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
    return c.progress
  }

  elapsedS() { return this.current ? (Date.now() - this.current.t0) / 1000 : 0 }

  check() {
    if (this.runGen != null && this.runGen !== this.gen) throw new Abort('superseded')
    if (this.interrupted) throw new Abort(this.interrupted)
    if (Date.now() > this.deadline) throw new Abort('timeout')
  }

  mapError(e) {
    if (e instanceof Abort) return fail(e.message === 'timeout' ? 'timeout' : 'interrupted', e.message)
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

  async goto(goal) {
    this.bot.pathfinder.setGoal(null)   // drains a stale stop flag (emits path_stop now, before goto listens)
    await this.bot.waitForTicks(1)
    this.check()
    await this.bot.pathfinder.goto(goal)
  }

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
  // there and re-check; forget it if it is gone). Returns the block, positioned within reach, or null.
  async findStation(blockName, memKey) {
    const id = this.md.blocksByName[blockName].id
    let block = this.bot.findBlock({ matching: id, maxDistance: 8 })
    const remembered = this.mem.base[memKey]
    if (!block && remembered && this.bot.entity.position.distanceTo(new Vec3(remembered.x, remembered.y, remembered.z)) <= 32) {
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
      return got > 0 ? ok(`+${got} ${target}`) : fail('failed', `craft ${target} produced nothing (table ${table ? `${table.name}@${table.position}` : 'none'})`)
    },

    async smelt(item) {
      const md = this.md
      if (item !== 'iron_ingot') return fail('failed', `cannot smelt ${item}`)
      const raw = this.count('raw_iron')
      if (raw === 0) return fail('no_materials', 'no raw iron')
      let furnace = await this.findStation('furnace', 'furnace')
      if (!furnace) furnace = await this.placeNear('furnace')
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

  // Nearest exposed block of the kind (one the bot can see), else the nearest at all.
  pickBlock(ids, maxDistance) {
    const cands = this.bot.findBlocks({ matching: ids, maxDistance, count: 24 })
    if (!cands.length) return null
    const me = this.bot.entity.position
    cands.sort((a, b) => me.distanceTo(a) - me.distanceTo(b))
    for (const p of cands) { const b = this.bot.blockAt(p); if (b && this.bot.canSeeBlock(b)) return b }
    return this.bot.blockAt(cands[0])
  }

  // Manual staircase: dig head, feet and step-down ahead, walk onto the step, repeat.
  async digStaircase(steps) {
    const b = this.bot
    const [fx, fz] = this.headingVec()
    for (let i = 0; i < steps; i++) {
      this.check()
      const feet = b.entity.position.floored()
      const ahead = feet.offset(fx, 0, fz)
      for (const p of [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)]) {
        const blk = b.blockAt(p)
        if (blk && blk.boundingBox === 'block' && b.canDigBlock(blk)) { if (blk.name === 'lava' || blk.name === 'water') throw new Abort('liquid ahead'); await this.digSafe(blk) }
      }
      await this.goto(new goals.GoalBlock(ahead.x, ahead.y - 1, ahead.z))
    }
  }
}
