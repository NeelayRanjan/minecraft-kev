// The status page (--status-port <n>): one static HTML page that polls /state.json every second and shows the plans,
// the goal stack, the current subtask, kev's forecasts, the recent chat, the leader's last decisions and the plugins.
// node:http only; the page has inline CSS and JS and loads nothing else. getState() is the runner's (a throw answers 500).
import http from 'node:http'

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>kev status</title>
<style>
  :root { --bg: #14161a; --panel: #1d2026; --fg: #e4e6ea; --dim: #8b9099; --ok: #6cc97a; --run: #e8c35a; --bad: #e0685f; --line: #2c3038; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  h1 small { color: var(--dim); font-weight: 400; margin-left: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; min-width: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 0 0 8px; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 2px 0; overflow-wrap: anywhere; }
  .plan { margin-bottom: 10px; }
  .plan-title { font-weight: 600; }
  .st { display: inline-block; width: 1.4em; text-align: center; }
  .done { color: var(--ok); } .running { color: var(--run); } .blocked { color: var(--bad); } .pending, .skipped, .dropped { color: var(--dim); }
  .dim { color: var(--dim); }
  .bar { display: inline-block; height: 8px; background: var(--run); border-radius: 2px; vertical-align: middle; margin-right: 6px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 2px 6px 2px 0; vertical-align: top; overflow-wrap: anywhere; }
  td.num { text-align: right; white-space: nowrap; color: var(--dim); }
  #err { color: var(--bad); }
</style></head>
<body>
<h1>kev <small id="clock">connecting...</small> <small id="err"></small></h1>
<div class="grid">
  <section><h2>Plans</h2><div id="plans"></div></section>
  <section><h2>Goal stack</h2><div id="stack"></div></section>
  <section><h2>Current subtask</h2><div id="current"></div><h2 style="margin-top:12px">kev forecasts</h2><div id="forecasts"></div></section>
  <section><h2>Chat</h2><ul id="chat"></ul></section>
  <section><h2>Leader decisions</h2><ul id="leader"></ul></section>
  <section><h2>Plugins</h2><ul id="plugins"></ul></section>
</div>
<script>
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ts = t => t == null ? '' : 't=' + Math.round(t) + 's';
const MARK = { done: '\\u2713', running: '\\u25b6', pending: '\\u00b7', blocked: '\\u2717', skipped: '\\u21b7' };
function stepText(s) { return [s.kind, s.arg, s.count != null ? 'x' + s.count : null, s.from ? 'from ' + s.from : null].filter(x => x != null).join(' ').replace(/_/g, ' '); }
function stepState(p, i) {
  const s = p.steps[i];
  if (s.skipped) return 'skipped';
  if (i < p.cursor) return 'done';
  if (i === p.cursor) return p.status === 'blocked' ? 'blocked' : p.status === 'running' ? 'running' : p.status === 'done' ? 'done' : 'pending';
  return p.status === 'done' ? 'done' : 'pending';
}
function render(s) {
  $('clock').textContent = ts(s.t);
  const plans = s.plans || [];
  $('plans').innerHTML = plans.length ? plans.slice().reverse().map(p =>
    '<div class="plan"><div class="plan-title ' + esc(p.status) + '">#' + p.id + ' ' + esc(p.title) + ' <span class="dim">(' + esc(p.status) +
    (p.reason ? ': ' + esc(p.reason) : '') + (p.source ? ', ' + esc(p.source) : '') + ')</span></div><ul>' +
    p.steps.map((st, i) => { const k = stepState(p, i); return '<li class="' + k + '"><span class="st">' + MARK[k] + '</span>' + (i + 1) + '. ' + esc(stepText(st)) + '</li>'; }).join('') +
    '</ul></div>').join('') : '<span class="dim">no plans</span>';
  const st = s.stack || {};
  $('stack').innerHTML = '<ul>' + (st.pushed || []).map(g => '<li><b>#' + g.id + '</b> ' + esc(stepText(g)) + ' <span class="dim">' + esc(g.source) +
    (g.plan_id != null ? ', plan #' + g.plan_id + ' step ' + (g.step_index + 1) : '') + '</span><br><span class="dim">' + esc(g.progress) + '</span></li>').join('') +
    '<li class="dim">' + esc(st.text || '(chain only)') + '</li></ul>';
  const c = s.current;
  $('current').innerHTML = c && c.id ? '<b>' + esc(c.id) + '</b> ' + Math.round(c.elapsedS || 0) + ' s' + (c.progress != null ? ', ' + Math.round(c.progress * 100) + '% done' : '') : '<span class="dim">idle</span>';
  const f = s.forecasts || {};
  const fk = Object.keys(f);
  $('forecasts').innerHTML = fk.length ? '<table>' + fk.map(k => { const p = Math.round(100 * f[k]); return '<tr><td>' + esc(k.replace(/_/g, ' ')) + '</td><td class="num"><span class="bar" style="width:' + p + 'px"></span>' + p + '%</td></tr>'; }).join('') + '</table>' : '<span class="dim">none</span>';
  $('chat').innerHTML = (s.chat || []).map(m => '<li><span class="dim">' + ts(m.t) + '</span> <b>' + esc(m.name) + '</b>: ' + esc(m.text) + '</li>').join('') || '<li class="dim">no chat</li>';
  $('leader').innerHTML = (s.leader || []).slice().reverse().map(l => '<li><span class="dim">' + ts(l.t) + '</span> <b>' + esc(l.action || '(none)') + '</b>' +
    (l.kind && l.kind !== l.action ? ' <span class="dim">(' + esc(l.kind) + ')</span>' : '') + (l.why ? ': ' + esc(l.why) : '') + '</li>').join('') || '<li class="dim">no calls yet</li>';
  $('plugins').innerHTML = (s.plugins || []).map(p => '<li class="' + (p.enabled ? 'done' : 'blocked') + '">' + esc(p.id) + (p.timeout ? ' <span class="dim">' + p.timeout + ' s</span>' : '') +
    (p.error ? ' <span class="blocked">' + esc(p.error) + '</span>' : '') + '</li>').join('') || '<li class="dim">none loaded</li>';
}
async function poll() {
  try { const r = await fetch('state.json', { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); render(await r.json()); $('err').textContent = ''; }
  catch (e) { $('err').textContent = 'no state: ' + e.message; }
  setTimeout(poll, 1000);
}
poll();
</script>
</body></html>
`

// Resolves { port, close } once listening (port 0: an ephemeral port); rejects when the port is taken.
export function startStatusServer({ port, getState, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    if (url === '/state.json') {
      let body
      try { body = JSON.stringify(getState()) } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`state failed: ${e?.message || e}`); return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return
    }
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', () => {})
      resolve({ port: server.address().port, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }) })
    })
  })
}
