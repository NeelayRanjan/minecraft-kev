// Steering inside a walk (kev-steers, Task 1): the pure model kev picks one of eight compass headings, jump,
// dig_ahead or stop at 2 Hz while the motor layer's pathfinder walk is underway. Option list and descriptions,
// the label from the pathfinder's own next path node (the teacher for the `steer` choice question), the state
// text's steering line, the outcome label for the 30 s "reach the target" forecast, and the two question
// definitions. No Mineflayer import: dirWord is reused from summary.js (its other exports read the bot only
// through the `bot` argument, so importing it here stays pure).
import { dirWord } from './summary.js'

export const STEER_OPTIONS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'jump', 'dig_ahead', 'stop']

export const STEER_DESC = {
  north: 'walk north',
  'north-east': 'walk north-east',
  east: 'walk east',
  'south-east': 'walk south-east',
  south: 'walk south',
  'south-west': 'walk south-west',
  west: 'walk west',
  'north-west': 'walk north-west',
  jump: 'jump forward over the block ahead',
  dig_ahead: 'dig the block(s) ahead and step in',
  stop: 'stop: the target is reached',
}

// dx, dz -> one of the eight compass words (0 = north is -z, 90 = east is +x). A thin wrapper so this module never
// imports anything Mineflayer-facing beyond summary.js's pure geometry helper.
export function headingWord(dx, dz) {
  return dirWord(dx, dz)
}

const NEAR_M = 0.4   // a path node this close to pos is "already there"; look at the next one

// The teacher label for the `steer` choice: the pathfinder's own plan, reduced to one of STEER_OPTIONS.
// `reached` wins outright (the walk is over). Otherwise take the first path node farther than NEAR_M from pos
// (its centre is (x+0.5, z+0.5), horizontal distance only): a node with blocks to break is dig_ahead, a node
// a full block higher (and nothing to break) is jump, else the heading toward its centre. With no path (not
// yet computed, or none of its nodes clears NEAR_M) fall back to the heading straight toward goalPos.
export function steerLabel({ pos, path, goalPos, reached }) {
  if (reached) return 'stop'
  if (path && path.length) {
    const node = path.find(n => Math.hypot((n.x + 0.5) - pos.x, (n.z + 0.5) - pos.z) > NEAR_M)
    if (node) {
      if (node.toBreak && node.toBreak.length) return 'dig_ahead'
      if (node.y > Math.floor(pos.y)) return 'jump'
      return headingWord((node.x + 0.5) - pos.x, (node.z + 0.5) - pos.z)
    }
  }
  return headingWord(goalPos.x - pos.x, goalPos.z - pos.z)
}

const NO_MOVE_M = 0.2   // below this in the last half second, "did not move" (lesson 8: words over numbers)
const clean = s => s.replace(/<\|/g, '< |').replace(/\|>/g, '| >')
// Rounded "N m dir[, N m below/above you]", the serializer's own phrasing (agent/serialize.js's `rel`).
const relPhrase = ({ dist, dir, dy }) => {
  let s = `${Math.round(dist)} m ${dir}`
  if (Math.abs(dy) >= 2) s += `, ${Math.abs(Math.round(dy))} m ${dy < 0 ? 'below' : 'above'} you`
  return s
}

// The steering line of state text: the current steering target, the block ahead at foot and head height and the
// block underfoot beyond it, and how far the player moved in the last half second. Numbers rounded to whole
// metres (lesson 8); a last move under NO_MOVE_M reads as "did not move" rather than a near-zero number.
export function steerLine({ targetName, target, ahead, lastMove }) {
  const moved = lastMove.dist < NO_MOVE_M ? 'did not move' : `moved ${Math.round(lastMove.dist)} m ${lastMove.dir}`
  return clean(`steering: toward ${targetName} ${relPhrase(target)}; ahead: ${ahead.feet} at your feet, ${ahead.head} at head height, ${ahead.below} below; last half second: ${moved}.`)
}

// The `reach_target_30s` outcome label from the 1 Hz position frames (game truth, post hoc): true if any frame
// strictly after t and within horizonS of it lands within 3 m of targetPos's block centre (+0.5 on x and z);
// false if the horizon fully elapsed (endT >= t + horizonS) with no such frame; null (censored) if the episode
// ended first, per the feedback-loop protocol (report the censoring rate beside every forecast metric).
export function reachLabel({ frames, t, targetPos, horizonS = 30, endT }) {
  const cx = targetPos.x + 0.5, cy = targetPos.y, cz = targetPos.z + 0.5
  const win = frames.filter(f => f.t > t && f.t <= t + horizonS)
  if (win.some(f => Math.hypot(f.x - cx, f.y - cy, f.z - cz) <= 3)) return true
  if (endT >= t + horizonS) return false
  return null
}

// The two new question definitions, in questionFor's shape (agent/questions.js): steer is a choice over
// STEER_OPTIONS/STEER_DESC, reach_target_30s is a noul forecast.
export function steerQuestions() {
  return {
    steer: { type: 'choice', instructions: 'Which way should the player move in the next half second to reach the steering target?', criteria: STEER_DESC },
    reach_target_30s: { type: 'noul', instructions: 'Will the player be within 3 m of the steering target within the next 30 seconds?' },
  }
}
