// go_to_player(<name>) and receive(<item>) arena check, with a second Mineflayer bot `player_1` as the player:
// player_1 12 m away -> go_to_player(player_1) ok (within 3 m); player_1 8 m away with 4 redstone, tossing them a few
// seconds into the run -> receive(redstone) with obs.goalTop { from: player_1, count: 4 } walks to it and ends ok (+4);
// player_1 in spectator mode -> go_to_player player_gone; player_1 quits -> go_to_player player_gone and receive
// player_gone. Also: go_to(player:player_1) and receive(redstone) goals offer the options through the registry.
// Usage: node tests/integration/plugins/player_check.mjs [--port 25575] [--seed plugins-player]. PASS/FAIL; exit 0 on PASS.
import { createBot } from 'mineflayer'
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const port = Number(args.port ?? 25575)
const A = await startArena({ port, seed: args.seed ?? 'plugins-player' })
const { X, Y, Z, cmd, step, check, motor, registry, obs, bot, log } = A
const P = 'player_1'

const player = createBot({ host: '127.0.0.1', port, username: P, version: '1.20.4', auth: 'offline' })
player.on('error', e => log(`${P} error: ${e.message}`))
await new Promise(r => player.once('spawn', r))
await cmd(`/gamemode survival ${P}`)
await cmd(`/tp ${P} ${X + 12.5} ${Y} ${Z + 0.5}`)
await bot.waitForTicks(40)
const dist = () => { const e = bot.players[P]?.entity; return e ? e.position.distanceTo(bot.entity.position) : Infinity }
log(`${P} joined, ${dist().toFixed(1)} m away`)

// Options through the registry.
const goOffered = registry.optionsFor(obs(), { kind: 'go_to', arg: `player:${P}`, count: 1 }).map(o => o.id)
check(goOffered.includes(`go_to_player(${P})`), `go_to(player:${P}) offers go_to_player(${P}) (${goOffered.join(', ')})`)
const rcvOffered = registry.optionsFor(obs(), { kind: 'receive', arg: 'redstone', count: 4, from: P }).map(o => o.id)
check(rcvOffered.includes('receive(redstone)'), `receive(redstone) offers receive(redstone) (${rcvOffered.join(', ')})`)

// (a) go_to_player: 12 m -> within 3 m.
let r = await step(`go_to_player(${P})`)
check(r.result === 'ok' && dist() <= 3.5, `go_to_player ok, within 3 m (${r.result} ${r.detail}, ${dist().toFixed(1)} m)`)

// (b) receive: player_1 8 m away with 4 redstone, tosses them toward the bot 6 s into the run.
await cmd(`/give ${P} redstone 4`)
await cmd(`/tp ${P} ${X - 7.5} ${Y} ${Z + 0.5}`)
await bot.waitForTicks(20)
const toss = setTimeout(async () => {
  try {
    await player.lookAt(bot.entity.position.offset(0, 1, 0), true)
    await player.toss(player.registry.itemsByName.redstone.id, null, 4)
    log(`${P} tossed 4 redstone (${dist().toFixed(1)} m away)`)
  } catch (e) { log(`${P} toss failed: ${e.message}`) }
}, 6000)
r = await motor.run('receive(redstone)', { ...obs(), goalTop: { kind: 'receive', arg: 'redstone', from: P, count: 4 } })
clearTimeout(toss)
log(`receive(redstone) -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
check(r.result === 'ok' && r.detail === '+4 redstone' && motor.count('redstone') === 4, `receive ok (+4) (${r.result} ${r.detail}, redstone ${motor.count('redstone')})`)

// (c) spectator: no entity for other clients -> player_gone.
await cmd(`/gamemode spectator ${P}`)
await cmd(`/tp ${P} ${X + 10.5} ${Y} ${Z + 0.5}`)
await bot.waitForTicks(20)
r = await step(`go_to_player(${P})`)
check(r.result === 'player_gone', `a spectator is player_gone (${r.result} ${r.detail})`)

// (d) player_1 quits: go_to_player and receive (no giver, nothing dropped) -> player_gone.
player.quit()
await bot.waitForTicks(40)
r = await step(`go_to_player(${P})`)
check(r.result === 'player_gone', `a player who left is player_gone (${r.result} ${r.detail})`)
r = await motor.run('receive(redstone)', { ...obs(), goalTop: { kind: 'receive', arg: 'redstone', from: P, count: 8 } })
log(`receive(redstone) -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
check(r.result === 'player_gone', `receive with the giver gone is player_gone (${r.result} ${r.detail})`)

await A.finish()
