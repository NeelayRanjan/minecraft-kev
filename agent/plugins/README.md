# Motor plugins

Every `*.mjs` file here is one motor primitive, loaded by `agent/plugins.js` (`PluginRegistry`) at the start of an
episode and re-imported when the file changes while the episode runs (500 ms debounce). Other files (this README)
are ignored. Plugins are written and tested offline in an arena (`tests/integration/`), never generated at runtime.

```js
// agent/plugins/<id>.mjs
export default {
  id: 'mine',            // the option name; offered as mine(<arg>). Letters, digits, underscore. Must not be a built-in executor name (the built-in wins).
  timeout: 60,           // seconds; replaces the motor's default of 30
  breaker: true,         // its result feeds mem.lastPath like the built-in movers (no_path / timeout / ok)
  options(obs, goal) { return [{ arg: 'sand', desc: 'mine sand nearby' }] },   // goal = { kind, arg, count } or null
  preconditions(obs, arg) { return true },                                    // offered only when true
  async run(motor, arg, obs) { return { result: 'ok', detail: '...' } },
}
```

- `motor` is the Motor run context: `check()` (throws when the run was timed out, interrupted or superseded: call it
  after every await), `goto()`, `walkTo()`, `mineKind()`, `log()`, `bot`, `mem`, `md`, and the other Motor helpers.
- Return typed results (`RESULTS` in `motor.js`: `ok`, `no_path`, `not_found`, `no_materials`, `failed`, ...). A
  thrown error is mapped like a built-in's (`mapError`). Only a bug counts, an error `mapError` maps to `failed`
  (a TypeError, say): **three in a row disable the plugin** until its file changes (a clean run resets the count). A
  thrown NoPath (`no_path`), a pathfinder Timeout, a typed result, a timeout or an interrupt never counts; the livelock
  breaker withholds an option that keeps failing. A throw from `options()` or `preconditions()` skips the plugin for
  that call and counts as a bug.
- A run in flight keeps the code it started with; the next run uses the reloaded file. A reload that fails to import
  keeps the previous version and shows the error in `registry.list()`. Deleting the file removes the plugin.
- The options reach kev and the leader only through the goal filters (`goals.js` `pluginOptions`), which the runner
  wires to `registry.optionsFor(obs, goal)`.
