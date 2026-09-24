// The LLM leader (milestone 2 shape): at every decision point it sees the same state text kev sees, plus recent
// history and kev's forecasts, and picks exactly one subtask id from the offered list. Output is JSON validated
// against the options; nothing else is parsed. Talks to a local Ollama server (/api/chat).

export const SYSTEM = `You lead a Minecraft survival bot. Its goal is an iron pickaxe, then surviving the night.
Each turn you get the bot's state, what it did recently and how that went, its own forecasts, and the subtasks it can do right now.
Pick exactly one subtask id from the offered list. Rules: if a subtask keeps failing the same way, do something different that changes the situation (move, make room, go back to the table, gather what is missing). Prefer progress on the tech tree; flee creepers; fight weak mobs only at good health.
Answer with JSON only: {"subtask": "<id from the list>", "why": "<one short sentence>"}`

export function buildPlannerMessages({ stateText, options, history = [], forecasts = {} }) {
  const hist = history.slice(-12).map(e => {
    if (e.kind === 'subtask_done') return `t=${Math.round(e.t)}s ${e.id} -> ${e.result}${e.repeats > 1 ? ` (${e.repeats} times in a row)` : ''}`
    if (e.kind === 'interrupt') return `t=${Math.round(e.t)}s interrupted: ${e.reason}`
    if (e.kind === 'death') return `t=${Math.round(e.t)}s DIED`
    if (e.kind === 'goal_done') return `t=${Math.round(e.t)}s GOAL REACHED`
    return `t=${Math.round(e.t)}s ${e.kind}`
  })
  const fc = Object.entries(forecasts).map(([q, p]) => `${q}: ${typeof p === 'number' ? p.toFixed(2) : p}`)
  const user = [
    'STATE', stateText, '',
    'RECENT HISTORY (oldest first)', hist.length ? hist.join('\n') : '(none yet)', '',
    "BOT'S OWN FORECASTS", fc.length ? fc.join('\n') : '(none)', '',
    'SUBTASKS OFFERED NOW', options.map(o => `- ${o.id}: ${o.desc}`).join('\n'), '',
    'Reply with JSON: {"subtask": "<id>", "why": "..."}',
  ].join('\n')
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
}

export function parsePlannerAnswer(text, options) {
  if (typeof text !== 'string') return null
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj
  try { obj = JSON.parse(s.slice(start, end + 1)) } catch { return null }
  const id = typeof obj.subtask === 'string' ? obj.subtask.trim() : null
  if (!id || !options.some(o => o.id === id)) return null
  return { id, why: typeof obj.why === 'string' ? obj.why.slice(0, 200) : '' }
}

export async function askPlanner({ url = 'http://127.0.0.1:11434', model = 'qwen3:4b', timeoutMs = 60_000, ...ctx }) {
  const t0 = Date.now()
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: buildPlannerMessages(ctx), stream: false, format: 'json', think: false, options: { temperature: 0.2, num_predict: 160 }, keep_alive: '30m' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`planner ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const raw = body?.message?.content ?? ''
  return { ...(parsePlannerAnswer(raw, ctx.options) || { id: null, why: '' }), raw: raw.slice(0, 400), latency_ms: Date.now() - t0 }
}
