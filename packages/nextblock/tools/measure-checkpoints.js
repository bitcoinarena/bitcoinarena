// What a checkpoint buys, in ticks.
//
// A transcript replays: hand the batches to `step` and the digest comes out
// the same. What it cannot say is WHERE two runs part company - only that the
// final digests differ, which puts the disagreement somewhere in the whole
// round. Checkpoints are a state hash at agreed ticks, so the answer becomes a
// window instead of a round.
//
// This measures the difference on the real core rather than reasoning about
// it: one run, then the same run with a single input word changed, and the
// first checkpoint that disagrees.
//
//   node packages/nextblock/tools/measure-checkpoints.js
import * as sim from '../src/sim.js';
import { hash } from '../src/state.js';

const ONE = 65536;
const TICKS = 600;            // ten seconds at the core's 60 Hz
const EVERY = 60;             // one checkpoint a second, the spec's rate
const FLIP_AT = 307;          // somewhere in the middle, nothing special about it

/** A scripted drive: throttle down, and a slalom that does not depend on time. */
const steerAt = (t) => (Math.floor(t / 90) % 2 ? -ONE : ONE);

function run(flip, delta) {
  const st = sim.init(1);
  const marks = [];
  for (let t = 0; t < TICKS; t++) {
    let steer = steerAt(t);
    if (flip && t === FLIP_AT) steer += delta;
    sim.step(st, ONE, steer, 0, 0, 0);
    if ((t + 1) % EVERY === 0) marks.push({ tick: t + 1, state: hash(st) });
  }
  return marks;
}

// HOW BIG A CHANGE HAS TO BE. One unit of Q16.16 on the steer at a single
// tick does not reach the state at all - the core absorbs it - so the size is
// measured rather than assumed, and the smallest one that moves the digest is
// the one this reports on.
const honest = run(false, 0);
let delta = 1, altered = null;
for (; delta <= ONE; delta *= 2) {
  altered = run(true, delta);
  if (honest.at(-1).state !== altered.at(-1).state) break;
}

const firstBad = honest.findIndex((m, i) => m.state !== altered[i].state);
const lastGood = firstBad > 0 ? honest[firstBad - 1].tick : 0;

console.log(`ticks in the round        ${TICKS}`);
console.log(`checkpoint every          ${EVERY} ticks`);
console.log(`checkpoints in the round  ${honest.length}`);
console.log(`input changed at tick     ${FLIP_AT}`);
console.log(`smallest steer change     ${delta} of ${ONE}  (${(delta / ONE).toFixed(6)} of full lock)`);
console.log('');
if (firstBad < 0) {
  console.log('the runs never disagree - the change did not reach the state');
} else {
  console.log(`first disagreeing mark    tick ${altered[firstBad].tick}`);
  console.log(`last agreeing mark        tick ${lastGood}`);
  console.log(`divergence located to     ${altered[firstBad].tick - lastGood} ticks`);
  console.log(`without checkpoints       ${TICKS} ticks`);
  console.log(`narrowed by               ${(TICKS / (altered[firstBad].tick - lastGood)).toFixed(0)}x`);
}
console.log('');
console.log(`final digests differ       ${honest.at(-1).state !== altered.at(-1).state}`);
