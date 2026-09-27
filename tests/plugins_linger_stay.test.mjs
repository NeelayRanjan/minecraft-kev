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

import stay from '../agent/plugins/stay.mjs'
test('stay: offered under stay goals; here holds the bot\'s spot; a player\'s spot is where they stood, not where they go; pushed away, it walks back', async () => {
  assert.deepEqual(stay.options({}, { kind: 'stay', arg: 'player:Steve' }).map(o => o.arg), ['Steve'])
  assert.deepEqual(stay.options({}, { kind: 'stay', arg: 'here' }).map(o => o.arg), ['here'])
  assert.deepEqual(stay.options({}, { kind: 'go_to', arg: 'player:Steve' }), [])
  // here: the spot is the bot's position at the first run
  let { bot, motor } = stubWorld({ me: new Vec3(5, 64, 5) })
  motor.deadline = Date.now() + 1600
  let r = await stay.run(motor, 'here', { goalTop: { id: 7, kind: 'stay', arg: 'here' } })
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.deepEqual(motor.mem.staySpot, { goalId: 7, arg: 'here', pos: { x: 5, y: 64, z: 5 } })
  // pushed 8 m away (a fight, a knockback): the next run walks back to the spot
  bot.entity.position = new Vec3(13, 64, 5)
  motor.deadline = Date.now() + 1600
  r = await stay.run(motor, 'here', { goalTop: { id: 7, kind: 'stay', arg: 'here' } })
  assert.equal(r.result, 'ok')
  assert.ok(bot.entity.position.distanceTo(new Vec3(5, 64, 5)) <= 2, `back at the spot (${bot.entity.position})`)
  // a player: the spot is where Steve stood when the bot reached him; he walks off, the bot stays
  ;({ bot, motor } = stubWorld({ me: new Vec3(0, 64, 0), players: { Steve: { gamemode: 0, entity: { isValid: true, position: new Vec3(2, 64, 0) } } } }))
  bot.waitForTicks = async () => {}
  bot.on = () => {}; bot.removeListener = () => {}
  bot.pathfinder = { setGoal() {} }
  motor.deadline = Date.now() + 1600
  r = await stay.run(motor, 'Steve', { goalTop: { id: 9, kind: 'stay', arg: 'player:Steve' } })
  assert.equal(r.result, 'ok', JSON.stringify(r))
  assert.deepEqual(motor.mem.staySpot.pos, { x: 2, y: 64, z: 0 })
  bot.players.Steve.entity.position = new Vec3(30, 64, 30)
  motor.deadline = Date.now() + 1600
  await stay.run(motor, 'Steve', { goalTop: { id: 9, kind: 'stay', arg: 'player:Steve' } })
  assert.ok(bot.entity.position.distanceTo(new Vec3(2, 64, 0)) <= 3, 'did not follow Steve')
  // a new stay goal fixes a new spot
  motor.deadline = Date.now() + 1600
  await stay.run(motor, 'here', { goalTop: { id: 10, kind: 'stay', arg: 'here' } })
  assert.equal(motor.mem.staySpot.goalId, 10)
})

import protect, { threatNear } from '../agent/plugins/protect.mjs'
test('protect: offered under protect goals; threatNear takes the hostile nearest the player within 8 m, never a player or a passive mob', () => {
  assert.deepEqual(protect.options({}, { kind: 'protect', arg: 'player:Steve' }).map(o => o.arg), ['Steve'])
  assert.deepEqual(protect.options({}, { kind: 'stay', arg: 'player:Steve' }), [])
  const P = new Vec3(0, 64, 0)
  const ent = (id, name, type, x) => ({ id, name, type, isValid: true, position: new Vec3(x, 64, 0) })
  const entities = { 1: ent(1, 'player', 'player', 1), 2: ent(2, 'cow', 'animal', 2), 3: ent(3, 'skeleton', 'hostile', 6), 4: ent(4, 'zombie', 'hostile', 4), 5: ent(5, 'creeper', 'hostile', 12) }
  assert.equal(threatNear(entities, P).id, 4, 'the zombie 4 m away')
  delete entities[4]
  assert.equal(threatNear(entities, P).id, 3)
  delete entities[3]
  assert.equal(threatNear(entities, P), null, 'the creeper is 12 m away; the player and the cow never count')
})
test('protect: a run attacks the hostile next to the player and ends ok with the fight count', async () => {
  const { bot, motor } = stubWorld({ me: new Vec3(0, 64, 0), players: { Steve: { gamemode: 0, entity: { isValid: true, position: new Vec3(2, 64, 0) } } } })
  const zombie = { id: 50, name: 'zombie', type: 'hostile', isValid: true, position: new Vec3(5, 64, 0) }
  bot.entities[50] = zombie
  const attacked = []
  bot.pvp = { attack: e => { attacked.push(e.id); setTimeout(() => { e.isValid = false; delete bot.entities[50] }, 100) }, stop() {} }
  bot.pathfinder = { setGoal() {} }
  motor.deadline = Date.now() + 2500
  const r = await protect.run(motor, 'Steve')
  assert.deepEqual(attacked, [50])
  assert.equal(r.result, 'ok'); assert.equal(r.detail, 'fought 1 mob near Steve')
})
