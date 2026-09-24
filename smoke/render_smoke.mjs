// Headless render smoke test: set the time of day, record N first-person frames, report render speed.
// Usage: node smoke/render_smoke.mjs day|midnight [frames] [size]
// Writes out/render_<mode>.mp4. Requires node-canvas-webgl and ffmpeg. The bot must be op (server/ops.json).

import fs from 'node:fs'
import { createBot } from 'mineflayer'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('node-canvas-webgl') // registers the headless canvas before prismarine-viewer loads
const { headless } = require('prismarine-viewer')

const mode = process.argv[2] ?? 'day'
const frames = Number(process.argv[3] ?? 30)
const size = Number(process.argv[4] ?? 448)
fs.mkdirSync('out', { recursive: true })
const output = `out/render_${mode}.mp4`

const t0 = Date.now()
const log = (step, msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}: ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const bot = createBot({ host: '127.0.0.1', port: 25565, username: 'kev_render', version: '1.20.4', auth: 'offline' })
setTimeout(() => { log('FAIL', 'timeout after 120 s'); process.exit(1) }, 120_000)
bot.on('kicked', r => { log('FAIL', `kicked: ${JSON.stringify(r)}`); process.exit(1) })
bot.on('error', e => { log('FAIL', `error: ${e.message}`); process.exit(1) })
bot.on('message', m => { const s = m.toString(); if (s.includes('time') || s.includes('Unknown') || s.includes('permission')) log('chat', s) })

bot.once('spawn', async () => {
  log('spawn', `at ${bot.entity.position.floored()} time ${bot.time.timeOfDay}`)
  await bot.waitForChunksToLoad()
  bot.chat(`/time set ${mode}`)
  await sleep(2500)
  log('time', `timeOfDay now ${bot.time.timeOfDay} (day=1000, midnight=18000)`)
  // Look slightly down so the ground is in frame; pitch is radians, positive = down in mineflayer.
  await bot.look(bot.entity.yaw, 0.15, true)

  const tStart = Date.now()
  const client = headless(bot, { output, frames, width: size, height: size, viewDistance: 4 })
  if (!client) { log('FAIL', 'headless() returned false: viewer does not support this version'); process.exit(1) }
  client.on('close', code => {
    const dt = (Date.now() - tStart) / 1000
    log('render', `${frames} frames at ${size}x${size} in ${dt.toFixed(1)} s = ${(frames / dt).toFixed(1)} fps (includes world-mesh warmup); ffmpeg exit ${code}`)
    log(code === 0 ? 'PASS' : 'FAIL', output)
    bot.quit()
    setTimeout(() => process.exit(code === 0 ? 0 : 1), 300)
  })
})
