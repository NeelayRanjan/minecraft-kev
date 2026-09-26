// Table over every reports/leader_bench/*.rows.jsonl, scored on decisions made before the goal (after the iron
// pickaxe the scripted teacher idles with wait until morning, so agreement there says nothing).
// Usage: node scripts/leader_bench_report.mjs [dir=reports/leader_bench] [prefix=dagger]
import fs from 'node:fs'
import path from 'node:path'

const [dir = 'reports/leader_bench', prefix = 'dagger'] = process.argv.slice(2)
const goalT = {}
const goalOf = file => {
  if (!(file in goalT)) {
    const j = JSON.parse(fs.readFileSync(path.join('out', file), 'utf8'))
    goalT[file] = j.events.find(e => e.kind === 'goal_done' && !e.goal)?.t ?? Infinity
  }
  return goalT[file]
}
const summaries = fs.readdirSync(dir).filter(f => f.startsWith('summary_')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
// the rows file is named like leader_bench.mjs's tag: model with ':' and '/' as '_', plus _think-<x> when thinking
const byTag = {}
for (const s of summaries) for (const m of Object.values(s.models)) byTag[m.model.replace(/[:/]/g, '_') + (m.think ? `_think-${m.think}` : '')] = m
const share = (xs, f) => xs.length ? (xs.filter(f).length / xs.length).toFixed(2) : '-'
const lines = [
  '| model | n pre-goal | valid | agrees with teacher | with kev | threat decisions agree | re-picks a just-failed subtask | answers changed without forecasts | latency p50 | tok/s | VRAM in use (with kev + 5 bots) | kev p50 / p90 while it runs |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
]
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.rows.jsonl')).sort()) {
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const pre = rows.filter(r => r.t < goalOf(r.file)), v = pre.filter(r => r.id), fl = pre.filter(r => r.lastFailed && r.id)
  const threat = v.filter(r => /threat/.test(r.teacher) || /threat/.test(r.id)), abl = pre.filter(r => r.id && r.id_noforecast)
  const m = byTag[f.replace('.rows.jsonl', '')] || {}
  lines.push(`| ${m.model ?? f} | ${pre.length} | ${share(pre, r => r.id)} | ${share(v, r => r.id === r.teacher)} | ${share(v.filter(r => r.kev), r => r.id === r.kev)} | ` +
    `${share(threat, r => r.id === r.teacher)} (n ${threat.length}) | ${share(fl, r => r.id === r.lastFailed)} (teacher ${share(fl, r => r.teacher === r.lastFailed)}, kev ${share(fl.filter(r => r.kev), r => r.kev === r.lastFailed)}) | ` +
    `${share(abl, r => r.id !== r.id_noforecast)} (n ${abl.length}) | ${m.latency_ms?.p50 ?? '-'} ms | ${m.tokens_per_s ?? '-'} | ${m.vram ?? '-'} | ${m.kev_latency_during ? `${m.kev_latency_during.p50} / ${m.kev_latency_during.p90} ms` : '-'} |`)
}
const out = ['# Leader bench', '', `Logged decision points from kev-driven DAgger episodes (out/${prefix}_s*.json) replayed through each candidate with the live prompt (agent/planner.js), think off. Scored before the goal only. Half the sample follows a failed subtask. Teacher agreement is a sanity filter, not the objective.`, '', ...lines, '']
fs.writeFileSync(path.join(dir, 'README.md'), out.join('\n'))
console.log(out.join('\n'))
