// Fixture plugin: offers echo(<arg>) for each of obs.echoArgs (default ['a']) when obs.echoReady; run returns the arg.
export default {
  id: 'echo', timeout: 2, breaker: true,
  options(obs, goal) { return (obs.echoArgs || ['a']).map(arg => ({ arg, desc: `echo ${arg}` })) },
  preconditions(obs, arg) { return !!obs.echoReady },
  async run(motor, arg, obs) { return { result: 'ok', detail: arg } },
}
