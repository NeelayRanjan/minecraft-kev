// Low-rate first-person video recorder built on prismarine-viewer's headless internals: renders on its own cadence
// (default 5 fps) instead of the stock headless() loop that renders as fast as it can, and pipes JPEG frames to ffmpeg.
// Frame k of the output corresponds to episode time k / fps (the recorder starts at the runner's t0) -- by
// construction, not by luck: a separate writer clock writes exactly one frame per tick, duplicating the last
// encoded JPEG when a fresh render isn't ready, so the output never falls behind even if rendering is slow.
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
  // The viewer has meshes/textures for the entities in its entities.json (94 in 1.20.4); anything else throws, sometimes
  // asynchronously from a texture load (a witch's splash potion crashed an episode). Render every mob and player the
  // viewer knows, but no projectiles, vehicles or dropped things: those are the ones that crashed, and they carry no
  // information a leader needs. (2026-09-25: the user wants all mobs visible for the vision experiments.)
  const NOT_RENDERED = new Set(['arrow', 'boat', 'chest_minecart', 'command_block_minecart', 'hopper_minecart', 'minecart', 'tnt_minecart', 'dragon_fireball', 'fireball',
    'small_fireball', 'egg', 'ender_pearl', 'eye_of_ender', 'experience_bottle', 'experience_orb', 'firework_rocket', 'fishing_bobber', 'leash_knot', 'llama_spit',
    'potion', 'shulker_bullet', 'snowball', 'trident', 'wither_skull', 'evoker_fangs', 'armor_stand'])
  const RENDER = new Set(Object.keys(require('prismarine-viewer/viewer/lib/entity/entities.json')).filter(n => !NOT_RENDERED.has(n)))
  viewer.updateEntity = e => { if (!RENDER.has(e?.name)) return; try { updateEntity(e) } catch {} }
  const cam = () => { viewer.setFirstPersonCamera(bot.entity.position, bot.entity.yaw, bot.entity.pitch); worldView.updatePosition(bot.entity.position) }
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position)
  viewer.listen(worldView)
  worldView.init(bot.entity.position)
  worldView.listenToBot(bot)
  bot.on('move', cam)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output])
  ff.stderr.on('data', d => log(`ffmpeg: ${String(d).trim()}`))

  // lastJpeg is whatever the most recent successful render produced; a black frame before the first one lands, so
  // the writer clock below always has something legal to write even if rendering hasn't produced anything yet.
  let lastJpeg = createCanvas(width, height).toBuffer('image/jpeg', { quality: 0.8 })
  let renderBusy = false, rendered = 0
  const renderTimer = setInterval(() => {
    if (renderBusy) return
    renderBusy = true
    try {
      viewer.update()
      renderer.render(viewer.scene, viewer.camera)
      lastJpeg = canvas.toBuffer('image/jpeg', { quality: 0.8 })
      rendered++
    } catch (e) { log(`recorder: ${e.message}`) } finally { renderBusy = false }
  }, 1000 / fps)

  // Writer clock: decoupled from the render clock above, and drift-free (it targets episode time, not tick count),
  // so frame k always lands at k / fps even when a render was slow, threw, or never happened yet -- it just
  // re-writes lastJpeg, counted as a dupe whenever it's not the first write of a freshly rendered frame.
  const t0 = Date.now()
  let written = 0, dupes = 0, lastWritten = null
  const writeTimer = setInterval(() => {
    if (!ff.stdin.writable) return
    const target = Math.floor((Date.now() - t0) * fps / 1000)
    while (written <= target) {
      if (lastJpeg === lastWritten) dupes++
      lastWritten = lastJpeg
      ff.stdin.write(lastJpeg)
      written++
    }
  }, 1000 / fps)

  log(`recording ${output} at ${fps} fps, ${width}x${height}`)
  return {
    frames: () => written,
    stats: () => ({ written, rendered, dupes }),
    stop: () => new Promise(resolve => {
      clearInterval(renderTimer)
      clearInterval(writeTimer)
      bot.removeListener('move', cam)
      try { worldView.removeListenersFromBot(bot) } catch {}
      ff.once('close', code => { log(`recorder: ${written} frames (${rendered} rendered, ${dupes} dupes), ffmpeg exit ${code}`); resolve(written) })
      ff.stdin.end()
    }),
  }
}
