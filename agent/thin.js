// Record thinning shared by gen_data.mjs and rebuild_data.mjs: every decision-point record is kept, except post-goal
// ones (1 in `thin`); forecast-only records keep 1 in `thin` by order. Strips _meta.
export function thinRecords(recs, thin = 8) {
  const kept = []
  let postGoalDec = 0, forecastN = 0
  for (const r of recs) {
    const m = r._meta || {}
    const postGoal = /Goal: iron pickaxe done/.test(r.state)
    const keep = m.decision ? (postGoal ? postGoalDec++ % thin === 0 : true) : forecastN++ % thin === 0
    if (!keep) continue
    const { _meta, ...rest } = r
    kept.push(rest)
  }
  return kept
}
