// The executor registry: new motor primitives as files in agent/plugins/*.mjs, loaded at start and re-imported when a
// file changes while an episode runs (hot reload), so a new primitive can be tried live without a restart. Plugins are
// written and arena-tested offline, never generated at runtime. Contract: agent/plugins/README.md.
//
// Motor.run uses a built-in executor first, then registry.get(name); the plugin's timeout replaces the motor's. The
// registry never throws out of load(), the watch callbacks or optionsFor(). A plugin whose run() throws a bug three times
// in a row (an error mapError maps to 'failed'; NoPath, typed results, timeouts and interrupts do not count) is disabled
// until its file changes; so is one
// whose options() or preconditions() throws three times in a row.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { optionId } from './subtasks.js'
import { mapError } from './motor.js'

export const MAX_THROWS = 3
export const DEBOUNCE_MS = 500

const short = e => String(e?.message ?? e).split('\n')[0].slice(0, 160)

export class PluginRegistry {
  constructor({ dir, log = () => {} } = {}) {
    this.dir = dir; this.log = log
    this.entries = new Map()   // id -> { id, file, mtime, version, plugin, enabled, error, throws }
    this.files = new Map()     // file -> { mtime, id | null, error | null } (the last import attempt of each file)
    this.timers = new Map()    // file -> debounce timer
    this.watcher = null
    this.version = 0
  }

  async load() {
    const loaded = [], failed = []
    let names = []
    try { names = fs.readdirSync(this.dir).filter(f => f.endsWith('.mjs')).sort() } catch (e) { this.log(`plugins: cannot read ${this.dir}: ${short(e)}`) }
    for (const f of names) {
      const r = await this.loadFile(path.join(this.dir, f))
      if (r.id) loaded.push(r.id)
      else if (r.error) failed.push({ file: r.file, error: r.error })
    }
    return { loaded, failed }
  }

  // Import one file if it changed since the last attempt. Returns { file, id } (loaded), { file, error } (failed) or
  // { file } (unchanged, or unchanged and disabled). A deleted file removes its plugin.
  async loadFile(file) {
    try {
      let st
      try { st = fs.statSync(file) } catch { this.remove(file); return { file } }
      const prev = this.files.get(file)
      if (prev && prev.mtime === st.mtimeMs) {
        const e = prev.id && this.entries.get(prev.id)
        return e && e.enabled ? { file, id: e.id } : prev.error && !prev.id ? { file, error: prev.error } : { file }
      }
      let mod
      try { mod = await import(pathToFileURL(file).href + '?v=' + st.mtimeMs) } catch (e) { return this.failed(file, st.mtimeMs, short(e)) }
      const p = mod?.default
      if (!p || typeof p !== 'object') return this.failed(file, st.mtimeMs, 'no default export object')
      if (typeof p.id !== 'string' || !/^\w+$/.test(p.id)) return this.failed(file, st.mtimeMs, 'default export has no valid id')
      if (typeof p.run !== 'function') return this.failed(file, st.mtimeMs, `plugin ${p.id} has no run function`)
      const owner = this.entries.get(p.id)
      if (owner && owner.file !== file) return this.failed(file, st.mtimeMs, `id ${p.id} already loaded from ${path.basename(owner.file)}`)
      if (prev?.id && prev.id !== p.id) this.entries.delete(prev.id)   // the file was renamed to a new id
      this.entries.set(p.id, { id: p.id, file, mtime: st.mtimeMs, version: ++this.version, plugin: p, enabled: true, error: null, throws: 0 })
      this.files.set(file, { mtime: st.mtimeMs, id: p.id, error: null })
      this.log(`plugins: loaded ${p.id} from ${path.basename(file)}`)
      return { file, id: p.id }
    } catch (e) {
      return { file, error: short(e) }
    }
  }

  // A failed (re)import keeps the last good version of the file's plugin running and records the error on it.
  failed(file, mtime, error) {
    const prev = this.files.get(file)
    this.files.set(file, { mtime, id: prev?.id ?? null, error })
    const e = prev?.id && this.entries.get(prev.id)
    if (e) e.error = `reload failed, previous version kept: ${error}`
    this.log(`plugins: ${path.basename(file)} failed: ${error}`)
    return { file, error }
  }

  remove(file) {
    const prev = this.files.get(file)
    this.files.delete(file)
    if (prev?.id && this.entries.get(prev.id)?.file === file) { this.entries.delete(prev.id); this.log(`plugins: removed ${prev.id}`) }
  }

  // The plugin with a run() that counts its throws against this version. null when unknown or disabled. The returned
  // object holds this version's function: a run in flight keeps the code it started with after a reload.
  get(name) {
    const e = this.entries.get(name)
    if (!e || !e.enabled) return null
    const { plugin, version } = e
    const reg = this
    return {
      ...plugin,
      async run(motor, arg, obs) {
        try {
          const out = await plugin.run(motor, arg, obs)
          reg.ok(name, version)
          return out
        } catch (err) {
          reg.threw(name, version, err, motor)
          throw err
        }
      },
    }
  }

  ok(id, version) {
    const e = this.entries.get(id)
    if (e && e.version === version) e.throws = 0
  }

  // Count a throw only for the current version, only when it is a bug (mapError maps it to 'failed': a TypeError, not a
  // NoPath -> no_path or a pathfinder Timeout; the livelock breaker handles those) and only when the run was not
  // abandoned: an Abort (the motor's own stop or safety check), or a context whose check() throws (timed out,
  // interrupted, superseded), means the error came from the motor, not the plugin.
  threw(id, version, err, motor) {
    const e = this.entries.get(id)
    if (!e || e.version !== version || !e.enabled) return
    if (err?.name === 'Abort') return
    if (mapError(err).result !== 'failed') return
    try { motor?.check?.() } catch { return }
    this.strike(e, short(err))
  }

  strike(e, error) {
    e.throws += 1
    if (e.throws >= MAX_THROWS) this.disable(e.id, error)
  }

  disable(id, error) {
    const e = this.entries.get(id)
    if (!e) return
    e.enabled = false; e.error = error ?? 'disabled'
    this.log(`plugins: disabled ${id}: ${e.error}`)
  }

  enabled(id) { return !!this.entries.get(id)?.enabled }

  list() {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(e => ({ id: e.id, timeout: e.plugin.timeout ?? null, enabled: e.enabled, error: e.error }))
  }

  // The options the enabled plugins offer under `goal` whose preconditions hold, shaped as subtasks.js options.
  optionsFor(obs, goal) {
    const out = []
    for (const e of [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!e.enabled) continue
      const p = e.plugin
      try {
        const offered = typeof p.options === 'function' ? p.options(obs, goal) || [] : []
        const opts = []
        for (const o of offered) {
          const arg = o?.arg ?? null
          if (typeof p.preconditions === 'function' && !p.preconditions(obs, arg)) continue
          const id = optionId(p.id, arg)
          opts.push({ id, name: p.id, arg, desc: o?.desc ?? id })
        }
        out.push(...opts)
      } catch (err) {
        this.log(`plugins: ${p.id} options/preconditions threw: ${short(err)}`)
        this.strike(e, short(err))
      }
    }
    return out
  }

  watch() {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.dir, (type, name) => {
        try {
          if (!name || !String(name).endsWith('.mjs')) return
          const file = path.join(this.dir, String(name))
          clearTimeout(this.timers.get(file))
          this.timers.set(file, setTimeout(() => {
            this.timers.delete(file)
            this.loadFile(file).catch(err => this.log(`plugins: reload ${name}: ${short(err)}`))
          }, DEBOUNCE_MS))
        } catch (err) { this.log(`plugins: watch event: ${short(err)}`) }
      })
      this.watcher.on('error', err => this.log(`plugins: watcher error: ${short(err)}`))
    } catch (err) { this.watcher = null; this.log(`plugins: cannot watch ${this.dir}: ${short(err)}`) }
  }

  unwatch() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    try { this.watcher?.close() } catch {}
    this.watcher = null
  }
}

// The motor backlog: one JSON line per request the bot could not serve (every leader `cannot`, every expander
// `missing`), so the next motor work is chosen from what was actually asked. Never throws.
export function appendRequestLog(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch (e) {
    console.error(`request log ${file}: ${short(e)}`)
  }
}
