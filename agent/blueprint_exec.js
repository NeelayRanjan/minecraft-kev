// Shared by the blueprint executors (agent/plugins/build_blueprint.mjs, agent/plugins/dig_blueprint.mjs): the time
// budget constants, the blueprint lookup through motor.blueprints and the inventory map. Lives outside agent/plugins/
// because every *.mjs file there is loaded as a plugin.
//
// Time budget: an executor keeps MARGIN_MS free before its run's deadline while it works (motor.reserveMs: every walk
// is capped to end before it, no step starts with under 2 s of it left); its final tidy then runs with FINAL_MS
// reserved. The call returns its own result before the run's deadline, never a timeout after productive work.
export const MARGIN_MS = 12_000
export const FINAL_MS = 1500

// The blueprint `arg` of kind `kind` through the accessor motor.blueprints (goals.js registerBlueprintAccessor
// contract; the runner sets it, an arena check may set a BlueprintBook itself): { acc, bp } | { error: <typed result> }.
export function loadBlueprint (motor, arg, kind) {
  const acc = motor.blueprints
  if (!acc?.get) return { error: { result: 'failed', detail: 'no blueprint book' } }
  const bp = acc.get(arg)
  if (!bp) return { error: { result: 'failed', detail: `no blueprint ${arg}` } }
  if (bp.kind !== kind) return { error: { result: 'failed', detail: `${arg} is not a ${kind} blueprint` } }
  return { acc, bp }
}

// { item name: count } of the bot's inventory.
export function inventoryOf (bot) {
  const m = {}
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}
