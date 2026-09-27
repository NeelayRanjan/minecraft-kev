// build_blueprint(<bp>) arena check: blueprints from agent/templates.js, held in a BlueprintBook set as
// motor.blueprints (the runner sets the same accessor), built through Motor.run exactly as in play, one call after
// another (at most 25) until the book says finished. Cases:
//   (a) a 5x5x3 cobblestone hut on flat ground (80 cobblestone + 20 dirt): complete, no scaffold left
//   (b) the same where the ground under the far two rows drops by one: foundation placed, complete, no scaffold left
//   (c) a fresh hut interrupted (motor.interrupt) after ~15 placements, then resumed to complete
//   (d) staircase_up(6): built, then the bot walks (no digging, no towers) from the anchor onto the top step
//   (e) staircase_down(5) from the top of a 6-high pillar: built from the top, then the bot walks down to the lowest step
//   (f) a 9-high pillar: the top cells need a scaffold column, which is dug away afterwards
// Usage: node tests/integration/plugins/build_check.mjs [--port 25576] [--seed plugins-build] [--only a,b,...]
// PASS/FAIL; exit 0 on PASS.
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { startArena, argsOf, USER } from './arena.mjs'
import { BlueprintBook } from '../../../agent/blueprint_book.js'
import { makeBlueprint } from '../../../agent/templates.js'
import { diff, foundation } from '../../../agent/blueprints.js'

const { goals } = pathfinderPkg
const args = argsOf(process.argv)
const only = args.only ? new Set(String(args.only).split(',')) : null
const A = await startArena({ port: Number(args.port ?? 25576), seed: args.seed ?? 'plugins-build', minutes: 30 })
const { X, Y, Z, cmd, check, motor, obs, bot, log, mem } = A

const book = new BlueprintBook()
motor.blueprints = book
const blockAt = p => bot.blockAt(new Vec3(p.x, p.y, p.z))
const k = p => `${p.x},${p.y},${p.z}`

// Count the scaffold blocks the motor places (its log line), per blueprint.
const scaffoldPlaced = new Map()
const baseLog = motor.log
motor.log = s => {
  const m = /^scaffold: placed \w+ at (-?\d+,-?\d+,-?\d+) for (bp\d+)$/.exec(s)
  if (m) { if (!scaffoldPlaced.has(m[2])) scaffoldPlaced.set(m[2], new Set()); scaffoldPlaced.get(m[2]).add(m[1]) }
  baseLog(s)
}

async function arena () {
  await A.reset()
  await cmd(`/fill ${X - 12} ${Y + 5} ${Z - 12} ${X + 12} ${Y + 14} ${Z + 12} air`)
  await cmd(`/kill @e[type=item]`)
}

async function buildLoop (id, cap = 25) {
  let calls = 0, last = null
  while (calls < cap && !book.progress(id, blockAt).finished) {
    calls++
    last = await A.step(`build_blueprint(${id})`)
  }
  return { calls, last, finished: !!book.progress(id, blockAt).finished }
}

// Every scaffold position the motor placed for `id` is gone (air or anything but dirt/cobblestone), and its memory is empty.
function scaffoldGone (id) {
  const left = [...(scaffoldPlaced.get(id) ?? [])].map(s => s.split(',').map(Number)).filter(([x, y, z]) => ['dirt', 'cobblestone'].includes(blockAt({ x, y, z })?.name))
  return left.length === 0 && !(mem.scaffold?.[id]?.length)
}
// No dirt anywhere around the build (the arena is stone and air; dirt is only ever scaffold here).
function dirtAround (bp) {
  const n = []
  for (let x = X - 12; x <= X + 12; x++) for (let y = Y - 1; y <= Y + 14; y++) for (let z = Z - 12; z <= Z + 12; z++) {
    if (blockAt({ x, y, z })?.name === 'dirt') n.push(k({ x, y, z }))
  }
  return n
}
function complete (id) {
  const d = diff(book.get(id), blockAt)
  return { ok: d.done === d.total, text: `${d.done}/${d.total} cells` }
}
const hut = anchor => makeBlueprint('hut', { w: 5, d: 5, h: 3 }, 'cobblestone', { anchor, facing: 'north' })
const anchorHere = () => ({ x: X, y: Y, z: Z })
const run = name => !only || only.has(name)

// (a) flat hut
if (run('a')) {
  log('--- (a) a 5x5x3 hut on flat ground')
  await arena()
  await cmd(`/give ${USER} cobblestone 80`); await cmd(`/give ${USER} dirt 20`)
  const id = book.add(hut(anchorHere()))
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(a) hut complete in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const dirt = dirtAround()
  check(scaffoldGone(id) && dirt.length === 0, `(a) no scaffold left (placed ${scaffoldPlaced.get(id)?.size ?? 0}; dirt ${dirt.join(' ') || 'none'})`)
}

// (b) the far two rows of the hut over ground one block lower: foundation blocks under them
if (run('b')) {
  log('--- (b) a hut on a 1-block drop')
  await arena()
  // hut rows 0..4 lie at z = Z-2 .. Z-6; rows 3-4 (z <= Z-5) and beyond: the top ground layer removed
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z - 5} air`)
  await cmd(`/give ${USER} cobblestone 80`); await cmd(`/give ${USER} dirt 20`)
  const bp = hut(anchorHere())
  const found = foundation(bp, blockAt)
  log(`(b) ${found.length} foundation cells`)
  const id = book.add(bp)
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(b) hut on the drop complete in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const placedF = found.filter(f => blockAt(f)?.name === 'cobblestone').length
  check(found.length > 0 && placedF === found.length, `(b) foundation placed (${placedF} of ${found.length})`)
  const dirt = dirtAround()
  check(scaffoldGone(id) && dirt.length === 0, `(b) no scaffold left (placed ${scaffoldPlaced.get(id)?.size ?? 0}; dirt ${dirt.join(' ') || 'none'})`)
}

// (c) interrupted after ~15 placements, then resumed
if (run('c')) {
  log('--- (c) a hut interrupted, then resumed')
  await arena()
  await cmd(`/give ${USER} cobblestone 80`); await cmd(`/give ${USER} dirt 20`)
  const id = book.add(hut(anchorHere()))
  const d0 = diff(book.get(id), blockAt).done
  const running = motor.run(`build_blueprint(${id})`, obs())
  let placedAtInterrupt = null
  const poll = setInterval(() => {
    const n = diff(book.get(id), blockAt).done - d0
    if (n >= 15 && placedAtInterrupt == null) { placedAtInterrupt = n; motor.interrupt('test') }
  }, 100)
  const r0 = await running
  clearInterval(poll)
  log(`build_blueprint(${id}) -> ${r0.result}${r0.detail ? ` (${r0.detail})` : ''} after ${placedAtInterrupt} placements`)
  const mid = diff(book.get(id), blockAt)
  check(r0.result === 'interrupted' && placedAtInterrupt != null && mid.done < mid.total, `(c) interrupted mid-build (${r0.result}, ${mid.done}/${mid.total})`)
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(c) resumed to complete in ${r.calls} more calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  check(scaffoldGone(id) && dirtAround().length === 0, '(c) no scaffold left')
}

// (d) staircase_up(6), then walked up
if (run('d')) {
  log('--- (d) staircase_up(6)')
  await arena()
  await cmd(`/give ${USER} cobblestone 40`); await cmd(`/give ${USER} dirt 20`)
  const bp = makeBlueprint('staircase_up', { height: 6, width: 1 }, 'cobblestone', { anchor: anchorHere(), facing: 'north' })
  const id = book.add(bp)
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(d) staircase_up complete in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  check(scaffoldGone(id) && dirtAround().length === 0, '(d) no scaffold left')
  // the top step: row 5, layer 5 (offset 2 -> z = Z - 7, y = Y + 5); stand on it
  const top = { x: X, y: Y + 5, z: Z - 7 }
  await cmd(`/tp ${USER} ${X + 0.5} ${Y} ${Z + 0.5}`); await bot.waitForTicks(20)
  let walked = false
  try { await motor.walkTo(new goals.GoalBlock(top.x, top.y + 1, top.z)); walked = true } catch (e) { log(`walk up: ${e?.name} ${e?.message}`) }
  const f = bot.entity.position.floored()
  check(walked && blockAt(top)?.name === 'cobblestone' && f.x === top.x && f.y === top.y + 1 && f.z === top.z, `(d) the bot walks up onto the top step (at ${f})`)
}

// (e) staircase_down(5) from a 6-high pillar top, then walked down
if (run('e')) {
  log('--- (e) staircase_down(5) from a pillar top')
  await arena()
  await cmd(`/fill ${X} ${Y} ${Z} ${X} ${Y + 5} ${Z} stone`)
  await cmd(`/tp ${USER} ${X + 0.5} ${Y + 6} ${Z + 0.5}`); await bot.waitForTicks(30)
  await cmd(`/give ${USER} cobblestone 40`); await cmd(`/give ${USER} dirt 20`)
  const anchor = { x: X, y: Y + 6, z: Z }
  const bp = makeBlueprint('staircase_down', { depth: 5, width: 1 }, 'cobblestone', { anchor, facing: 'north' })
  const id = book.add(bp)
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(e) staircase_down complete in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  check(scaffoldGone(id) && dirtAround().length === 0, '(e) no scaffold left')
  // the lowest step: row 5, layer -5 (offset 0 -> z = Z - 5, y = Y + 1); from the pillar top, walk down onto it
  const low = { x: X, y: Y + 1, z: Z - 5 }
  await cmd(`/tp ${USER} ${X + 0.5} ${Y + 6} ${Z + 0.5}`); await bot.waitForTicks(30)
  let walked = false
  try { await motor.walkTo(new goals.GoalBlock(low.x, low.y + 1, low.z)); walked = true } catch (e) { log(`walk down: ${e?.name} ${e?.message}`) }
  const f = bot.entity.position.floored()
  check(walked && blockAt(low)?.name === 'cobblestone' && f.x === low.x && f.y === low.y + 1 && f.z === low.z, `(e) the bot walks down to the lowest step (at ${f})`)
}

// (f) a 9-high pillar: scaffolding for the top cells, removed afterwards
if (run('f')) {
  log('--- (f) a 9-high pillar (scaffold)')
  await arena()
  await cmd(`/give ${USER} cobblestone 20`); await cmd(`/give ${USER} dirt 20`)
  const id = book.add(makeBlueprint('pillar', { h: 9 }, 'cobblestone', { anchor: anchorHere(), facing: 'north' }))
  const r = await buildLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(f) pillar complete in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const used = scaffoldPlaced.get(id)?.size ?? 0
  const dirt = dirtAround()
  check(used > 0 && scaffoldGone(id) && dirt.length === 0, `(f) scaffold used (${used} blocks) and removed (dirt ${dirt.join(' ') || 'none'})`)
}

await A.finish()
