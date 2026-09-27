import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeLeaderLog, renderReport, milestone2, milestone2Line, renderComparisonLine, renderHeaderTable, plansSummary, renderPlansSection, renderMotorBacklogSection } from '../agent/leader_report.js'

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
      { t: 28, kind: 'death', pos: { x: 1, y: 2, z: 3 } },
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
  for (const needle of ['synthetic_run', 'events', 'override', 'continue', 'stale', 'Decision log', 'thinking', 'Milestone 2']) {
    assert.ok(md.toLowerCase().includes(needle.toLowerCase()), `report should mention "${needle}"`)
  }
})

// ---- milestone 2 (iron pickaxe + survive the first night) ------------------------------------------------------

// A synthetic timeline sampled every 100s to t=1500: `step` reaches 8 (the iron-pickaxe step) at pickaxeStep8T,
// `day` advances past day 0 at morningAtT (the "first morning" signal), and `death` events fall at deathTimes.
function milestone2Log({ pickaxeStep8T = 200, morningAtT = 1200, deathTimes = [], meta = {} } = {}) {
  const timeline = []
  for (let t = 0; t <= 1500; t += 100) {
    timeline.push({ t, step: t >= pickaxeStep8T ? 8 : 5, rawIron: 0, ingots: 0, health: 20, dead: false, timeOfDay: t % 24000, day: t >= morningAtT ? 1 : 0 })
  }
  const events = deathTimes.map(t => ({ t, kind: 'death', pos: { x: 0, y: 0, z: 0 } }))
  return { meta: { minutes: 25, ...meta }, events, decisions: [], leader: [], timeline }
}

test('milestone2: passes when the pickaxe step is reached, morning is found, and no death precedes it', () => {
  const m = milestone2(milestone2Log({ deathTimes: [1300] }))
  assert.equal(m.pickaxe_t, 200)
  assert.equal(m.first_morning_t, 1200)
  assert.equal(m.deaths_before_morning, 0)
  assert.equal(m.passed, true)
})

test('milestone2: fails on a death before the first morning', () => {
  const m = milestone2(milestone2Log({ deathTimes: [900] }))
  assert.equal(m.deaths_before_morning, 1)
  assert.equal(m.passed, false)
})

test('milestone2: fails when no morning is ever observed, even with the pickaxe and no deaths', () => {
  const json = milestone2Log({ morningAtT: 100000 })
  const m = milestone2(json)
  assert.equal(m.pickaxe_t, 200)
  assert.equal(m.first_morning_t, null)
  assert.equal(m.passed, false)
})

test('milestone2Line: renders the yes/no summary with pickaxe time and death count', () => {
  const line = milestone2Line(milestone2Log({ deathTimes: [1300] }))
  assert.equal(line, 'milestone 2: yes (iron pickaxe at 200s, deaths before first morning 0)')
})

test('summarizeLeaderLog: exposes milestone2 on the summary', () => {
  const s = summarizeLeaderLog(milestone2Log({ deathTimes: [900] }))
  assert.equal(s.milestone2.passed, false)
  assert.equal(s.milestone2.deaths_before_morning, 1)
})

test('renderComparisonLine: the one-line comparison-block format', () => {
  const json = milestone2Log({ deathTimes: [1300], meta: { stage_reached: 1, stage_times: { 1: 200 }, deaths: 1 } })
  const line = renderComparisonLine(json, 'r2_kev_s3000')
  assert.equal(line, 'r2_kev_s3000: stage 1/5 (stage 1 @ 200.0s), deaths 1, milestone 2: yes (iron pickaxe at 200s, deaths before first morning 0)')
})

test('renderHeaderTable: a log with no leader shows "leader mode | off"', () => {
  const json = milestone2Log()
  const s = summarizeLeaderLog(json)
  assert.equal(s.header.mode, null)
  const table = renderHeaderTable(s, 'r2_kev_s3000')
  assert.match(table, /\| leader mode \| off \|/)
})

// A synthetic subgoals run: two chat requests (one pushed a goal that completed, one answered cannot), a leader-pushed
// goal the stuck rule failed, and one left open at the end.
function goalsLog() {
  return {
    meta: { minutes: 6, deaths: 0, end_reason: 'time', ended_t: 360, leader: { mode: 'subgoals', think: false, model: 'm', url: 'u' } },
    events: [
      { t: 30, kind: 'audience_request', name: 'alice', text: 'gather 8 cobblestone' },
      { t: 34, kind: 'goal_pushed', goal: { id: 1, kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:alice' }, why: 'the audience asked' },
      { t: 80, kind: 'goal_done', goal: { id: 1, kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:alice' } },
      { t: 100, kind: 'audience_request', name: 'bob', text: 'find a village' },
      { t: 103, kind: 'leader_cannot', action: 'cannot', why: 'no village detector yet' },
      { t: 120, kind: 'goal_pushed', goal: { id: 2, kind: 'find', arg: 'diamond_ore', count: null, source: 'leader' }, why: 'diamonds next' },
      { t: 420, kind: 'goal_failed', goal: { id: 2, kind: 'find', arg: 'diamond_ore', count: null, source: 'leader' }, reason: 'stuck' },
      { t: 300, kind: 'goal_pushed', goal: { id: 3, kind: 'go_to', arg: 'base', count: null, source: 'leader' }, why: 'home' },
    ],
    decisions: [],
    leader: [
      { t_asked: 30, t_answered: 34, trigger: 'audience_request', kind: 'push_goal', action: 'push_goal', goal_id: 1, requests: [{ t: 30, name: 'alice' }], why: 'the audience asked', latency_ms: 4000 },
      { t_asked: 100, t_answered: 103, trigger: 'audience_request', kind: 'cannot', action: 'cannot', goal_id: null, requests: [{ t: 100, name: 'bob' }], why: 'no village detector yet', latency_ms: 3000 },
      { t_asked: 118, t_answered: 120, trigger: 'goal_done', kind: 'push_goal', action: 'push_goal', goal_id: 2, requests: [], why: 'diamonds next', latency_ms: 2000 },
      { t_asked: 298, t_answered: 300, trigger: 'periodic', kind: 'push_goal', action: 'push_goal', goal_id: 3, requests: [], why: 'home', latency_ms: 2000 },
    ],
  }
}

test('goals: pushed goals with source, outcome and duration, requests with their answers, goal actions in the mix', () => {
  const s = summarizeLeaderLog(goalsLog())
  assert.equal(s.stats.actionMix.push_goal, 3)
  assert.equal(s.stats.actionMix.cannot, 1)
  assert.equal(s.stats.actionMix.pop_goal, 0)
  assert.deepEqual(s.goals.pushed.map(p => [p.id, p.goal, p.source, p.outcome, p.durationS]),
    [[1, 'gather(cobblestone, 8)', 'audience:alice', 'done', 46], [2, 'find(diamond_ore)', 'leader', 'failed (stuck)', 300], [3, 'go_to(base)', 'leader', 'open', 60]])
  assert.deepEqual(s.goals.requests.map(r => [r.name, r.answeredT, r.answer]),
    [['alice', 34, 'push_goal gather(cobblestone, 8)'], ['bob', 103, 'cannot: no village detector yet']])
  const md = renderReport(s, 'gs')
  assert.match(md, /## Goals/)
  assert.match(md, /\| 1 \| gather\(cobblestone, 8\) \| audience:alice \| 34\.0s \| done \| 46\.0s \|/)
  assert.match(md, /\| push_goal \| 3 \|/)
  assert.match(md, /\| 100\.0s \| bob \| find a village \| 103\.0s \| cannot: no village detector yet \|/)
})

test('goals: a run of another mode with no goal activity renders no Goals section and no goal rows', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.ok(!('push_goal' in s.stats.actionMix))
  const md = renderReport(s, 'x')
  assert.ok(!md.includes('## Goals') && !md.includes('push_goal'))
})

test('goals: with settled records a request is credited to the call that settled it (not an earlier error call)', () => {
  const j = goalsLog()
  j.events = [{ t: 30, kind: 'audience_request', name: 'alice', text: 'gather 8 cobblestone' }, { t: 50, kind: 'audience_request', name: 'bob', text: 'dance' }]
  j.leader = [
    { t_asked: 30, t_answered: 31, kind: 'error', requests: [{ t: 30, name: 'alice' }], settled: [] },
    { t_asked: 51, t_answered: 53, kind: 'continue', requests: [{ t: 30, name: 'alice' }, { t: 50, name: 'bob' }], settled: [{ t: 30, name: 'alice', as: 'not_now' }] },
    { t_asked: 70, t_answered: 72, kind: 'cannot', why: 'no dancing', requests: [{ t: 50, name: 'bob' }], settled: [{ t: 50, name: 'bob', as: 'cannot' }] },
  ]
  const s = summarizeLeaderLog(j)
  assert.deepEqual(s.goals.requests.map(r => [r.name, r.answeredT, r.answer]), [['alice', 53, 'not now (after continue)'], ['bob', 72, 'cannot: no dancing']])
})

// ---- deaths (counted from events, not meta.deaths) -------------------------------------------------------------

test('summarizeLeaderLog: deaths counts death events, matching meta.deaths on a normal end', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.equal(s.header.deaths, 1)   // one death event added to syntheticLog, matching its meta.deaths: 1
})

test('summarizeLeaderLog: a crash end never sets meta.deaths, so deaths is counted from the death events instead', () => {
  const json = milestone2Log({ deathTimes: [100, 200], meta: { end_reason: 'crash: uncaught: x' } })
  assert.equal(json.meta.deaths, undefined)   // agent/run_episode.mjs's shutdown() never passes deaths to elog.finish()
  const s = summarizeLeaderLog(json)
  assert.equal(s.header.deaths, 2)
  assert.match(renderHeaderTable(s, 'crash_run'), /\| deaths \| 2 \|/)
})

// ---- action mix includes the plan answers (GOAL_ACTIONS imported from agent/leader.js) --------------------------

test('summarizeLeaderLog: the action mix counts plan_item, plan_steps, edit and say alongside the goal actions', () => {
  const log = goalsLog()
  log.leader.push({ t_asked: 500, t_answered: 502, kind: 'plan_item', action: 'plan_item', goal_id: null, requests: [], why: 'a compass' })
  log.leader.push({ t_asked: 510, t_answered: 512, kind: 'say', action: 'say', goal_id: null, requests: [], why: 'hi' })
  const s = summarizeLeaderLog(log)
  assert.equal(s.stats.actionMix.plan_item, 1)
  assert.equal(s.stats.actionMix.say, 1)
  assert.equal(s.stats.actionMix.plan_steps, 0)
  assert.equal(s.stats.actionMix.edit, 0)
  assert.match(renderReport(s, 'gs2'), /\| plan_item \| 1 \|/)
})

// ---- Plans section ------------------------------------------------------------------------------------------------

// One plan of 3 steps read from meta.plans (the plan book's own saved state, the normal case): the first two steps
// are behind the cursor (done), the third is where the plan is stuck (blocked, with a reason).
function plansLog() {
  return {
    meta: {
      minutes: 10, end_reason: 'time', ended_t: 100,
      plans: [{
        id: 1, title: 'iron pickaxe parts', source: 'audience:alice',
        steps: [
          { kind: 'gather', arg: 'log', count: 4 },
          { kind: 'craft_item', arg: 'wooden_pickaxe', count: 1 },
          { kind: 'gather', arg: 'raw_iron', count: 3 },
        ],
        cursor: 2, status: 'blocked', t: 5, end_t: 60, reason: 'stuck',
      }],
    },
    events: [], decisions: [], leader: [],
  }
}

test('plansSummary: one plan of 3 steps, one blocked, read from meta.plans', () => {
  const s = summarizeLeaderLog(plansLog())
  assert.equal(s.plans.length, 1)
  assert.equal(s.plans[0].id, 1)
  assert.equal(s.plans[0].title, 'iron pickaxe parts')
  assert.equal(s.plans[0].source, 'audience:alice')
  assert.deepEqual(s.plans[0].steps.map(x => x.outcome), ['done', 'done', 'blocked (stuck)'])
  assert.equal(s.plans[0].end, 'blocked at 60.0s (step 3): stuck')
})

test('renderReport: the Plans section lists the plan, its step outcomes and end state', () => {
  const md = renderReport(summarizeLeaderLog(plansLog()), 'plansrun')
  assert.match(md, /## Plans/)
  assert.match(md, /#1 iron pickaxe parts \(source: audience:alice, added 5\.0s\)/)
  assert.match(md, /\| 1\. gather 4 log \| done \|/)
  assert.match(md, /\| 3\. mine 3 raw iron \| blocked \(stuck\) \|/)
  assert.match(md, /end state: blocked at 60\.0s \(step 3\): stuck/)
})

test('plansSummary: falls back to the plan_* events when meta.plans is missing (a crash before finish() wrote it)', () => {
  const json = {
    meta: { minutes: 10, end_reason: 'crash: x', ended_t: 100 },
    events: [
      { t: 5, kind: 'plan_added', plan: { id: 1, title: 'wooden pickaxe', source: 'leader', steps: [
        { kind: 'gather', arg: 'log', count: 2 }, { kind: 'craft_item', arg: 'wooden_pickaxe', count: 1 } ] }, why: null },
      { t: 10, kind: 'plan_step', plan_id: 1, step_index: 0, of: 2, step: { kind: 'gather', arg: 'log', count: 2 }, goal_id: 1, target: 2 },
      { t: 20, kind: 'plan_step', plan_id: 1, step_index: 1, of: 2, step: { kind: 'craft_item', arg: 'wooden_pickaxe', count: 1 }, goal_id: 2, target: 1 },
    ],
    decisions: [], leader: [],
  }
  const s = summarizeLeaderLog(json)
  assert.equal(s.plans.length, 1)
  assert.deepEqual(s.plans[0].steps.map(x => x.outcome), ['done', 'running'])
  assert.equal(s.plans[0].end, 'open')
})

test('plansSummary: a run with no plans gives an empty list, and the report says (none)', () => {
  const s = summarizeLeaderLog(syntheticLog())
  assert.deepEqual(s.plans, [])
  const md = renderReport(s, 'x')
  assert.match(md, /## Plans\n\n\(none\)/)
})

test('renderPlansSection: (none) for an empty or missing list', () => {
  assert.match(renderPlansSection([]), /\(none\)/)
  assert.match(renderPlansSection(), /\(none\)/)
})

// ---- Motor backlog section -----------------------------------------------------------------------------------

test('renderMotorBacklogSection: (none) with no entries', () => {
  assert.match(renderMotorBacklogSection([]), /\(none\)/)
  assert.match(renderMotorBacklogSection(), /\(none\)/)
})

test('renderMotorBacklogSection: renders one row per unserved request', () => {
  const entries = [
    { t: 12.3, kind: 'cannot', why: 'no village detector yet', name: 'bob', text: 'find a village' },
    { t: 40, kind: 'plan_item', item: 'diamond_pickaxe', count: 1, missing: ['diamond'], name: 'alice', text: 'make a diamond pickaxe', why: null },
  ]
  const md = renderMotorBacklogSection(entries)
  assert.match(md, /## Motor backlog/)
  assert.match(md, /\| 12\.3s \| bob \| find a village \| no village detector yet \|/)
  assert.match(md, /\| 40\.0s \| alice \| make a diamond pickaxe \| missing: diamond \|/)
})

test('renderReport: wires the requestLines option into the Motor backlog section', () => {
  const s = summarizeLeaderLog(syntheticLog())
  const withNone = renderReport(s, 'x')
  assert.match(withNone, /## Motor backlog\n\n\(none\)/)
  const withEntries = renderReport(s, 'x', { requestLines: [{ t: 1, kind: 'cannot', why: 'no', name: 'a', text: 'b' }] })
  assert.match(withEntries, /## Motor backlog/)
  assert.match(withEntries, /\| a \| b \| no \|/)
})
