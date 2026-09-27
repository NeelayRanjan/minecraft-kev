#!/usr/bin/env node
// Per-run report for a chain-mode LLM leader episode: header (mode, thinking, model, stage reached and its time,
// deaths counted from the death events (not meta.deaths, which a crash end never sets), end reason), leader call
// statistics (action mix, including the plan answers plan_item/plan_steps/edit/say alongside push_goal/pop_goal/
// cannot, latency p50/p90/max, thinking/prompt chars, truncated count), a milestone-2 verdict (iron pickaxe +
// survive the first night), override outcomes (did the replacement's first run end ok?), agreement between an
// applied leader answer and kev's own choice, what kev did next after a "continue", a Goals section for a subgoals
// run (pushed goals with source, outcome and duration; chat requests and how the leader answered them), a Plans
// section (every plan the bot ever held, its steps' outcomes and how it ended; "(none)" when there were no plans),
// a Motor backlog section (out/<name>.requests.jsonl: every request the bot could not serve; "(none)" when the
// file does not exist), and the full decision log with a thinking appendix. Works the same for a log with no leader
// at all (--policy kev alone): the header shows "leader mode | off" and the leader-call sections are empty.
// Reads out/<name>.json (agent/run_episode.mjs, chain mode, with or without --leader) and, if present,
// out/<name>.requests.jsonl. Pure computation lives in agent/leader_report.js (summarizeLeaderLog, renderReport,
// milestone2Line, renderComparisonLine); this file is only argv/file I/O.
// Usage: node scripts/leader_report.mjs <name> [--out reports/leader/<name>.md]
//        node scripts/leader_report.mjs <name> --line   # just the one-line comparison-block summary, no report write
import fs from 'node:fs'
import path from 'node:path'
import { summarizeLeaderLog, renderReport, renderHeaderTable, renderStatsSection, milestone2Line, renderComparisonLine } from '../agent/leader_report.js'

const args = process.argv.slice(2)
const name = args.find(a => !a.startsWith('--'))
if (!name) { console.error('usage: node scripts/leader_report.mjs <name> [--out reports/leader/<name>.md] [--line]'); process.exit(2) }

const inPath = path.join('out', `${name}.json`)
if (!fs.existsSync(inPath)) { console.error(`missing ${inPath}`); process.exit(1) }
const json = JSON.parse(fs.readFileSync(inPath, 'utf8'))

if (args.includes('--line')) {
  console.log(renderComparisonLine(json, name))
  process.exit(0)
}

const outFlagIdx = args.indexOf('--out')
const outPath = outFlagIdx >= 0 ? args[outFlagIdx + 1] : path.join('reports', 'leader', `${name}.md`)

const reqPath = path.join('out', `${name}.requests.jsonl`)
const requestLines = fs.existsSync(reqPath)
  ? fs.readFileSync(reqPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []

const summary = summarizeLeaderLog(json)
const report = renderReport(summary, name, { requestLines })

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, report)

console.log(renderHeaderTable(summary, name))
console.log(milestone2Line(json))
console.log(renderStatsSection(summary))
if (summary.goals.pushed.length || summary.goals.requests.length) {
  const g = summary.goals, n = o => g.pushed.filter(p => p.outcome.startsWith(o)).length
  console.log(`goals: ${g.pushed.length} pushed (${n('done')} done, ${n('failed')} failed, ${n('popped')} popped, ${n('open')} open); requests: ${g.requests.length} (${g.requests.filter(r => r.answer).length} answered)`)
}
if (summary.plans.length) console.log(`plans: ${summary.plans.length} (${summary.plans.map(p => p.end.split(' ')[0]).join(', ')})`)
if (requestLines.length) console.log(`motor backlog: ${requestLines.length} unserved requests (${reqPath})`)
console.log(`report written to ${outPath}`)
