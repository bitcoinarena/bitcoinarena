// THE FIXTURE'S WINNER AND LOSER, REPLAYED AGAINST THE CORE ALONE (2026-09-19, M3).
// window-fixture.js's players are not stored input logs: the tests build them with
//   const st = init(seedWordForEntry(entry, RANDOMNESS)); for (t<ticks) step(st, ...wordsAt(t));
// and the seed depends only on roundRandomness, playerPubkey, worldSecret and joinTick - all fixed - while
// wordsAt is a pure function of t. So both drives replay with no daemons, no HTTP and no settlement.
//
// THE CONSTANTS ARE IMPORTED FROM THE FIXTURE, NEVER COPIED. The first version of this probe inlined the world
// secret, and when the fixture was re-picked (1d -> 6d) the probe went on measuring the old one and reported the
// winner still wrecked. A probe that holds its own copy of what it measures will disagree with it sooner or later.
// Prints what the CORE holds: run state, score, truck x/z, hp, and the tick it stopped being live.
// Exit 0 when the winner delivers and the loser wrecks, 1 otherwise.
const ROOT = process.env.BLWP_ROOT || '/tmp/btc-phase0';
const { init, step, runScore } = await import(`${ROOT}/packages/core/src/sim.js`);
const L = await import(`${ROOT}/packages/core/src/state.js`);
const { seedWordForEntry } = await import(`${ROOT}/packages/protocol/src/seed.js`);
const { WINNER, LOSER, RANDOMNESS, wordsAt } = await import(`${ROOT}/packages/blwp-node/test/window-fixture.js`);

const Q = 65536;
const STATE = ['LIVE', 'DELIVERED', 'WRECKED'];
const play = (who) => {
  const st = init(seedWordForEntry({ playerPubkey: who.key, worldSecret: who.worldSecret, joinTick: 0 }, RANDOMNESS));
  const s = st.i32;
  let stopped = null;
  for (let t = 0; t < who.ticks; t++) {
    step(st, ...wordsAt(t));
    if (stopped === null && s[L.O_SCORE + L.S_STATE] !== 0) stopped = t;
  }
  const run = s[L.O_SCORE + L.S_STATE];
  return { who: who.name, state: STATE[run] ?? run, score: runScore(st),
    truckX: +(s[L.O_TRUCK + L.T_X] / Q).toFixed(2), truckZ: +(s[L.O_TRUCK + L.T_Z] / Q).toFixed(2),
    hp: +(s[L.O_TRUCK + L.T_HP] / Q).toFixed(2), delivered: run === 1, wrecked: run === 2, stoppedAtTick: stopped };
};
const w = play(WINNER), l = play(LOSER);
console.log(JSON.stringify(w));
console.log(JSON.stringify(l));
process.exit(w.delivered && l.wrecked ? 0 : 1);
