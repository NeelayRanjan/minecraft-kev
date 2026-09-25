// Climb and smelt check on a live server (Task 7 fixes): explore_toward(surface) from a 2-high tunnel 20 blocks under
// stone climbs a manual staircase to open sky, digging with the stone pickaxe (the iron one keeps its durability);
// smelt with a leftover plank in the furnace tops the fuel up and smelts all the raw iron.
// Usage: node tests/integration/climb_check.mjs [--port 25573] [--seed climb-1]   Prints PASS/FAIL; exit code 0 on PASS.
import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { plugin as pvp } from 'mineflayer-pvp'
import mcDataFor from 'minecraft-data'
import { Vec3 } from 'vec3'
import { startServer } from '../../agent/server_ctl.js'
import { Motor } from '../../agent/motor.js'
import { EpisodeMemory, summarize } from '../../agent/summary.js'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter(Boolean))
const port = Number(args.port ?? 25573), seed = args.seed ?? 'climb-1'
const t0 = Date.now()
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
const server = await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: 'kev_climb', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
const failHard = async (why) => { log(`FAIL ${why}`); try { bot.quit() } catch {} await server.stop(); process.exit(1) }
bot.on('kicked', r => failHard(`kicked ${JSON.stringify(r)}`))
setTimeout(() => failHard('timeout 6 min'), 6 * 60_000)
process.on('uncaughtException', e => failHard(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', e => failHard(`unhandled: ${e?.stack || e}`))
await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch { log('chunks not ready, retrying') } }
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log })
const obs = () => summarize(bot, mcData, mem, { t: (Date.now() - t0) / 1000, current: null, last: null, goal: 'nether' })
const cmd = async (s) => { server.proc.stdin.write(s.slice(1).replaceAll('@s', bot.username) + '\n'); await bot.waitForTicks(10); await motor.settleInventory() }   // console: no op needed
const pos = () => bot.entity.position
await cmd('/time set 1000'); await cmd('/difficulty peaceful'); await cmd('/gamerule doDaylightCycle false')
let pass = true
const check = (cond, what) => { if (!cond) { pass = false; log(`  assertion failed: ${what}`) } else log(`  ok: ${what}`) }

// (a) climb: a 30x30 column of stone from Y-24 to Y+2 with a 2-high tunnel at Y-20.
const X = Math.floor(pos().x), Y = Math.floor(pos().y), Z = Math.floor(pos().z)
for (let y = Y - 24; y <= Y + 2; y += 8) await cmd(`/fill ${X - 12} ${y} ${Z - 12} ${X + 12} ${Math.min(y + 7, Y + 2)} ${Z + 12} stone`)
await cmd(`/fill ${X - 1} ${Y - 20} ${Z - 1} ${X + 1} ${Y - 19} ${Z + 1} air`)
await cmd('/clear')
await cmd('/give @s iron_pickaxe'); await cmd('/give @s stone_pickaxe'); await cmd('/give @s cobblestone 16')
await cmd(`/tp @s ${X + 0.5} ${Y - 20} ${Z + 0.5}`)
await bot.waitForTicks(20)
const ironDamage = () => { const it = motor.item('iron_pickaxe'); return it?.durabilityUsed ?? it?.nbt?.value?.Damage?.value ?? 0 }
const d0 = ironDamage(), y0 = pos().y
check(obs().underground, `starts underground at y ${y0.toFixed(0)}`)
for (let i = 0; i < 5 && obs().underground; i++) {
  const r = await motor.run('explore_toward(surface)', obs())
  log(`explore_toward(surface) -> ${r.result}${r.detail ? ` (${r.detail})` : ''}   [y ${pos().y.toFixed(0)}]`)
}
check(!obs().underground, `reached open sky (y ${y0.toFixed(0)} -> ${pos().y.toFixed(0)})`)
check(ironDamage() === d0, `the iron pickaxe was not used (damage ${d0} -> ${ironDamage()})`)

// (b) smelt with a leftover plank in the furnace: fuel is topped up, all 3 raw iron smelted.
await cmd('/clear')
const p = pos().floored()
await cmd(`/fill ${p.x - 2} ${p.y} ${p.z - 2} ${p.x + 2} ${p.y + 2} ${p.z + 2} air`)
await cmd(`/setblock ${p.x + 2} ${p.y} ${p.z} furnace{Items:[{Slot:1b,id:"minecraft:oak_planks",Count:1b}]}`)
await cmd('/give @s raw_iron 3'); await cmd('/give @s oak_planks 4')
const r = await motor.run('smelt(iron_ingot)', obs())
log(`smelt(iron_ingot) -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
check(r.result === 'ok' && motor.count('iron_ingot') === 3, `3 iron ingots (${motor.count('iron_ingot')})`)

log(pass ? 'PASS' : 'FAIL')
try { bot.quit() } catch {}
await server.stop()
process.exit(pass ? 0 : 1)
