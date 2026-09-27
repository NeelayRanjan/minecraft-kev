// Leader prompt inputs whose user prompts, as rendered by the base branch (66867fc) before the blueprint answers, are
// stored in leader_user_base_{plain,goals}.txt: without a blueprint cut or feedback the prompt must stay byte-identical.
export const baseCtx = {
  stateText: 'Minecraft survival, day 1. you: health 16/20, food 13/20.',
  chainText: 'Goal chain: iron pickaxe. step 5 of 47: get 3 raw iron (have 1).',
  need: { ingots: 3, diamonds: 0, sticks: 2, obsidian: 0, flint: 0, missing: ['iron_pickaxe'] },
  options: [{ id: 'mine_iron', desc: 'mine the nearest known iron ore' }, { id: 'explore_toward(down)', desc: 'dig a staircase down' }, { id: 'wait', desc: 'stand still' }],
  current: { id: 'mine_iron', elapsedS: 12, progress: 0.4, lastResult: { id: 'mine_stone', result: 'ok', repeats: 1 } },
  history: [
    { t: 100, kind: 'subtask_done', id: 'mine_stone', result: 'ok' },
    { t: 110, kind: 'interrupt', reason: 'threat', subtask: 'mine_iron' },
    { t: 120, kind: 'plan_added', plan: { id: 2, title: 'compass', steps: [{ kind: 'gather', arg: 'redstone', count: 1 }], source: 'audience:Steve' } },
    { t: 130, kind: 'leader_say', text: 'On it' },
  ],
  forecasts: { subgoal_succeeds_60s: 0.41 },
  forecastTrend: { subgoal_succeeds_60s: [0.6, 0.5, 0.41] },
  kevPick: { t: 99, top: [['mine_iron', 0.8], ['wait', 0.1]] },
  subtaskStats: { mine_iron: { attempts: 3, ok: 1, fails: { no_path: 2 } } },
  ownHistory: [{ t: 130, action: 'say', kind: 'say', why: 'acknowledge' }],
  minutesLeft: 12.5, deaths: 0,
  recentResults: [{ id: 'explore_toward(down)', result: 'no_path' }],
}

export const goalCtx = {
  ...baseCtx,
  goalStack: { text: 'Goal from the audience (Steve): gather 8 cobblestone (have 3). Then: the chain', pushed: [
    { id: 1, kind: 'gather', arg: 'cobblestone', count: 8, source: 'audience:Steve', t: 40, progress: 'gather 8 cobblestone (have 3)' }] },
  plans: ['#1 compass (1 of 3 steps): gather redstone 1', 'blocked #2 bucket: no iron'],
  requests: [{ t: 140, name: 'Alex', text: 'build me a small stone hut' }],
}
