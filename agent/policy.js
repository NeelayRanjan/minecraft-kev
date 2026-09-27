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

// Order: died > took_damage > threat crossing (a hostile within 16 m, or a new attacker: a player who just hit the
// bot, obs.attacker with sinceS 0, live session lesson) > drowning (the threat crossing is an edge and would be lost;
// drowning is a level and fires again on the next tick). The attacker edge fires only for a player attacker and only
// with no hostile within 16 m (a mob hit keeps main's behaviour exactly: the 16 m crossing and the 4 hp cumulative
// drop; final review). 'drowning': while the air is at DROWNING_OXYGEN or below, every tick, for any subtask that is
// not an escape (a mining subtask re-picked in a flooded tunnel is cut at once, r2_leader t=2404); wait (floats, swims
// to shore), explore_toward(surface) and the threat responses run on.
export function interruptFor({ hostileDist, prevHostileDist, current, healthDrop, dead, oxygen = 20, attacker = null }) {
  if (!current) return null
  if (dead) return 'died'
  if (healthDrop >= DAMAGE_INTERRUPT_HP) return 'took_damage'
  const nowNear = hostileDist != null && hostileDist <= HOSTILE_RANGE
  const wasNear = prevHostileDist != null && prevHostileDist <= HOSTILE_RANGE
  const attackerNew = attacker?.kind === 'player' && attacker.sinceS === 0 && !nowNear
  if (!THREAT_SUBTASKS.has(current.name) && ((nowNear && !wasNear) || attackerNew)) return 'threat'
  if (oxygen != null && oxygen <= DROWNING_OXYGEN && !escapes(current)) return 'drowning'
  return null
}

// The goal guard (Task 7 fix round 1): kev was never trained on the plugin executors and, under a pushed goal, keeps
// picking moves over them (blueprint smoke: explore_toward(surface) p 0.45 vs build_blueprint 0.20, 34 times). Under a
// pushed goal (depth > 0) whose teacher picks an offered plugin option (its name in `plugins`), that pick replaces
// kev's, unless kev picked a threat response, eat, or the same id. Returns the id to start instead, or null (kev's
// pick stands). At depth 0 never fires, so experiment-1 and chain runs are unchanged.
export function goalGuard({ kevPick, teacherPick, offered, depth, plugins }) {
  if (!(depth > 0) || !teacherPick || !kevPick || kevPick === teacherPick) return null
  const name = id => String(id).split('(')[0]
  if (THREAT_SUBTASKS.has(name(kevPick)) || kevPick === 'eat') return null
  if (!plugins.has(name(teacherPick)) || !offered.includes(teacherPick)) return null
  return teacherPick
}
