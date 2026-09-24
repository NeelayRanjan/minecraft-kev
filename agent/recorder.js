// Low-rate first-person video recorder built on prismarine-viewer's headless internals: renders on a fixed timer
// (default 5 fps) instead of the stock headless() loop that renders as fast as it can, and pipes JPEG frames to ffmpeg.
// Frame k of the output corresponds to episode time k / fps (the recorder starts at the runner's t0).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

export function startRecorder(bot, { output, fps = 5, width = 448, height = 448, viewDistance = 4, log = () => {} }) {
  const { createCanvas } = require('node-canvas-webgl/lib')
  global.THREE = require('three')
  global.Worker = require('worker_threads').Worker
  const { WorldView, Viewer } = require('prismarine-viewer/viewer')
  const canvas = createCanvas(width, height)
  const renderer = new global.THREE.WebGLRenderer({ canvas })
  const viewer = new Viewer(renderer)
  if (!viewer.setVersion(bot.version)) throw new Error(`prismarine-viewer does not support ${bot.version}`)
  const updateEntity = viewer.updateEntity.bind(viewer)
  // The viewer only has meshes/textures for a subset of entities; anything else throws, sometimes asynchronously from
  // a texture load (a witch's splash potion crashed an episode). Render a whitelist of common mobs and players only.
  const RENDER = new Set(['player', 'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'husk', 'drowned', 'stray',
    'zombie_villager', 'pillager', 'cow', 'pig', 'sheep', 'chicken', 'horse', 'donkey', 'wolf', 'cat', 'ocelot', 'rabbit', 'squid', 'bat', 'villager', 'iron_golem', 'fox', 'goat', 'bee'])
  viewer.updateEntity = e => { if (!RENDER.has(e?.name)) return; try { updateEntity(e) } catch {} }
  const cam = () => { viewer.setFirstPersonCamera(bot.entity.position, bot.entity.yaw, bot.entity.pitch); worldView.updatePosition(bot.entity.position) }
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position)
  viewer.listen(worldView)
  worldView.init(bot.entity.position)
  worldView.listenToBot(bot)
  bot.on('move', cam)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output])
  ff.stderr.on('data', d => log(`ffmpeg: ${String(d).trim()}`))
  let frames = 0, busy = false
  const timer = setInterval(() => {
    if (busy || !ff.stdin.writable) return
    busy = true
    try {
      viewer.update()
      renderer.render(viewer.scene, viewer.camera)
      ff.stdin.write(canvas.toBuffer('image/jpeg', { quality: 0.8 }))
      frames++
    } catch (e) { log(`recorder: ${e.message}`) } finally { busy = false }
  }, 1000 / fps)
  log(`recording ${output} at ${fps} fps, ${width}x${height}`)
  return {
    frames: () => frames,
    stop: () => new Promise(resolve => {
      clearInterval(timer)
      bot.removeListener('move', cam)
      try { worldView.removeListenersFromBot(bot) } catch {}
      ff.once('close', code => { log(`recorder: ${frames} frames, ffmpeg exit ${code}`); resolve(frames) })
      ff.stdin.end()
    }),
  }
}
