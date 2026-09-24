// Motor-layer integration check on a live server (like the parent's autopilot_check.py).
// Usage: node tests/integration/motor_check.mjs [--port 25571] [--seed motor-1] [--no-video]
// Starts its own Paper instance, connects a bot, runs the tech tree's subtasks in order through Motor.run and prints
// "[t] subtask -> result (detail)" per line. PASS when every result that must be ok is ok. Records out/motor_check.mp4.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createBot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { plugin as pvp } from 'mineflayer-pvp'
import mcDataFor from 'minecraft-data'
import { startServer } from '../../agent/server_ctl.js'
import { Motor } from '../../agent/motor.js'
import { EpisodeMemory, summarize } from '../../agent/summary.js'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter(Boolean))
const port = Number(args.port ?? 25571), seed = args.seed ?? 'motor-1', video = !!args.video   // --video: prismarine headless recorder (leaks memory over minutes; see Task 9's recorder)
const t0 = Date.now()
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

const server = await startServer({ port, seed, log })
const bot = createBot({ host: '127.0.0.1', port, username: 'kev_smoke', version: '1.20.4', auth: 'offline' })
bot.loadPlugin(pathfinderPkg.pathfinder); bot.loadPlugin(collectPkg.plugin); bot.loadPlugin(pvp)
const failHard = async (why) => { log(`FAIL ${why}`); try { bot.quit() } catch {} await server.stop(); process.exit(1) }
bot.on('kicked', r => failHard(`kicked ${JSON.stringify(r)}`))
bot.on('error', e => log(`bot error: ${e.message}`))
const deadline = setTimeout(() => failHard('timeout 8 min'), 8 * 60_000)

process.on('uncaughtException', e => failHard(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', e => failHard(`unhandled: ${e?.stack || e}`))
await new Promise(r => bot.once('spawn', r))
for (let i = 0; i < 8; i++) { try { await bot.waitForChunksToLoad(); break } catch (e) { log(`chunks not ready yet (${e.message.slice(0, 40)}), retrying`) } }
bot.chat('/time set 1000'); bot.chat('/difficulty peaceful')
await new Promise(r => setTimeout(r, 1500))
const mcData = mcDataFor(bot.version)
const mem = new EpisodeMemory()
const motor = new Motor(bot, mcData, mem, { log })
if (video) {
  const require = createRequire(import.meta.url); require('node-canvas-webgl')
  const { headless } = require('prismarine-viewer')
  fs.mkdirSync('out', { recursive: true })
  headless(bot, { output: 'out/motor_check.mp4', frames: -1, width: 448, height: 448, viewDistance: 4 })
  log('recording out/motor_check.mp4')
}
const obs = () => summarize(bot, mcData, mem, { t: (Date.now() - t0) / 1000, current: null, last: null })

const plan = [
  ['gather_wood', true], ['gather_wood', true], ['craft(planks)', true], ['craft(crafting_table)', true], ['craft(sticks)', true],
  ['craft(planks)', true], ['craft(wooden_pickaxe)', true], ['explore_toward(down)', true], ['mine_stone', true], ['mine_stone', true], ['mine_stone', true],
  ['craft(crafting_table)', true], ['craft(stone_pickaxe)', true], ['craft(furnace)', true], ['explore_toward(down)', true], ['explore_toward(down)', true],
  ['wait', true], ['pillar_up', true], ['flee(threat)', false], ['return_to_base', false], ['explore_toward(surface)', false],
]
let ok = true
for (const [id, must] of plan) {
  const o = obs()
  if (id === 'flee(threat)') o.nearestHostile = { name: 'zombie', dist: 5, dir: 'west', dy: 0, pos: { x: o.pos.x - 5, y: o.pos.y, z: o.pos.z } }
  const r = await motor.run(id, o)
  const inv = Object.entries(o.inventory).map(([k, v]) => `${v} ${k}`).join(', ')
  log(`${id} -> ${r.result}${r.detail ? ` (${r.detail})` : ''}   [y ${o.pos.y.toFixed(0)}; had: ${inv || 'nothing'}]`)
  if (must && r.result !== 'ok') ok = false
}
const finalInv = Object.entries(obs().inventory).map(([k, v]) => `${v} ${k}`).join(', ')
log(`final inventory: ${finalInv}`)
log(ok ? 'PASS' : 'FAIL')
clearTimeout(deadline)
bot.quit()
await server.stop()
process.exit(ok ? 0 : 1)
