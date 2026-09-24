// The tiny HTTP client for kev.serve's TypeSafe-compatible endpoint (same contract as the parent project's kev_client.py).
export async function ask(url, state, questions, { model = 'kev-latest', timeoutMs = 120_000 } = {}) {
  const t0 = Date.now()
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({ state, model, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`kev ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  body.latency_ms = body.latency_ms ?? Date.now() - t0
  return body
}

export async function models(url) {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { headers: { authorization: 'Bearer local' } })
  return res.json()
}
