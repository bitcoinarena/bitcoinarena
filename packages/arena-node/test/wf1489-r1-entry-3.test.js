// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-find-entry 3: A CANCEL POSTED A FEW MS BEFORE THE ENTRY CLOSE SPLITS THE SEATS' TABLES. Since #1435 a seat takes a cancel only
// on its own clock before the entry close, at its own door or handed on by another seat's door - and carries none from a peer after it. A player
// who posts his signed cancel to one seat just before the close (that seat takes it; its hand-on reaches the other seats after the close, and
// they refuse it) leaves the round with one table at the seats holding the cancel and another at the rest. Each rebuilds another settlement, the
// threshold never meets, and the whole market's stakes wait for their locks' expiry. Safe behaviour: the seats settle the round all the same.
// (fixture copied from late-cancel-1435.test.js:) A CANCEL SIGNED AFTER THE ENTRY CLOSE IS NEVER CARRIED (kanban #1435, state machine audit 8 R1). A cancel's signed message is only
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


test('a cancel landing at one seat a few ms before the entry close does not stop the market settling', async () => {
  const w = await marketLockRound();
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  // THE SEAT-TO-SEAT HAND-ON TAKES A NORMAL ROUND TRIP (live seats: 50-100 ms through their tunnels)
  globalThis.fetch = async (u, o) => { if (String(u).includes(`:${w.b.port}/cancel?`)) await wait(120); return realFetch(u, o); };
  try {
    const played = [await lockAndPlay(w, player(20), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(21), { noMarks: true, pick: 1 })];
    skipTo(Number(w.c.entryCloseMs) - 30);
    const atA = await realFetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(played[1].eid)}`, { method: 'POST', body: signCancel(w, played[1]) }).then((r) => r.status);
    await wait(600);
    const split = { atA, cancelledAtA: w.a.round.cancelled(played[1].eid), cancelledAtB: w.b.round.cancelled(played[1].eid) };
    await closeRound(w);
    await attestBoth(w, 0);
    const o = await outcome(w.a, w.rid);
    skipTo(Number(o.finalAtMs) + 100);
    const got = await settledBySweep(w, 10000);
    console.log('  #1489-3:', JSON.stringify({ ...split, state: got.state, why: got.why }));
    assert.equal(atA, 201);
    assert.equal(got.state, 'ACCEPTED', `the market never settled: ${JSON.stringify({ ...split, why: got.why })}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});

// kanban #1520: the grace after the close takes only a cancel another seat of the round already holds - a player who posts his own cancel
// after the close with the hand-on mark is refused all the same (the #1435 door stays shut to him)
test('a cancel posted after the close with the hand-on mark, held by no seat, is refused', async () => {
  const w = await marketLockRound();
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [await lockAndPlay(w, player(30), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(31), { noMarks: true, pick: 1 })];
    skipTo(Number(w.c.entryCloseMs) + 50);
    const forged = await fetch(`http://127.0.0.1:${w.b.port}/cancel?entry=${toHex(played[1].eid)}`,
      { method: 'POST', body: signCancel(w, played[1]), headers: { 'x-arena-relayed': '1' } }).then((r) => r.status);
    assert.equal(forged, 409);
    assert.equal(w.b.round.cancelled(played[1].eid), false);
  } finally { await w.close(); }
});
