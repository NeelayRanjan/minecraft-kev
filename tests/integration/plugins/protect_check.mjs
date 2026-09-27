// protect(<name>) arena check (live retry session 2026-09-27: "there is a skeleton next to me" was refused), with a
// second Mineflayer bot `player_1` as the player (creative, so the zombie cannot hurt it): a zombie summoned 5 m from
// player_1 and a cow 3 m from it; the bot, 7 m away with an iron sword, runs protect(player_1). The zombie dies or is
// engaged (the bot attacked it), the cow is alive, the run ends ok. Also: the protect goal offers the option.
// Usage: node tests/integration/plugins/protect_check.mjs [--port 25597] [--seed plugins-protect]. PASS/FAIL; exit 0 on PASS.
import { createBot } from 'mineflayer'
import { startArena, argsOf, USER } from './arena.mjs'

const args = argsOf(process.argv)
const port = Number(args.port ?? 25597)
const A = await startArena({ port, seed: args.seed ?? 'plugins-protect' })
const { X, Y, Z, cmd, check, motor, registry, obs, bot, log } = A
const P = 'player_1'

const player = createBot({ host: '127.0.0.1', port, username: P, version: '1.20.4', auth: 'offline' })
player.on('error', e => log(`${P} error: ${e.message}`))
await new Promise(r => player.once('spawn', r))
await cmd(`/gamemode creative ${P}`)
await cmd(`/tp ${P} ${X + 0.5} ${Y} ${Z + 7.5}`)
await cmd(`/give ${USER} iron_sword 1`)
await bot.waitForTicks(40)

const offered = registry.optionsFor(obs(), { kind: 'protect', arg: `player:${P}`, count: null }).map(o => o.id)
check(offered.includes(`protect(${P})`), `protect(player:${P}) offers protect(${P}) (${offered.join(', ')})`)

await cmd('/difficulty easy')
await cmd(`/summon zombie ${X + 5.5} ${Y} ${Z + 7.5} {PersistenceRequired:1b,Tags:["guard_target"]}`)
await cmd(`/summon cow ${X - 2.5} ${Y} ${Z + 7.5} {PersistenceRequired:1b}`)
await bot.waitForTicks(20)
const zombie = () => Object.values(bot.entities).find(e => e.name === 'zombie')
const cow = () => Object.values(bot.entities).find(e => e.name === 'cow')
const z0 = zombie()
log(`zombie ${z0 ? `${z0.position.distanceTo(player.entity.position).toFixed(1)} m from ${P}` : 'not seen'}, cow ${cow() ? 'seen' : 'not seen'}`)
check(!!z0 && !!cow(), 'the zombie and the cow are there')

let attacked = 0
const origAttack = bot.pvp.attack.bind(bot.pvp)
bot.pvp.attack = e => { if (e?.name === 'zombie') attacked++; if (e?.name === 'cow' || e?.type === 'player') log(`  attacked ${e.name} (wrong target)`); return origAttack(e) }
const r = await motor.run(`protect(${P})`, { ...obs(), goalTop: { kind: 'protect', arg: `player:${P}` } })
log(`protect(${P}) -> ${r.result}${r.detail ? ` (${r.detail})` : ''}`)
await bot.waitForTicks(20)
const dead = !zombie()
check(dead || attacked > 0, `the zombie died or was engaged (dead ${dead}, attacks ${attacked})`)
check(r.result === 'ok' && /fought/.test(r.detail ?? ''), `the run ends ok with a fight (${r.result} ${r.detail})`)
check(!!cow(), 'the cow is alive (passive mobs are never attacked)')
await cmd('/kill @e[type=zombie]'); await cmd('/difficulty peaceful')

player.quit()
await A.finish()
