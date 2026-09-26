// Pure decision-loop helpers for the runner: which option to act on, and when to interrupt the motor layer.
export const HOSTILE_RANGE = 16
export const DAMAGE_INTERRUPT_HP = 4
export const DROWNING_OXYGEN = 10   // of 20 (air supply / 15); ~7 s of air left before drowning damage
const THREAT_SUBTASKS = new Set(['fight', 'flee', 'pillar_up'])
// What a bot low on air may keep doing: the threat responses and the two ways out of the water.
const escapes = c => THREAT_SUBTASKS.has(c.name) || c.name === 'wait' || (c.name === 'explore_toward' && c.arg === 'surface')

// Validates the chosen id against the offered options (kev can only pick among the criteria we sent, but the
// runner never trusts that) and falls back to wait with a distinct source so the event is visible in the log.
export function chooseAction({ policy, qs, labels, answers, rng = Math.random, epsAction = 0, pick = null }) {
  const options = Object.keys(qs.next_subtask.criteria)
  if (epsAction > 0 && rng() < epsAction) {
    const id = pick ? pick(options) : options[Math.floor(rng() * options.length)]
    return { id, source: 'random' }
  }
  const id = policy === 'kev' ? answers?.next_subtask?.choice : labels?.next_subtask
  if (id != null && options.includes(id)) return { id, source: policy === 'kev' ? 'kev' : 'teacher' }
  return { id: 'wait', source: 'fallback' }
}

// Order: died > took_damage > threat crossing > drowning (the threat crossing is an edge and would be lost; drowning is
// a level and fires again on the next tick). 'drowning': while the air is at DROWNING_OXYGEN or below, every tick, for
// any subtask that is not an escape (a mining subtask re-picked in a flooded tunnel is cut at once, r2_leader t=2404);
// wait (floats, swims to shore), explore_toward(surface) and the threat responses run on.
export function interruptFor({ hostileDist, prevHostileDist, current, healthDrop, dead, oxygen = 20 }) {
  if (!current) return null
  if (dead) return 'died'
  if (healthDrop >= DAMAGE_INTERRUPT_HP) return 'took_damage'
  const nowNear = hostileDist != null && hostileDist <= HOSTILE_RANGE
  const wasNear = prevHostileDist != null && prevHostileDist <= HOSTILE_RANGE
  if (nowNear && !wasNear && !THREAT_SUBTASKS.has(current.name)) return 'threat'
  if (oxygen != null && oxygen <= DROWNING_OXYGEN && !escapes(current)) return 'drowning'
  return null
}
