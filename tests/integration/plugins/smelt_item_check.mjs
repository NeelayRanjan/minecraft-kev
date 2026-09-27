// smelt_item(<item>) arena check: 3 sand + 1 coal + a carried furnace -> 3 glass (the furnace is placed); then the
// legacy smelt(iron_ingot) through the shared Motor.smeltAny (2 raw iron + 1 coal -> 2 ingots); then charcoal from 3
// oak logs, the input doubling as fuel, in a fresh furnace (1 charcoal: 1 log is input, 1 log burns for 1.5 items).
// Usage: node tests/integration/plugins/smelt_item_check.mjs [--port 25572] [--seed plugins-smelt]. PASS/FAIL; exit 0 on PASS.
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const A = await startArena({ port: Number(args.port ?? 25572), seed: args.seed ?? 'plugins-smelt' })
const { cmd, step, check, motor, registry, obs, bot } = A

// (a) glass
await cmd(`/give ${USER} sand 3`); await cmd(`/give ${USER} coal 1`); await cmd(`/give ${USER} furnace 1`)
const offered = registry.optionsFor(obs(), { kind: 'smelt_item', arg: 'glass', count: 3 }).map(o => o.id)
check(offered.includes('smelt_item(glass)'), `smelt_item(glass) goal offers smelt_item(glass) (${offered.join(', ')})`)
let r = await step('smelt_item(glass)')
check(r.result === 'ok' && motor.count('glass') === 3 && motor.count('sand') === 0, `glass 3 (${r.result} ${r.detail}, glass ${motor.count('glass')}, sand ${motor.count('sand')})`)
check(!!bot.findBlock({ matching: A.mcData.blocksByName.furnace.id, maxDistance: 6 }) && motor.count('furnace') === 0, 'the carried furnace was placed')

// (b) the legacy smelt(iron_ingot), same furnace
await cmd(`/give ${USER} raw_iron 2`); await cmd(`/give ${USER} coal 1`)
r = await step('smelt(iron_ingot)')
check(r.result === 'ok' && r.detail === '+2 iron ingots' && motor.count('iron_ingot') === 2, `legacy smelt(iron_ingot): 2 ingots (${r.result} ${r.detail})`)

// (c) charcoal from logs that are also the only fuel, in a fresh furnace (the one above may still burn, or hold coal
// that went in while it was burning): 1 log smelted, 1 log burnt, 1 left.
const fb = bot.findBlock({ matching: A.mcData.blocksByName.furnace.id, maxDistance: 6 }).position
await cmd(`/setblock ${fb.x} ${fb.y} ${fb.z} air`); await cmd(`/setblock ${fb.x} ${fb.y} ${fb.z} furnace`); await cmd('/kill @e[type=item]')
await cmd(`/clear ${USER} coal`)
await cmd(`/give ${USER} oak_log 3`)
r = await step('smelt_item(charcoal)')
check(r.result === 'ok' && motor.count('charcoal') === 1 && motor.count('oak_log') === 1, `charcoal from logs as input and fuel: 1 charcoal, 1 log left (${r.result} ${r.detail}, charcoal ${motor.count('charcoal')}, logs ${motor.count('oak_log')})`)

// (d) nothing to smelt: no_materials
r = await step('smelt_item(glass)')
check(r.result === 'no_materials', `no sand: no_materials (${r.result})`)

await A.finish()
