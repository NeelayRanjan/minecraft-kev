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
