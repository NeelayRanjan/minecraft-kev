// dig_blueprint(<bp>) arena check: dig blueprints from agent/templates.js, held in a BlueprintBook set as
// motor.blueprints (the runner sets the same accessor), dug through Motor.run exactly as in play, one call after another
// until the book says finished. The dig sites are stone blocks filled with /fill north of the bot. Cases:
//   (a) a 3x3x2 room: dug fully
//   (b) a 12-block tunnel (two streamed segments) with one iron_ore and one coal_ore set into its walls: the tunnel dug,
//       both ores mined as a vein and their drops (raw_iron, coal) collected
//   (c) a 3x3x2 room with a lava source set beside one side: hit_liquid naming the lava, no cell next to the lava dug,
//       no lava anywhere but the source (nothing released into the dug area)
//   (d) stairs_down_to 10 levels below the start (two segments): dug, then the bot walks (no digging) up to the start,
//       down to the last step and back up
//   (e) the same over a 4-deep pocket under steps 3 and 4: floor blocks placed, the stairs complete, walked down
// Usage: node tests/integration/plugins/dig_check.mjs [--port 25577] [--seed plugins-dig] [--only a,b,...]
// PASS/FAIL; exit 0 on PASS.
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { startArena, argsOf, USER } from './arena.mjs'
import { BlueprintBook } from '../../../agent/blueprint_book.js'
import { makeBlueprint } from '../../../agent/templates.js'
import { diff } from '../../../agent/blueprints.js'

const { goals } = pathfinderPkg
const args = argsOf(process.argv)
const only = args.only ? new Set(String(args.only).split(',')) : null
const A = await startArena({ port: Number(args.port ?? 25577), seed: args.seed ?? 'plugins-dig', minutes: 25 })
const { X, Y, Z, cmd, check, motor, bot, log } = A

const book = new BlueprintBook()
motor.blueprints = book
const blockAt = p => bot.blockAt(new Vec3(p.x, p.y, p.z))
const run = name => !only || only.has(name)
const count = name => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

async function arena (fills) {
  await A.reset()
  for (const f of fills) await cmd(`/fill ${f}`)
  await cmd('/kill @e[type=item]')
  await cmd(`/tp ${USER} ${X + 0.5} ${Y} ${Z + 0.5}`); await bot.waitForTicks(20)
  await cmd(`/give ${USER} stone_pickaxe 1`)
}

async function digLoop (id, cap = 10) {
  let calls = 0, last = null
  while (calls < cap && !book.progress(id, blockAt).finished) {
    calls++
    last = await A.step(`dig_blueprint(${id})`)
    if (last.result === 'hit_liquid') break
  }
  return { calls, last, finished: !!book.progress(id, blockAt).finished }
}
function complete (id) {
  const d = diff(book.get(id), blockAt)
  return { ok: d.done === d.total, text: `${d.done}/${d.total} cells` }
}
async function walk (to, what) {
  motor.deadline = Date.now() + 60_000   // motor.walkTo checks the run deadline; no run is active here
  try { await motor.walkTo(new goals.GoalBlock(to.x, to.y, to.z)) } catch (e) { log(`walk ${what}: ${e?.name} ${e?.message}`) }
  const f = bot.entity.position.floored()
  return { ok: f.x === to.x && f.y === to.y && f.z === to.z, at: `${f.x} ${f.y} ${f.z}` }
}

// (a) a 3x3x2 room in a stone block north of the bot
if (run('a')) {
  log('--- (a) room 3x3x2')
  await arena([`${X - 4} ${Y} ${Z - 6} ${X + 4} ${Y + 3} ${Z - 1} stone`])
  const id = book.add(makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, { anchor: { x: X, y: Y, z: Z - 1 }, facing: 'north' }))
  const r = await digLoop(id)
  const c = complete(id)
  check(r.finished && c.ok, `(a) room dug in ${r.calls} calls (${c.text}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
}

// (b) a 12-block tunnel with an iron ore and a coal ore in its walls
if (run('b')) {
  log('--- (b) tunnel 12 with two ores in the walls')
  await arena([`${X - 3} ${Y - 1} ${Z - 16} ${X + 3} ${Y + 3} ${Z - 1} stone`])
  const iron = { x: X - 1, y: Y, z: Z - 5 }, coal = { x: X + 1, y: Y + 1, z: Z - 9 }
  await cmd(`/setblock ${iron.x} ${iron.y} ${iron.z} iron_ore`)
  await cmd(`/setblock ${coal.x} ${coal.y} ${coal.z} coal_ore`)
  const bp = makeBlueprint('tunnel', { len: 12, w: 1, h: 2 }, null, { anchor: { x: X, y: Y, z: Z - 1 }, facing: 'north' })
  const id = book.add(bp)
  const r = await digLoop(id)
  let dugAll = true
  for (let z = Z - 1; z >= Z - 12; z--) for (const y of [Y, Y + 1]) if (blockAt({ x: X, y, z })?.boundingBox === 'block') dugAll = false
  check(r.finished && dugAll, `(b) tunnel dug in ${r.calls} calls (segment ${(book.get(id).segment ?? 0) + 1} of ${book.get(id).segments}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const oresGone = blockAt(iron)?.name !== 'iron_ore' && blockAt(coal)?.name !== 'coal_ore'
  check(oresGone && count('raw_iron') >= 1 && count('coal') >= 1, `(b) both ores mined (${blockAt(iron)?.name}, ${blockAt(coal)?.name}) and collected (raw_iron ${count('raw_iron')}, coal ${count('coal')})`)
}

// (c) a room with a lava source beside its east side (middle row, feet level)
if (run('c')) {
  log('--- (c) room next to lava')
  await arena([`${X - 4} ${Y} ${Z - 6} ${X + 4} ${Y + 3} ${Z - 1} stone`])
  const lava = { x: X + 2, y: Y, z: Z - 2 }
  await cmd(`/setblock ${lava.x} ${lava.y} ${lava.z} lava`)
  await bot.waitForTicks(20)
  const bp = makeBlueprint('room', { w: 3, d: 3, h: 2 }, null, { anchor: { x: X, y: Y, z: Z - 1 }, facing: 'north' })
  const id = book.add(bp)
  const r = await digLoop(id, 4)
  await bot.waitForTicks(60)   // anything released would flow by now
  check(r.last?.result === 'hit_liquid' && (r.last.detail ?? '').startsWith(`${lava.x}, ${lava.y}, ${lava.z}`), `(c) hit_liquid naming the lava (${r.last?.result} ${r.last?.detail ?? ''})`)
  const nextTo = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => ({ x: lava.x + dx, y: lava.y + dy, z: lava.z + dz }))
  const opened = nextTo.filter(p => blockAt(p)?.boundingBox !== 'block').map(p => `${p.x},${p.y},${p.z} ${blockAt(p)?.name}`)
  check(opened.length === 0, `(c) no cell next to the lava dug (${opened.join(' ') || 'all solid'})`)
  const lavaCells = []
  for (let x = X - 4; x <= X + 4; x++) for (let y = Y - 1; y <= Y + 3; y++) for (let z = Z - 6; z <= Z; z++) if (blockAt({ x, y, z })?.name === 'lava') lavaCells.push(`${x},${y},${z}`)
  const d = diff(book.get(id), blockAt)
  check(lavaCells.length === 1 && lavaCells[0] === `${lava.x},${lava.y},${lava.z}` && d.done > 0, `(c) no lava released (lava at ${lavaCells.join(' ')}; room ${d.done}/${d.total} dug)`)
  await cmd(`/setblock ${lava.x} ${lava.y} ${lava.z} stone`)
}

// (d) stairs_down_to 10 levels below the start, then walked both ways
if (run('d')) {
  log('--- (d) stairs_down_to 10 levels below')
  await arena([`${X - 3} ${Y - 14} ${Z - 13} ${X + 3} ${Y + 3} ${Z - 1} stone`, `${X - 3} ${Y - 14} ${Z} ${X + 3} ${Y - 1} ${Z + 2} stone`])
  const start = { x: X, y: Y, z: Z }
  const bp = makeBlueprint('stairs_down_to', { y: Y - 10 }, null, { anchor: start, facing: 'north' })
  const id = book.add(bp)
  const r = await digLoop(id)
  const last = { x: X, y: Y - 10, z: Z - 10 }
  let dugAll = true
  for (let k = 1; k <= 10; k++) for (let dy = 0; dy < 3; dy++) if (blockAt({ x: X, y: Y - k + dy, z: Z - k })?.boundingBox === 'block') dugAll = false
  check(r.finished && dugAll && bp.segments === 2, `(d) stairs dug in ${r.calls} calls (segments ${bp.segments}; last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const up1 = await walk(start, 'up to the start')
  check(up1.ok, `(d) the bot walks up to the start (at ${up1.at})`)
  const down = await walk(last, 'down to the last step')
  check(down.ok && blockAt({ x: last.x, y: last.y - 1, z: last.z })?.boundingBox === 'block', `(d) the bot walks down to the last step (at ${down.at})`)
  const up2 = await walk(start, 'back up')
  check(up2.ok, `(d) and back up to the start (at ${up2.at})`)
}

// (e) stairs_down_to 10 levels below with a 4-deep pocket (a cave) under the floors of steps 3 and 4: floor blocks are
// placed from the held cobblestone, the stairs complete and the bot walks down to the last step (fix round 2)
if (run('e')) {
  log('--- (e) stairs_down_to over a 4-deep pocket')
  await arena([`${X - 3} ${Y - 14} ${Z - 13} ${X + 3} ${Y + 3} ${Z - 1} stone`, `${X - 3} ${Y - 14} ${Z} ${X + 3} ${Y - 1} ${Z + 2} stone`,
    `${X - 1} ${Y - 8} ${Z - 3} ${X + 1} ${Y - 4} ${Z - 3} air`, `${X - 1} ${Y - 9} ${Z - 4} ${X + 1} ${Y - 5} ${Z - 4} air`])
  await cmd(`/give ${USER} cobblestone 16`)
  const start = { x: X, y: Y, z: Z }
  const bp = makeBlueprint('stairs_down_to', { y: Y - 10 }, null, { anchor: start, facing: 'north' })
  const id = book.add(bp)
  const r = await digLoop(id)
  const floors = [{ x: X, y: Y - 4, z: Z - 3 }, { x: X, y: Y - 5, z: Z - 4 }]
  const bridged = floors.every(f => blockAt(f)?.boundingBox === 'block')
  check(r.finished && bridged, `(e) stairs over the pocket dug in ${r.calls} calls, floors ${floors.map(f => blockAt(f)?.name).join(' ')} (last ${r.last?.result} ${r.last?.detail ?? ''})`)
  const last = { x: X, y: Y - 10, z: Z - 10 }
  const down = await walk(last, 'down to the last step')
  check(down.ok, `(e) the bot walks down to the last step, the target level (at ${down.at})`)
}

await A.finish()
