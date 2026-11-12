// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 sm1-find-round 2: A HEAD-TO-HEAD CLOSE THAT FAILED ONCE IS RETRIED AS A REPLAYED RUN, AND A REVEALED WINNER IS SIGNED FORFEIT.
// #headToHeadClose (verify.js) answers { stored: false, why } for every entry when its decide fails - the decide adapter's sandbox call
// (core-sandbox.js ASK_MS 2 s, LOAD_MS 10 s; a refused load is cached for the thread's life), or anything else thrown in it. The
// finality watch (server.js watchFinality) then holds each such entry HOLDING and calls verifier.retryClose on its cadence. #retryClose
// has no head-to-head branch (only the attested one): it carries receipts, finds no first mark (a head-to-head entry plays no run), every
// peer answered, so #kept's `!canonical && #neverStarted` signs stoppedOutcome - FORFEIT 0 over an empty transcript - for entries that
// revealed in time, the winner included. One signer node, one result: that FORFEIT is the seat's result for good.
// Invariant: a head-to-head entry is signed only from the round's reveals (WIN/DRAW/LOSS, FORFEIT for no reveal), never as a run that
// never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, say, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const player = (name, k) => ({ name, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const signed = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
const reveal = (w, played, move, salt) => Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.status)));

test('#1489 sm1-round-2: a head-to-head close whose decide failed once is not retried as a run that never started (no FORFEIT for a revealed move)', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x81), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const b = await lockAndPlay(w, player('rock', 0x82), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    const revealed = [await reveal(w, a, SCISSORS, sa), await reveal(w, b, ROCK, sb)];
    // THE DECIDE FAILS ONCE at the first seat (as a decide call past its 2 s sandbox deadline does): the close's own try throws
    const seat = w.nodes[0];
    skipTo(Number(roundEndMs(w.c)) + 1000);
    const real = seat.round.revealsOf;
    let failed = 0;
    seat.round.revealsOf = function (...args) {
      if (!failed) { failed++; throw new Error('decide: the core did not answer within 2000 ms'); }
      return real.apply(this, args);
    };
    await Promise.all(w.nodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (const stop = Date.now() + 20000; Date.now() < stop && !(signed(seat, w, a.eid).length && signed(seat, w, b.eid).length);) await wait(200);
    const said = { revealed, failedOnce: failed, other: { a: signed(w.nodes[1], w, a.eid), b: signed(w.nodes[1], w, b.eid) },
      seat: { a: signed(seat, w, a.eid), b: signed(seat, w, b.eid) } };
    console.log('  FACTS #1489 sm1-round-2:', JSON.stringify(said));
    assert.equal(failed, 1, 'the decide never failed: not the case this test is about');
    assert.deepEqual(said.other, { a: ['FAILED 0'], b: ['DELIVERED 2'] }, 'the other seat decides from the reveals');
    assert.notDeepEqual(said.seat.b, ['FORFEIT 0'], 'the seat whose decide failed once signed the revealed winner FORFEIT - as a run that never started');
    assert.notDeepEqual(said.seat.a, ['FORFEIT 0'], 'the seat whose decide failed once signed a revealed move FORFEIT');
  } finally { await w.close(); }
});
