// One Paper instance per (port, seed): servers/<port>/ is created from server/ (jar, eula, ops.json), the world is
// deleted, server.properties is rendered with the port and seed, the server is started and awaited until "Done".
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_DIR = path.join(ROOT, 'server')
export const JAR = 'paper-1.20.4-499.jar'

export function renderProperties(template, { port, seed }) {
  const set = (txt, key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm')
    return re.test(txt) ? txt.replace(re, `${key}=${val}`) : txt + (txt.endsWith('\n') || txt === '' ? '' : '\n') + `${key}=${val}\n`
  }
  return set(set(template, 'server-port', port), 'level-seed', seed)
}

export function javaBin() {
  const tools = path.join(ROOT, 'tools')
  const jdk = fs.existsSync(tools) && fs.readdirSync(tools).find(d => d.startsWith('jdk-21'))
  return jdk ? path.join(tools, jdk, 'bin', 'java') : 'java'
}

// A previous run that crashed leaves its (detached) server alive; server.pid lets the next start on this port reclaim it.
export function killStale(dir, log = () => {}) {
  const pidFile = path.join(dir, 'server.pid')
  if (!fs.existsSync(pidFile)) return
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  try { process.kill(pid, 0) } catch { fs.rmSync(pidFile, { force: true }); return }
  log(`killing stale server pid ${pid} in ${dir}`)
  try { process.kill(pid, 'SIGKILL') } catch {}
  const t0 = Date.now()
  while (Date.now() - t0 < 5000) { try { process.kill(pid, 0) } catch { break } }
  fs.rmSync(pidFile, { force: true })
}

export async function startServer({ port, seed, dir = path.join(ROOT, 'servers', String(port)), javaArgs = ['-Xms1G', '-Xmx2G'], timeoutMs = 120_000, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  killStale(dir, log)
  for (const f of [JAR, 'eula.txt', 'ops.json']) fs.copyFileSync(path.join(TEMPLATE_DIR, f), path.join(dir, f))
  // Paper unpacks ~200 MB of libraries per instance; share the template's read-only copies instead of duplicating them.
  for (const d of ['libraries', 'versions', 'cache']) {
    const src = path.join(TEMPLATE_DIR, d), dst = path.join(dir, d)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dst) && !fs.lstatSync(dst).isSymbolicLink()) fs.rmSync(dst, { recursive: true, force: true })
    if (!fs.existsSync(dst)) fs.symlinkSync(src, dst)
  }
  for (const w of fs.readdirSync(dir).filter(d => d.startsWith('world'))) fs.rmSync(path.join(dir, w), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), renderProperties(fs.readFileSync(path.join(TEMPLATE_DIR, 'server.properties'), 'utf8'), { port, seed }))
  const outPath = path.join(dir, 'server.out')
  const out = fs.openSync(outPath, 'w')
  const proc = spawn(javaBin(), [...javaArgs, '-jar', JAR, '--nogui'], { cwd: dir, stdio: ['pipe', out, out], detached: true })
  fs.writeFileSync(path.join(dir, 'server.pid'), String(proc.pid))
  await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      let txt = ''
      try { txt = fs.readFileSync(outPath, 'utf8') } catch {}
      if (/Done \(/.test(txt)) { clearInterval(timer); resolve() }
      else if (proc.exitCode !== null) { clearInterval(timer); reject(new Error(`server exited ${proc.exitCode}: ${txt.slice(-500)}`)) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); proc.kill('SIGKILL'); reject(new Error('server start timeout')) }
    }, 500)
  })
  log(`server ${port} seed ${seed} ready`)
  const stop = () => new Promise(resolve => {
    if (proc.exitCode !== null) return resolve()
    proc.once('exit', () => resolve())
    try { proc.stdin.write('stop\n') } catch { proc.kill('SIGTERM') }
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL') }, 15_000).unref()
  })
  return { port, seed, dir, proc, stop }
}
