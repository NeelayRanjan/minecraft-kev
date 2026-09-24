// Memory probe for the motor layer: give the bot a pickaxe, run one subtask, log heap size and pathfinder events per second.
// Usage: node tests/integration/mem_probe.mjs [subtask=mine_stone] [--port 25572] [--seed motor-1] [--mode collect|manual]
import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { plugin as pvp } from 'mineflayer-pvp'
import mcDataFor from 'minecraft-data'
import { startServer } from '../../agent/server_ctl.js'
import { Motor } from '../../agent/motor.js'
import { EpisodeMemory, summarize } from '../../agent/summary.js'

const argv = process.argv.slice(2)
const subtask = argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'mine_stone'
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined }
const port = Number(opt('port') ?? 25572), seed = opt('seed') ?? 'motor-1', mode = opt('mode') ?? 'collect'
const t0 = Date.now()
const mb = () => (process.memoryUsage().heapUsed / 1048576).toFixed(0)
const log = s => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s heap ${mb()} MB] ${s}`)

const server = await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: 'kev_smoke', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
const bail = async why => { log(`END ${why}`); try { bot.quit() } catch {} await server.stop(); process.exit(0) }
process.on('uncaughtException', e => bail(`uncaught ${e.stack}`))
setTimeout(() => bail('deadline'), 150_000)
await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch { log('chunks retry') } }
bot.chat('/time set 1000'); bot.chat('/difficulty peaceful')
if (!argv.includes('--nogive')) { bot.chat('/give kev_smoke wooden_pickaxe'); bot.chat('/give kev_smoke oak_planks 8'); bot.chat('/give kev_smoke stick 4'); bot.chat('/give kev_smoke crafting_table') }
await bot.waitForTicks(20)
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log })
let lastPU = 0
bot.on('path_update', r => {
  const heap = process.memoryUsage().heapUsed / 1048576
  if (Date.now() - lastPU > 1000 || r.status !== 'partial') { lastPU = Date.now(); log(`path_update ${r.status} visited ${r.visitedNodes} generated ${r.generatedNodes} time ${r.time?.toFixed?.(0)} ms len ${r.path.length}`) }
  if (heap > 1500) { log(`HEAP GUARD: ${heap.toFixed(0)} MB during ${r.status} visited ${r.visitedNodes} generated ${r.generatedNodes} time ${r.time?.toFixed?.(0)} ms; goal ${JSON.stringify(bot.pathfinder.goal ?? r.context?.goal ?? 'n/a').slice(0, 200)}`); bot.pathfinder.setGoal(null); bail('heap guard') }
})
bot.on('goal_reached', () => log('goal_reached'))
bot.on('diggingCompleted', b => log(`dug ${b.name}`))
bot.on('playerCollect', (c, e) => { if (c === bot.entity) log(`collected ${e.name}`) })
const tick = setInterval(() => log(`tick y ${bot.entity.position.y.toFixed(1)} moving ${bot.pathfinder.isMoving()} mining ${bot.pathfinder.isMining()} inv ${bot.inventory.items().map(i => `${i.count} ${i.name}`).join(',')}`), 2000)
const obs = summarize(bot, mcData, mem, { t: 0, current: null, last: null })
log(`start ${subtask} mode ${mode}; blocks: ${obs.blocks.map(b => `${b.name} ${b.dist.toFixed(0)}m`).join(', ')}`)
for (const st of subtask.split(',')) {
  if (st.startsWith('give:')) { const [, item, n] = st.split(':'); bot.chat(`/give kev_smoke ${item} ${n ?? 1}`); await bot.waitForTicks(10); log(`gave ${n ?? 1} ${item}`); continue }
  const o = summarize(bot, mcData, mem, { t: 0, current: null, last: null })
  let r
  if (st === 'craft_pkt') {
    // Packet-level view of table crafting: 6 wooden pickaxe crafts straight through bot.craft, logging every click we
    // send and every slot/window packet we receive, to compare a failing attempt with a succeeding one.
    bot.chat('/clear kev_smoke'); await bot.waitForTicks(5); bot.chat('/give kev_smoke oak_planks 30'); bot.chat('/give kev_smoke stick 20'); bot.chat('/give kev_smoke crafting_table'); await bot.waitForTicks(10)
    const table = await motor.placeNear('crafting_table')
    await bot.waitForTicks(10)
    const origWrite = bot._client.write.bind(bot._client)
    bot._client.write = (name, params) => { if (name === 'window_click') log(`    > click win ${params.windowId} slot ${params.slot} btn ${params.mouseButton} mode ${params.mode} state ${params.stateId} changed ${params.changedSlots?.length} cursor ${params.cursorItem?.itemId ?? '-'}`); return origWrite(name, params) }
    bot._client.on('window_items', p => log(`    < window_items win ${p.windowId} state ${p.stateId} n ${p.items?.length} nonempty ${p.items?.filter(i => i?.present).length}`))
    bot._client.on('set_slot', p => log(`    < set_slot win ${p.windowId} slot ${p.slot} item ${p.item?.itemId ?? '-'} x${p.item?.itemCount ?? ''} state ${p.stateId}`))
    bot._client.on('open_window', p => log(`    < open_window win ${p.windowId} type ${p.inventoryType}`))
    const id = mcData.itemsByName.wooden_pickaxe.id
    let okN = 0
    for (let i = 0; i < 6; i++) {
      await motor.settleInventory(6)
      const rs = bot.recipesFor(id, null, 1, table)
      const before = motor.count('wooden_pickaxe')
      log(`attempt ${i}: recipes ${rs.length}, inv ${bot.inventory.items().map(x => `${x.count} ${x.name}@${x.slot}`).join(',')}`)
      try { await bot.craft(rs[0], 1, table) } catch (e) { log(`  craft threw ${e.message}`) }
      await bot.waitForTicks(3); await motor.settleInventory(6)
      const got = motor.count('wooden_pickaxe') - before
      log(`attempt ${i}: ${got > 0 ? 'OK' : 'NOTHING'} (+${got})`)
      if (got > 0) okN++
    }
    log(`craft_pkt: ${okN}/6 ok`)
    r = { result: 'pkt-done' }
  } else if (st === 'craft_loop') {
    // Flake rate of table crafting: place a table, craft sticks at it 10 times, count successes.
    bot.chat('/clear kev_smoke'); await bot.waitForTicks(5); bot.chat('/give kev_smoke oak_planks 40'); bot.chat('/give kev_smoke crafting_table'); await bot.waitForTicks(10)
    const table = await motor.placeNear('crafting_table')
    log(`placed table ${table?.position} dist ${table ? bot.entity.position.distanceTo(table.position).toFixed(1) : '-'}`)
    let okN = 0
    for (let i = 0; i < 10; i++) {
      const before = motor.count('stick')
      const r0 = await motor.run('craft(sticks)', summarize(bot, mcData, mem, { t: 0, current: null, last: null }))
      const got = motor.count('stick') - before
      log(`craft ${i}: ${r0.result} ${r0.detail ?? ''} (+${got})`)
      if (r0.result === 'ok') okN++
    }
    // and 5 wooden pickaxes through the table (needs sticks from above)
    bot.chat('/give kev_smoke stick 16'); await bot.waitForTicks(10)
    for (let i = 0; i < 5; i++) {
      const r0 = await motor.run('craft(wooden_pickaxe)', summarize(bot, mcData, mem, { t: 0, current: null, last: null }))
      log(`pickaxe ${i}: ${r0.result} ${r0.detail ?? ''}`)
      if (r0.result === 'ok') okN++
    }
    log(`craft_loop: ${okN}/15 ok`)
    r = { result: 'loop-done' }
  } else if (st === 'craft_seq') {
    // The motor check's exact crafting sequence, with slot-update logging, to see where the client inventory desyncs.
    bot.chat('/clear kev_smoke'); await bot.waitForTicks(5); bot.chat('/give kev_smoke oak_log 5'); await bot.waitForTicks(10)
    const inv = () => bot.inventory.items().map(i => `${i.count} ${i.name}@${i.slot}`).join(',')
    bot.inventory.on('updateSlot', (slot, o, n) => log(`  updateSlot ${slot}: ${o ? `${o.count} ${o.name}` : '-'} -> ${n ? `${n.count} ${n.name}` : '-'}`))
    bot.on('windowOpen', w => log(`  windowOpen ${w.type}`))
    bot.on('windowClose', w => log(`  windowClose ${w.type}`))
    bot._client.on('window_items', p => log(`  window_items win ${p.windowId} n ${p.items?.length} state ${p.stateId}`))
    bot._client.on('set_slot', p => log(`  set_slot win ${p.windowId} slot ${p.slot} item ${p.item?.itemId ?? p.item?.blockId ?? '-'} x${p.item?.itemCount ?? ''} state ${p.stateId}`))
    const craftIt = async (name, table) => {
      const id = mcData.itemsByName[name].id
      const rs = bot.recipesFor(id, null, 1, table)
      log(`craft ${name}: recipes ${rs.length}; inv before ${inv()}`)
      if (!rs.length) return
      try { await bot.craft(rs[0], 1, table) } catch (e) { log(`  craft threw ${e.message}`) }
      log(`  resolved; inv ${inv()}`)
      await bot.waitForTicks(10)
      log(`  +10 ticks; inv ${inv()}`)
    }
    await craftIt('oak_planks', null)
    await craftIt('oak_planks', null)
    await craftIt('crafting_table', null)
    await craftIt('stick', null)
    const table = await motor.placeNear('crafting_table')
    log(`placed table ${table?.position}; inv ${inv()}`)
    await bot.waitForTicks(4)
    await craftIt('wooden_pickaxe', table)
    r = { result: 'seq-done' }
  } else if (st === 'craft_manual') {
    bot.on('windowOpen', w => log(`windowOpen ${w.type} slots ${w.slots.length}`))
    bot.on('windowClose', w => log(`windowClose ${w.type}`))
    const table = motor.item('crafting_table') ? await motor.placeNear('crafting_table') : bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 })
    log(`table ${table ? `${table.name}@${table.position} dist ${bot.entity.position.distanceTo(table.position).toFixed(1)}` : 'none'}`)
    await bot.waitForTicks(4)
    const id = mcData.itemsByName.wooden_pickaxe.id
    const rs = bot.recipesFor(id, null, 1, table)
    log(`recipes ${rs.length}; first: requiresTable ${rs[0]?.requiresTable} delta ${JSON.stringify(rs[0]?.delta)} result ${JSON.stringify(rs[0]?.result)}`)
    const inv = () => bot.inventory.items().map(i => `${i.count} ${i.name}`).join(',')
    try { await bot.craft(rs[0], 1, table); log(`craft resolved; inv ${inv()}`) } catch (e) { log(`craft threw ${e.name}: ${e.message}`) }
    for (let i = 0; i < 6; i++) { await bot.waitForTicks(5); log(`+${(i + 1) * 5} ticks inv ${inv()}`) }
    r = { result: 'manual-done' }
  } else if (mode === 'manual' && st === 'mine_stone') {
    const block = motor.pickBlock(motor.stoneIds, 16)
    log(`manual: goto near ${block.position} (${block.name}, visible ${bot.canSeeBlock(block)})`)
    try { await bot.pathfinder.goto(new pathfinderPkg.goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)); log('near'); await bot.dig(block); log('dug') } catch (e) { log(`manual error ${e.name}: ${e.message}`) }
    r = { result: 'manual-done' }
  } else {
    r = await motor.run(st, o)
  }
  log(`${st} -> ${r.result} ${r.detail ?? ''}; y ${bot.entity.position.y.toFixed(1)} inv ${bot.inventory.items().map(i => `${i.count} ${i.name}`).join(',')}`)
}
clearInterval(tick)
await bail('done')
