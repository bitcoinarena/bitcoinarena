// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #3811 (#1489 sm1-find-round, base 1a7276a5e, finding 1): A SEAT KILLED BETWEEN ITS CLOSE'S STORE WRITE AND ITS CLOSE LOGIC NEVER LEARNS WHO IS IN A
// HEAD-TO-HEAD ROUND IT HELD NO ENTRY OF. The close sweep writes rounds.state = CLOSED (round.close, one UPDATE) and only then runs afterClose ->
// membersKnown, which takes the round's entries from the peers (takeAcceptedEntry) - for up to the result window (end + 605 s) while peers are
// slow or unreachable. A seat killed in that window (a deploy, an OOM kill) comes back with the round CLOSED and no entry held: the close sweep
// skips it (no longer open), and the start's resumingCloses reruns the close logic only for a closed round with an entry "short of final" held
// HERE - none - so membersKnown never runs again and the seat never signs anything for the round. Invariant: a round closed here whose close
// logic did not finish is taken up again after a restart, as one that is still open past its end is (#1587).
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

test('#1489 sm1-round finding 1: a seat killed after its close write, before its close logic learned the members, signs the round after its restart', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const short = w.nodes[6];
    shutDoor(short, b32(0x71)); shutDoor(short, b32(0x72));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true, unreached: [6] });
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await wait(2500);
    assert.ok(!short.round.entry(a.eid) && !short.round.entry(b.eid), 'the short seat holds an entry: not the case this test is about');
    skipTo(Number(w.c.entryCloseMs) + 500);
    const others = w.nodes.slice(0, 6);
    await reveal(w, a, SCISSORS, sa, others);
    await reveal(w, b, ROCK, sb, others);
    skipTo(Number(roundEndMs(w.c)) + 1000);
    // THE SHORT SEAT'S CLOSE WRITE LANDS AND THE PROCESS IS KILLED BEFORE ITS CLOSE LOGIC RAN (round.close is the sweep's first step)
    assert.equal(short.round.close(w.rid), true);
    const port = short.port, db = short.round.db;
    await short.close();
    await Promise.all(others.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (const stop = Date.now() + 30000; Date.now() < stop && !others.every((d) => signed(d, w, a.eid).length && signed(d, w, b.eid).length);) await wait(200);
    const atOthers = others.map((d) => ({ a: signed(d, w, a.eid), b: signed(d, w, b.eid) }));
    const back = await serve(db, { plugins: [NEXTBLOCK, RPS], port, ...opts, stakeLocks: w.slot.port, poolCurve: curve, finality: { everyMs: 100 },
      chainFor: w.slot.chainFor, randomnessFor: w.slot.randomnessFor, lnurlFetch: w.lnurl.fetchLike, closeAtEnd: { everyMs: 250 },
      peers: others.map((d) => `http://127.0.0.1:${d.port}`) });
    back.round.chainView = CLOCK.chainView();
    back.stakeSecrets.peers = others.map((d) => `http://127.0.0.1:${d.port}`);
    back.dkg.peers = back.stakeSecrets.peers;
    w.nodes[6] = back;
    for (const stop = Date.now() + 20000; Date.now() < stop && !signed(back, w, a.eid).length;) await wait(200);
    const said = { others: atOthers, heldA: !!back.round.entry(a.eid), heldB: !!back.round.entry(b.eid), shortA: signed(back, w, a.eid), shortB: signed(back, w, b.eid) };
    console.log('  FACTS #1489 sm1-round finding 1:', JSON.stringify(said));
    for (const o of atOthers) assert.deepEqual(o, { a: ['FAILED 0'], b: ['DELIVERED 2'] }, 'the six seats decide the round');
    assert.deepEqual({ a: said.shortA, b: said.shortB }, { a: ['FAILED 0'], b: ['DELIVERED 2'] },
      `the restarted seat never took the round up again: entries held ${said.heldA}/${said.heldB}, signed ${JSON.stringify(said.shortA)} / ${JSON.stringify(said.shortB)}`);
  } finally { await w.close(); }
});
