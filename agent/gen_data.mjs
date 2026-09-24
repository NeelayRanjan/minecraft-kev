// Many episodes in parallel (each on its own Paper instance) -> one kev JSONL file, thinned, plus a base-rate and
// censoring report. Labels are always the teacher's choice or the post-hoc truth, whoever drove.
//
//   node agent/gen_data.mjs --seeds 48 --seed0 0 --procs 4 --minutes 20 --eps-action 0.1 --out data/mc1.jsonl
//   node agent/gen_data.mjs --seeds 12 --seed0 1000 --procs 4 --minutes 20 --out data/mc1_holdout.jsonl
//   node agent/gen_data.mjs --policy kev --kev-url http://127.0.0.1:8009 --seeds 24 --seed0 2000 --out data/mc1_dagger.jsonl
//
// Thinning: every decision-point record is kept, except post-goal ones (1 in --thin); forecast-only records keep
// 1 in --thin by time. --thin 5 with 1 Hz decisions gives ~5 records per 20 s of play.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && !argv[i + 1]?.startsWith('--') ? argv[i + 1] : d }
const seeds = Number(opt('seeds', 4)), seed0 = Number(opt('seed0', 0)), procs = Number(opt('procs', 2)), minutes = opt('minutes', '20')
const epsAction = opt('eps-action', '0'), out = opt('out', 'data/mc.jsonl'), thin = Number(opt('thin', 5)), policy = opt('policy', 'teacher')
const kevUrl = opt('kev-url', null), port0 = Number(opt('port0', 25600)), prefix = opt('prefix', 'gen'), difficulty = opt('difficulty', 'normal')
const video = argv.includes('--video'), videoSeeds = Number(opt('video-seeds', 2))   // --video records only the first N seeds (each renderer costs CPU and RAM)
fs.mkdirSync(path.dirname(out), { recursive: true })
const T0 = Date.now()
const say = s => console.log(`[${((Date.now() - T0) / 60000).toFixed(1)} min] ${s}`)

function runEpisode(seed, slot) {
  return new Promise(resolve => {
    const name = `${prefix}_s${seed}`
    const args = [path.join(HERE, 'run_episode.mjs'), '--seed', String(seed), '--port', String(port0 + slot), '--policy', policy, '--minutes', minutes,
      '--eps-action', epsAction, '--out', name, '--difficulty', difficulty, '--quiet', ...(kevUrl ? ['--kev-url', kevUrl] : []), ...(video && seed - seed0 < videoSeeds ? ['--video'] : [])]
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, (Number(minutes) * 60 + 240) * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'))
      let summary = null
      try { summary = line ? JSON.parse(line) : null } catch {}
      resolve({ seed, name, code, summary, stderr: stderr.slice(-400) })
    })
  })
}

import { thinRecords as thinShared } from './thin.js'
const thinRecords = recs => thinShared(recs, thin)

const results = []
let next = 0
async function worker(slot) {
  while (next < seeds) {
    const seed = seed0 + next++
    const r = await runEpisode(seed, slot)
    results.push(r)
    const s = r.summary
    if (s) say(`seed ${seed}: ${s.end_reason} at ${s.t} s, goal ${s.goal_done_t != null ? `${Math.round(s.goal_done_t)} s` : 'no'}, deaths ${s.deaths}, ${s.records} records (${s.decision_points} decisions)`)
    else say(`seed ${seed}: FAILED (exit ${r.code}) ${r.stderr.replace(/\s+/g, ' ').slice(-200)}`)
  }
}
await Promise.all(Array.from({ length: Math.min(procs, seeds) }, (_, i) => worker(i)))

// ---- merge, thin, report ----------------------------------------------------------------------------------------
const all = [], labels = {}, censor = {}
let rawN = 0, goals = 0, deaths = 0, ok = 0
for (const r of results.sort((a, b) => a.seed - b.seed)) {
  if (!r.summary) continue
  ok++
  const file = path.join('out', `${r.name}.jsonl`)
  if (!fs.existsSync(file)) continue
  const recs = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  rawN += recs.length
  all.push(...thinRecords(recs))
  if (r.summary.goal_done_t != null) goals++
  deaths += r.summary.deaths || 0
  for (const [qid, c] of Object.entries(r.summary.censoring || {})) { const t = censor[qid] ||= { asked: 0, labelled: 0, censored: 0 }; t.asked += c.asked; t.labelled += c.labelled; t.censored += c.censored }
}
for (const r of all) for (const [qid, q] of Object.entries(r.questions)) { const t = labels[qid] ||= {}; const k = String(q.label); t[k] = (t[k] || 0) + 1 }
fs.writeFileSync(out, all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''))
const report = { seeds, seed0, ok, goals, deaths, raw_records: rawN, records: all.length, thin, policy, eps_action: epsAction, minutes, labels, censoring: censor, wall_min: +((Date.now() - T0) / 60000).toFixed(1) }
fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.report.json', JSON.stringify(report, null, 2))
say(`done: ${ok}/${seeds} episodes, ${goals} reached the goal, ${deaths} deaths; ${rawN} raw -> ${all.length} records -> ${out}`)
for (const [qid, c] of Object.entries(labels)) { const n = Object.values(c).reduce((a, b) => a + b, 0); say(`  ${qid}: n=${n} ` + Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v} (${(100 * v / n).toFixed(0)}%)`).join(', ')) }
for (const [qid, c] of Object.entries(censor)) say(`  censoring ${qid}: ${c.censored}/${c.asked} (${(100 * c.censored / Math.max(1, c.asked)).toFixed(0)}%)`)
