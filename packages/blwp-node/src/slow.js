// WHICH PHASE HELD THE EVENT LOOP, IN THE DAEMON'S OWN LOG.
//
// the owner 2026-09-17 19:15, the ghost letter's remainder: measured from outside the Daily, half the stalls over 300 ms
// have a [custody], [payout] or [close] line inside their window, and every picture gap over 600 ms lies inside a
// stall. That says WHICH PATH was running, not which call held the loop - `lncli` is spawned asynchronously, a
// replay runs in a worker, and a line printed during a stall is a breadcrumb, not a cause.
//
// So each phase is timed here, where the work is, and a phase that held the loop longer than the threshold says so
// with its own name. Nothing is decided by this file and no rule reads it: it logs, and a phase that is quick logs
// nothing. `BLWP_SLOW_MS` moves the threshold (default 100 ms); `BLWP_SLOW_MS=0` turns it off.
//
// AWAITED WORK IS MEASURED IN TWO NUMBERS, because they answer different questions: `held` is the synchronous stretch
// before the first await - the part a socket waits behind - and `took` is the whole call, which may be mostly waiting
// on Lightning or a peer and cost the loop nothing.
const THRESHOLD = () => {
  const named = process.env.BLWP_SLOW_MS;
  return named === undefined ? 100 : Number(named);
};

/**
 * `label`, run and timed. Returns exactly what `fn` returns, promise or value.
 *
 * `over` names a threshold of its own, for a step that is small on its own and large in a loop: a close's per-entry
 * work is under 100 ms an entry and holds the loop for a second across eight of them, and a number nobody can see is a
 * number nobody can act on.
 */
export function timed(label, fn, { say = console.log, over = null } = {}) {
  const limit = over === null ? THRESHOLD() : Math.max(over, THRESHOLD() > 0 ? 0 : Infinity);
  if (!(limit > 0)) return fn();
  const began = performance.now();
  let out;
  try {
    out = fn();
  } catch (e) {
    const held = performance.now() - began;
    if (held >= limit) say(`[slow] ${label} threw after holding the loop ${held.toFixed(0)} ms`);
    throw e;
  }
  const held = performance.now() - began;
  if (!out || typeof out.then !== 'function') {
    if (held >= limit) say(`[slow] ${label} held the loop ${held.toFixed(0)} ms`);
    return out;
  }
  if (held >= limit) say(`[slow] ${label} held the loop ${held.toFixed(0)} ms before it waited`);
  return out.then((v) => {
    const took = performance.now() - began;
    if (took >= limit) say(`[slow] ${label} took ${took.toFixed(0)} ms, ${held.toFixed(0)} ms of it on the loop`);
    return v;
  }, (e) => {
    const took = performance.now() - began;
    if (took >= limit) say(`[slow] ${label} failed after ${took.toFixed(0)} ms, ${held.toFixed(0)} ms of it on the loop`);
    throw e;
  });
}
