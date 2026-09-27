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
