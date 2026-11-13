// kanban #1489 sm5-find-h2h 1: TWO SEATS WHOSE CLOCKS DIFFER BY LESS THAN THE 5 s TOLERANCE DECIDE ONE HEAD-TO-HEAD ROUND OPPOSITE WAYS.
// A seat's reveal door is timed by its own clock (revealStands, atMs <= round end), and its close sweep decides the round the moment its own
// clock passes the end: carryReveals pulls the peers' reveals once, then the verdict is signed and never revisited. A seat whose clock runs
// 1.5 s behind still takes a reveal for 1.5 s after the seat ahead has decided without it. Seat A signs the late revealer FORFEIT (and the
// other player WIN as a lone revealer); seat B, holding both moves, signs the late revealer WIN and the other LOSS.
// Invariant: every seat of a round signs the same verdict for an entry (the reveals every seat decides from are the same).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, untilSettled } from './lock-round-fixture.js';
import { resultFinality } from '../src/finality.js';
import { PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
// entries close 8 s after the committee time (the fixture's 1.5 s leaves no room for a seat 1.5 s behind)
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, entryCloseMs: 8500n };
const ROCK = 0, PAPER = 1;
const SKEW_MS = 1500;
const mk = (n) => ({ name: `p${n}`, key: b32(0x90 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
// THIS SEAT'S OWN SIGNED VERDICT (a seat also keeps the peers' results it gathered)
const verdicts = (d, w, eid) => d.round.results(w.rid, eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((p) => toHex(p.nodePubkey) === toHex(d.round.pubkey)).map((p) => `${p.outcome} ${p.score}`);
const reveal = (d, played, move, salt) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then(async (x) => `${x.status}${x.status >= 300 ? ` ${(await x.text()).slice(0, 80)}` : ''}`);

test('#1489 sm5-h2h-1: a seat 1.5 s behind takes a reveal the seat ahead already decided without - the two sign opposite verdicts', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 20000 });
  const [A, B] = w.nodes;
  // SEAT B's CLOCK RUNS 1.5 s BEHIND SEAT A's (well inside FINAL_TOLERANCE_MS, 5 s)
  B.round.now = () => testNow() - SKEW_MS;
  try {
    skipTo(Number(w.c.committeeTimeMs) + SKEW_MS + 200);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + SKEW_MS + 500);
    const ra = [await reveal(A, a, ROCK, sa), await reveal(B, a, ROCK, sa)];
    // the round's end on A's clock: A closes and decides; B's clock still reads 1 s before the end
    const end = Number(roundEndMs(w.c));
    skipTo(end + 500);
    for (let i = 0; i < 100 && !(verdicts(A, w, a.eid).length && verdicts(A, w, b.eid).length); i++) await wait(100);
    const aFirst = { a: verdicts(A, w, a.eid), b: verdicts(A, w, b.eid) };
    // player b's reveal, 0.5 s after the end on A's clock - 1 s before it on B's
    const rb = [await reveal(A, b, PAPER, sb), await reveal(B, b, PAPER, sb)];
    for (let i = 0; i < 100 && !(verdicts(B, w, a.eid).length && verdicts(B, w, b.eid).length); i++) await wait(100);
    const got = { revealA: ra, revealB: rb, seatA: { a: verdicts(A, w, a.eid), b: verdicts(A, w, b.eid) }, seatAFirst: aFirst, seatB: { a: verdicts(B, w, a.eid), b: verdicts(B, w, b.eid) } };
    console.log('  FACTS (sm5-h2h-1):', JSON.stringify(got));
    assert.ok(got.seatA.b.length && got.seatB.b.length, `both seats signed player b's entry: ${JSON.stringify(got)}`);
    assert.deepEqual(got.seatA.b, got.seatB.b, `the two seats signed player b's entry differently: ${JSON.stringify(got)}`);
    assert.deepEqual(got.seatA.a, got.seatB.a, `the two seats signed player a's entry differently: ${JSON.stringify(got)}`);
    // and the round settles (it cannot while the seats disagree) - once its §13A window is over on both clocks (kanban #1976: the probe
    // first asked 4 s after the close, inside the 600 s objection window, where no round settles: it read NONE with the seats agreeing)
    const win = windowsOf(w.c);
    const published = () => w.nodes.every((d) => d.round.entriesOf(w.rid).every(({ entryId }) => {
      const f = resultFinality(d.round, w.rid, entryId);
      return f.state === PROVISIONALLY_FINAL && f.published === true;
    }));
    for (const stop = Date.now() + 30000; Date.now() < stop && !published(); await wait(100));
    skipTo(Number(win.finalAfterMs) + SKEW_MS + 50);
    const st = await untilSettled(w);
    assert.equal(st && st.state, 'ACCEPTED', JSON.stringify(st));
  } finally { await w.close(); }
});

// kanban #1976: the reveal the seat behind took inside its own window (A's clock 0.5 s past the end) is carried by the seat ahead - which now
// closes and decides only at end + FINAL_TOLERANCE_MS on its clock - and both seats sign b's win
test('#1976: a reveal taken by the seat 1.5 s behind just after the end on the seat ahead is decided alike at both seats', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 20000 });
  const [A, B] = w.nodes;
  B.round.now = () => testNow() - SKEW_MS;
  try {
    skipTo(Number(w.c.committeeTimeMs) + SKEW_MS + 200);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + SKEW_MS + 500);
    const ra = [await reveal(A, a, ROCK, sa), await reveal(B, a, ROCK, sa)];
    skipTo(Number(roundEndMs(w.c)) + 500);
    // b's reveal at A, then 0.7 s later at B (B's clock still 0.3 s before the end) - past A's close sweep (every 250 ms), which before #1976 had decided by then
    const rb = [await reveal(A, b, PAPER, sb)];
    await wait(700);
    rb.push(await reveal(B, b, PAPER, sb));
    const both = (d) => verdicts(d, w, a.eid).length && verdicts(d, w, b.eid).length;
    for (let i = 0; i < 150 && !(both(A) && both(B)); i++) await wait(100);
    const got = { revealA: ra, revealB: rb, seatA: { a: verdicts(A, w, a.eid), b: verdicts(A, w, b.eid) }, seatB: { a: verdicts(B, w, a.eid), b: verdicts(B, w, b.eid) } };
    console.log('  FACTS (#1976 carried):', JSON.stringify(got));
    assert.equal(rb[0].slice(0, 3), '409', `the seat ahead refuses the late reveal: ${JSON.stringify(got)}`);
    assert.equal(rb[1], '201', `the seat behind takes it: ${JSON.stringify(got)}`);
    assert.deepEqual(got.seatA, got.seatB, `the two seats signed differently: ${JSON.stringify(got)}`);
    assert.deepEqual(got.seatA.b, ['DELIVERED 2'], `paper beats rock at both seats: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
