#!/usr/bin/env node
// Video replay bench for the LLM leader: replays a stratified sample of a logged leader run's calls through
// candidate leaders, text only or with the last 120 s of the bot's first-person video (a 6x6 mosaic, or the frames).
//
//   node scripts/video_bench.mjs --run leader_events_s3000 --n 40 --out reports/video_bench/leader_events_s3000/
//        extracts frames (data/video_bench/<run>/frames/, cached), builds one mosaic per call and calls.jsonl
//   node scripts/video_bench.mjs --run <run> --ask text27b|vl_text|vl_mosaic|vl_frames [--vl-model qwen3-vl:8b] [--url ...]
//        runs one arm over calls.jsonl, appending to answers_<arm>.jsonl (resumable)
//   node scripts/video_bench.mjs --run <run> --out reports/video_bench/<run>/ --report [--no-describe]
//        the arm table and eight close-ups; asks the vl model to describe the eight mosaics (cached) unless --no-describe
//
// Alignment: the recorder drops frames when the event loop stalls, so frame k is not at k/5 s (run 1 drifts ~4 min
// by the end). The script aligns the video to the log (camera motion vs scene change, agent/video_bench.js alignLag),
// writes data/video_bench/<run>/timemap.json and extracts frames at the aligned video times; --no-align uses k/5.
// The frames are always kept (frame_paths in calls.jsonl, for the vl_frames arm); --frames-list is accepted for that.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LEADER_SYSTEM, leaderSchema, parseLeaderAnswer } from '../agent/leader.js'
import { frameSchedule, mosaicLayout, ageLabel, sampleCalls, rebuildLeaderInput, lastResults, scoreArm, pickShowcase,
  motionSeries, videoSeries, alignLag, videoTime, VIDEO_NOTE, FRAMES_NOTE, MOSAIC_SIZE, VIDEO_FPS } from '../agent/video_bench.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flag = k => argv.includes(`--${k}`)

const run = arg('run', 'leader_events_s3000')
const n = Number(arg('n', 40))
const outDir = path.resolve(ROOT, arg('out', `reports/video_bench/${run}/`))
const dataDir = path.join(ROOT, 'data/video_bench', run)
const framesDir = path.join(dataDir, 'frames')
const callsPath = path.join(dataDir, 'calls.jsonl')
const url = (arg('url', 'http://100.109.91.95:11434')).replace(/\/$/, '')
const vlModel = arg('vl-model', 'qwen3-vl:8b')
const ARMS = {
  text27b: { model: arg('text-model', 'qwen38-27b-iq2s'), images: null, numCtx: 4096 },
  vl_text: { model: vlModel, images: null, numCtx: 8192 },
  vl_mosaic: { model: vlModel, images: 'mosaic', numCtx: 8192 },
  vl_frames: { model: vlModel, images: 'frames', numCtx: 16384 },
}

const readJsonl = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const tkey = t => t.toFixed(1)
const framePath = vt => path.join(framesDir, `f_${tkey(vt)}.jpg`)   // named by VIDEO time
const mosaicPath = t => path.join(dataDir, `mosaic_${tkey(t)}.jpg`)
const rel = p => path.relative(ROOT, p)

function ffmpegFrame(video, t, dst) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(1), '-i', video, '-frames:v', '1', '-q:v', '4', dst], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''; p.stderr.on('data', d => { err += d })
    p.on('close', code => code === 0 && fs.existsSync(dst) ? resolve() : reject(new Error(`ffmpeg t=${t}: ${err.slice(0, 200)}`)))
  })
}

async function pool(items, k, fn) {
  let i = 0
  await Promise.all(Array.from({ length: k }, async () => { while (i < items.length) await fn(items[i++]) }))
}

let canvasMod = null
async function loadCanvas() {
  if (canvasMod !== null) return canvasMod
  try { canvasMod = await import('node-canvas-webgl') } catch { try { canvasMod = await import('canvas') } catch { canvasMod = false } }
  return canvasMod
}

async function buildMosaic(frames, dst) {
  const { cols, tile } = mosaicLayout(36)   // one fixed 6x6 grid, so every mosaic reads the same way; early calls leave the first tiles black
  const cv = await loadCanvas()
  const slots = 36 - frames.length
  if (cv) {
    const { createCanvas, loadImage } = cv.default?.createCanvas ? cv.default : cv
    const c = createCanvas(MOSAIC_SIZE, MOSAIC_SIZE), g = c.getContext('2d')
    g.fillStyle = '#000'; g.fillRect(0, 0, MOSAIC_SIZE, MOSAIC_SIZE)
    g.font = 'bold 22px sans-serif'; g.textBaseline = 'top'
    for (let i = 0; i < frames.length; i++) {
      const k = i + slots, x = (k % cols) * tile, y = Math.floor(k / cols) * tile
      g.drawImage(await loadImage(framePath(frames[i].video_t)), x, y, tile, tile)
      const label = ageLabel(frames[i].age), w = g.measureText(label).width
      g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(x + 3, y + 3, w + 10, 28)
      g.fillStyle = '#fff'; g.fillText(label, x + 8, y + 6)
    }
    fs.writeFileSync(dst, c.toBuffer('image/jpeg', { quality: 0.85 }))
    return
  }
  // fallback: ffmpeg tile filter over a concat list, label drawn per frame with drawtext
  const list = path.join(dataDir, `concat_${path.basename(dst)}.txt`)
  const blank = path.join(dataDir, 'blank.jpg')
  if (!fs.existsSync(blank)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=448x448', '-frames:v', '1', blank])
  fs.writeFileSync(list, [...Array(slots).fill(blank), ...frames.map(f => framePath(f.video_t))].map(p => `file '${p}'\nduration 1`).join('\n') + '\n')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${tile}:${tile},tile=${cols}x${cols}`, '-frames:v', '1', '-q:v', '3', dst])
  fs.rmSync(list)
}

async function prepare() {
  const t0 = Date.now()
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', `${run}.json`), 'utf8'))
  const video = path.join(ROOT, 'out', `${run}.mp4`)
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim())
  const maxT = dur - 1 / VIDEO_FPS
  fs.mkdirSync(framesDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  const align = flag('no-align') ? null : timeMap(json, video, dur)
  const lastT = align ? json.meta?.ended_t ?? Infinity : maxT
  const calls = sampleCalls(json, n, { maxT: lastT })
  const need = new Map()
  const sched = new Map(calls.map(c => [c.t_asked, frameSchedule(c.t_asked).filter(f => f.t_frame <= lastT)
    .map(f => ({ ...f, video_t: videoTime(f.t_frame, align?.lag, dur) }))]))
  for (const fr of sched.values()) for (const f of fr) need.set(tkey(f.video_t), f.video_t)
  const todo = [...need.values()].filter(t => !fs.existsSync(framePath(t)))
  let done = 0
  await pool(todo, 6, async t => { await ffmpegFrame(video, t, framePath(t)); if (++done % 100 === 0) console.log(`  frames ${done}/${todo.length}`) })
  const tFrames = Date.now()
  const lines = []
  for (const c of calls) {
    const frames = sched.get(c.t_asked)
    const mp = mosaicPath(c.t_asked)
    if (!fs.existsSync(mp)) await buildMosaic(frames, mp)
    const { messages } = rebuildLeaderInput(json, c)
    lines.push(JSON.stringify({ t_asked: c.t_asked, stratum: c.stratum, outcome: c.outcome, current_id: c.current_id, offered: c.offered,
      run1_action: c.action, run1_kind: c.kind, run1_why: c.why, run1_latency_ms: c.latency_ms, teacher_label: c.teacher_label,
      last_results: lastResults(json.events, c.t_asked), system: messages[0].content, user: messages[1].content,
      mosaic_path: rel(mp), frame_paths: frames.map(f => rel(framePath(f.video_t))), frame_ages: frames.map(f => f.age),
      frame_video_t: frames.map(f => f.video_t) }))
  }
  fs.writeFileSync(callsPath, lines.join('\n') + '\n')
  const strata = {}; for (const c of calls) strata[c.stratum] = (strata[c.stratum] || 0) + 1
  const summary = { run, video_s: dur, episode_s: json.meta?.ended_t, aligned: !!align,
    ...(align ? { align_score: +align.score.toFixed(0), unaligned_score: +align.score0.toFixed(0), lag_s: Object.fromEntries([600, 1200, 1800, 2400, 3000, 3300].map(t => [t, align.lag[t]])) } : {}), calls: calls.length, strata, frames_needed: need.size, frames_extracted: todo.length,
    extract_s: +((tFrames - t0) / 1000).toFixed(1), total_s: +((Date.now() - t0) / 1000).toFixed(1), canvas: (await loadCanvas()) ? 'node-canvas' : 'ffmpeg tile',
    calls_jsonl: rel(callsPath) }
  console.log(JSON.stringify(summary, null, 1))
}

// Per-frame scene scores (cached), then the lag per episode second (cached in timemap.json).
function timeMap(json, video, dur) {
  const p = path.join(dataDir, 'timemap.json')
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  const sp = path.join(dataDir, 'scene_scores.txt')
  if (!fs.existsSync(sp)) execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=112:112,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=${sp}`, '-f', 'null', '-'])
  const scores = []; for (const l of fs.readFileSync(sp, 'utf8').split('\n')) { const m = /scene_score=([0-9.]+)/.exec(l); if (m) scores.push(+m[1]) }
  const T = Math.ceil(json.meta?.ended_t ?? dur)
  const { lag, score, score0 } = alignLag(motionSeries(json.frames, T), videoSeries(scores), { maxLag: Math.max(60, Math.ceil(T - dur) + 120), pen: 0.1 })
  const out = { method: 'camera motion (json.frames) vs scene change (ffmpeg), monotone DP, pen 0.1', video_s: dur, episode_s: T, score, score0, lag }
  fs.writeFileSync(p, JSON.stringify(out))
  return out
}

function requestBody(arm, call) {
  const a = ARMS[arm]
  const options = call.offered.map(id => ({ id }))
  const b64 = p => fs.readFileSync(path.join(ROOT, p)).toString('base64')
  let user = call.user, images
  if (a.images === 'mosaic') { user = `${VIDEO_NOTE}\n\n${user}`; images = [b64(call.mosaic_path)] }
  if (a.images === 'frames') { user = `${FRAMES_NOTE.replace('AGES', call.frame_ages.map(ageLabel).join(', '))}\n\n${user}`; images = call.frame_paths.map(b64) }
  const messages = [{ role: 'system', content: call.system ?? LEADER_SYSTEM }, { role: 'user', content: user, ...(images ? { images } : {}) }]
  return { model: a.model, messages, stream: false, format: leaderSchema(options), think: false,
    options: { temperature: 0.2, num_predict: 200, num_ctx: a.numCtx }, keep_alive: '30m' }
}

async function post(body, timeoutMs = 180_000) {
  const res = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function ask(arm) {
  if (!ARMS[arm]) throw new Error(`unknown arm ${arm}; one of ${Object.keys(ARMS).join(', ')}`)
  const calls = readJsonl(callsPath)
  if (!calls.length) throw new Error(`no ${rel(callsPath)}: run the extraction first`)
  const outPath = path.join(dataDir, `answers_${arm}.jsonl`)
  const have = new Set(readJsonl(outPath).map(r => tkey(r.t_asked)))
  console.log(`${arm} (${ARMS[arm].model}): ${calls.length - have.size} calls to ask, ${have.size} already answered`)
  for (const c of calls) {
    if (have.has(tkey(c.t_asked))) continue
    const t0 = Date.now()
    let row
    try {
      const body = await post(requestBody(arm, c))
      const raw = body?.message?.content ?? ''
      const { action, why } = parseLeaderAnswer(raw, c.offered.map(id => ({ id })))
      row = { t_asked: c.t_asked, arm, model: ARMS[arm].model, action, why, raw: raw.slice(0, 400), latency_ms: Date.now() - t0,
        prompt_tokens: body?.prompt_eval_count ?? null, tokens: body?.eval_count ?? null, truncated: body?.done_reason === 'length', error: null }
    } catch (e) {
      row = { t_asked: c.t_asked, arm, model: ARMS[arm].model, action: null, why: '', latency_ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) }
    }
    fs.appendFileSync(outPath, JSON.stringify(row) + '\n')
    console.log(`  t=${c.t_asked} ${c.current_id} -> ${row.action ?? 'ERR ' + row.error} (${row.latency_ms} ms${row.prompt_tokens ? `, ${row.prompt_tokens} prompt tok` : ''})`)
  }
}

async function describe(calls) {
  const p = path.join(dataDir, 'describe_vl_mosaic.jsonl')
  const have = new Map(readJsonl(p).map(r => [tkey(r.t_asked), r]))
  for (const c of calls) {
    if (have.has(tkey(c.t_asked))) continue
    const t0 = Date.now()
    let row
    try {
      const body = await post({ model: vlModel, stream: false, think: false, keep_alive: '30m', options: { temperature: 0.2, num_predict: 120, num_ctx: 8192 },
        messages: [{ role: 'user', content: `${VIDEO_NOTE}\n\nDescribe in two sentences what the bot has been doing in this video.`, images: [fs.readFileSync(path.join(ROOT, c.mosaic_path)).toString('base64')] }] })
      row = { t_asked: c.t_asked, text: (body?.message?.content ?? '').trim(), latency_ms: Date.now() - t0 }
    } catch (e) { row = { t_asked: c.t_asked, text: null, error: String(e.message || e).slice(0, 300) } }
    fs.appendFileSync(p, JSON.stringify(row) + '\n'); have.set(tkey(c.t_asked), row)
  }
  return have
}

async function report() {
  const calls = readJsonl(callsPath)
  const byT = new Map(calls.map(c => [tkey(c.t_asked), c]))
  const answers = {}
  for (const arm of Object.keys(ARMS)) { const rows = readJsonl(path.join(dataDir, `answers_${arm}.jsonl`)); if (rows.length) answers[arm] = new Map(rows.map(r => [tkey(r.t_asked), r])) }
  const rowsFor = get => calls.map(c => ({ ...c, answer: get(c) })).filter(r => r.answer)
  const table = [['run 1 (live, iq3xxs)', scoreArm(rowsFor(c => ({ action: c.run1_action, latency_ms: c.run1_latency_ms }))), calls.length]]
  for (const [arm, m] of Object.entries(answers)) table.push([`${arm} (${[...m.values()][0].model})`, scoreArm(rowsFor(c => m.get(tkey(c.t_asked)))), calls.length])
  const f = x => x == null ? '-' : x.toFixed(2)
  const strata = {}; for (const c of calls) strata[c.stratum] = (strata[c.stratum] || 0) + 1
  const L = [`# Video replay bench: ${run}`, '',
    `${calls.length} leader calls from run 1 (strata: ${Object.entries(strata).map(([k, v]) => `${k} ${v}`).join(', ')}), replayed with the live prompt rebuilt from the log.`,
    'Vision arms add the last 120 s of first-person video (36 frames: 1 per 10 s, then 1 per 4 s, then 1 per s for the last 20 s).', '',
    '| arm | answered | valid | agrees with teacher | same as run 1 | bad re-push | left a threat response | latency p50 |', '|---|---|---|---|---|---|---|---|']
  for (const [name, s] of table) L.push(`| ${name} | ${s.n}/${calls.length} | ${f(s.valid)} | ${f(s.agree_teacher)} | ${f(s.same_as_run1)} | ${s.bad_repush} | ${s.left_threat} of ${s.threat_n} | ${s.latency_p50 == null ? '-' : (s.latency_p50 / 1000).toFixed(1) + ' s'} |`)
  L.push('', 'Agreement compares the subtask each answer leads to (continue = keep the current one). Bad re-push: picking a subtask whose last attempt failed to path. Left a threat response: a non-threat subtask while fleeing, fighting or pillaring.', '')
  const show = pickShowcase(calls)
  const desc = flag('no-describe') ? new Map() : await describe(show)
  L.push('## Close-ups', '')
  for (const c of show) {
    L.push(`### t = ${c.t_asked} s (${c.stratum}${c.outcome ? `, run 1's override ended ${c.outcome}` : ''})`, '',
      `![mosaic](${path.relative(outDir, path.join(ROOT, c.mosaic_path))})`, '',
      `current: \`${c.current_id}\`; teacher: \`${c.teacher_label ?? '-'}\``, '',
      `- run 1: \`${c.run1_action}\` (${c.run1_kind}): ${c.run1_why || ''}`)
    for (const [arm, m] of Object.entries(answers)) { const a = m.get(tkey(c.t_asked)); if (a) L.push(`- ${arm}: \`${a.action ?? 'invalid'}\`${a.error ? ` (error: ${a.error})` : ''}: ${a.why || ''}`) }
    L.push('')
  }
  if (desc.size) {
    L.push('## What it saw (vl_mosaic, asked to describe the mosaic, no schema)', '')
    for (const c of show) { const d = desc.get(tkey(c.t_asked)); L.push(`- t = ${c.t_asked} s: ${d?.text ?? `(error: ${d?.error})`}`) }
    L.push('')
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'))
  console.log(`wrote ${rel(path.join(outDir, 'report.md'))}`)
}

if (arg('ask')) await ask(arg('ask'))
else if (flag('report')) await report()
else await prepare()
