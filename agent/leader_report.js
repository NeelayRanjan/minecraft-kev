// Per-run report for a chain-mode LLM leader episode (agent/run_episode.mjs --leader ...): header, leader call
// statistics, override outcomes, agreement with kev, the full decision log, and a thinking-text appendix.
// Pure: reads only the parsed episode-log JSON object; scripts/leader_report.mjs is the thin file-I/O CLI.

const STAGE_NAMES = ['iron pickaxe', 'iron tools', 'iron armor', 'diamond tools', 'lit nether portal']
const ACTIONS = ['continue', 'override', 'stale', 'invalid', 'error', 'blocked', 'dropped']

const isNum = x => typeof x === 'number' && Number.isFinite(x)
const nums = arr => arr.filter(isNum)
const sortAsc = arr => [...arr].sort((a, b) => a - b)
const quantile = (arr, q) => { if (!arr.length) return null; const s = sortAsc(arr); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
const median = arr => { if (!arr.length) return null; const s = sortAsc(arr); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function stageIndexAt(events, t) {
  let idx = 0
  for (const e of events) if (e.kind === 'stage_done' && e.t <= t) idx = e.stage
  return idx
}
function stageNameAt(events, t) {
  const idx = stageIndexAt(events, t)
  return STAGE_NAMES[idx] ?? String(idx)
}

function nearestDecision(decisions, t) {
  let best = null, bestDiff = Infinity
  for (const d of decisions) {
    const diff = Math.abs(d.t - t)
    if (diff < bestDiff) { bestDiff = diff; best = d }
  }
  return best
}

// For each leader_override event, the next subtask_start with the replacement's id at or after the override, and
// that run's outcome: the result of the next subtask_done for the same id after that start.
function overrideOutcomes(events) {
  const overrideEvents = events.filter(e => e.kind === 'leader_override')
  const overrides = overrideEvents.map(ov => {
    const start = events.find(e => e.kind === 'subtask_start' && e.id === ov.to && e.t >= ov.t)
    const done = start ? events.find(e => e.kind === 'subtask_done' && e.id === ov.to && e.t >= start.t) : null
    return { t: ov.t, from: ov.from ?? null, to: ov.to, why: ov.why ?? null, result: done ? done.result : null }
  })
  return { overrides, overrideOkCount: overrides.filter(o => o.result === 'ok').length }
}

// At decision points where a leader answer was applied (source === 'leader'), does the leader's pick (d.chosen)
// equal kev's own next_subtask choice (the pick kev would have made, still logged under answers)?
function leaderAgreement(decisions) {
  const rows = decisions
    .filter(d => d.decision && d.source === 'leader')
    .map(d => ({ t: d.t, leaderChoice: d.chosen ?? null, kevChoice: d.answers?.next_subtask?.choice ?? null }))
  const matches = rows.filter(r => r.kevChoice != null && r.kevChoice === r.leaderChoice).length
  return { rows, n: rows.length, matches, rate: rows.length ? matches / rows.length : null }
}

// For every leader call whose kind was "continue", what kev did at the next decision point after it answered.
function continueThenKev(calls, decisions) {
  const byTime = [...decisions].filter(d => d.decision).sort((a, b) => a.t - b.t)
  const rows = calls.filter(l => l.kind === 'continue').map(l => {
    const next = byTime.find(d => d.t >= l.t_answered)
    return { t: l.t_asked, kevNext: next ? (next.answers?.next_subtask?.choice ?? next.chosen ?? null) : null }
  })
  const counts = {}
  for (const r of rows) { const k = r.kevNext ?? '(none)'; counts[k] = (counts[k] || 0) + 1 }
  return { rows, counts }
}

// One row per leader call, in call order: t, stage in progress, subtask it was asked about, kev's own choice at
// the nearest decision point, what the leader answered, and how the call was classified.
function decisionLogRows(calls, events, decisions) {
  return calls.map(l => {
    const nd = nearestDecision(decisions.filter(d => d.decision), l.t_asked)
    return {
      t: l.t_asked,
      stage: stageNameAt(events, l.t_asked),
      currentSubtask: l.current_id ?? null,
      kevChoice: nd ? (nd.answers?.next_subtask?.choice ?? null) : null,
      action: l.action ?? null,
      kind: l.kind,
      latencyS: isNum(l.latency_ms) ? l.latency_ms / 1000 : null,
      why: String(l.why || '').slice(0, 120),
    }
  })
}

export function summarizeLeaderLog(json) {
  const meta = json.meta || {}
  const leaderMeta = meta.leader || {}
  const calls = json.leader || []
  const events = json.events || []
  const decisions = json.decisions || []

  const header = {
    mode: leaderMeta.mode ?? null,
    think: !!leaderMeta.think,
    model: leaderMeta.model ?? null,
    url: leaderMeta.url ?? null,
    minutes: meta.minutes ?? null,
    stageReached: meta.stage_reached ?? null,
    stageTimes: meta.stage_times || {},
    deaths: meta.deaths ?? 0,
    endReason: meta.end_reason ?? null,
    endedT: meta.ended_t ?? null,
  }

  const actionMix = Object.fromEntries(ACTIONS.map(k => [k, 0]))
  for (const l of calls) if (Object.prototype.hasOwnProperty.call(actionMix, l.kind)) actionMix[l.kind]++
  actionMix.dropped = events.filter(e => e.kind === 'leader_dropped').length

  const latencies = nums(calls.map(l => l.latency_ms))
  const stats = {
    calls: calls.length,
    actionMix,
    latencyP50Ms: quantile(latencies, 0.5),
    latencyP90Ms: quantile(latencies, 0.9),
    latencyMaxMs: latencies.length ? Math.max(...latencies) : null,
    thinkingCharsMedian: median(calls.map(l => (l.thinking || '').length).filter(n => n > 0)),
    promptCharsMedian: median(nums(calls.map(l => l.prompt_chars))),
    truncatedCount: calls.filter(l => l.truncated).length,
  }

  const { overrides, overrideOkCount } = overrideOutcomes(events)
  const agreement = leaderAgreement(decisions)
  const { rows: continueThen, counts: continueThenCounts } = continueThenKev(calls, decisions)
  const rows = decisionLogRows(calls, events, decisions)
  const thinkingAppendix = calls
    .filter(l => l.thinking && l.thinking.length > 0)
    .slice(0, 10)
    .map(l => ({ t: l.t_asked, text: String(l.thinking).slice(0, 1500) }))

  return { header, stats, overrides, overrideOkCount, agreement, continueThen, continueThenCounts, rows, thinkingAppendix }
}

// ---- rendering -------------------------------------------------------------------------------------------------

const fmt1 = x => (isNum(x) ? x.toFixed(1) : '-')
const fmtSecs = x => (isNum(x) ? `${x.toFixed(1)}s` : '-')
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderHeaderTable(summary, name) {
  const h = summary.header
  const stageTimesStr = Object.keys(h.stageTimes).length
    ? Object.entries(h.stageTimes).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `stage ${k} @ ${fmtSecs(v)}`).join(', ')
    : 'none reached'
  const lines = [
    `# Leader run: ${name}`,
    '',
    '| field | value |',
    '|---|---|',
    `| leader mode | ${h.mode ?? '-'} |`,
    `| thinking | ${h.think ? 'on' : 'off'} |`,
    `| model | ${h.model ?? '-'} |`,
    `| minutes | ${h.minutes ?? '-'} |`,
    `| stage reached | ${h.stageReached ?? '-'} (${stageTimesStr}) |`,
    `| deaths | ${h.deaths ?? 0} |`,
    `| end reason | ${h.endReason ?? '-'} (t=${fmtSecs(h.endedT)}) |`,
    '',
  ]
  return lines.join('\n')
}

export function renderStatsSection(summary) {
  const s = summary.stats
  const lines = [
    '## Leader call statistics',
    '',
    `calls: ${s.calls}`,
    '',
    '| action | count |',
    '|---|---|',
    ...ACTIONS.map(k => `| ${k} | ${s.actionMix[k] ?? 0} |`),
    '',
    `latency p50 / p90 / max: ${fmt1(s.latencyP50Ms)} / ${fmt1(s.latencyP90Ms)} / ${fmt1(s.latencyMaxMs)} ms`,
    `thinking chars (median, over calls with any): ${s.thinkingCharsMedian ?? '-'}`,
    `prompt chars (median): ${s.promptCharsMedian ?? '-'}`,
    `truncated: ${s.truncatedCount}`,
    '',
  ]
  return lines.join('\n')
}

function renderOverridesSection(summary) {
  const lines = ['## Override outcomes', '']
  if (!summary.overrides.length) { lines.push('no overrides this run.', ''); return lines.join('\n') }
  lines.push('| t | overridden subtask | replacement | replacement result |', '|---|---|---|---|')
  for (const o of summary.overrides) lines.push(`| ${fmtSecs(o.t)} | ${o.from ?? '(idle)'} | ${o.to} | ${o.result ?? '(no matching subtask_done found)'} |`)
  lines.push('', `replacements ending ok: ${summary.overrideOkCount}/${summary.overrides.length}`, '')
  return lines.join('\n')
}

function renderAgreementSection(summary) {
  const a = summary.agreement
  const lines = [
    '## Agreement with kev',
    '',
    `at decision points where a leader answer was applied: ${a.matches}/${a.n} equal kev's own next_subtask choice` +
      (a.rate != null ? ` (${(100 * a.rate).toFixed(0)}%)` : ' (none applied)'),
    '',
    'what kev did next after a leader "continue" call:',
    '',
  ]
  const entries = Object.entries(summary.continueThenCounts).sort((a, b) => b[1] - a[1])
  if (!entries.length) lines.push('no continue calls this run.')
  else { lines.push('| kev\'s next choice | count |', '|---|---|'); for (const [k, v] of entries) lines.push(`| ${esc(k)} | ${v} |`) }
  lines.push('')
  return lines.join('\n')
}

function renderDecisionLog(summary) {
  const lines = [
    '## Decision log',
    '',
    '| t | stage | current subtask | kev\'s choice | leader action | kind | latency (s) | why |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const r of summary.rows) {
    lines.push(`| ${fmtSecs(r.t)} | ${esc(r.stage)} | ${esc(r.currentSubtask ?? '(idle)')} | ${esc(r.kevChoice ?? '-')} | ${esc(r.action ?? '-')} | ${r.kind} | ${fmt1(r.latencyS)} | ${esc(r.why)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderThinkingAppendix(summary) {
  const lines = ['## Appendix: thinking text (first 10 calls with thinking)', '']
  if (!summary.thinkingAppendix.length) { lines.push('no thinking text recorded (thinking mode off, or empty every time).', ''); return lines.join('\n') }
  for (const t of summary.thinkingAppendix) {
    lines.push(`<details><summary>t=${fmtSecs(t.t)}</summary>`, '', '```', t.text, '```', '', '</details>', '')
  }
  return lines.join('\n')
}

export function renderReport(summary, name) {
  return [
    renderHeaderTable(summary, name),
    renderStatsSection(summary),
    renderOverridesSection(summary),
    renderAgreementSection(summary),
    renderDecisionLog(summary),
    renderThinkingAppendix(summary),
  ].join('\n')
}
