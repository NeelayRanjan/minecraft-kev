// Chain motor check on a live server: the executors the nether chain adds (iron tools and armor, diamond tools,
// diamonds, gravel/flint, obsidian, deep exploration with the lava check). Every scenario is built with op commands
// (/give, /fill, /setblock, /tp) so terrain does not decide the outcome.
// Usage: node tests/integration/chain_check.mjs [--port 25572] [--seed chain-1]
// Prints "[t] subtask -> result (detail)" per step and PASS/FAIL; exit code 0 on PASS.
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
const port = Number(args.port ?? 25572), seed = args.seed ?? 'chain-1'
const t0 = Date.now()
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

const server = await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: 'kev_smoke', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
const failHard = async (why) => { log(`FAIL ${why}`); try { bot.quit() } catch {} await server.stop(); process.exit(1) }
bot.on('kicked', r => failHard(`kicked ${JSON.stringify(r)}`))
bot.on('error', e => log(`bot error: ${e.message}`))
const deadline = setTimeout(() => failHard('timeout 10 min'), 10 * 60_000)
process.on('uncaughtException', e => failHard(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', e => failHard(`unhandled: ${e?.stack || e}`))

await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch (e) { log(`chunks not ready yet (${e.message.slice(0, 40)}), retrying`) } }
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log })
const obs = () => summarize(bot, mcData, mem, { t: (Date.now() - t0) / 1000, current: null, last: null, goal: 'nether' })
const cmd = async (s) => { bot.chat(s); await bot.waitForTicks(10); await motor.settleInventory() }
const count = n => motor.count(n)
const nameAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name
const pos = () => bot.entity.position

await cmd('/time set 1000'); await cmd('/difficulty peaceful'); await cmd('/gamerule doDaylightCycle false')

let pass = true
const check = (cond, what) => { if (!cond) { pass = false; log(`  assertion failed: ${what}`) } }
async function step(id, allowed = ['ok']) {
  const r = await motor.run(id, obs())
  log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}   [y ${pos().y.toFixed(0)}]`)
  check(allowed.includes(r.result), `${id}: ${r.result} not in ${allowed.join('/')}`)
  return r
}

// A flat arena around the spawn: stone floor under the feet, 5 blocks of air above it.
const X = Math.floor(pos().x), Y = Math.floor(pos().y), Z = Math.floor(pos().z)
await cmd(`/fill ${X - 7} ${Y - 1} ${Z - 7} ${X + 7} ${Y - 1} ${Z + 7} stone`)
await cmd(`/fill ${X - 7} ${Y} ${Z - 7} ${X + 7} ${Y + 4} ${Z + 7} air`)
await cmd(`/tp kev_smoke ${X + 0.5} ${Y} ${Z + 0.5}`)
await bot.waitForTicks(20)
log(`arena at ${X} ${Y} ${Z}`)

// (a) iron sword, axe and the four armor pieces; the armor is worn afterwards.
await cmd('/give kev_smoke iron_ingot 32'); await cmd('/give kev_smoke stick 8'); await cmd('/give kev_smoke crafting_table 1')
for (const it of ['iron_sword', 'iron_axe', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await step(`craft(${it})`)
const worn = [5, 6, 7, 8].map(i => bot.inventory.slots[i]?.name ?? null)
log(`  armor slots 5..8: ${worn.join(', ')}`)
check(worn.join() === 'iron_helmet,iron_chestplate,iron_leggings,iron_boots', 'four iron armor pieces worn')
check(count('iron_sword') === 1 && count('iron_axe') === 1, 'iron sword and axe in the inventory')

// Obsidian ×3 at feet level 5 m south; without a diamond pickaxe mine_obsidian must fail cleanly.
await cmd(`/fill ${X - 1} ${Y} ${Z + 5} ${X + 1} ${Y} ${Z + 5} obsidian`)
await step('mine_obsidian', ['no_materials'])

// (b) diamond pickaxe, sword and axe from 8 diamonds (the 8 sticks cover all five tools).
await cmd('/give kev_smoke diamond 8')
for (const it of ['diamond_pickaxe', 'diamond_sword', 'diamond_axe']) await step(`craft(${it})`)
check(count('diamond_pickaxe') === 1 && count('diamond_sword') === 1 && count('diamond_axe') === 1, 'three diamond tools')
await cmd('/give kev_smoke diamond_pickaxe 1')   // the brief's setup; one is already crafted

// (c) a diamond ore 5 m east at feet level.
await cmd(`/setblock ${X + 5} ${Y} ${Z} diamond_ore`)
let before = count('diamond')
await step('mine_diamond')
check(count('diamond') === before + 1, `+1 diamond (had ${before}, now ${count('diamond')})`)
check(nameAt(X + 5, Y, Z) !== 'diamond_ore', 'the diamond ore is gone')

// (d) a 3x1x3 gravel patch 3-5 m west: flint at 10% per block, so ok (flint) or failed (all gravel dug, no flint).
await cmd(`/fill ${X - 5} ${Y} ${Z - 1} ${X - 3} ${Y} ${Z + 1} gravel`)
before = count('flint')
const rg = await step('mine_gravel', ['ok', 'failed'])
const gravelLeft = () => { let n = 0; for (let x = X - 5; x <= X - 3; x++) for (let z = Z - 1; z <= Z + 1; z++) if (nameAt(x, Y, z) === 'gravel') n++; return n }
log(`  gravel left in the patch: ${gravelLeft()}, flint ${before} -> ${count('flint')}`)
if (rg.result === 'ok') check(count('flint') > before, 'ok means flint was picked up')
else check(gravelLeft() === 0 && count('flint') === before, 'failed means the whole patch was dug without flint')

// (e) the three obsidian blocks with the diamond pickaxe.
before = count('obsidian')
await step('mine_obsidian')
const obsLeft = [-1, 0, 1].filter(dx => nameAt(X + dx, Y, Z + 5) === 'obsidian').length
log(`  obsidian ${before} -> ${count('obsidian')}, left in place: ${obsLeft}`)
check(obsLeft === 0 && count('obsidian') >= before + 1, 'obsidian mined and picked up')

// (f) explore_toward(deep) twice from the surface: y goes down, results ok or timeout only.
await cmd(`/tp kev_smoke ${X + 0.5} ${Y} ${Z + 0.5}`); await bot.waitForTicks(20)
const ySurface = pos().y
await step('explore_toward(deep)', ['ok', 'timeout'])
await step('explore_toward(deep)', ['ok', 'timeout'])
check(pos().y < ySurface, `y decreased from the surface (${ySurface.toFixed(0)} -> ${pos().y.toFixed(0)})`)

// (g) the staircase band (between iron level and diamond level) inside a sealed deepslate block: 4 steps down.
const pocket = async (y, r, y0, y1) => {
  await cmd(`/fill ${X - r} ${y0} ${Z - r} ${X + r} ${y1} ${Z + r} deepslate`)
  await cmd(`/fill ${X} ${y} ${Z} ${X} ${y + 1} ${Z} air`)
  await cmd(`/tp kev_smoke ${X + 0.5} ${y} ${Z + 0.5}`); await bot.waitForTicks(30)
}
mem.heading = 'north'
await pocket(-20, 8, -32, -16)
let y0 = pos().y
await step('explore_toward(deep)')
check(pos().y <= y0 - 3, `staircase went down (${y0.toFixed(0)} -> ${pos().y.toFixed(0)})`)

// The lava check: lava under the next step stops the staircase before digging, and the heading turns.
const feet = pos().floored(), [hx, hz] = motor.headingVec(), headingBefore = mem.heading
const lava = feet.offset(hx, -2, hz)
await cmd(`/setblock ${lava.x} ${lava.y} ${lava.z} lava`)
log(`  lava under the next step at ${lava} (heading ${headingBefore}), sees ${motor.unsafeToStep(feet.offset(hx, 0, hz))}`)
y0 = pos().y
const rl = await step('explore_toward(deep)', ['failed'])
check(/lava/.test(rl.detail || '') && mem.heading !== headingBefore && Math.abs(pos().y - y0) < 0.5, 'stopped at the lava and turned')
await cmd(`/setblock ${lava.x} ${lava.y} ${lava.z} deepslate`)

// (h) diamond level: tunnel 12 m horizontally.
mem.heading = 'east'
await pocket(-56, 14, -59, -52)
const p0 = pos().clone()
await step('explore_toward(deep)')
check(Math.abs(pos().x - p0.x) >= 10 && Math.abs(pos().y - p0.y) <= 2, `tunnelled east (${p0.floored()} -> ${pos().floored()})`)

log(`final inventory: ${Object.entries(obs().inventory).map(([k, v]) => `${v} ${k}`).join(', ')}`)
log(pass ? 'PASS' : 'FAIL')
clearTimeout(deadline)
bot.quit()
await server.stop()
process.exit(pass ? 0 : 1)
