// The LLM leader (milestone 2 shape): at every decision point it sees the same state text kev sees, plus recent
// history and kev's forecasts, and picks exactly one subtask id from the offered list. Output is JSON validated
// against the options; nothing else is parsed. Talks to a local Ollama server (/api/chat).
// askLeader (chain mode, agent/leader.js) uses the same transport for the supervising leader: continue or override.
import crypto from 'node:crypto'
import { buildLeaderMessages, leaderSchema, parseLeaderAnswer } from './leader.js'

export const SYSTEM = `You lead a Minecraft survival bot. Its goal is an iron pickaxe, then surviving the night.
Each turn you get the bot's state, what it did recently and how that went, its own forecasts, and the subtasks it can do right now.
Pick exactly one subtask id from the offered list.

Tech tree and exact quantities (do not gather more than needed):
1. gather_wood until you hold 5 logs in total (logs + planks/4). 1 log -> 4 planks. 2 planks -> 4 sticks.
2. craft(planks), then craft(crafting_table) (4 planks).
3. craft(sticks), then craft(wooden_pickaxe) (3 planks + 2 sticks, at a table).
4. mine_stone until 11 cobblestone, then craft(stone_pickaxe) (3 cobblestone + 2 sticks).
5. mine_iron until 3 raw iron (iron ore needs a stone pickaxe). explore_toward(down) or explore_toward(cave) if no iron is known; mine_coal for fuel if coal is close.
6. craft(furnace) (8 cobblestone), then smelt(iron_ingot) (needs raw iron and fuel: coal, planks or logs).
7. craft(iron_pickaxe) (3 iron ingots + 2 sticks).
The state's "step k of 7" line says which step is next; follow it unless a threat or a repeated failure calls for something else.
The offered list already excludes gathering that is not needed: if gather_wood is offered, more wood is still needed; if it is not offered, you have enough.
Rules: if a subtask keeps failing the same way, do something different that changes the situation (move, go back to the table, gather what is missing). Flee creepers; fight weak mobs only at good health; at night underground is safer than the surface.
Answer with JSON only: {"subtask": "<id from the list>", "why": "<one short sentence>"}`

export const answerSchema = options => ({
  type: 'object',
  properties: { subtask: { type: 'string', enum: options.map(o => o.id) }, why: { type: 'string' } },
  required: ['subtask'],
})

export function buildPlannerMessages({ stateText, options, history = [], forecasts = {} }) {
  // a goal-stack goal_done (it carries e.goal) is not the episode goal; only the chain's / the pickaxe's reads GOAL REACHED
  const hist = history.filter(e => !(e.kind === 'goal_done' && e.goal)).slice(-12).map(e => {
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

export async function askPlanner({ url = 'http://127.0.0.1:11434', model = 'qwen3:4b', timeoutMs = 60_000, think = false, numPredict = 120, numCtx = 2048, ...ctx }) {
  const t0 = Date.now()
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // format = JSON schema: Ollama constrains decoding so "subtask" is always one of the offered ids (a small model given
    // the whole state otherwise often echoes the state back as JSON). 2048 ctx keeps the 4B model at ~2.9 GB on the GPU.
    body: JSON.stringify({ model, messages: buildPlannerMessages(ctx), stream: false, format: answerSchema(ctx.options), think, options: { temperature: 0.2, num_predict: numPredict, num_ctx: numCtx }, keep_alive: '60m' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`planner ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const raw = body?.message?.content ?? ''
  return { ...(parsePlannerAnswer(raw, ctx.options) || { id: null, why: '' }), raw: raw.slice(0, 400), latency_ms: Date.now() - t0,
    tokens: body?.eval_count ?? null, thinking_chars: body?.message?.thinking?.length ?? 0,
    tps: body?.eval_count && body?.eval_duration ? body.eval_count / (body.eval_duration / 1e9) : null }
}

// The leader call: messages from leader.js, the answer constrained to {"action": "continue" | offered id, "why"}.
// With think the model reasons first (Ollama returns it as message.thinking, kept up to 4000 chars for the log);
// num_predict covers the thinking too, so it is larger. The caller sets a longer timeout for the very first call
// (the 27B model may still be loading).
export async function askLeader({ url = 'http://100.109.91.95:11434', model = 'qwen38-27b-iq3xxs', think = false, numPredict = think ? 1500 : 200, numCtx = 6144,   // goal-mode prompts with plans reach ~4.1k tokens (plans_smoke: one call over 4096 failed); 8192 cost ~5 GB of KV cache on the 27B and evicted the user's other model
  temperature = 0.2, timeoutMs = think ? 150_000 : 45_000, goals = false, ...ctx }) {
  // goals: the subgoals leader (schema and parser accept the goal and plan answers and return `goal` and the plan payload)
  const messages = buildLeaderMessages(ctx)
  const promptText = messages.map(m => m.content).join('\n')
  const t0 = Date.now()
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, format: leaderSchema(ctx.options, { goals }), think, options: { temperature, num_predict: numPredict, num_ctx: numCtx }, keep_alive: '90m' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`leader ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const raw = body?.message?.content ?? ''
  const { action, why, goal, ...plan } = parseLeaderAnswer(raw, ctx.options, { goals })   // plan: item | title + steps | edit | text | build | dig | blueprint
  // truncated: num_predict ran out (with thinking, usually inside the thinking, so the answer is empty -> invalid)
  return { action, why, ...(goals ? { goal, ...plan } : {}), truncated: body?.done_reason === 'length', raw: raw.slice(0, 400), thinking: (body?.message?.thinking ?? '').slice(0, 4000), latency_ms: Date.now() - t0,
    tokens: body?.eval_count ?? null, prompt_tokens: body?.prompt_eval_count ?? null,
    tps: body?.eval_count && body?.eval_duration ? body.eval_count / (body.eval_duration / 1e9) : null,
    prompt_chars: promptText.length, prompt_hash: crypto.createHash('sha1').update(promptText).digest('hex').slice(0, 12) }
}
