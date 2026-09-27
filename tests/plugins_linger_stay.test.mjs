// linger(<name>) (go_to(player) on arrival) and stay(<player|here>) (item 19): stub-bot tests of the hold behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import linger, { holdAround } from '../agent/plugins/linger.mjs'

// A stub bot: goto() teleports to the goal's spot (records it); an item entity is picked up when the bot stands within 1 m.
function stubWorld({ me = new Vec3(0, 64, 0), items = [], players = {} } = {}) {
  const bot = { username: 'Kevin', entity: { position: me }, players, entities: {}, goals: [] }
  for (const [i, it] of items.entries()) bot.entities[100 + i] = { id: 100 + i, name: 'item', isValid: true, position: it.pos, getDroppedItem: () => ({ name: it.name }) }
  const motor = {
    bot, mem: {}, current: null, log() {}, check() {}, deadline: Date.now() + 60_000,
    async goto(g) {
      bot.goals.push(g)
      const r = Math.sqrt(g.rangeSq ?? 0)
      bot.entity.position = new Vec3(g.x + Math.min(r, 0.5), g.y, g.z)
      for (const [id, e] of Object.entries(bot.entities)) if (e.position.distanceTo(bot.entity.position) <= 1.2) { e.isValid = false; delete bot.entities[id]; motor.picked = (motor.picked || 0) + 1 }
    },
  }
  return { bot, motor }
}

test('linger: offered under go_to(player:<name>); holds near the player and picks up drops within 6 m', async () => {
  assert.deepEqual(linger.options({}, { kind: 'go_to', arg: 'player:Steve' }).map(o => o.arg), ['Steve'])
  assert.deepEqual(linger.options({}, { kind: 'go_to', arg: 'base' }), [])
  const { bot, motor } = stubWorld({ items: [{ name: 'redstone', pos: new Vec3(4, 64, 0) }, { name: 'dirt', pos: new Vec3(20, 64, 0) }],
    players: { Steve: { gamemode: 0, entity: { isValid: true, position: new Vec3(1, 64, 1) } } } })
  const r = await holdAround(motor, { center: () => bot.players.Steve.entity.position, keepM: 4, ms: 900 })
  assert.equal(r, null, 'ran out its time')
  assert.equal(motor.picked, 1, 'the drop 4 m away was picked up, not the one 20 m away')
  // the player walked 10 m off: the bot walks back within 2 m of them
  bot.players.Steve.entity.position = new Vec3(10, 64, 10)
  await holdAround(motor, { center: () => bot.players.Steve.entity.position, keepM: 4, ms: 600 })
  assert.ok(bot.entity.position.distanceTo(new Vec3(10, 64, 10)) <= 2, `back near the player (${bot.entity.position})`)
})
