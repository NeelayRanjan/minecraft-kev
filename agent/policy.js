// Pure decision-loop helpers for the runner: which option to act on, and when to interrupt the motor layer.
export const HOSTILE_RANGE = 16
export const DAMAGE_INTERRUPT_HP = 4
export const DROWNING_OXYGEN = 10   // of 20 (air supply / 15); ~7 s of air left before drowning damage
const THREAT_SUBTASKS = new Set(['fight', 'flee', 'pillar_up'])

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

// 'drowning' fires once, when the air crosses DROWNING_OXYGEN (prevOxygen above it or unknown): a level trigger would
// interrupt every subtask started in the water, including the wait that now floats and swims to shore (motor.js).
export function interruptFor({ hostileDist, prevHostileDist, current, healthDrop, dead, oxygen = 20, prevOxygen = null }) {
  if (!current) return null
  if (dead) return 'died'
  if (healthDrop >= DAMAGE_INTERRUPT_HP) return 'took_damage'
  const lowAir = oxygen != null && oxygen <= DROWNING_OXYGEN, wasLow = prevOxygen != null && prevOxygen <= DROWNING_OXYGEN
  if (lowAir && !wasLow && !THREAT_SUBTASKS.has(current.name)) return 'drowning'
  const nowNear = hostileDist != null && hostileDist <= HOSTILE_RANGE
  const wasNear = prevHostileDist != null && prevHostileDist <= HOSTILE_RANGE
  if (nowNear && !wasNear && !THREAT_SUBTASKS.has(current.name)) return 'threat'
  return null
}
