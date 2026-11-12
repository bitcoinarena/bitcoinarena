// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 sm1-find-round 1 (kanban #1587): A SEAT RESTARTED PAST A HEAD-TO-HEAD ROUND'S END CLOSES IT BEFORE IT CAN LEARN WHO IS IN IT.
// serve() runs the close sweep once, synchronously, at its own construction (server.js `sweep()` after `setInterval(sweep, ...)`),
// and that is before `headToHeadReady = true` further down - so afterClose of every head-to-head round that ended while the seat
// was down takes the "as before #1071" path: no membersKnown, the round decided and SIGNED over only the entries this seat holds.
// A seat whose door missed one entry (the #1068 case: 18 of 114 two-entry rounds on 7 of 14 seats) signs VOID for the entry it holds,
// while the six seats that hold both sign FAILED / DELIVERED - and its one result per entry is final (INSERT OR IGNORE), so the
// membersKnown pass the start's resumingCloses runs right after it changes nothing. Invariant (#1071): a head-to-head seat signs
// nothing for a round before it knows who is in it - the short seat signs what the threshold signs, as it does when it is up at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, curve } from './lock-round-fixture.js';
import { b32, opts, say, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { CLOCK } from './block-clock.js';
import { serve } from '../src/server.js';
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
const reveal = (w, played, move, salt, seats) => Promise.all(seats.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.text())));
const shutDoor = (d, playerKey) => {
  const real = d.round.enter;
  d.round.enter = function (contract, ...more) {
    if (!more.length && toHex(contract.playerPubkey) === toHex(playerKey)) throw new Error('entry refused: the backup rule');
    return real.call(this, contract, ...more);
  };
};

test('#1489 sm1-round-2: a seat restarted past a head-to-head round\'s end signs what the threshold signs, not VOID over the entries it alone holds', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  let back = null;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, b32(0x72));
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await wait(2500);                                              // the relay has had its go at that door
    assert.ok(!short.round.entry(b.eid), 'the short seat holds the second entry: not the case this test is about');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa, w.nodes);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    // THE SHORT SEAT GOES DOWN (a deploy, a crash) before the round's end; the six others close it at its end and sign
    const port = short.port, db = short.round.db;
    await short.close();
    const others = w.nodes.slice(0, 6);
    skipTo(Number(roundEndMs(w.c)) + 1000);
    await Promise.all(others.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (const stop = Date.now() + 30000; Date.now() < stop && !others.every((d) => signed(d, w, a.eid).length && signed(d, w, b.eid).length);) await wait(200);
    const atOthers = others.map((d) => ({ a: signed(d, w, a.eid), b: signed(d, w, b.eid) }));
    // AND COMES BACK on its own store and port, as a live seat does: closeAtEnd, its peers named
    back = await serve(db, { plugins: [NEXTBLOCK, RPS], port, ...opts, stakeLocks: w.slot.port, poolCurve: curve, finality: { everyMs: 100 },
      chainFor: w.slot.chainFor, randomnessFor: w.slot.randomnessFor, lnurlFetch: w.lnurl.fetchLike, closeAtEnd: { everyMs: 250 },
      peers: others.map((d) => `http://127.0.0.1:${d.port}`) });
    back.round.chainView = CLOCK.chainView();
    back.stakeSecrets.peers = others.map((d) => `http://127.0.0.1:${d.port}`);
    back.dkg.peers = back.stakeSecrets.peers;
    w.nodes[6] = back;                                             // closed with the rest
    for (const stop = Date.now() + 30000; Date.now() < stop && !signed(back, w, a.eid).length;) await wait(200);
    await wait(3000);                                              // and the start's own resumed close has run too
    const said = { others: atOthers, shortA: signed(back, w, a.eid), shortB: signed(back, w, b.eid), shortHoldsB: !!back.round.entry(b.eid) };
    console.log('  FACTS #1489 sm1-round-2:', JSON.stringify(said));
    for (const o of atOthers) assert.deepEqual(o, { a: ['FAILED 0'], b: ['DELIVERED 2'] }, 'the six seats that hold both entries decide the round');
    assert.deepEqual(said.shortA, ['FAILED 0'], `the restarted seat signed ${said.shortA} for the entry it held - decided before it learned who is in the round`);
  } finally { await w.close(); }
});
