import test from 'node:test'
import assert from 'node:assert/strict'
import { startStatusServer } from '../agent/status_page.js'

test('status page: /state.json returns getState(), / returns the HTML that polls it, unknown paths 404', async () => {
  const state = { t: 12, plans: [{ id: 1, title: 'compass', steps: [] }], stack: { text: 'x', pushed: [] }, chat: [{ t: 3, name: 'Steve', text: 'hi' }] }
  const srv = await startStatusServer({ port: 0, getState: () => state })
  try {
    assert.ok(srv.port > 0)
    const r = await fetch(`http://127.0.0.1:${srv.port}/state.json`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /application\/json/)
    assert.deepEqual(await r.json(), state)
    const h = await fetch(`http://127.0.0.1:${srv.port}/`)
    assert.equal(h.status, 200)
    assert.match(h.headers.get('content-type'), /text\/html/)
    const html = await h.text()
    assert.match(html, /state\.json/)
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/, 'no external resources')
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status, 404)
  } finally { await srv.close() }
})

test('status page: a getState that throws answers 500, the server keeps serving', async () => {
  let n = 0
  const srv = await startStatusServer({ port: 0, getState: () => { if (n++ === 0) throw new Error('boom'); return { ok: 1 } } })
  try {
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/state.json`)).status, 500)
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${srv.port}/state.json`)).json(), { ok: 1 })
  } finally { await srv.close() }
})

test('status page: a taken port rejects (the runner logs it and goes on)', async () => {
  const a = await startStatusServer({ port: 0, getState: () => ({}) })
  try { await assert.rejects(startStatusServer({ port: a.port, getState: () => ({}) })) } finally { await a.close() }
})

// The blueprint grid (agent/blueprint_plans.js blueprintGrid) as the page renders it: the same function runs in the
// page (embedded by its source) and here.
import { gridHtml } from '../agent/status_page.js'
const escT = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
test('status page: the blueprint grid, one small table per layer (top layer first), a class per cell state, the legend', () => {
  assert.equal(gridHtml(null, escT), '<span class="dim">no blueprint</span>')
  const g = { id: 'bp1', title: 'hut <5x5x3>', kind: 'build', segment: 1, segments: 1, progress: 'layer 1 of 2, 3 of 8 blocks',
    layers: [{ layer: 1, rows: ['#o', 'x!'] }, { layer: 2, rows: ['s.', '_ '] }] }
  const h = gridHtml(g, escT)
  assert.match(h, /hut &lt;5x5x3&gt;/)
  assert.match(h, /layer 1 of 2, 3 of 8 blocks/)
  assert.ok(h.indexOf('layer 2</div>') < h.indexOf('layer 1</div>'), 'top layer first')
  const cellsOf = s => [...s.matchAll(/<td class="c-(\w+)"/g)].map(m => m[1])
  const l1 = h.slice(h.indexOf('layer 1</div>'))
  assert.deepEqual(cellsOf(l1).slice(0, 4), ['placed', 'missing', 'wrong', 'blocked'])
  const l2 = h.slice(h.indexOf('layer 2</div>'), h.indexOf('layer 1</div>'))
  assert.deepEqual(cellsOf(l2), ['scaffold', 'todig', 'dug', 'none'])
  for (const k of ['placed', 'missing', 'wrong', 'blocked', 'scaffold', 'to dig', 'dug']) assert.ok(h.includes(k), k)
  const seg = gridHtml({ ...g, segment: 2, segments: 4 }, escT)
  assert.match(seg, /segment 2 of 4/)
})

test('status page: the page embeds gridHtml and a Blueprint section', async () => {
  const srv = await startStatusServer({ port: 0, getState: () => ({}) })
  try {
    const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text()
    assert.match(html, /function gridHtml/)
    assert.match(html, /id="blueprint"/)
  } finally { await srv.close() }
})
