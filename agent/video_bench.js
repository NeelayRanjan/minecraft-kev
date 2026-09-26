// Offline "video replay bench" for the LLM leader (pure helpers; the I/O lives in scripts/video_bench.mjs).
// Idea: show a vision model the last two minutes of the bot's first-person video as a "moving average" (sparse
// frames for the distant past, dense near the present) beside the usual text prompt, and see whether it decides
// better than text alone, on a stratified sample of the calls a logged leader run actually made.
import { buildLeaderMessages, subtaskStats, THREAT_RESPONSES, PATH_FAILURES } from './leader.js'
import { DESC } from './subtasks.js'

export const VIDEO_FPS = 5
export const MOSAIC_SIZE = 1344
export const DEFAULT_TIERS = [[120, 60, 0.1], [60, 20, 0.25], [20, 0, 1]]
export const VIDEO_NOTE = 'VIDEO: a mosaic of the last 120 s seen through the bot\'s eyes, oldest top-left, newest bottom-right; each tile is labelled with its age in seconds. Note: the renderer draws no lighting (night looks like day) and only some mobs.'
export const FRAMES_NOTE = 'VIDEO: the attached images are frames of the last 120 s seen through the bot\'s eyes, oldest first, newest last; their ages in seconds, in the same order: AGES. Note: the renderer draws no lighting (night looks like day) and only some mobs.'

const round = (x, step) => Math.round(x / step) * step
const r1 = x => +x.toFixed(1)

// Frames to show for a call at episode time t: each tier [from, to, fps] samples ages in [to, from) at fps, ages
// beyond windowS are dropped, frame times snap to the video's 0.2 s grid and must be >= 0. Oldest first.
export function frameSchedule(t, { windowS = 120, tiers = DEFAULT_TIERS } = {}) {
  const out = new Map()
  for (const [from, to, fps] of tiers) {
    const n = Math.round((from - to) * fps)
    for (let k = 0; k < n; k++) {
      const age = to + k / fps
      if (age >= windowS || age >= from) continue
      const t_frame = r1(round(t - age, 1 / VIDEO_FPS))
      if (t_frame < 0) continue
      if (!out.has(t_frame)) out.set(t_frame, { t_frame, age: r1(t - t_frame) })
    }
  }
  return [...out.values()].sort((a, b) => a.t_frame - b.t_frame)
}

export function mosaicLayout(n, size = MOSAIC_SIZE) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  return { cols, rows: Math.max(1, Math.ceil(n / cols)), tile: Math.floor(size / cols) }
}

export const ageLabel = age => `-${Math.round(age)}s`

// The result of the first attempt of id that ended at or after t (the fate of an override), or null.
export function outcomeAfter(events, id, t) {
  const d = events.find(e => e.kind === 'subtask_done' && e.id === id && e.t >= t)
  return d ? d.result : null
}

// Per subtask id, the result of its last attempt that ended before t.
export function lastResults(events, t) {
  const out = {}
  for (const e of events) if (e.kind === 'subtask_done' && e.t < t) out[e.id] = e.result
  return out
}

// The teacher label of the nearest decision at or before t (decisions sorted by t).
export function teacherLabelAt(decisions, t) {
  let lab = null
  for (const d of decisions) { if (d.t > t) break; if (d.teacher_label != null) lab = d.teacher_label }
  return lab
}

const evenly = (xs, k) => {
  if (k <= 0) return []
  if (xs.length <= k) return xs.slice()
  return Array.from({ length: k }, (_, i) => xs[Math.floor((i + 0.5) * xs.length / k)])
}

// Stratified sample of json.leader: overrides whose target later ended no_path (cap 10), overrides away from
// fight/flee (cap 5), overrides that ended ok (10), then continue calls spread over time up to n. Each entry is the
// log's call plus {stratum, outcome, teacher_label}. maxT drops calls past the end of the video.
export function sampleCalls(json, n = 40, { maxT = Infinity, caps = { nopath: 10, threat: 5, ok: 10 } } = {}) {
  const events = json.events || [], decisions = json.decisions || []
  const calls = (json.leader || []).filter(l => l.t_asked <= maxT)
  const used = new Set(), picked = []
  const take = (xs, k, stratum) => {
    for (const l of evenly(xs.filter(l => !used.has(l)), k)) { used.add(l); picked.push({ l, stratum }) }
  }
  const overrides = calls.filter(l => l.kind === 'override' && l.id)
  const withOutcome = overrides.map(l => ({ l, outcome: outcomeAfter(events, l.id, l.t_answered ?? l.t_asked) }))
  const outcomeOf = new Map(withOutcome.map(x => [x.l, x.outcome]))
  take(withOutcome.filter(x => x.outcome === 'no_path').map(x => x.l), caps.nopath, 'nopath')
  take(overrides.filter(l => l.current_id === 'fight(threat)' || l.current_id === 'flee(threat)'), caps.threat, 'threat')
  take(withOutcome.filter(x => x.outcome === 'ok').map(x => x.l), caps.ok, 'ok')
  take(calls.filter(l => l.kind === 'continue'), Math.max(0, n - picked.length), 'continue')
  return picked.slice(0, n).map(({ l, stratum }) => ({ ...l, stratum, outcome: outcomeOf.get(l) ?? null, teacher_label: teacherLabelAt(decisions, l.t_asked) }))
    .sort((a, b) => a.t_asked - b.t_asked)
}

// kev's forecasts in the leader prompt's form, from a decision's answers.
export function forecastsOf(a = {}) {
  const o = {}
  for (const q of ['subgoal_succeeds_60s', 'iron_found_3min', 'survive_until_morning']) if (a[q]?.probabilities) o[q] = a[q].probabilities.true
  if (a.damage_next_20s?.probabilities) o.damage_major_or_death = (a.damage_next_20s.probabilities[2] || 0) + (a.damage_next_20s.probabilities[3] || 0)
  return o
}

// The buildLeaderMessages inputs for a logged call, rebuilt from the log (as the runner built them at t_asked,
// except `need`, which the log does not keep), and the messages themselves.
export function rebuildLeaderInput(json, call, { minutes = json.meta?.minutes ?? 60 } = {}) {
  const t = call.t_asked
  const decs = json.decisions.filter(d => d.t <= t)
  const d = decs[decs.length - 1]
  const hist = json.events.filter(e => e.t <= t)
  const starts = hist.filter(e => e.kind === 'subtask_start'); const st = starts[starts.length - 1]
  const trend = {}
  for (const x of decs.slice(-5)) for (const [q, p] of Object.entries(forecastsOf(x.answers || {}))) (trend[q] ||= []).push(+p.toFixed(3))
  const lastDec = decs.filter(x => x.decision).pop()
  const kevPick = lastDec?.answers?.next_subtask?.probabilities
    ? { t: lastDec.t, top: Object.entries(lastDec.answers.next_subtask.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) } : null
  const dones = hist.filter(e => e.kind === 'subtask_done'); const ld = dones[dones.length - 1]
  const own = json.leader.filter(l => l.t_asked < t).slice(-5).map(l => ({ t: l.t_asked, action: l.action, kind: l.kind, why: l.why }))
  const input = {
    stateText: d.state_text, chainText: d.state_text.split('\n')[0].replace(/^Minecraft survival, day \d+\. /, ''), need: null,
    options: call.offered.map(id => ({ id, desc: DESC[id] || '' })),
    current: { id: call.current_id, elapsedS: st ? t - st.t : 0, progress: null, lastResult: ld ? { id: ld.id, result: ld.result } : null },
    history: hist.slice(-300), forecasts: Object.fromEntries(Object.entries(trend).map(([q, h]) => [q, h[h.length - 1]])), forecastTrend: trend, kevPick,
    subtaskStats: subtaskStats(hist), ownHistory: own, minutesLeft: minutes - t / 60, deaths: hist.filter(e => e.kind === 'death').length,
    recentResults: dones.slice(-6).map(e => ({ id: e.id, result: e.result })),
  }
  return { input, messages: buildLeaderMessages(input) }
}

// An answer as the subtask it leads to: continue (or naming the current subtask) keeps the current one.
export const effective = (action, currentId) => action == null ? null : action === 'continue' ? currentId : action

const median = xs => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const rate = (k, n) => n ? +(k / n).toFixed(3) : null

// rows: {current_id, offered, teacher_label, run1_action, last_results: {id: result}, answer: {action, why, latency_ms, error}}.
// valid: fraction of rows with an answer in the schema; agree_teacher / same_as_run1: over valid rows (with a label),
// comparing the subtask each answer leads to; bad_repush: answers naming an id whose last result before the call was a
// path failure (count); left_threat: answers leaving a threat response for a non-threat subtask (count, of threat_n).
export function scoreArm(rows) {
  const n = rows.length
  const ok = rows.filter(r => { const a = r.answer?.action; return a && !r.answer.error && (a === 'continue' || (r.offered || []).includes(a)) })
  const lab = ok.filter(r => r.teacher_label != null)
  const r1rows = ok.filter(r => r.run1_action != null)
  const bad = ok.filter(r => r.answer.action !== 'continue' && r.answer.action !== r.current_id && PATH_FAILURES.has((r.last_results || {})[r.answer.action]))
  const threat = ok.filter(r => THREAT_RESPONSES.has(r.current_id))
  const left = threat.filter(r => !['continue', 'fight(threat)', 'flee(threat)', 'pillar_up', r.current_id].includes(r.answer.action))
  return {
    n, valid: rate(ok.length, n),
    agree_teacher: rate(lab.filter(r => effective(r.answer.action, r.current_id) === r.teacher_label).length, lab.length),
    same_as_run1: rate(r1rows.filter(r => effective(r.answer.action, r.current_id) === effective(r.run1_action, r.current_id)).length, r1rows.length),
    bad_repush: bad.length, left_threat: left.length, threat_n: threat.length,
    latency_p50: median(rows.map(r => r.answer?.latency_ms)),
  }
}

// The report's eight close-up calls: up to 2 threat ones, no-path ones up to 5 in all, then 3 continues spread in time.
export function pickShowcase(calls, { hard = 5, soft = 3 } = {}) {
  const threat = calls.filter(c => c.stratum === 'threat').slice(0, 2)
  const nopath = evenly(calls.filter(c => c.stratum === 'nopath'), hard - threat.length)
  const first = [...threat, ...nopath]
  const rest = evenly(calls.filter(c => c.stratum === 'continue'), soft)
  return [...first, ...rest].sort((a, b) => a.t_asked - b.t_asked)
}

// ---- video/episode alignment ------------------------------------------------------------------------------------
// The recorder renders on a setInterval, so every stall of the event loop drops frames: frame k is NOT at k/fps s.
// (Run 1: 16,695 frames for a 3,601 s episode; the video runs up to ~4 min behind by the end.) The lag is recovered
// from the log: camera turning (yaw/pitch change per second in json.frames) against the video's per-second scene
// change, aligned by a monotone path (the lag never shrinks and grows by at most 1 s per s: frames are only dropped).

const zscore = a => { const m = a.reduce((p, q) => p + q, 0) / a.length; const sd = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length) || 1; return a.map(x => (x - m) / sd) }

// Camera motion per episode second (log-compressed, z-scored) from json.frames {t, yaw, pitch}.
export function motionSeries(frames, T) {
  const mot = new Array(T).fill(0)
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i], s = Math.floor(b.t)
    if (s < 0 || s >= T) continue
    let dy = Math.abs(b.yaw - a.yaw); dy = Math.min(dy, 2 * Math.PI - dy)
    mot[s] = (dy + Math.abs(b.pitch - a.pitch)) / Math.max(0.2, b.t - a.t)
  }
  return zscore(mot.map(x => Math.log1p(x * 5)))
}

// Scene change per video second (log-compressed, z-scored) from per-frame scene scores.
export function videoSeries(scores, fps = VIDEO_FPS) {
  const out = []
  for (let v = 0; (v + 1) * fps <= scores.length; v++) { let y = 0; for (let k = v * fps; k < (v + 1) * fps; k++) y += scores[k]; out.push(Math.log1p(y * 20)) }
  return zscore(out)
}

// lag[s] (episode second s is shown at video second s - lag[s]) maximising sum motion[s] * video[s - lag[s]], with
// lag[0..] nondecreasing by 0 or 1 per second and `pen` per increment. Also the score of the path and of lag 0.
export function alignLag(motion, video, { maxLag = 400, pen = 0.1 } = {}) {
  const T = motion.length, L = maxLag, NEG = -Infinity
  let prev = new Float64Array(L + 1).fill(NEG); prev[0] = 0
  const back = []
  for (let s = 0; s < T; s++) {
    const cur = new Float64Array(L + 1).fill(NEG), bk = new Uint8Array(L + 1)
    for (let l = 0; l <= L; l++) {
      let best = prev[l], b = 0
      if (l > 0 && prev[l - 1] - pen > best) { best = prev[l - 1] - pen; b = 1 }
      if (best === NEG) continue
      const v = s - l
      cur[l] = best + (v >= 0 && v < video.length ? motion[s] * video[v] : 0); bk[l] = b
    }
    back.push(bk); prev = cur
  }
  let l = 0; for (let k = 0; k <= L; k++) if (prev[k] > prev[l]) l = k
  const score = prev[l], lag = new Array(T)
  for (let s = T - 1; s >= 0; s--) { lag[s] = l; l -= back[s][l] }
  let score0 = 0; for (let s = 0; s < T && s < video.length; s++) score0 += motion[s] * video[s]
  return { lag, score, score0 }
}

// Video time (on the frame grid, clamped to the video) for episode time t, given lag per episode second.
export function videoTime(t, lag, videoS = Infinity) {
  const l = lag ? lag[Math.max(0, Math.min(lag.length - 1, Math.floor(t)))] : 0
  return r1(Math.max(0, Math.min(videoS - 1 / VIDEO_FPS, round(t - l, 1 / VIDEO_FPS))))
}
