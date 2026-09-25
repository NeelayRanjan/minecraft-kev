// A minimal obs (the summarize() output shape) with overrides, for the pure-module tests.
export function baseObs(over = {}) {
  return {
    t: 0, day: 0, timeOfDay: 1000, phase: 'morning', secondsToDusk: 550, secondsToMorning: null, weather: 'clear', biome: 'forest',
    pos: { x: 40, y: 72, z: -37 }, standingOn: 'grass_block', skyLight: 15, blockLight: 0, underground: false, inWater: false,
    health: 20, food: 20, inventory: {}, holding: null, toolWear: {},
    base: { crafting_table: null, furnace: null },
    memory: { ironSeen: null, lastPath: null, deaths: 0, heading: 'north' },
    blocks: [], entities: [], nearestHostile: null,
    current: null, last: null, goal: 'iron_pickaxe', done: false,
    armor: {}, portalLit: false, portalFrame: null,
    ...over,
  }
}
