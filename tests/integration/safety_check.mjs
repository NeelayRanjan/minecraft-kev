// Motor safety check on a live server: the drowning and fall fixes (r2 runs, 2026-09-25: most of the 18 deaths were
// waits at the bottom of a lake, a staircase down from a beach, sand falling onto the head during the climb).
// Every scenario is built with op commands (/fill, /setblock, /tp, /give) so terrain does not decide the outcome.
//   (a) a 5x5 pool three deep with a sand shore, the bot at the bottom: three waits end on the shore or afloat, no
//       damage, air back to 20/20.
//   (b) the down staircase with a 6-deep, 2-wide pit under the next step: without blocks it stops ('drop ahead', no
//       step); with cobblestone it places the floor and steps onto it. No damage.
//   (c) the climb (explore_toward(surface)) from a sealed cell 40 m down under a sand layer, with no step ahead
//       (a 4-deep hole) and no blocks: turns instead of stepping, no suffocation, climbs.
//   (d) explore_toward(down) from a sand beach at the edge of deep water, three times as a driver would: no damage,
//       dry at the end (a wait swims out if a run ended in the water).
// Usage: node tests/integration/safety_check.mjs [--port 25574] [--seed safety-1]. Prints PASS/FAIL; exit 0 on PASS.
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
const port = Number(args.port ?? 25574), seed = args.seed ?? 'safety-1'
const t0 = Date.now()
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

const server = await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: 'kev_smoke', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
const failHard = async (why) => { log(`FAIL ${why}`); try { bot.quit() } catch {} await server.stop(); process.exit(1) }
bot.on('kicked', r => failHard(`kicked ${JSON.stringify(r)}`))
bot.on('error', e => log(`bot error: ${e.message}`))
bot.on('death', () => log('  the bot died'))
const deadline = setTimeout(() => failHard('timeout 8 min'), 8 * 60_000)
process.on('uncaughtException', e => failHard(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', e => failHard(`unhandled: ${e?.stack || e}`))

await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch (e) { log(`chunks not ready yet (${e.message.slice(0, 40)}), retrying`) } }
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log })
const obs = () => summarize(bot, mcData, mem, { t: (Date.now() - t0) / 1000, current: null, last: null, goal: 'nether' })
const cmd = async (s) => { bot.chat(s); await bot.waitForTicks(10); await motor.settleInventory() }
const pos = () => bot.entity.position
// Any health loss counts (peaceful regenerates, so the final health alone would hide drowning or suffocation).
let lastHealth = bot.health, damage = 0
bot.on('health', () => { if (bot.health < lastHealth) { damage += lastHealth - bot.health; log(`  damage: health ${lastHealth} -> ${bot.health} (oxygen ${bot.oxygenLevel})`) } lastHealth = bot.health })

await cmd('/time set 1000'); await cmd('/difficulty peaceful'); await cmd('/gamerule doDaylightCycle false')

let pass = true
const check = (cond, what) => { log(`  ${cond ? 'ok' : 'assertion failed'}: ${what}`); if (!cond) pass = false }
async function step(id) {
  const r = await motor.run(id, obs())
  log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}   [${pos().x.toFixed(1)} ${pos().y.toFixed(1)} ${pos().z.toFixed(1)}, in water ${bot.entity.isInWater}, oxygen ${bot.oxygenLevel}]`)
  return r
}
const X = Math.floor(pos().x), Y = Math.floor(pos().y), Z = Math.floor(pos().z)
// Rebuilding with /fill around the bot would bury it (suffocation damage): park it on a pillar outside first.
async function park() { await cmd(`/setblock ${X + 16} ${Y + 10} ${Z} stone`); await tp(X + 16, Y + 11, Z) }
// The arena: stone from Y-9 to Y-1, air from Y to Y+6, 25 x 25.
async function arena() {
  await park()
  await cmd(`/fill ${X - 12} ${Y - 9} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 6} ${Z + 12} air`)
  await cmd('/kill @e[type=item]')
}
const tp = async (x, y, z) => { await cmd(`/tp kev_smoke ${x + 0.5} ${y} ${z + 0.5} 180 0`); await bot.waitForTicks(20) }
const waitOxygen = async (s) => { for (let i = 0; i < s * 4 && (bot.oxygenLevel ?? 20) < 20; i++) await bot.waitForTicks(5); return bot.oxygenLevel ?? 20 }
log(`arena at ${X} ${Y} ${Z}`)

// (a) pool: sand shore at Y-1 around, water Y-3..Y-1 in the middle 5 x 5; the bot at the bottom.
await arena()
await cmd(`/fill ${X - 5} ${Y - 1} ${Z - 5} ${X + 5} ${Y - 1} ${Z + 5} sand`)
await cmd(`/fill ${X - 2} ${Y - 3} ${Z - 2} ${X + 2} ${Y - 1} ${Z + 2} water`)
await tp(X, Y - 3, Z)
log(`(a) in the pool: in water ${bot.entity.isInWater}, y ${pos().y.toFixed(1)}`)
damage = 0
for (let i = 0; i < 3; i++) { const r = await step('wait'); check(r.result === 'ok', `wait ${i + 1} is ok (${r.detail ?? ''})`) }
const onShore = !bot.entity.isInWater && pos().y >= Y - 0.01
const afloat = pos().y >= Y - 1.8   // bobbing at the water line (isInWater flickers there)
check(onShore || afloat, `on the shore or afloat (y ${pos().y.toFixed(2)}, in water ${bot.entity.isInWater})`)
check(await waitOxygen(10) === 20, `air back to 20/20 (${bot.oxygenLevel})`)
check(damage === 0, `no damage in the pool (${damage})`)

// (b) down staircase over a pit: stone floor, a 6-deep hole 1 x 2 under the next step (cells z-1 and z-2).
await arena()
await cmd('/clear kev_smoke'); await cmd('/give kev_smoke stone_pickaxe 1')
await cmd(`/fill ${X} ${Y - 7} ${Z - 2} ${X} ${Y - 2} ${Z - 1} air`)
await tp(X, Y, Z)
damage = 0
mem.heading = 'north'; motor.deadline = Date.now() + 30_000
let err = null
try { await motor.digStaircase(1) } catch (e) { err = e }
log(`(b1) digStaircase(1) without blocks -> ${err ? `${err.name}: ${err.message}` : 'stepped'}   [y ${pos().y.toFixed(1)}, heading ${mem.heading}]`)
check(err?.message === 'drop ahead' && motor.mapError(err).result === 'failed', `stopped with 'drop ahead' (result ${err ? motor.mapError(err).result : 'none'})`)
check(pos().y >= Y - 0.01 && mem.heading !== 'north', 'did not step, heading turned')
await cmd('/kill @e[type=item]')
await cmd('/give kev_smoke cobblestone 8')
mem.heading = 'north'; motor.deadline = Date.now() + 30_000; err = null
try { await motor.digStaircase(1) } catch (e) { err = e }
await bot.waitForTicks(10)
const floor = bot.blockAt(new Vec3(X, Y - 2, Z - 1))?.name
log(`(b2) digStaircase(1) with cobblestone -> ${err ? `${err.name}: ${err.message}` : 'stepped'}   [y ${pos().y.toFixed(1)}, floor ${floor}]`)
check(!err && floor === 'cobblestone', 'placed the floor of the step')
check(Math.floor(pos().y + 0.01) === Y - 1, `stood on it (y ${pos().y.toFixed(2)})`)
check(damage === 0, `no damage on the staircase (${damage})`)

// (c) the climb, 40 m down (the client keeps the chunk's own sky light, 0 at that depth; /fill does not relight it):
// solid stone from D-3 to D+20 with sand at D+3..D+4 (as over the granite of r2_leader t=323), a 1 x 2 cell for the
// bot at D..D+1, and a hole 4 deep where the first step north would be. No blocks: it must turn, not step.
const D = Y - 40
await park()
await cmd(`/fill ${X - 6} ${D - 3} ${Z - 6} ${X + 6} ${D + 20} ${Z + 6} stone`)
await cmd(`/fill ${X - 6} ${D + 3} ${Z - 6} ${X + 6} ${D + 4} ${Z + 6} sand`)
await cmd(`/fill ${X} ${D} ${Z} ${X} ${D + 1} ${Z} air`)
await cmd(`/fill ${X} ${D - 3} ${Z - 1} ${X} ${D} ${Z - 1} air`)
await cmd('/clear kev_smoke'); await cmd('/give kev_smoke stone_pickaxe 1')
await tp(X, D, Z)
damage = 0; mem.heading = 'north'
log(`(c) sealed cell at y ${D}: underground ${motor.underground()}`)
check(motor.underground(), 'the cell reads as underground')
let lowest = pos().y
const trackLow = () => { lowest = Math.min(lowest, pos().y) }
bot.on('move', trackLow)
for (let i = 0; i < 2; i++) await step('explore_toward(surface)')
bot.off('move', trackLow)
check(lowest >= D - 0.01, `never stepped into the hole (lowest y ${lowest.toFixed(2)})`)
check(pos().y > D + 4.5, `climbed through the sand (y ${pos().y.toFixed(1)})`)
// Sand falling onto the bot is dug out at once: a moment of suffocation (1-2 hp per layer) instead of r2's death.
check(damage <= 4, `at most a moment of suffocation in the climb (${damage} hp)`)

// (d) beach: stone arena, a sand beach at Y-1, deep water (Y-6..Y-1) from 2 m north of the bot onwards.
await arena()
await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} sand`)
await cmd(`/fill ${X - 6} ${Y - 6} ${Z - 12} ${X + 6} ${Y - 1} ${Z - 2} water`)
const trace = setInterval(() => { if (bot.entity.isInWater) log(`  (in water at ${pos().floored()}, oxygen ${bot.oxygenLevel})`) }, 2000)
await cmd('/clear kev_smoke'); await cmd('/give kev_smoke stone_pickaxe 1'); await cmd('/give kev_smoke cobblestone 8')
await tp(X, Y, Z)
damage = 0; mem.heading = 'north'
for (let i = 0; i < 3; i++) await step('explore_toward(down)')
clearInterval(trace)
if (bot.entity.isInWater) await step('wait')
check(!bot.entity.isInWater || pos().y >= Y - 1.8, `dry or afloat at the end (in water ${bot.entity.isInWater}, y ${pos().y.toFixed(1)})`)
check(await waitOxygen(10) === 20, `air 20/20 (${bot.oxygenLevel})`)
check(damage === 0, `no damage from the beach (${damage})`)

// (e) a 3-wide channel with the nearest shore ~24 m away: past the old 12 m search radius (leaveWater's default is
// now 48 m, the live session found open water wider than that). Stone floor everywhere, a shallow channel south of
// the bot, a sand shore at the far (north) end.
await park()
await cmd(`/fill ${X - 24} ${Y - 9} ${Z - 24} ${X + 24} ${Y - 1} ${Z + 24} stone`)
await cmd(`/fill ${X - 24} ${Y} ${Z - 24} ${X + 24} ${Y + 6} ${Z + 24} air`)
await cmd('/kill @e[type=item]')
await cmd(`/fill ${X - 3} ${Y - 3} ${Z - 22} ${X + 3} ${Y - 1} ${Z + 5} water`)
await cmd(`/fill ${X - 3} ${Y - 1} ${Z - 24} ${X + 3} ${Y - 1} ${Z - 23} sand`)
await tp(X, Y - 3, Z)
log(`(e) in a 3-wide channel, shore ~24 m north: in water ${bot.entity.isInWater}`)
damage = 0
const r5 = await step('wait')
check(r5.result === 'ok', `wait is ok (${r5.detail ?? ''})`)
check(!bot.entity.isInWater, `dry after leaving (in water ${bot.entity.isInWater}, y ${pos().y.toFixed(1)})`)
check(damage === 0, `no damage crossing to the far shore (${damage})`)

// (f) a hostile placed so the naive flee direction (straight away from it) is into water: the bot must turn to a dry
// heading instead of failing 'no_path' (only one of the four headings is wet, so it must not report every-heading-wet
// either). Peaceful despawns hostile mobs at once, so difficulty goes to easy just for this scenario.
await arena()
await cmd(`/fill ${X - 4} ${Y - 1} ${Z + 1} ${X + 4} ${Y - 1} ${Z + 9} water`)
await tp(X, Y, Z)
await cmd('/difficulty easy')
await cmd(`/summon zombie ${X + 0.5} ${Y} ${Z - 10 + 0.5} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`)
await bot.waitForTicks(10)
mem.heading = 'north'
damage = 0
const r6 = await step('flee(threat)')
log(`(f) flee with water south of the naive direction: heading now ${mem.heading}`)
check(r6.result !== 'no_path', `did not refuse (only one heading is wet): ${r6.result} ${r6.detail ?? ''}`)
check(mem.heading === 'west', `turned away from the wet heading (south) instead of fleeing into it (heading ${mem.heading})`)
check(damage === 0, `no damage fleeing (${damage})`)
await cmd('/kill @e[type=zombie]'); await cmd('/difficulty peaceful')

log(pass ? 'PASS' : 'FAIL')
clearTimeout(deadline)
bot.quit()
await server.stop()
process.exit(pass ? 0 : 1)
