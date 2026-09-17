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
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

/**
 * THE PROCESSOR THIS THREAD ITSELF USED, in ms - not the process's, which counts every replay worker and would say a
 * daemon was busy while its own loop sat waiting for the machine. Linux keeps it per thread; where it does not, the
 * process's own number is used and it is the only number there is.
 */
const threadCpu = () => {
  try {
    const stat = readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) * 10;      // utime + stime, in clock ticks of 10 ms
  } catch {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  }
};

// AWAITED WORK IS MEASURED IN TWO NUMBERS, because they answer different questions: `held` is the synchronous stretch
// before the first await - the part a socket waits behind - and `took` is the whole call, which may be mostly waiting
// on Lightning or a peer and cost the loop nothing.
const THRESHOLD = () => {
  const named = process.env.BLWP_SLOW_MS;
  return named === undefined ? 100 : Number(named);
};

/**
 * WHAT RAN, AND FOR HOW LONG IT DID NOT LET GO: every timed phase's SYNCHRONOUS stretch, kept in a ring.
 *
 * A stall cannot be read off a stack of what is open: a timer cannot fire while the loop is held, so by the time the
 * watcher below runs, the phase that held it has already returned. So each phase writes down the window it held, and
 * a stall is named by the windows that fall inside it. A stall with no window in it ran in something nobody timed,
 * which is a different fact and is printed as one.
 */
const ran = [];
const KEPT = 256;
const notice = (label, from, to) => {
  if (to - from < 5) return;
  ran.push({ label, from, to });
  if (ran.length > KEPT) ran.shift();
};

/** Only for a test: what the ring holds. */
export const heldRecently = () => ran.slice();

/** Every long garbage collection, so a stall that is one is not blamed on the phase it interrupted. */
const collections = [];
let watchingGc = false;
function watchCollections() {
  if (watchingGc) return;
  watchingGc = true;
  try {
    const kinds = { [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor', [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
      [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental', [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak callbacks' };
    const seen = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 20) continue;
        collections.push({ at: performance.now(), ms: e.duration, kind: kinds[e.detail && e.detail.kind] || 'a collection' });
        if (collections.length > 64) collections.shift();
      }
    });
    seen.observe({ entryTypes: ['gc'] });
    seen.unref?.();
  } catch { watchingGc = false; }
}

/**
 * THE LOOP WATCHES ITSELF AND SAYS WHAT HELD IT (the owner 2026-09-17 19:15, the ghost lag). Measured from outside, 32 of
 * the 34 stalls over 300 ms left on the Daily had no phase name at all: an outside pinger can only say WHEN the loop
 * stopped answering. This ticks every `every` ms and, when a tick is late by more than `over`, prints the labels that
 * were open, the garbage collections inside that window, and - when there were neither - says so in those words,
 * because "nothing was named" is the fact that tells an operator to time something new.
 */
export function watchLoop({ every = 50, over = 250, say = console.log } = {}) {
  watchCollections();
  let last = performance.now();
  let lastCpu = threadCpu();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = threadCpu();
    const used = cpu - lastCpu;
    lastCpu = cpu;
    const late = now - last - every;
    last = now;
    if (late < over) return;
    const inside = ran.filter((r) => r.to > now - late - every && r.from < now)
      .sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 3);
    const held = inside.length
      ? inside.map((r) => `${r.label} ${(r.to - r.from).toFixed(0)} ms`).join(', ')
      : null;
    const gc = collections.filter((c) => c.at >= now - late - every).reduce((a, c) => a + c.ms, 0);
    // AND WHETHER THIS PROCESS WAS RUNNING AT ALL. A loop held while the process used almost no processor was not
    // held by anything it did: it was not given the machine. That is a different fault from a slow phase and must not
    // be read as one - this host also carries a bitcoind at about five cores.
    const running = used > late * 0.5;
    say(`[lag] the loop was held ${late.toFixed(0)} ms`
      + (held ? ` and in it ran ${held}` : '')
      + (gc >= 20 ? `${held ? ',' : ''} with ${gc.toFixed(0)} ms of garbage collection in it` : '')
      + (!held && gc < 20 ? ' by something nobody timed' : '')
      + `; this thread used ${used.toFixed(0)} ms of processor in it`
      + (running ? '' : ' - it was waiting for the machine, not for itself'));
  }, every);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

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
  const leave = () => notice(label, began, performance.now());
  let out;
  try {
    out = fn();
  } catch (e) {
    leave();
    const held = performance.now() - began;
    if (held >= limit) say(`[slow] ${label} threw after holding the loop ${held.toFixed(0)} ms`);
    throw e;
  }
  leave();
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
