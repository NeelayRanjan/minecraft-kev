// The second live stress session (live_retry, 2026-09-27): leader-side fixes (brief items 4, 5, 9-16, 18, 19).
import test from 'node:test'
import assert from 'node:assert/strict'
import { leaderSchema, parseLeaderAnswer, settleKind, RequestBook, leaderSystemGoals, LEADER_SYSTEM, buildLeaderMessages, applyAnswer } from '../agent/leader.js'
import { baseCtx, goalCtx } from './fixtures/leader_prompt_ctx.mjs'

const opts = [{ id: 'mine_iron', desc: 'x' }, { id: 'wait', desc: 'z' }]
const q = [{ t: 1, name: 'Steve', text: 'are you coming?' }]

// 4: talking and acting are not exclusive: every goals-mode answer may carry a reply the runner sends.
test('item 4: the goals schema has an optional reply for every action; the chain schema is unchanged', () => {
  const s = leaderSchema(opts, { goals: true, requests: q })
  assert.deepEqual(s.properties.reply, { type: 'string' })
  assert.ok(!s.required.includes('reply'))
  assert.equal(leaderSchema(opts).properties.reply, undefined)
  assert.deepEqual(Object.keys(leaderSchema(opts).properties), ['action', 'why'])
  const raw = JSON.stringify({ action: 'push_goal', goal: { kind: 'go_to', arg: 'player:Steve' }, reply: 'On my way!', why: 'asked' })
  assert.equal(parseLeaderAnswer(raw, opts, { goals: true }).reply, 'On my way!')
  assert.equal(parseLeaderAnswer(JSON.stringify({ action: 'continue', reply: 'coming' }), opts, { goals: true }).reply, 'coming')
  assert.equal(parseLeaderAnswer(JSON.stringify({ action: 'continue' }), opts, { goals: true }).reply, null)
  assert.deepEqual(parseLeaderAnswer(raw, opts), { action: null, why: 'asked' }, 'chain mode: {action, why} only')
  assert.deepEqual(Object.keys(parseLeaderAnswer(JSON.stringify({ action: 'wait', reply: 'x', why: 'w' }), opts)), ['action', 'why'])
})
test('item 4: a continue or override that carries a reply answers the requests shown; without one it does not', () => {
  assert.equal(settleKind({ kind: 'continue', id: null }, true, 'on my way'), 'reply')
  assert.equal(settleKind({ kind: 'override', id: 'wait' }, true, 'hold on'), 'reply')
  assert.equal(settleKind({ kind: 'continue', id: null }, true, '  '), 'continue')
  assert.equal(settleKind({ kind: 'continue', id: null }, false, 'hi'), 'continue')
  assert.equal(settleKind({ kind: 'stale', id: null }, true, 'hi'), 'stale')
  const b = new RequestBook(); const r = b.add({ t: 1, name: 'Steve', text: 'are you coming?' })
  b.shown([r.id]); b.settle([r.id], 'reply', 2)
  assert.equal(r.answered.kind, 'reply')
})
test('item 4: the goals prompt asks for a reply whenever the leader acts on a request; the chain prompt is unchanged', () => {
  const sys = leaderSystemGoals()
  assert.match(sys, /Add a short reply for the player whenever you act on a request/)
  assert.match(sys, /"reply": "<short line for the player>"/)
  assert.match(sys, /"are you coming\?" -> push_goal go_to, arg player:Steve, reply "On my way!"/)
  assert.doesNotMatch(LEADER_SYSTEM, /reply/)
  assert.match(buildLeaderMessages(goalCtx)[1].content, /"reply" \(any action\)/)
  assert.doesNotMatch(buildLeaderMessages(baseCtx)[1].content, /reply/)
})
test('item 4: a say whose line came in reply instead of text is accepted', () => {
  const r = applyAnswer({ answer: { action: 'say', text: '', reply: 'I am 12 m east of you' }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true,
    requests: [{ t: 1, name: 'Steve', text: 'where are you?' }], recentSays: [] })
  assert.deepEqual(r, { kind: 'say', id: null, text: 'I am 12 m east of you' })
})

// 5: an idle or interrupt call overrode a subtask while "come back" waited; the request must get a request-level answer.
import { LeaderTrigger, pickEvent, requestStillWaiting, WAITING_FEEDBACK } from '../agent/leader.js'
test('item 5: a continue or override leaves a shown request waiting: the next call fires at once with FEEDBACK', () => {
  const b = new RequestBook(); const r = b.add({ t: 1, name: 'Steve', text: 'come back' })
  const shown = [r]
  b.shown([r.id]); b.settle([r.id], 'override', 5)
  assert.equal(requestStillWaiting('override', shown), true)
  assert.equal(requestStillWaiting('continue', shown), true)
  assert.equal(requestStillWaiting('stale', shown), true)
  assert.equal(requestStillWaiting('push_goal', shown), false)
  assert.equal(requestStillWaiting('continue', []), false)
  assert.equal(WAITING_FEEDBACK, 'a player request is still waiting: answer it first')
  const tr = new LeaderTrigger('subgoals')
  tr.asked(30)
  assert.equal(tr.due({ t: 31, event: 'request_waiting' }), true, 'bypasses the 20 s spacing')
  assert.equal(tr.reason, 'request_waiting')
  assert.equal(pickEvent(['subtask_failed', 'request_waiting'], 'subgoals'), 'request_waiting')
  // the second call that does not answer settles it as not_now (today's rule), and then nothing waits
  b.shown([r.id]); const nn = b.settle([r.id], 'continue', 9)
  assert.equal(nn.length, 1); assert.equal(requestStillWaiting('continue', shown), false)
})

// 19: stay(player:<name> | here): "wait over here" pushes it, "you can go" pops it (with a reply).
import { GoalStack, goalHave } from '../agent/goals.js'
import { goalPhrase, planChatLines } from '../agent/plans.js'
import { goalStackView } from '../agent/leader.js'
import { baseObs } from './fixtures.mjs'
test('item 19: stay is pushed and popped through the leader; the prompt has the examples; plan shows it', () => {
  const push = applyAnswer({ answer: { action: 'push_goal', goal: { kind: 'stay', arg: 'player:Steve' }, reply: "I'll wait here", why: 'asked' },
    currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true })
  assert.equal(push.kind, 'push_goal'); assert.deepEqual(push.goal, { kind: 'stay', arg: 'player:Steve', count: null })
  assert.equal(applyAnswer({ answer: { action: 'push_goal', goal: { kind: 'stay', arg: 'the tree' } }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true }).kind, 'invalid')
  assert.equal(applyAnswer({ answer: { action: 'pop_goal', reply: 'Off I go!' }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true }).kind, 'pop_goal')
  const sys = leaderSystemGoals()
  assert.match(sys, /- stay, arg player:<name> or here:/)
  assert.match(sys, /"wait over here", "stay here" or "stay with me" -> push_goal stay, arg player:Steve, reply "I'll wait here"/)
  assert.match(sys, /"you're free to go", "you can go", "carry on" or "go back to work" -> pop_goal with a reply/)
  assert.equal(goalPhrase({ kind: 'stay', arg: 'player:Steve' }, 'Steve'), 'wait here with you')
  assert.equal(goalPhrase({ kind: 'stay', arg: 'here' }), 'wait here')
  const s = new GoalStack({ goal: 'nether' }), o = baseObs({ goal: 'nether', armor: {}, portalLit: false })
  s.push({ kind: 'stay', arg: 'player:Steve', source: 'audience:Steve', t: 0, obs: o })
  const lines = planChatLines({ pushed: goalStackView(s, o).pushed, planLines: ['no plans'], chain: null })
  assert.match(lines[0], /^Goals: #1 Staying with Steve until you say I can go/)
})

// 9: generic item names ("bed" is not an item in 1.20.4) map to a default variant, in plan_item and in the request text.
import { ITEM_ALIASES, itemAlias, itemInRequest } from '../agent/leader.js'
import { isItem } from '../agent/recipes.js'
test('item 9: the alias table maps generic names to real items, for plan_item and the request matcher', () => {
  for (const [k, v] of Object.entries(ITEM_ALIASES)) { assert.equal(isItem(k), false, `${k} is not an item itself`); assert.equal(isItem(v), true, `${v} is an item`) }
  for (const [k, v] of [['bed', 'white_bed'], ['wool', 'white_wool'], ['planks', 'oak_planks'], ['log', 'oak_log'], ['boat', 'oak_boat'], ['door', 'oak_door'],
    ['stairs', 'oak_stairs'], ['slab', 'oak_slab'], ['fence', 'oak_fence'], ['carpet', 'white_carpet'], ['concrete', 'white_concrete'], ['dye', 'white_dye'],
    ['banner', 'white_banner'], ['sign', 'oak_sign']]) assert.equal(itemAlias(k), v, k)
  assert.equal(itemAlias('compass'), 'compass'); assert.equal(itemAlias('button'), 'button', 'ambiguous: not aliased')
  const r = applyAnswer({ answer: { action: 'plan_item', item: { name: 'Bed', count: 2 } }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true })
  assert.deepEqual(r, { kind: 'plan_item', id: null, item: 'white_bed', count: 2, why: '' })
  assert.deepEqual(itemInRequest('can you make me a bed'), { item: 'white_bed', count: 1 })
  assert.deepEqual(itemInRequest('I want 2 beds'), { item: 'white_bed', count: 2 })
  assert.deepEqual(itemInRequest('make a white bed'), { item: 'white_bed', count: 1 })
  assert.deepEqual(itemInRequest('craft some stairs'), { item: 'oak_stairs', count: 1 })
  assert.deepEqual(itemInRequest('make a red bed'), { item: 'red_bed', count: 1 }, 'a named colour wins')
})

// 11: "enough leather for a leather helmet, don't craft it" planned 1 leather. plan_item materials_only plans the
// ingredients of the item (net) and stops before its final craft.
import { expandMaterials } from '../agent/recipes.js'
test('item 11: plan_item materials_only: parsed, validated, planned without the final craft; the prompt has the example', () => {
  const s = leaderSchema(opts, { goals: true })
  assert.deepEqual(s.properties.item.properties.materials_only, { type: 'boolean' })
  const raw = JSON.stringify({ action: 'plan_item', item: { name: 'leather_helmet', count: 1, materials_only: true } })
  const parsed = parseLeaderAnswer(raw, opts, { goals: true })
  assert.deepEqual(parsed.item, { name: 'leather_helmet', count: 1, materials_only: true })
  assert.deepEqual(parseLeaderAnswer(JSON.stringify({ action: 'plan_item', item: { name: 'compass' } }), opts, { goals: true }).item, { name: 'compass', count: null })
  const r = applyAnswer({ answer: parsed, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true })
  assert.deepEqual(r, { kind: 'plan_item', id: null, item: 'leather_helmet', count: 1, why: '', materials_only: true })
  const steps = expandMaterials('leather_helmet', 1, {}).steps
  assert.deepEqual(steps.map(x => `${x.kind} ${x.arg} ${x.count}`), ['hunt leather 5'], 'no crafting table: only the final craft needs one')
  assert.deepEqual(expandMaterials('leather_helmet', 1, { leather: 2 }).steps.map(x => `${x.kind} ${x.arg} ${x.count}`), ['hunt leather 3'], 'net of the inventory')
  assert.deepEqual(expandMaterials('iron_pickaxe', 1, { stick: 2, iron_ingot: 3 }).steps, [], 'all held: nothing to do')
  assert.deepEqual(expandMaterials('glass', 4, {}).steps.map(x => `${x.kind} ${x.arg} ${x.count}`).slice(-1), ['gather sand 4'], 'a smelted item: its input')
  assert.match(leaderSystemGoals(), /"enough leather for a leather helmet, don't craft it" -> plan_item leather_helmet count 1 materials_only true/)
})
import { refreshPlanStep } from '../agent/goals.js'
import { PlanBook, guardPlanAnswer, itemPlanTitle } from '../agent/plans.js'
test('item 11: a materials plan refreshes against its materials, is titled "materials for", and is its own duplicate key', () => {
  const plan = { id: 2, item: 'leather_helmet', count: 1, materials_only: true, steps: [] }
  const hunt = { kind: 'hunt', arg: 'leather', count: 5 }
  assert.deepEqual(refreshPlanStep(hunt, plan, baseObs({ inventory: { leather: 3 } })), { ...hunt, count: 2 })
  assert.equal(refreshPlanStep(hunt, plan, baseObs({ inventory: { leather: 5 } })).skip, true)
  assert.equal(itemPlanTitle('leather_helmet', 1, true), 'materials for leather helmet')
  const b = new PlanBook()
  b.add({ title: 'materials for leather helmet', steps: [hunt], source: 'leader', t: 1, item: 'leather_helmet', count: 1, materials_only: true })
  const ask = mo => ({ kind: 'plan_item', id: null, item: 'leather_helmet', count: 1, why: '', ...(mo ? { materials_only: true } : {}) })
  assert.equal(guardPlanAnswer(ask(true), b, 2).duplicate, 1)
  assert.equal(guardPlanAnswer(ask(false), b, 2).duplicate, undefined, 'crafting the helmet is another plan')
})
test('item 12: the goals prompt says storage blocks unpack into 9 of their item', () => {
  assert.match(leaderSystemGoals(), /Storage blocks unpack into 9 of their item \(1 redstone block = 9 redstone/)
})

// 13: say for "tell me about yourself" and for a question addressed to the bot by name; a persona and a HOW I WORK block
// of true facts from the code's constants (Kevin invented a village search and claimed staircases keep it safe).
import { hasQuestion, HOW_I_WORK } from '../agent/leader.js'
test('item 13: say is offered for tell/explain/describe/show openers and for a question naming the bot', () => {
  const ask = (text, botName) => hasQuestion([{ t: 1, name: 'A', text }], botName)
  for (const t of ['tell me about yourself', 'Explain how you work', 'describe your base', 'show me your inventory']) assert.equal(ask(t), true, t)
  assert.equal(ask('hey kevin, tell me about yourself', 'Kevin'), true)
  assert.equal(ask('hey Kevin what are you doing', 'Kevin'), true)
  assert.equal(ask('kevin you there?', 'Kevin'), true)
  assert.equal(ask('bye kevin', 'Kevin'), false, 'names the bot, no question')
  assert.equal(ask('hey kevin, tell me about yourself'), false, 'without the bot name only openers count')
  assert.equal(ask('kevinator where is it', 'Kevin'), false, 'not the bot\'s name: a whole word only')
  assert.equal(ask('hey kevinator tell me', 'Kevin'), false, 'the name must be a whole word')
  assert.ok(leaderSchema(opts, { goals: true, requests: [{ t: 1, name: 'A', text: 'hey kevin, tell me about yourself' }], botName: 'Kevin' }).properties.action.enum.includes('say'))
  const r = applyAnswer({ answer: { action: 'say', text: 'I am Kevin!' }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true,
    requests: [{ t: 1, name: 'A', text: 'hey kevin, tell me about yourself' }], recentSays: [], botName: 'Kevin' })
  assert.equal(r.kind, 'say')
})
test('item 13: the goals prompt has the persona and a HOW I WORK block of at most 8 true lines', () => {
  const sys = leaderSystemGoals()
  assert.match(sys, /You are Kevin, a Minecraft bot the audience steers from chat\. Friendly, a bit dramatic, honest about what you can and cannot do\./)
  assert.match(leaderSystemGoals({ botName: 'Bob' }), /You are Bob, a Minecraft bot/)
  const lines = HOW_I_WORK.split('\n').filter(l => l.startsWith('- '))
  assert.ok(lines.length >= 6 && lines.length <= 8, `${lines.length} lines`)
  for (const re of [/32 m/, /5 minutes/, /10 minutes unless a player asks again/, /no village finder/, /sheep, cow, pig, chicken, spider, squid/, /dig/, /keepInventory/])
    assert.match(HOW_I_WORK, re)
  assert.ok(sys.includes(HOW_I_WORK))
  assert.doesNotMatch(LEADER_SYSTEM, /HOW I WORK|You are Kevin/)
})

// 14: cannot answers repeated word for word ("...but I can craft items, gather materials, or head to a spot").
import { recentCannotTexts, leaderFeedback } from '../agent/leader.js'
test('item 14: a cannot whose text repeats one of the last 5 cannot texts is invalid (repeated reply) and gets FEEDBACK', () => {
  const base = { currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true, requests: q }
  const said = ['I cannot do that, but I can craft items.']
  const r = applyAnswer({ ...base, answer: { action: 'cannot', why: 'I Cannot do that, but I can craft items. ' }, recentCannots: said })
  assert.deepEqual(r, { kind: 'invalid', id: 'cannot', reason: 'repeated reply' })
  assert.equal(applyAnswer({ ...base, answer: { action: 'cannot', why: 'x', reply: 'I cannot do that, but I can craft items.' }, recentCannots: said }).kind, 'invalid', 'the reply is the text')
  assert.equal(applyAnswer({ ...base, answer: { action: 'cannot', why: 'No village finder yet, sorry!' }, recentCannots: said }).kind, 'cannot')
  assert.equal(settleKind(r, true), 'invalid', 'settles nothing')
  assert.match(leaderFeedback(r, true), /refused: repeated reply/)
  const ev = [{ kind: 'leader_cannot', why: 'a' }, { kind: 'leader_cannot', why: 'b', reply: 'B!' }, { kind: 'leader_cannot', why: 'night', reason: 'night' }, { kind: 'leader_say', text: 'c' }]
  assert.deepEqual(recentCannotTexts(ev), ['a', 'B!'], 'the code\'s own refusals (night, blocked plan) do not count')
})

// 15: "I turned on keep inventory for you" got "Not now": a statement (no question, nothing to do) the leader answers
// with continue is settled as thanks, with an automatic "thanks!" at most once per 60 s.
import { isStatement, statementsToThank, THANKS_EVERY_S } from '../agent/leader.js'
test('item 15: statements answered with continue are thanked, not "not now"; requests and questions are not statements', () => {
  for (const t of ['I turned on keep inventory for you', 'I set the time to day for you', 'nice job', 'bye kevin', 'lol'])
    assert.equal(isStatement(t, 'Kevin'), true, t)
  for (const t of ['I want two white beds total', 'come here', 'where are you', 'can you make a bed', 'Im so scared, there is a skeleton next to me',
    'please get wood', 'hey kevin, tell me about yourself', 'help'])
    assert.equal(isStatement(t, 'Kevin'), false, t)
  assert.equal(THANKS_EVERY_S, 60)
  const b = new RequestBook()
  const s1 = b.add({ t: 1, name: 'A', text: 'I turned on keep inventory for you' }), r1 = b.add({ t: 2, name: 'A', text: 'come here' })
  const shown = [s1, r1]
  assert.deepEqual(statementsToThank('continue', shown, 'Kevin').map(r => r.id), [s1.id])
  assert.deepEqual(statementsToThank('override', shown, 'Kevin'), [], 'only a continue thanks')
  assert.deepEqual(statementsToThank('push_goal', shown, 'Kevin'), [])
  b.shown([s1.id, r1.id]); b.settle([s1.id], 'thanks', 3)
  assert.equal(s1.answered.kind, 'thanks')
  assert.equal(requestStillWaiting('continue', shown), true, 'the real request still waits')
})

// 16: protect(player:<name>) through the leader; a new request (a goal or a plan) ends a protect goal on top.
import { endsProtect } from '../agent/leader.js'
test('item 16: protect in the prompt, pushed through the leader; a new goal or plan ends it', () => {
  const sys = leaderSystemGoals()
  assert.match(sys, /- protect, arg player:<name>: follow that player and fight hostile mobs near them for 2 minutes;/)
  assert.match(sys, /"help, there's a skeleton next to me" -> push_goal protect, arg player:Steve/)
  const r = applyAnswer({ answer: { action: 'push_goal', goal: { kind: 'protect', arg: 'player:Steve' } }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true })
  assert.deepEqual(r.goal, { kind: 'protect', arg: 'player:Steve', count: null })
  const top = { kind: 'protect', arg: 'player:Steve' }
  assert.equal(endsProtect({ kind: 'push_goal', goal: { kind: 'gather', arg: 'log', count: 8 } }, top), true)
  assert.equal(endsProtect({ kind: 'plan_item', item: 'torch', count: 8 }, top), true)
  assert.equal(endsProtect({ kind: 'push_goal', goal: { kind: 'protect', arg: 'player:Alex' } }, top), true)
  assert.equal(endsProtect({ kind: 'say', text: 'hi' }, top), false)
  assert.equal(goalPhrase({ kind: 'protect', arg: 'player:Steve' }, 'Steve'), 'protect you')
  assert.equal(endsProtect({ kind: 'push_goal', goal: { kind: 'gather', arg: 'log', count: 8 } }, { kind: 'chain' }), false)
})

// 18: "where are you" was answered with 36 m against 14 m in the goal line: the leader gets the players' distances
// from obs.players (entity, else the server-reported position), with the inventory line, when there is chat.
test('item 18: PLAYERS (exact) from obs.players beside INVENTORY (exact), only with chat', () => {
  const players = { Steve: { dist: 14.2, dir: 'north-east' }, Alex: { dist: 120, dir: 'south', reported: true } }
  const withChat = buildLeaderMessages({ ...goalCtx, inventory: { dirt: 3 }, players, requests: [{ t: 5, name: 'Steve', text: 'where are you' }] })[1].content
  assert.match(withChat, /INVENTORY \(exact\): dirt x3\nPLAYERS \(exact\): Steve 14 m north-east of you, Alex 120 m south of you \(last reported position\)\n/)
  assert.doesNotMatch(buildLeaderMessages({ ...goalCtx, inventory: { dirt: 3 }, players, requests: [], conversation: [] })[1].content, /PLAYERS/)
  const none = buildLeaderMessages({ ...goalCtx, inventory: { dirt: 3 }, players: {}, requests: [{ t: 5, name: 'Steve', text: 'where are you' }] })[1].content
  assert.match(none, /PLAYERS \(exact\): none within 64 m/)
})

// Probe follow-ups: the 27B sent protect with a bare player name, and refused "are you coming to me?" through say.
test('probe: a bare player name for go_to, stay and protect becomes player:<name>; places, y: and here are kept', () => {
  const push = goal => applyAnswer({ answer: { action: 'push_goal', goal }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true })
  assert.deepEqual(push({ kind: 'protect', arg: 'Spacers_Choice' }).goal, { kind: 'protect', arg: 'player:Spacers_Choice', count: null })
  assert.deepEqual(push({ kind: 'stay', arg: 'Steve' }).goal, { kind: 'stay', arg: 'player:Steve', count: null })
  assert.deepEqual(push({ kind: 'stay', arg: 'here' }).goal, { kind: 'stay', arg: 'here', count: null })
  assert.deepEqual(push({ kind: 'go_to', arg: 'Steve' }).goal, { kind: 'go_to', arg: 'player:Steve', count: null })
  assert.deepEqual(push({ kind: 'go_to', arg: 'base' }).goal, { kind: 'go_to', arg: 'base', count: null })
  assert.deepEqual(push({ kind: 'go_to', arg: 'y:12' }).goal, { kind: 'go_to', arg: 'y:12', count: null })
})
test('probe: a say that refuses ("I can\'t ...") is invalid with FEEDBACK: act on the request or answer cannot', () => {
  const say = text => applyAnswer({ answer: { action: 'say', text }, currentId: null, askedCurrentId: null, offered: opts, goalsEnabled: true,
    requests: [{ t: 1, name: 'A', text: 'are you coming to me at least?' }], recentSays: [] })
  const r = say("I can't come to you, but I can craft items.")
  assert.deepEqual(r, { kind: 'invalid', id: 'say', reason: 'say never refuses; act on the request or answer cannot' })
  assert.match(leaderFeedback(r, true), /say never refuses/)
  assert.equal(say('I cannot do that').kind, 'invalid')
  assert.equal(say("I'm 14 m north-east of you, coming!").kind, 'say')
  assert.equal(say("Can't wait to see it!").kind, 'say', 'only a first-person refusal')
})
