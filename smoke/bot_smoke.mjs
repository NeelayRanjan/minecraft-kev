// Infrastructure smoke test: connect, find the nearest log, path to it, mine it, report.
// Usage: node smoke/bot_smoke.mjs [host] [port]
// Exit 0 on success, 1 on failure or timeout. Every step prints a typed line so failures are attributable.

import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'

const { pathfinder, Movements } = pathfinderPkg
const { plugin: collectBlock } = collectPkg

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25565)
const t0 = Date.now()
const log = (step, msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}: ${msg}`)

const bot = createBot({ host, port, username: 'kev_smoke', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

const deadline = setTimeout(() => { log('FAIL', 'timeout after 180 s'); process.exit(1) }, 180_000)

bot.on('kicked', r => { log('FAIL', `kicked: ${JSON.stringify(r)}`); process.exit(1) })
bot.on('error', e => { log('FAIL', `error: ${e.message}`); process.exit(1) })

bot.once('spawn', async () => {
  log('spawn', `at ${bot.entity.position.floored()} health ${bot.health} food ${bot.food} version ${bot.version}`)
  const mcData = (await import('minecraft-data')).default(bot.version)
  bot.pathfinder.setMovements(new Movements(bot, mcData))

  // Wait for chunks around us to load so findBlock sees something.
  await bot.waitForChunksToLoad()
  log('chunks', 'loaded')

  const logIds = mcData.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id)
  const target = bot.findBlock({ matching: logIds, maxDistance: 64 })
  if (!target) { log('FAIL', 'no log within 64 m of spawn (try another seed)'); process.exit(1) }
  const dist = bot.entity.position.distanceTo(target.position)
  log('find', `${target.name} at ${target.position} (${dist.toFixed(1)} m)`)

  const before = bot.inventory.items().reduce((n, i) => n + i.count, 0)
  try {
    await bot.collectBlock.collect(target)
  } catch (e) {
    log('FAIL', `collect failed: ${e.name}: ${e.message}`)
    process.exit(1)
  }
  const after = bot.inventory.items().reduce((n, i) => n + i.count, 0)
  const items = bot.inventory.items().map(i => `${i.count}x ${i.name}`).join(', ') || 'nothing'
  log('collect', `done; inventory ${before} -> ${after} items: ${items}`)

  const ok = after > before
  log(ok ? 'PASS' : 'FAIL', ok ? 'walked to a tree and mined a log' : 'collect returned but inventory did not grow')
  clearTimeout(deadline)
  bot.quit()
  setTimeout(() => process.exit(ok ? 0 : 1), 500)
})
