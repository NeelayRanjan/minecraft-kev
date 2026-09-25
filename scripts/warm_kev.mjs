// Warm a freshly started kev.serve before bots use it: the first requests compile the fla/Triton kernels (>10 s, past
// the runner's 10 s timeout). Sends the states of the first records of a kev-format file, labels stripped.
// Usage: node scripts/warm_kev.mjs [url=http://127.0.0.1:8009] [records=data/mc1_holdout.jsonl] [n=12]
import fs from 'node:fs'
import { ask } from '../agent/kev_client.js'

const [url = 'http://127.0.0.1:8009', file = 'data/mc1_holdout.jsonl', n = '12'] = process.argv.slice(2)
const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, Number(n)).map(l => JSON.parse(l))
const t0 = Date.now()
for (const r of recs) {
  const qs = Object.fromEntries(Object.entries(r.questions).map(([k, { label, target, ...q }]) => [k, q]))
  const resp = await ask(url, r.state, qs, { timeoutMs: 600_000 })
  console.log(`warm: ${Object.keys(qs).length} questions, ${Math.round(resp.latency_ms)} ms`)
}
console.log(`warm: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
