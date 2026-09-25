// Offline leader bench: replay logged decision points through candidate leader models (Ollama) with the exact live
// prompt (agent/planner.js: state text, last 12 events, kev's logged forecasts, the offered subtasks) and score them
// without Minecraft. Decision points come from raw episode logs (out/<prefix>_s*.json, kev-driven DAgger runs by
// default); half the sample is taken right after a failed subtask, where a leader has something to fix.
//
//   node scripts/leader_bench.mjs --models qwen3:8b,qwen38-27b-iq2s --n 200 [--prefix dagger] [--think false]
//        [--ablate 60] [--kev-url http://127.0.0.1:8009] [--out reports/leader_bench]
//
// Per model: valid answers, agreement with the teacher and with kev, how often it re-picks a subtask that just failed
// (teacher and kev rates beside it), latency and tokens/s, VRAM and Ollama's GPU/CPU split, and (with --kev-url) kev's
// latency while the leader generates. --ablate N re-asks N items with the forecasts removed: the share of changed
// answers says whether the leader reads kev's forecasts at all.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { askPlanner } from '../agent/planner.js'
import { ask } from '../agent/kev_client.js'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const models = opt('models', 'qwen3:8b').split(',')
const N = Number(opt('n', 200)), prefix = opt('prefix', 'dagger'), url = opt('url', 'http://127.0.0.1:11434')
const think = { true: true, false: false }[opt('think', 'false')] ?? opt('think', 'false')   // true/false or low/medium/high
const ablateN = Number(opt('ablate', 0)), kevUrl = opt('kev-url', null), outDir = opt('out', 'reports/leader_bench')
const numCtx = Number(opt('ctx', 2048)), numPredict = think ? 2048 : 120
const [seedLo, seedHi] = (opt('seeds', '0-999999')).split('-').map(Number)   // pin the episode set so runs compare
fs.mkdirSync(outDir, { recursive: true })

// ---- sample ----------------------------------------------------------------------------------------------------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const rng = mulberry32(7)
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
const forecastsOf = answers => {
  const f = {}
  for (const q of ['subgoal_succeeds_60s', 'iron_found_3min', 'survive_until_morning']) if (answers[q]?.probabilities) f[q] = answers[q].probabilities.true
  if (answers.damage_next_20s?.probabilities) f.damage_major_or_death = (answers.damage_next_20s.probabilities[2] || 0) + (answers.damage_next_20s.probabilities[3] || 0)
  return f
}
const items = []
const seedOf = f => { const m = new RegExp(`^${prefix}_s(\\d+)\\.json$`).exec(f); return m ? Number(m[1]) : null }
for (const file of fs.readdirSync('out').filter(f => { const s = seedOf(f); return s != null && s >= seedLo && s <= seedHi }).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join('out', file), 'utf8'))
  for (const d of j.decisions) {
    const crit = d.qs?.next_subtask?.criteria
    if (!d.decision || !crit || Object.keys(crit).length < 2 || !d.teacher_label) continue
    const before = j.events.filter(e => e.t < d.t)
    const lastDone = before.filter(e => e.kind === 'subtask_done').at(-1)
    items.push({
      file, t: d.t, state: d.state_text, options: Object.entries(crit).map(([id, desc]) => ({ id, desc })), history: before.slice(-12),
      forecasts: forecastsOf(d.answers), teacher: d.teacher_label, kev: d.answers?.next_subtask?.choice ?? null,
      lastFailed: lastDone && lastDone.result !== 'ok' && crit[lastDone.id] ? lastDone.id : null, subgoalOk: d.labels?.subgoal_succeeds_60s ?? null,
    })
  }
}
const afterFail = shuffle(items.filter(x => x.lastFailed)), rest = shuffle(items.filter(x => !x.lastFailed))
const nFail = Math.min(afterFail.length, Math.floor(N / 2))
const sample = [...afterFail.slice(0, nFail), ...rest.slice(0, N - nFail)]
console.log(`bench: ${items.length} decision points in out/${prefix}_s*.json (${afterFail.length} right after a failure); sample ${sample.length} (${nFail} after a failure)`)

// ---- kev latency probe -----------------------------------------------------------------------------------------
let probe = null
function startProbe() {
  if (!kevUrl) return
  const rec = JSON.parse(fs.readFileSync('data/mc1_holdout.jsonl', 'utf8').split('\n')[0])
  const qs = Object.fromEntries(Object.entries(rec.questions).map(([k, { label, target, ...q }]) => [k, q]))
  probe = { lat: [], errors: 0, on: true }
  ;(async () => { while (probe.on) { try { probe.lat.push((await ask(kevUrl, rec.state, qs, { timeoutMs: 15_000 })).latency_ms) } catch { probe.errors++ } await new Promise(r => setTimeout(r, 500)) } })()
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }
const sh = c => { try { return execSync(c, { encoding: 'utf8' }).trim() } catch { return null } }

// ---- run -------------------------------------------------------------------------------------------------------
const summary = {}
for (const model of models) {
  console.log(`\n== ${model} (think ${think})`)
  const t0 = Date.now()
  try { await askPlanner({ url, model, stateText: 'warm-up', options: [{ id: 'wait', desc: 'wait' }], timeoutMs: 900_000, think: false }) } catch (e) { console.log(`load failed: ${e.message}`); continue }
  const load_s = (Date.now() - t0) / 1000
  const vram = sh('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader'), split = sh(`ollama ps | grep '${model.split(':')[0]}'`)
  console.log(`loaded in ${load_s.toFixed(0)} s; GPU ${vram}; ${split?.replace(/\s+/g, ' ')}`)
  if (kevUrl) { startProbe(); await new Promise(r => setTimeout(r, 1000)) }
  const rows = []
  for (const [i, it] of sample.entries()) {
    const ctx = { stateText: it.state, options: it.options, history: it.history, forecasts: it.forecasts }
    let a
    try { a = await askPlanner({ url, model, timeoutMs: 300_000, think, numPredict, numCtx, ...ctx }) } catch (e) { a = { id: null, error: String(e.message).slice(0, 120) } }
    const row = { i, file: it.file, t: it.t, id: a.id, teacher: it.teacher, kev: it.kev, lastFailed: it.lastFailed, latency_ms: a.latency_ms, tokens: a.tokens, tps: a.tps, why: a.why, error: a.error }
    if (i < ablateN) {
      try { const b = await askPlanner({ url, model, timeoutMs: 300_000, think, numPredict, numCtx, ...ctx, forecasts: {} }); row.id_noforecast = b.id } catch { row.id_noforecast = null }
    }
    rows.push(row)
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sample.length}  valid ${rows.filter(r => r.id).length}  teacher-agree ${rows.filter(r => r.id === r.teacher).length}  p50 ${pct(rows.map(r => r.latency_ms).filter(Boolean), 0.5)} ms`)
  }
  if (probe) { probe.on = false; await new Promise(r => setTimeout(r, 600)) }
  const valid = rows.filter(r => r.id), fail = rows.filter(r => r.lastFailed)
  const rate = (xs, f) => xs.length ? +(xs.filter(f).length / xs.length).toFixed(3) : null
  const s = {
    model, think, n: rows.length, load_s: Math.round(load_s), vram, ollama_ps: split,
    valid: rate(rows, r => r.id), agree_teacher: rate(valid, r => r.id === r.teacher), agree_kev: rate(valid.filter(r => r.kev), r => r.id === r.kev),
    after_failure: { n: fail.length, repick_failed: rate(fail.filter(r => r.id), r => r.id === r.lastFailed), teacher_repick: rate(fail, r => r.teacher === r.lastFailed), kev_repick: rate(fail.filter(r => r.kev), r => r.kev === r.lastFailed) },
    latency_ms: { p50: pct(valid.map(r => r.latency_ms), 0.5), p90: pct(valid.map(r => r.latency_ms), 0.9), max: pct(valid.map(r => r.latency_ms), 1) },
    tokens_per_s: pct(rows.map(r => r.tps).filter(Boolean), 0.5), tokens_p50: pct(rows.map(r => r.tokens).filter(Boolean), 0.5),
    forecast_ablation: ablateN ? { n: rows.filter(r => 'id_noforecast' in r).length, changed: rate(rows.filter(r => 'id_noforecast' in r && r.id && r.id_noforecast), r => r.id !== r.id_noforecast) } : null,
    kev_latency_during: probe ? { n: probe.lat.length, p50: pct(probe.lat, 0.5), p90: pct(probe.lat, 0.9), max: pct(probe.lat, 1), errors: probe.errors } : null,
  }
  summary[model] = s
  const tag = model.replace(/[:/]/g, '_') + (think ? `_think-${think}` : '')
  fs.writeFileSync(path.join(outDir, `${tag}.rows.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(JSON.stringify(s, null, 1))
  sh(`curl -s http://127.0.0.1:11434/api/generate -d '{"model":"${model}","keep_alive":0}'`)   // unload before the next model
}
const sumPath = path.join(outDir, `summary_${Date.now()}.json`)
fs.writeFileSync(sumPath, JSON.stringify({ prefix, N, think, ablateN, sample: sample.length, after_failure: nFail, models: summary }, null, 1))
console.log(`\nwrote ${sumPath}`)
