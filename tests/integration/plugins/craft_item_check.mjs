// craft_item(<item>) arena check: 6 oak planks + a carried table -> 4 oak stairs (3x3: the table is placed); 4 iron
// ingots + 1 redstone -> a compass at that table; 1 plank -> an oak button in the 2x2 grid; a compass again with
// nothing -> no_materials.
// Usage: node tests/integration/plugins/craft_item_check.mjs [--port 25573] [--seed plugins-craft]. PASS/FAIL; exit 0 on PASS.
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const A = await startArena({ port: Number(args.port ?? 25573), seed: args.seed ?? 'plugins-craft' })
const { cmd, step, check, motor, registry, obs, bot } = A

// (a) oak stairs at a placed table
await cmd(`/give ${USER} oak_planks 6`); await cmd(`/give ${USER} crafting_table 1`)
const offered = registry.optionsFor(obs(), { kind: 'craft_item', arg: 'oak_stairs', count: 4 }).map(o => o.id)
check(offered.includes('craft_item(oak_stairs)'), `craft_item(oak_stairs) goal offers craft_item(oak_stairs) (${offered.join(', ')})`)
let r = await step('craft_item(oak_stairs)')
check(r.result === 'ok' && motor.count('oak_stairs') === 4 && motor.count('oak_planks') === 0, `oak_stairs 4 (${r.result} ${r.detail}, stairs ${motor.count('oak_stairs')})`)
check(!!bot.findBlock({ matching: A.mcData.blocksByName.crafting_table.id, maxDistance: 6 }) && motor.count('crafting_table') === 0, 'the carried table was placed')

// (b) compass
await cmd(`/give ${USER} iron_ingot 4`); await cmd(`/give ${USER} redstone 1`)
r = await step('craft_item(compass)')
check(r.result === 'ok' && motor.count('compass') === 1 && motor.count('iron_ingot') === 0, `compass (${r.result} ${r.detail})`)

// (c) a 2x2 recipe
await cmd(`/give ${USER} oak_planks 1`)
r = await step('craft_item(oak_button)')
check(r.result === 'ok' && motor.count('oak_button') === 1, `oak_button in the 2x2 grid (${r.result} ${r.detail})`)

// (d) nothing left
r = await step('craft_item(compass)')
check(r.result === 'no_materials', `no ingredients: no_materials (${r.result})`)

await A.finish()
