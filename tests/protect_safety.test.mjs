import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import protect, { threatNear, creeperNear, protectDecision, PROTECT_MIN_HEALTH, CREEPER_KEEP_M } from '../agent/plugins/protect.mjs'
import { goalGuard } from '../agent/policy.js'

// Final review, Important 6: protect melee-attacked creepers, fought at any health, and the goal guard forced it at 3 hp.
const ent = (id, name, x, z, type = 'hostile') => ({ id, name, type, position: new Vec3(x, 64, z), isValid: true })

test('threatNear never returns a creeper; creeperNear finds the nearest one', () => {
  const center = new Vec3(0, 64, 0)
  assert.equal(threatNear({ 1: ent(1, 'creeper', 2, 0) }, center), null)
  assert.equal(threatNear({ 1: ent(1, 'creeper', 1, 0), 2: ent(2, 'zombie', 5, 0) }, center).name, 'zombie')
  assert.equal(creeperNear({ 1: ent(1, 'creeper', 3, 0), 2: ent(2, 'zombie', 1, 0) }, center).name, 'creeper')
  assert.equal(creeperNear({ 2: ent(2, 'zombie', 1, 0) }, center), null)
})

test('protectDecision: attack a hostile only above PROTECT_MIN_HEALTH; keep away from a creeper on the player\'s side', () => {
  assert.equal(PROTECT_MIN_HEALTH, 8)
  assert.equal(CREEPER_KEEP_M, 6)
  const player = new Vec3(0, 64, 0), bot = new Vec3(2, 64, 0)
  const zombie = ent(2, 'zombie', 4, 0), creeper = ent(3, 'creeper', 3, 0)
  assert.equal(protectDecision({ health: 20, food: 20, hasFood: false, bot, player, hostile: zombie }).act, 'attack')
  assert.equal(protectDecision({ health: 9, food: 20, hasFood: false, bot, player, hostile: zombie }).act, 'attack')
  // at 8 hp or less: never engage; eat when it can (food below 20 and something to eat), else retreat past the player
  assert.equal(protectDecision({ health: 8, food: 15, hasFood: true, bot, player, hostile: zombie }).act, 'eat')
  const r = protectDecision({ health: 8, food: 20, hasFood: true, bot, player, hostile: zombie })
  assert.equal(r.act, 'retreat')
  assert.ok(r.to.x < player.x, `the far side of the player from the zombie (${r.to.x})`)
  assert.equal(protectDecision({ health: 3, food: 5, hasFood: false, bot, player, hostile: zombie }).act, 'retreat')
  // a creeper: never attacked; close to the bot -> move to the player's far side from it; farther -> just follow
  const c = protectDecision({ health: 20, food: 20, hasFood: false, bot, player, hostile: null, creeper })
  assert.equal(c.act, 'retreat')
  assert.ok(c.to.x < player.x, `away from the creeper past the player (${c.to.x})`)
  assert.ok(c.to.distanceTo(creeper.position) >= CREEPER_KEEP_M + 2 - 1e-9, `the spot is out of the creeper's reach (${c.to.distanceTo(creeper.position)})`)
  assert.equal(protectDecision({ health: 20, food: 20, hasFood: false, bot: new Vec3(-8, 64, 0), player, hostile: null, creeper: ent(3, 'creeper', 6, 0) }).act, 'follow')
  // a creeper close and a zombie: the creeper wins (no melee next to a creeper)
  assert.equal(protectDecision({ health: 20, food: 20, hasFood: false, bot, player, hostile: zombie, creeper }).act, 'retreat')
  assert.equal(protectDecision({ health: 20, food: 20, hasFood: false, bot, player, hostile: null, creeper: null }).act, 'follow')
})

test('protect is not offered at 8 hp or less (preconditions)', () => {
  assert.equal(protect.preconditions({ health: 20 }, 'Steve'), true)
  assert.equal(protect.preconditions({ health: 9 }, 'Steve'), true)
  assert.equal(protect.preconditions({ health: 8 }, 'Steve'), false)
  assert.equal(protect.preconditions({ health: 3 }, 'Steve'), false)
})

test('goalGuard never forces protect or hunt at 8 hp or less; other plugin picks are still guarded', () => {
  const plugins = new Set(['protect', 'hunt', 'build_blueprint'])
  const offered = ['protect(Steve)', 'hunt(cow)', 'build_blueprint(bp1)', 'wait', 'eat']
  const g = (teacherPick, health) => goalGuard({ kevPick: 'wait', teacherPick, offered, depth: 1, plugins, health })
  assert.equal(g('protect(Steve)', 20), 'protect(Steve)')
  assert.equal(g('protect(Steve)', 8), null)
  assert.equal(g('protect(Steve)', 3), null)
  assert.equal(g('hunt(cow)', 5), null)
  assert.equal(g('build_blueprint(bp1)', 5), 'build_blueprint(bp1)')
  assert.equal(g('protect(Steve)', undefined), 'protect(Steve)', 'health unknown: as before')
})
