import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeLeaderLog, renderReport } from '../agent/leader_report.js'

// A tiny synthetic chain-mode log: 3 leader calls (1 override whose replacement ends ok, 1 continue, 1 stale),
// one stage_done, and enough decisions to check agreement and the continue -> kev's-next-pick tracking.
function syntheticLog() {
  return {
    meta: {
      minutes: 10,
      stage_reached: 1,
      stage_times: { 1: 30 },
      deaths: 1,
      end_reason: 'time',
      ended_t: 600,
      leader: { mode: 'events', think: false, model: 'test-model', url: 'http://leader.example:11434' },
    },
    events: [
      { t: 0, kind: 'subtask_start', id: 'gather_wood', source: 'kev' },
      { t: 10, kind: 'subtask_done', id: 'gather_wood', result: 'ok' },
      { t: 10.1, kind: 'subtask_start', id: 'mine_stone', source: 'kev' },
      { t: 12, kind: 'leader_override', from: 'mine_stone', to: 'mine_iron', why: 'switch to iron' },
      { t: 12.5, kind: 'subtask_start', id: 'mine_iron', source: 'leader' },
      { t: 20, kind: 'subtask_done', id: 'mine_iron', result: 'ok' },
      { t: 25, kind: 'leader_continue', action: 'continue', current: 'mine_iron', why: 'fine' },
      { t: 30, kind: 'stage_done', stage: 1 },
    ],
    decisions: [
      { t: 11.5, decision: true, source: 'kev', chosen: 'mine_iron', answers: { next_subtask: { choice: 'mine_iron' } } },
      { t: 12.6, decision: true, source: 'leader', chosen: 'mine_iron', answers: { next_subtask: { choice: 'mine_iron' } } },
      { t: 26, decision: true, source: 'kev', chosen: 'mine_iron', answers: { next_subtask: { choice: 'mine_iron' } } },
    ],
    leader: [
      { t_asked: 11, t_answered: 12, current_id: 'mine_stone', action: 'mine_iron', kind: 'override', id: 'mine_iron',
        why: 'switch to iron', thinking: '', latency_ms: 1000, prompt_chars: 500, truncated: false },
      { t_asked: 24, t_answered: 25, current_id: 'mine_iron', action: 'continue', kind: 'continue', id: null,
        why: 'fine', thinking: 'thinking text', latency_ms: 2000, prompt_chars: 600, truncated: false },
      { t_asked: 40, t_answered: 42, current_id: 'explore_toward(down)', action: 'mine_coal', kind: 'stale', id: null,
        why: 'too late', thinking: '', latency_ms: 1500, prompt_chars: 550, truncated: true },
    ],
  }
}

test('summarizeLeaderLog: header fields come from meta', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.header.mode, 'events')
  assert.equal(s.header.think, false)
  assert.equal(s.header.model, 'test-model')
  assert.equal(s.header.minutes, 10)
  assert.equal(s.header.stageReached, 1)
  assert.deepEqual(s.header.stageTimes, { 1: 30 })
  assert.equal(s.header.deaths, 1)
  assert.equal(s.header.endReason, 'time')
})

test('summarizeLeaderLog: action mix counts one of each kind, no dropped', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.stats.calls, 3)
  assert.deepEqual(s.stats.actionMix, { continue: 1, override: 1, stale: 1, invalid: 0, error: 0, blocked: 0, dropped: 0 })
})

test('summarizeLeaderLog: blocked calls are counted in the action mix', () => {
  const log = syntheticLog()
  log.leader.push({ t_asked: 50, t_answered: 52, current_id: 'flee(threat)', action: 'mine_iron', kind: 'blocked', id: 'mine_iron', reason: 'threat', why: 'x', thinking: '', latency_ms: 1200, prompt_chars: 500, truncated: false })
  const s = summarizeLeaderLog(log)
  assert.equal(s.stats.actionMix.blocked, 1)
  assert.match(renderReport(s), /\| blocked \| 1 \|/)
})

test('summarizeLeaderLog: latency, thinking-chars and prompt-chars stats', () => {
  const s = summarizeLeaderLog(syntheticLog())
  // latencies sorted: 1000, 1500, 2000
  assert.equal(s.stats.latencyP50Ms, 1500)
  assert.equal(s.stats.latencyP90Ms, 2000)
  assert.equal(s.stats.latencyMaxMs, 2000)
  assert.equal(s.stats.thinkingCharsMedian, 'thinking text'.length)
  assert.equal(s.stats.promptCharsMedian, 550)
  assert.equal(s.stats.truncatedCount, 1)
})

test('summarizeLeaderLog: the override outcome (replacement subtask_done after the override)', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.overrides.length, 1)
  assert.equal(s.overrides[0].from, 'mine_stone')
  assert.equal(s.overrides[0].to, 'mine_iron')
  assert.equal(s.overrides[0].result, 'ok')
  assert.equal(s.overrideOkCount, 1)
})

test('summarizeLeaderLog: agreement between an applied leader answer and kev\'s own choice', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.agreement.n, 1)
  assert.equal(s.agreement.matches, 1)
  assert.equal(s.agreement.rate, 1)
})

test('summarizeLeaderLog: what kev did next after a continue call', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.deepEqual(s.continueThenCounts, { mine_iron: 1 })
})

test('summarizeLeaderLog: one decision-log row per leader call, in order', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.rows.length, 3)
  assert.equal(s.rows[0].kind, 'override')
  assert.equal(s.rows[0].currentSubtask, 'mine_stone')
  assert.equal(s.rows[1].kind, 'continue')
  assert.equal(s.rows[2].kind, 'stale')
})

test('summarizeLeaderLog: thinking appendix picks up only calls with non-empty thinking', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.thinkingAppendix.length, 1)
  assert.equal(s.thinkingAppendix[0].text, 'thinking text')
})

test('renderReport: produces a non-empty markdown string covering the required sections', () => {
  const json = syntheticLog()
  const s = summarizeLeaderLog(json)
  const md = renderReport(s, 'synthetic_run')
  assert.equal(typeof md, 'string')
  for (const needle of ['synthetic_run', 'events', 'override', 'continue', 'stale', 'Decision log', 'thinking']) {
    assert.ok(md.toLowerCase().includes(needle.toLowerCase()), `report should mention "${needle}"`)
  }
})
