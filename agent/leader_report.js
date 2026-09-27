// Per-run report for a chain-mode LLM leader episode (agent/run_episode.mjs --leader ...): header, leader call
// statistics, override outcomes, agreement with kev, a Plans section, a Motor backlog section, the full decision
// log, and a thinking-text appendix.
// Pure: reads only the parsed episode-log JSON object (plus, for the Motor backlog, the parsed lines of the
// sibling out/<run>.requests.jsonl file); scripts/leader_report.mjs is the thin file-I/O CLI.
import { GOAL_ACTIONS } from './leader.js'   // plan_item, plan_steps, edit, say, push_goal, pop_goal, cannot
import { stepText } from './plans.js'

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

// The t of the first timeline sample where the game day advances past the day at t=0, or where timeOfDay wraps
// from >= 12000 (past noon) down below 12000 (a new day's morning) between consecutive samples. null if neither
// is ever observed (a censored/short episode that never reaches morning).
function firstMorningT(timeline) {
  if (!timeline || !timeline.length) return null
  const day0 = timeline[0].day
  let prevTod = timeline[0].timeOfDay
  for (const s of timeline) {
    if (isNum(s.day) && isNum(day0) && s.day > day0) return s.t
    if (isNum(prevTod) && isNum(s.timeOfDay) && prevTod >= 12000 && s.timeOfDay < 12000) return s.t
    prevTod = s.timeOfDay
  }
  return null
}

// Milestone 2 ("iron pickaxe and survive the first night"): the iron-pickaxe step (techStep index 8; chainStep's
// stage-0 numbering reuses the same 1..8 scale) reached, a first morning observed, and no death before it.
export function milestone2(json) {
  const timeline = json.timeline || []
  const events = json.events || []
  const pickaxeSample = timeline.find(s => isNum(s.step) && s.step >= 8)
  const pickaxe_t = pickaxeSample ? pickaxeSample.t : null
  const first_morning_t = firstMorningT(timeline)
  const cutoff = first_morning_t != null ? first_morning_t : Infinity
  const deaths_before_morning = events.filter(e => e.kind === 'death' && isNum(e.t) && e.t < cutoff).length
  const passed = pickaxe_t != null && deaths_before_morning === 0 && first_morning_t != null
  return { pickaxe_t, deaths_before_morning, first_morning_t, passed }
}

export function milestone2Line(json) {
  const m = milestone2(json)
  const fmt = t => (isNum(t) ? `${t.toFixed(0)}s` : '-')
  return `milestone 2: ${m.passed ? 'yes' : 'no'} (iron pickaxe at ${fmt(m.pickaxe_t)}, deaths before first morning ${m.deaths_before_morning})`
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

const goalText = g => g ? `${g.kind}${g.arg != null || g.count != null ? `(${[g.arg, g.count].filter(x => x != null).join(', ')})` : ''}` : '-'

// Goal stack activity (--leader subgoals): every pushed goal (goal_pushed) with its source and how it ended (the
// goal_done / goal_failed / goal_popped event with the same goal id; open when none), and every chat request
// (audience_request) with the leader call that was shown it and what that call answered.
export function goalsSummary(events, calls, endedT = null) {
  const ends = new Map()
  for (const e of events) if (['goal_done', 'goal_failed', 'goal_popped'].includes(e.kind) && e.goal?.id != null && !ends.has(e.goal.id)) ends.set(e.goal.id, e)
  const pushed = events.filter(e => e.kind === 'goal_pushed' && e.goal).map(e => {
    const end = ends.get(e.goal.id)
    const outcome = !end ? 'open' : end.kind === 'goal_done' ? 'done' : end.kind === 'goal_popped' ? 'popped' : `failed${end.reason ? ` (${end.reason})` : ''}`
    const endT = end ? end.t : endedT
    return { id: e.goal.id, goal: goalText(e.goal), source: e.goal.source ?? null, t: e.t, outcome, endT: end ? end.t : null,
      durationS: isNum(endT) && isNum(e.t) ? endT - e.t : null, why: e.why ?? null }
  })
  // Newer logs say which call settled a request (settled: answered, or not_now after two calls without an answer);
  // older ones only which calls were shown it (the first is taken).
  const hasSettled = calls.some(l => Array.isArray(l.settled))
  const requests = events.filter(e => e.kind === 'audience_request').map(e => {
    const same = r => r.t === e.t && r.name === e.name
    const call = hasSettled ? calls.find(l => (l.settled || []).some(same)) : calls.find(l => (l.requests || []).some(same))
    const as = hasSettled && call ? call.settled.find(same).as : call?.kind
    const pushedBy = call?.goal_id != null ? pushed.find(p => p.id === call.goal_id) : null
    const answer = !call ? null : as === 'not_now' ? `not now (after ${call.kind})` : pushedBy ? `push_goal ${pushedBy.goal}`
      : as === 'cannot' || as === 'pop_goal' ? `${call.kind}: ${String(call.reason || call.why || '').slice(0, 120)}` : call.kind
    return { t: e.t, name: e.name ?? null, text: e.text ?? '', answeredT: call ? call.t_answered ?? null : null, kind: call ? as : null, answer }
  })
  return { pushed, requests }
}

// One plan's row: steps with their outcome (done, skipped, blocked, running, pending) and how the plan ended (done,
// blocked, dropped or still open). Prefers meta.plans (the plan book's own saved state, written by run_episode.mjs's
// finish() whenever a plan ever existed): its `cursor`/`status`/`reason` are authoritative, so a step's outcome does
// not have to be inferred from event timing. A crash end (agent/run_episode.mjs's shutdown()) calls elog.finish()
// without `plans` (the same gap as `deaths`), so meta.plans can be missing even though the plan_* events are all
// there; planRowsFromEvents rebuilds the same shape from plan_added/plan_step/plan_done/plan_blocked/plan_edit for
// that case.
function planRowFromMeta(p, progress = {}) {
  const steps = p.steps.map((s, i) => {
    let outcome
    if (i < p.cursor) outcome = s.skipped ? 'skipped' : 'done'
    else if (i === p.cursor && p.status === 'blocked') outcome = `blocked${p.reason ? ` (${p.reason})` : ''}`
    else if (i === p.cursor && p.status === 'running') outcome = 'running'
    else outcome = 'pending'
    return withProgress({ index: i, text: stepText(s), outcome }, s, progress)
  })
  const end = p.status === 'done' ? `done at ${fmtSecs(p.end_t)}`
    : p.status === 'blocked' ? `blocked at ${fmtSecs(p.end_t)} (step ${p.cursor + 1})${p.reason ? `: ${p.reason}` : ''}`
    : p.status === 'dropped' ? `dropped at ${fmtSecs(p.end_t)}`
    : 'open'
  return { id: p.id, title: p.title, source: p.source, t: p.t, steps, end }
}

// The fallback (no meta.plans): a step's outcome is inferred from the next plan_step (or plan_done, on the last
// step) after it, and a plan_edit "skip" between the two turns "done" into "skipped" (skip carries no plan_id, so
// this can misattribute a skip to the wrong plan when more than one plan was ever active; meta.plans has no such
// ambiguity, which is why it is preferred).
function planRowsFromEvents(events, progress = {}) {
  const added = events.filter(e => e.kind === 'plan_added')
  const skips = events.filter(e => e.kind === 'plan_edit' && e.op === 'skip')
  return added.map(e => {
    const p = e.plan
    const stepsBy = new Map(events.filter(se => se.kind === 'plan_step' && se.plan_id === p.id).map(se => [se.step_index, se]))
    const doneEv = events.find(se => se.kind === 'plan_done' && se.plan_id === p.id)
    const blockedEv = events.find(se => se.kind === 'plan_blocked' && se.plan_id === p.id)
    const droppedEv = events.find(se => se.kind === 'plan_edit' && se.op === 'drop' && se.plan_id === p.id)
    const steps = p.steps.map((s, i) => {
      const cur = stepsBy.get(i)
      const nextT = stepsBy.get(i + 1)?.t ?? (i === p.steps.length - 1 ? doneEv?.t : null)
      let outcome
      if (blockedEv && blockedEv.step_index === i) outcome = `blocked${blockedEv.reason ? ` (${blockedEv.reason})` : ''}`
      else if (cur && nextT != null) outcome = skips.some(sk => sk.t > cur.t && sk.t <= nextT) ? 'skipped' : 'done'
      else if (cur) outcome = 'running'
      else outcome = 'pending'
      return withProgress({ index: i, text: stepText(s), outcome }, s, progress)
    })
    const end = doneEv ? `done at ${fmtSecs(doneEv.t)}`
      : blockedEv ? `blocked at ${fmtSecs(blockedEv.t)} (step ${blockedEv.step_index + 1})${blockedEv.reason ? `: ${blockedEv.reason}` : ''}`
      : droppedEv ? `dropped at ${fmtSecs(droppedEv.t)}`
      : 'open'
    return { id: p.id, title: p.title, source: p.source, t: e.t, steps, end }
  })
}

// A blueprint step (build/dig of a bp<n>) carries the blueprint's last progress line: meta.blueprints (finish()) or,
// without it, the last blueprint_progress event of that id.
function blueprintProgress(json) {
  const out = {}
  for (const e of json.events || []) if (e.kind === 'blueprint_progress' && e.id) out[e.id] = e.progress
  for (const [id, b] of Object.entries(json.meta?.blueprints || {})) if (b?.progress) out[id] = b.progress
  return out
}
function withProgress(row, step, progress) {
  const p = (step.kind === 'build' || step.kind === 'dig') && step.arg ? progress[step.arg] : null
  return p ? { ...row, progress: p } : row
}

export function plansSummary(json) {
  const metaPlans = json.meta?.plans
  const progress = blueprintProgress(json)
  if (metaPlans && metaPlans.length) return metaPlans.map(p => planRowFromMeta(p, progress))
  return planRowsFromEvents(json.events || [], progress)
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
    // Counted from the events, not meta.deaths: a crash end (agent/run_episode.mjs's shutdown()) calls elog.finish()
    // without a `deaths` field, so meta.deaths is silently absent even when death events were logged before the crash.
    deaths: events.filter(e => e.kind === 'death').length,
    endReason: meta.end_reason ?? null,
    endedT: meta.ended_t ?? null,
  }

  const actionMix = Object.fromEntries(ACTIONS.map(k => [k, 0]))
  for (const l of calls) if (Object.prototype.hasOwnProperty.call(actionMix, l.kind)) actionMix[l.kind]++
  actionMix.dropped = events.filter(e => e.kind === 'leader_dropped').length
  const goalCalls = calls.filter(l => GOAL_ACTIONS.includes(l.kind)).length
  if (header.mode === 'subgoals' || goalCalls) for (const k of GOAL_ACTIONS) actionMix[k] = calls.filter(l => l.kind === k).length

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

  const goals = goalsSummary(events, calls, meta.ended_t ?? null)
  const plans = plansSummary(json)
  return { header, stats, overrides, overrideOkCount, agreement, continueThen, continueThenCounts, rows, thinkingAppendix, milestone2: milestone2(json), goals, plans }
}

// ---- rendering -------------------------------------------------------------------------------------------------

const fmt1 = x => (isNum(x) ? x.toFixed(1) : '-')
const fmtSecs = x => (isNum(x) ? `${x.toFixed(1)}s` : '-')
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function formatStageTimes(stageTimes) {
  return Object.keys(stageTimes || {}).length
    ? Object.entries(stageTimes).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `stage ${k} @ ${fmtSecs(v)}`).join(', ')
    : 'none reached'
}

export function renderHeaderTable(summary, name) {
  const h = summary.header
  const stageTimesStr = formatStageTimes(h.stageTimes)
  const lines = [
    `# Leader run: ${name}`,
    '',
    '| field | value |',
    '|---|---|',
    `| leader mode | ${h.mode ?? 'off'} |`,
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
    ...GOAL_ACTIONS.filter(k => k in s.actionMix).map(k => `| ${k} | ${s.actionMix[k]} |`),
    '',
    `latency p50 / p90 / max: ${fmt1(s.latencyP50Ms)} / ${fmt1(s.latencyP90Ms)} / ${fmt1(s.latencyMaxMs)} ms`,
    `thinking chars (median, over calls with any): ${s.thinkingCharsMedian ?? '-'}`,
    `prompt chars (median): ${s.promptCharsMedian ?? '-'}`,
    `truncated: ${s.truncatedCount}`,
    '',
  ]
  return lines.join('\n')
}

function renderMilestone2Section(m) {
  const fmtT = t => (isNum(t) ? `${t.toFixed(1)}s` : '-')
  const lines = [
    '## Milestone 2',
    '',
    '(iron pickaxe and survive the first night)',
    '',
    '| field | value |',
    '|---|---|',
    `| iron pickaxe at | ${fmtT(m.pickaxe_t)} |`,
    `| first morning at | ${fmtT(m.first_morning_t)} |`,
    `| deaths before first morning | ${m.deaths_before_morning} |`,
    `| passed | ${m.passed ? 'yes' : 'no'} |`,
    '',
  ]
  return lines.join('\n')
}

// One line for a run script's comparison block: name, stage reached (of 5) with per-stage times, deaths, and the
// milestone-2 verdict. Takes the raw episode-log JSON (not a summary) so a caller can produce it from a bare
// out/<name>.json without going through summarizeLeaderLog itself.
export function renderComparisonLine(json, name) {
  const h = summarizeLeaderLog(json).header
  return `${name}: stage ${h.stageReached ?? '?'}/5 (${formatStageTimes(h.stageTimes)}), deaths ${h.deaths ?? 0}, ${milestone2Line(json)}`
}

function renderOverridesSection(summary) {
  const lines = ['## Override outcomes', '']
  if (!summary.overrides.length) { lines.push('no overrides this run.', ''); return lines.join('\n') }
  lines.push('| t | overridden subtask | replacement | replacement result |', '|---|---|---|---|')
  for (const o of summary.overrides) lines.push(`| ${fmtSecs(o.t)} | ${o.from ?? '(idle)'} | ${o.to} | ${o.result ?? '(no matching subtask_done found)'} |`)
  lines.push('', `replacements ending ok: ${summary.overrideOkCount}/${summary.overrides.length}`, '')
  return lines.join('\n')
}

// Only for a run with goal activity (a subgoals leader, a pushed goal or a chat request): otherwise nothing, so the
// reports of the other modes are unchanged.
export function renderGoalsSection(summary) {
  const g = summary.goals
  if (!g || (summary.header.mode !== 'subgoals' && !g.pushed.length && !g.requests.length)) return null
  const lines = ['## Goals', '']
  if (!g.pushed.length) lines.push('no goals pushed this run.', '')
  else {
    lines.push('| # | goal | source | pushed at | outcome | duration | why |', '|---|---|---|---|---|---|---|')
    for (const p of g.pushed) lines.push(`| ${p.id} | ${esc(p.goal)} | ${esc(p.source ?? '-')} | ${fmtSecs(p.t)} | ${esc(p.outcome)} | ${fmtSecs(p.durationS)}${p.outcome === 'open' ? ' (to the end)' : ''} | ${esc(String(p.why || '').slice(0, 120))} |`)
    lines.push('')
  }
  lines.push('requests from the chat:', '')
  if (!g.requests.length) lines.push('no requests this run.', '')
  else {
    lines.push('| t | from | request | answered at | answer |', '|---|---|---|---|---|')
    for (const r of g.requests) lines.push(`| ${fmtSecs(r.t)} | ${esc(r.name)} | ${esc(r.text)} | ${fmtSecs(r.answeredT)} | ${esc(r.answer ?? '(unanswered)')} |`)
    lines.push('')
  }
  return lines.join('\n')
}

// Always rendered (unlike Goals, which stays hidden for a run with no goal activity): "(none)" is itself the
// informative answer for a run that never had a plan.
export function renderPlansSection(plans) {
  const lines = ['## Plans', '']
  if (!plans || !plans.length) { lines.push('(none)', ''); return lines.join('\n') }
  for (const p of plans) {
    lines.push(`#${p.id} ${esc(p.title)} (source: ${esc(p.source ?? '-')}, added ${fmtSecs(p.t)})`, '')
    lines.push('| step | outcome |', '|---|---|')
    for (const s of p.steps) lines.push(`| ${s.index + 1}. ${esc(s.text)} | ${esc(s.outcome)}${s.progress ? `: ${esc(s.progress)}` : ''} |`)
    lines.push('', `end state: ${esc(p.end)}`, '')
  }
  return lines.join('\n')
}

// The motor backlog (out/<run>.requests.jsonl, read by scripts/leader_report.mjs and passed in as requestLines: it
// may not exist, hence "(none)"): one row per request the bot could not serve (a leader "cannot", or a plan_item
// the expander could not turn into steps), whoever asked and what stood in the way.
export function renderMotorBacklogSection(requestLines) {
  const lines = ['## Motor backlog', '']
  if (!requestLines || !requestLines.length) { lines.push('(none)', ''); return lines.join('\n') }
  lines.push('| t | from | request | why |', '|---|---|---|---|')
  for (const e of requestLines) {
    const from = e.name ?? '(none)'
    const request = e.text ?? (e.item ? `${e.kind}: ${[e.count, e.item].filter(x => x != null).join(' ')}` : e.kind ?? '-')
    const why = e.missing?.length ? `missing: ${e.missing.map(String).join(', ')}` : e.reason ?? e.why ?? '-'
    lines.push(`| ${fmtSecs(e.t)} | ${esc(from)} | ${esc(request)} | ${esc(why)} |`)
  }
  lines.push('')
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

export function renderReport(summary, name, { requestLines = [] } = {}) {
  return [
    renderHeaderTable(summary, name),
    renderStatsSection(summary),
    renderMilestone2Section(summary.milestone2),
    renderGoalsSection(summary),
    renderPlansSection(summary.plans),
    renderMotorBacklogSection(requestLines),
    renderOverridesSection(summary),
    renderAgreementSection(summary),
    renderDecisionLog(summary),
    renderThinkingAppendix(summary),
  ].filter(x => x != null).join('\n')
}
