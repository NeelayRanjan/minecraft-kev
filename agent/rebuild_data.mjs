// Rebuild a kev JSONL file from raw episode logs with the current labelers: deaths injected from events, optional
// questions dropped, same thinning as gen_data, and a fresh report with base rates and censoring.
//
//   node agent/rebuild_data.mjs --prefix gen --seed0 0 --seeds 40 --thin 8 --drop survive_until_morning --out data/mc1.jsonl
import fs from 'node:fs'
import path from 'node:path'
import { rebuildRecords } from './relabel.js'
import { thinRecords } from './thin.js'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && !argv[i + 1]?.startsWith('--') ? argv[i + 1] : d }
const prefix = opt('prefix', 'gen'), seed0 = Number(opt('seed0', 0)), seeds = Number(opt('seeds', 40)), thin = Number(opt('thin', 8))
const drop = (opt('drop', '') || '').split(',').filter(Boolean), out = opt('out', `data/${prefix}.jsonl`)
const all = [], labels = {}, censor = {}
let episodes = 0, goals = 0, deaths = 0, rawN = 0
for (let seed = seed0; seed < seed0 + seeds; seed++) {
  const file = path.join('out', `${prefix}_s${seed}.json`)
  if (!fs.existsSync(file)) { console.log(`seed ${seed}: no log`); continue }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { records, censoring } = rebuildRecords(json, { drop })
  episodes++; rawN += records.length
  if (json.meta?.goal_done_t != null) goals++
  deaths += json.meta?.deaths || 0
  for (const [qid, c] of Object.entries(censoring)) { const t = censor[qid] ||= { asked: 0, labelled: 0, censored: 0 }; t.asked += c.asked; t.labelled += c.labelled; t.censored += c.censored }
  const kept = thinRecords(records, thin)
  all.push(...kept)
  console.log(`seed ${seed}: ${json.meta?.end_reason} at ${Math.round(json.meta?.ended_t ?? 0)} s, goal ${json.meta?.goal_done_t != null ? Math.round(json.meta.goal_done_t) + ' s' : 'no'}, deaths ${json.meta?.deaths ?? 0}, ${records.length} -> ${kept.length} records`)
}
for (const r of all) for (const [qid, q] of Object.entries(r.questions)) { const t = labels[qid] ||= {}; const k = String(q.label); t[k] = (t[k] || 0) + 1 }
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''))
const report = { prefix, seed0, seeds, episodes, goals, deaths, raw_records: rawN, records: all.length, thin, dropped: drop, labels, censoring: censor, rebuilt: new Date().toISOString() }
fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.report.json', JSON.stringify(report, null, 2))
console.log(`rebuilt ${episodes} episodes (${goals} goals, ${deaths} deaths): ${rawN} raw -> ${all.length} records -> ${out}`)
for (const [qid, c] of Object.entries(labels)) { const n = Object.values(c).reduce((a, b) => a + b, 0); console.log(`  ${qid}: n=${n} ` + Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v} (${(100 * v / n).toFixed(0)}%)`).join(', ')) }
for (const [qid, c] of Object.entries(censor)) console.log(`  censoring ${qid}: ${c.censored}/${c.asked} (${(100 * c.censored / Math.max(1, c.asked)).toFixed(0)}%)`)
