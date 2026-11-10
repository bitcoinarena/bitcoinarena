// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CANCEL SIGNED AFTER THE ENTRY CLOSE IS NEVER CARRIED (kanban #1435, state machine audit 8 R1). A cancel's signed message is only
// (round, entry): it carries no time, so a player whose pick lost could sign one after the outcome, and one colluding seat listing it at
// GET /cancels took the loser out of every honest seat's table and gave its stake back. A seat now takes a cancel only on its own clock
// before the entry close - at its own door, or handed on by another seat's door to it - and never from a peer's list after that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return `${r.status} ${(await r.text()).trim()}`; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const attestBoth = async (w, outcomeIx) => Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: outcomeIx, observedAtMs: w.c.entryCloseMs + 1n }, [A0, A2]))));
const signCancel = (w, e) => ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
async function settledBySweep(w, ms = 20000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
const marketLockRound = () => lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
  serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });

test('a cancel the loser signs after the outcome, listed by one colluding seat, is not carried: the loser stays in the honest seat\'s table and its stake does not come back through it', async () => {
  const w = await marketLockRound();
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const back = (d, e) => fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}`)
    .then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).slice(0, 160)}`));
  try {
    const played = [await lockAndPlay(w, player(0), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(1), { noMarks: true, pick: 1 })];
    await closeRound(w);
    const lateDoor = await fetch(`http://127.0.0.1:${w.b.port}/cancel?entry=${toHex(played[1].eid)}`, { method: 'POST', body: signCancel(w, played[1]) }).then((r) => r.status);
    await attestBoth(w, 0);
    const o = await outcome(w.a, w.rid);
    // ENTRY 1 PICKED 1 AND LOST: its player signs a cancel now, and seat A (colluding, a modified seat) lists it at GET /cancels
    w.a.round.putCancel({ roundId: w.rid, entryId: played[1].eid, signature: signCancel(w, played[1]), receivedMs: w.a.round.now() });
    skipTo(Number(o.finalAtMs) + 100);
    const got = await settledBySweep(w, 8000);
    const facts = { lateDoor, afterB: w.b.round.cancelled(played[1].eid), state: got.state, why: got.why,
      rowsAtB: ((await outcome(w.b, w.rid)).table || { rows: [] }).rows.length, loserBackViaB: await back(w.b, played[1]) };
    console.log('  #1435:', JSON.stringify(facts));
    assert.equal(lateDoor, 409, 'the door took a cancel after the entry close');
    assert.equal(facts.afterB, false, 'honest seat B took a cancel signed after the close and the outcome, from a peer');
    assert.equal(facts.rowsAtB, 2, 'the loser was taken out of seat B\'s table');
    assert.notEqual(facts.loserBackViaB, '200', 'the loser\'s stake came back through seat B');
  } finally { await w.close(); }
});

test('a cancel taken in time at one seat only is handed on to the round\'s other seats before the entry close', async () => {
  const w = await marketLockRound();
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [await lockAndPlay(w, player(10), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(11), { noMarks: true, pick: 1 })];
    const at = await fetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(played[1].eid)}`, { method: 'POST', body: signCancel(w, played[1]) }).then((r) => r.status);
    let atB = false;
    for (const stop = Date.now() + 8000; Date.now() < stop && !atB; await wait(100)) atB = w.b.round.cancelled(played[1].eid);
    console.log('  #1435 in time:', JSON.stringify({ at, atB }));
    assert.equal(at, 201);
    assert.equal(atB, true, 'seat B never got the cancel seat A took before the entry close');
  } finally { await w.close(); }
});
