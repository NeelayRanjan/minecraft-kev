import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginRegistry, appendRequestLog } from '../agent/plugins.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ctx = { check() {} }   // a Motor run context that was never interrupted

function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mckev-plugins-'))
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f))
  for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), src)
  return dir
}
// Write a file and push its mtime forward so the cache-busting import sees a new version even on coarse timestamps.
let bump = 0
function writeNewer(file, src) {
  fs.writeFileSync(file, src)
  const t = new Date(Date.now() + 10_000 + (++bump) * 1000)
  fs.utimesSync(file, t, t)
}
async function until(fn, ms = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50) }
  return false
}
const plugin = (id, body) => `export default { id: '${id}', timeout: 3, options: () => [{ arg: 'a' }], preconditions: () => true, async run(motor, arg) { ${body} } }\n`

test('load() loads echo.mjs and reports broken.mjs failed with its error', async () => {
  const reg = new PluginRegistry({ dir: FIXTURES })
  const r = await reg.load()
  assert.deepEqual(r.loaded, ['echo'])
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0].file, /broken\.mjs$/)
  assert.match(r.failed[0].error, /broken on purpose/)
  assert.deepEqual(reg.list(), [{ id: 'echo', timeout: 2, enabled: true, error: null }])
})

test('get() runs a loaded plugin; unknown names are null', async () => {
  const reg = new PluginRegistry({ dir: FIXTURES })
  await reg.load()
  assert.deepEqual(await reg.get('echo').run(ctx, 'x', {}), { result: 'ok', detail: 'x' })
  assert.equal(reg.get('echo').timeout, 2)
  assert.equal(reg.get('nope'), null)
})

test('a file whose default export lacks id or run fails with a short reason', async () => {
  const dir = tempDir({ 'noid.mjs': 'export default { run: async () => ({ result: "ok" }) }\n', 'norun.mjs': 'export default { id: "norun" }\n' })
  const reg = new PluginRegistry({ dir })
  const r = await reg.load()
  assert.deepEqual(r.loaded, ['echo'])
  const errs = Object.fromEntries(r.failed.map(f => [path.basename(f.file), f.error]))
  assert.match(errs['noid.mjs'], /id/)
  assert.match(errs['norun.mjs'], /run/)
  assert.equal(reg.get('norun'), null)
})

test('a directory with only README.md loads nothing and fails nothing; a missing directory never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mckev-plugins-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# contract\n')
  assert.deepEqual(await new PluginRegistry({ dir }).load(), { loaded: [], failed: [] })
  const r = await new PluginRegistry({ dir: path.join(dir, 'absent') }).load()
  assert.deepEqual(r.loaded, [])
})

test('the shipped agent/plugins directory loads without failures', async () => {
  const dir = path.join(path.dirname(FIXTURES), '..', '..', 'agent', 'plugins')
  const r = await new PluginRegistry({ dir }).load()
  assert.deepEqual(r.failed, [])
})

test('optionsFor offers echo(a) only when the preconditions hold', async () => {
  const reg = new PluginRegistry({ dir: FIXTURES })
  await reg.load()
  assert.deepEqual(reg.optionsFor({ echoReady: false }, null), [])
  assert.deepEqual(reg.optionsFor({ echoReady: true }, null), [{ id: 'echo(a)', name: 'echo', arg: 'a', desc: 'echo a' }])
  assert.deepEqual(reg.optionsFor({ echoReady: true, echoArgs: ['a', 'b'] }, { kind: 'gather', arg: 'x', count: 1 }).map(o => o.id), ['echo(a)', 'echo(b)'])
})

test('optionsFor skips a plugin whose options() or preconditions() throws, and counts it', async () => {
  const dir = tempDir({ 'badopts.mjs': 'export default { id: "badopts", options() { throw new Error("x") }, preconditions: () => true, async run() { return { result: "ok" } } }\n' })
  const reg = new PluginRegistry({ dir })
  await reg.load()
  for (let i = 0; i < 3; i++) assert.deepEqual(reg.optionsFor({ echoReady: true }, null).map(o => o.id), ['echo(a)'])
  assert.equal(reg.enabled('badopts'), false)
  assert.equal(reg.enabled('echo'), true)
})

test('editing a plugin file while watched swaps its run function; the old reference keeps the old code', async () => {
  const dir = tempDir()
  const reg = new PluginRegistry({ dir })
  await reg.load()
  const old = reg.get('echo')
  reg.watch()
  try {
    writeNewer(path.join(dir, 'echo.mjs'), `export default { id: 'echo', timeout: 7, options: () => [], preconditions: () => true, async run(motor, arg) { return { result: 'ok', detail: 'v2:' + arg } } }\n`)
    assert.ok(await until(async () => (await reg.get('echo')?.run(ctx, 'x', {}))?.detail === 'v2:x'), 'the new version was never loaded')
    assert.equal(reg.get('echo').timeout, 7)
    assert.equal((await old.run(ctx, 'x', {})).detail, 'x')   // an in-flight holder keeps what it started with
  } finally { reg.unwatch() }
})

test('a deleted plugin file removes its plugin; a new file adds one', async () => {
  const dir = tempDir()
  const reg = new PluginRegistry({ dir })
  await reg.load()
  reg.watch()
  try {
    fs.rmSync(path.join(dir, 'echo.mjs'))
    assert.ok(await until(() => reg.get('echo') === null), 'echo was not removed')
    writeNewer(path.join(dir, 'fresh.mjs'), plugin('fresh', `return { result: 'ok', detail: arg }`))
    assert.ok(await until(() => reg.get('fresh') !== null), 'fresh was not added')
  } finally { reg.unwatch() }
})

test('three throws in a row disable a plugin until its file changes; a clean run resets the count', async () => {
  const dir = tempDir({ 'thrower.mjs': plugin('thrower', `if (arg === 'ok') return { result: 'failed', detail: 'typed' }; throw new Error('bug ' + arg)`) })
  const reg = new PluginRegistry({ dir })
  await reg.load()
  const boom = async arg => { await assert.rejects(reg.get('thrower').run(ctx, arg, {}), /bug/) }
  await boom('1'); await boom('2')
  assert.equal((await reg.get('thrower').run(ctx, 'ok', {})).detail, 'typed')   // a typed fail is not a throw, and resets
  await boom('3'); await boom('4')
  assert.equal(reg.enabled('thrower'), true)
  await boom('5')
  assert.equal(reg.enabled('thrower'), false)
  assert.equal(reg.get('thrower'), null)
  assert.deepEqual(reg.optionsFor({}, null).map(o => o.id), [])
  const row = reg.list().find(p => p.id === 'thrower')
  assert.equal(row.enabled, false); assert.match(row.error, /bug 5/)
  assert.equal((await reg.load()).loaded.includes('thrower'), false)   // an unchanged file stays disabled
  reg.watch()
  try {
    writeNewer(path.join(dir, 'thrower.mjs'), plugin('thrower', `return { result: 'ok', detail: 'fixed' }`))
    assert.ok(await until(() => reg.enabled('thrower')), 'a file change did not re-enable the plugin')
    assert.equal((await reg.get('thrower').run(ctx, 'x', {})).detail, 'fixed')
  } finally { reg.unwatch() }
})

test('a throw from an abandoned run (its context check() throws: timeout, interrupt, superseded) is not counted', async () => {
  const dir = tempDir({ 'thrower.mjs': plugin('thrower', `throw new Error('GoalChanged')`) })
  const reg = new PluginRegistry({ dir })
  await reg.load()
  const abandoned = { check() { throw new Error('interrupted') } }
  for (let i = 0; i < 4; i++) await assert.rejects(reg.get('thrower').run(abandoned, 'a', {}))
  assert.equal(reg.enabled('thrower'), true)
})

test('disable(id, error) and enabled(id)', async () => {
  const reg = new PluginRegistry({ dir: FIXTURES })
  await reg.load()
  reg.disable('echo', 'by hand')
  assert.equal(reg.enabled('echo'), false)
  assert.equal(reg.get('echo'), null)
  assert.equal(reg.list()[0].error, 'by hand')
  assert.equal(reg.enabled('nope'), false)
})

test('appendRequestLog appends JSON lines, creates the file, and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mckev-reqlog-'))
  const file = path.join(dir, 'sub', 'requests.jsonl')
  appendRequestLog(file, { t: 1, name: 'alex', text: 'build a boat', missing: ['boat'] })
  appendRequestLog(file, { t: 2, name: 'alex', text: 'fly', missing: null })
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(r => r.t), [1, 2])
  assert.deepEqual(rows[0].missing, ['boat'])
  assert.doesNotThrow(() => appendRequestLog(dir, { t: 3 }))   // a directory: logged, not thrown
})
