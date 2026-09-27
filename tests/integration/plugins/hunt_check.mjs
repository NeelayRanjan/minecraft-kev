// hunt(<mob>) arena check: a white sheep 6 m away with shears -> +n white_wool (shearing yields 1-3); the same sheep
// again -> not_found (a sheared sheep is skipped); a cow with an iron sword -> killed, leather or beef rose; a named cow
// -> not_found (never attack a named animal); no pig -> not_found. Also: hunt(white_wool) offers hunt(sheep) through
// the registry when a sheep is in sight.
// Usage: node tests/integration/plugins/hunt_check.mjs [--port 25574] [--seed plugins-hunt]. PASS/FAIL; exit 0 on PASS.
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const A = await startArena({ port: Number(args.port ?? 25574), seed: args.seed ?? 'plugins-hunt' })
const { X, Y, Z, cmd, step, check, motor, registry, obs, bot } = A
const mobs = name => Object.values(bot.entities).filter(e => e.name === name)
const killMobs = async () => { await cmd('/kill @e[type=!player]'); await bot.waitForTicks(20) }

// (a) a white sheep 6 m east, shears (the world's own animals removed first).
await killMobs(); await A.reset()
await cmd(`/give ${USER} shears 1`)
await cmd(`/summon sheep ${X + 6.5} ${Y} ${Z + 0.5} {Color:0b}`)
await bot.waitForTicks(20)
const offered = registry.optionsFor(obs(), { kind: 'hunt', arg: 'white_wool', count: 2 }).map(o => o.id)
check(offered.includes('hunt(sheep)'), `hunt(white_wool) offers hunt(sheep) (${offered.join(', ')})`)
let r = await step('hunt(sheep)')
const wool = motor.count('white_wool')
check(r.result === 'ok' && wool >= 1 && r.detail === `+${wool} white_wool`, `+n white_wool by shearing (${r.result} ${r.detail}, wool ${wool})`)
check(mobs('sheep').length === 1, 'the sheep is still alive')

// (b) the only sheep is sheared: not_found, and it is not attacked.
r = await step('hunt(sheep)')
check(r.result === 'not_found', `a sheared sheep is skipped (${r.result} ${r.detail})`)
check(mobs('sheep').length === 1, 'the sheared sheep is still alive')

// (c) a cow 6 m west, an iron sword: killed, leather or beef rose.
await killMobs(); await A.reset()
await cmd(`/give ${USER} iron_sword 1`)
await cmd(`/summon cow ${X - 5.5} ${Y} ${Z + 0.5}`)
await bot.waitForTicks(20)
r = await step('hunt(cow)')
const leather = motor.count('leather'), beef = motor.count('beef')
check(r.result === 'ok' && leather + beef >= 1, `killed a cow: leather or beef rose (${r.result} ${r.detail}; leather ${leather}, beef ${beef})`)
check(mobs('cow').length === 0, 'the cow is gone')

// (d) a named cow: never attacked.
await killMobs(); await A.reset()
await cmd(`/give ${USER} iron_sword 1`)
await cmd(`/summon cow ${X - 5.5} ${Y} ${Z + 0.5} {CustomName:'"Bessie"'}`)
await bot.waitForTicks(20)
r = await step('hunt(cow)')
check(r.result === 'not_found', `a named cow is not hunted (${r.result} ${r.detail})`)
check(mobs('cow').length === 1 && motor.count('beef') === 0, 'the named cow is alive')

// (e) no pig anywhere near.
await killMobs()
r = await step('hunt(pig)')
check(r.result === 'not_found', `no pig -> not_found (${r.result} ${r.detail})`)

await A.finish()
