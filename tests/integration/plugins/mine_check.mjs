// mine(<block>) arena check: redstone ore 6 m away with an iron pickaxe -> +redstone; the same without a pickaxe ->
// needs_tool (the ore stays); a sand patch with an empty inventory -> +n sand by hand. Also: the option reaches a
// gather(redstone) goal through the registry.
// Usage: node tests/integration/plugins/mine_check.mjs [--port 25571] [--seed plugins-mine]. PASS/FAIL; exit 0 on PASS.
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const A = await startArena({ port: Number(args.port ?? 25571), seed: args.seed ?? 'plugins-mine' })
const { X, Y, Z, cmd, step, check, at, motor, registry, obs } = A

// (a) redstone ore at feet level 6 m east, an iron pickaxe.
await cmd(`/give ${USER} iron_pickaxe 1`)
await cmd(`/setblock ${X + 6} ${Y} ${Z} redstone_ore`)
const offered = registry.optionsFor(obs(), { kind: 'gather', arg: 'redstone', count: 2 }).map(o => o.id)
check(offered.includes('mine(redstone_ore)'), `gather(redstone) offers mine(redstone_ore) (${offered.join(', ')})`)
let r = await step('mine(redstone_ore)')
check(r.result === 'ok' && motor.count('redstone') >= 1, `+redstone with an iron pickaxe (${r.result}, redstone ${motor.count('redstone')})`)
check(at(X + 6, Y, Z) !== 'redstone_ore', 'the redstone ore is gone')

// (b) no pickaxe: needs_tool, nothing dug.
await A.reset()
await cmd(`/setblock ${X + 6} ${Y} ${Z} redstone_ore`)
check(!registry.optionsFor(obs(), { kind: 'gather', arg: 'redstone', count: 2 }).length, 'no mine option without an iron pickaxe')
r = await step('mine(redstone_ore)')
check(r.result === 'needs_tool' && r.detail === 'iron pickaxe', `needs_tool (iron pickaxe) without a pickaxe (${r.result} ${r.detail})`)
check(at(X + 6, Y, Z) === 'redstone_ore', 'the redstone ore is still there')

// (c) a 3x1x3 sand patch 3-5 m west, empty inventory: dug by hand.
await A.reset()
await cmd(`/fill ${X - 5} ${Y} ${Z - 1} ${X - 3} ${Y} ${Z + 1} sand`)
r = await step('mine(sand)')
const sand = motor.count('sand')
check(r.result === 'ok' && sand >= 1 && r.detail === `+${sand} sand`, `+n sand by hand (${r.result} ${r.detail}, sand ${sand})`)

await A.finish()
