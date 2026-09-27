import test from 'node:test'
import assert from 'node:assert/strict'
import { renderProperties } from '../agent/server_ctl.js'

test('renderProperties overrides port and seed and keeps the rest', () => {
  const tpl = 'online-mode=false\nserver-port=25565\nlevel-seed=kev-smoke-1\nview-distance=8\n'
  const out = renderProperties(tpl, { port: 25570, seed: 'abc' })
  assert.match(out, /^server-port=25570$/m)
  assert.match(out, /^level-seed=abc$/m)
  assert.match(out, /^view-distance=8$/m)
  assert.match(out, /^online-mode=false$/m)
})

test('renderProperties appends a key the template lacks', () => {
  const out = renderProperties('online-mode=false\n', { port: 1, seed: 's' })
  assert.match(out, /^server-port=1$/m)
  assert.match(out, /^level-seed=s$/m)
})

// The whole system is called Kevin (kev is only the 0.8b decision model): --name sets the bot's username; the default
// stays kev_<port % 100>, so data generation and every existing script are unchanged.
import { botUsername } from '../agent/server_ctl.js'
test('botUsername: kev_<port % 100> by default; --name when it is a valid Minecraft name', () => {
  assert.equal(botUsername({ port: 25580 }), 'kev_80')
  assert.equal(botUsername({ port: 25595, name: null }), 'kev_95')
  assert.equal(botUsername({ port: 25580, name: 'Kevin' }), 'Kevin')
  for (const bad of ['Ke', 'x'.repeat(17), 'Kev in', 'Kévin', '']) assert.throws(() => botUsername({ port: 25580, name: bad }), /bad bot name/, bad)
})
