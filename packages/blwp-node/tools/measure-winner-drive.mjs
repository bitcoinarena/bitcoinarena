// THE FIXTURE'S WINNER, REPLAYED AGAINST THE CORE ALONE (2026-09-19, M3).
// window-fixture.js's WINNER is not a stored input log: the test builds it with
//   const st = init(seedWordForEntry(entry, RANDOMNESS)); for (t<ticks) step(st, ...wordsAt(t));
// and the seed depends only on roundRandomness, playerPubkey, worldSecret and joinTick - all fixed - while
// wordsAt is a pure function of t. So the drive is reproducible with no daemons, no HTTP and no settlement.
// Prints what the CORE holds: run state, score, truck x/z, hp, and the tick it stopped being live.
// Exit 0 while the winner still delivers with the score the fixture names, 1 once it does not: a bisect probe.
const ROOT = process.env.BLWP_ROOT || '/tmp/btc-phase0';
const { init, step, runScore } = await import(`${ROOT}/packages/core/src/sim.js`);
const L = await import(`${ROOT}/packages/core/src/state.js`);
const { seedWordForEntry } = await import(`${ROOT}/packages/protocol/src/seed.js`);

const b32 = (n) => new Uint8Array(32).fill(n);
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const RANDOMNESS = b32(0x9b);
const WINNER = { key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}1d`), ticks: 1320 };
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

const seed = seedWordForEntry({ playerPubkey: WINNER.key, worldSecret: WINNER.worldSecret, joinTick: 0 }, RANDOMNESS);
const st = init(seed);
const s = st.i32;
const Q = 65536;
const STATE = ['LIVE', 'DELIVERED', 'WRECKED'];
let stopped = null, stoppedState = null;
for (let t = 0; t < WINNER.ticks; t++) {
  step(st, ...wordsAt(t));
  const run = s[L.O_SCORE + L.S_STATE];
  if (run !== 0 && stopped === null) { stopped = t; stoppedState = run; }
}
const run = s[L.O_SCORE + L.S_STATE];
const score = runScore(st);
const out = {
  seed,
  state: STATE[run] ?? run,
  score,
  truckX: +(s[L.O_TRUCK + L.T_X] / Q).toFixed(2),
  truckZ: +(s[L.O_TRUCK + L.T_Z] / Q).toFixed(2),
  hp: +(s[L.O_TRUCK + L.T_HP] / Q).toFixed(2),
  delivered: run === 1,
  stoppedAtTick: stopped,
  stoppedAs: stoppedState === null ? null : (STATE[stoppedState] ?? stoppedState),
};
console.log(JSON.stringify(out));
// The fixture names DELIVERED with score 367. Good while that holds.
process.exit(out.delivered && out.score === 367 ? 0 : 1);
