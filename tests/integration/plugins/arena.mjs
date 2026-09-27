// Shared setup for the plugin arena checks (the pattern of safety_check.mjs / chain_check.mjs): its own Paper server,
// a bot with pathfinder, collectblock and pvp, a Motor with the PluginRegistry loaded from agent/plugins (so every
// executor goes through Motor.run exactly as in play), peaceful, noon, a flat stone arena around the spawn.
// finish() prints PASS or FAIL, stops the server, deletes its world and exits non-zero on any failed case.
import fs from 'node:fs'
import path from 'node:path'
import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { plugin as pvp } from 'mineflayer-pvp'
import mcDataFor from 'minecraft-data'
import { Vec3 } from 'vec3'
import { startServer, ROOT } from '../../../agent/server_ctl.js'
import { Motor } from '../../../agent/motor.js'
import { PluginRegistry } from '../../../agent/plugins.js'
import { EpisodeMemory, summarize } from '../../../agent/summary.js'

export const USER = 'kev_smoke'

export async function startArena({ port, seed, minutes = 8 }) {
  const t0 = Date.now()
  const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
  const server = await startServer({ port, seed, log })
  const cleanup = async () => {
    await server.stop()
    // Disk is tight: drop this instance's worlds (startServer recreates them on the next run).
    for (const w of fs.readdirSync(server.dir).filter(d => d.startsWith('world'))) fs.rmSync(path.join(server.dir, w), { recursive: true, force: true })
  }
  const bot = createBot({ host: '127.0.0.1', port, username: USER, version: '1.20.4', auth: 'offline' })
  bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
  const failHard = async (why) => { log(`FAIL ${why}`); try { bot.quit() } catch {} await cleanup(); process.exit(1) }
  bot.on('kicked', r => failHard(`kicked ${JSON.stringify(r)}`))
  bot.on('error', e => log(`bot error: ${e.message}`))
  bot.on('death', () => log('  the bot died'))
  const deadline = setTimeout(() => failHard(`timeout ${minutes} min`), minutes * 60_000)
  process.on('uncaughtException', e => failHard(`uncaught: ${e.stack || e}`))
  process.on('unhandledRejection', e => failHard(`unhandled: ${e?.stack || e}`))

  await new Promise(r => bot.once('spawn', r))
  for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch (e) { log(`chunks not ready yet (${e.message.slice(0, 40)}), retrying`) } }
  const mcData = mcDataFor(bot.version)
  const mem = new EpisodeMemory()
  const motor = new Motor(bot, mcData, mem, { log })
  const registry = new PluginRegistry({ dir: path.join(ROOT, 'agent', 'plugins'), log })
  const loaded = await registry.load()
  if (loaded.failed.length) await failHard(`plugins failed to load: ${JSON.stringify(loaded.failed)}`)
  motor.plugins = registry
  const obs = () => summarize(bot, mcData, mem, { t: (Date.now() - t0) / 1000, current: null, last: null, goal: 'iron_pickaxe' })
  const cmd = async (s) => { bot.chat(s); await bot.waitForTicks(10); await motor.settleInventory() }
  const pos = () => bot.entity.position

  await cmd('/time set 6000'); await cmd('/difficulty peaceful'); await cmd('/gamerule doDaylightCycle false'); await cmd('/gamerule doMobSpawning false')
  // A flat arena: 6 blocks of stone under the feet, 5 blocks of air above, 12 m around the spawn.
  const X = Math.floor(pos().x), Y = Math.floor(pos().y), Z = Math.floor(pos().z)
  const floor = async () => {
    await cmd(`/fill ${X - 12} ${Y - 6} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} stone`)
    await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 4} ${Z + 12} air`)
    await cmd(`/kill @e[type=item]`)
    await cmd(`/tp ${USER} ${X + 0.5} ${Y} ${Z + 0.5}`)
    await bot.waitForTicks(20)
  }
  await floor()
  log(`arena at ${X} ${Y} ${Z}; plugins: ${registry.list().map(p => `${p.id}${p.enabled ? '' : ' (disabled)'}`).join(', ')}`)

  const failures = []
  const check = (cond, what) => { log(`  ${cond ? 'PASS' : 'FAIL'}: ${what}`); if (!cond) failures.push(what) }
  async function step(id) {
    const r = await motor.run(id, obs())
    log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}   [${pos().x.toFixed(1)} ${pos().y.toFixed(1)} ${pos().z.toFixed(1)}]`)
    return r
  }
  const reset = async () => { await cmd(`/clear ${USER}`); await floor() }
  async function finish() {
    clearTimeout(deadline)
    log(failures.length ? `FAIL (${failures.length}): ${failures.join('; ')}` : 'PASS')
    try { bot.quit() } catch {}
    await cleanup()
    process.exit(failures.length ? 1 : 0)
  }
  return { bot, mcData, mem, motor, registry, obs, cmd, pos, log, check, step, reset, finish, X, Y, Z, at: (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name }
}

export function argsOf(argv) {
  return Object.fromEntries(argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter(Boolean))
}
