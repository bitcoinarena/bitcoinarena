// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS AGREE BEFORE A WINNER IS PAID, AS A THRESHOLD OF SIGNATURES (2026-09-29 17:33, PRIORITIES item 2:
// "Seats agree before a winner payout as a threshold, not over HTTP").
//
//   COUNT  a seat's yes is its node key's BIP-340 signature over the plan's id: an unsigned 201, a stranger's key, a
//          signature over another plan (one amount changed), a forged one, a seat counted twice - none is a vote. 2 of 2
//          and 5 of 7 (receiptsNeeded) decide.
//   ID     the plan's id is the same bytes whichever order the rows and their keys arrive in, and moves with any field.
//   NODES  two signer nodes and the fake lock port: a peer whose /settle-sends answers 201 with no signature is not a
//          seat that agreed - nothing is settled, no invoice paid; the same peer's signed answer settles and pays, and
//          GET /settle-taken serves the certificate that counted, which verifies here on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { planTakenId, signPlanTaken, countPlanTaken, splitCertificate, checkPlanTaken } from '../src/plan-taken.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, proposerOf, standing } from './lock-round-fixture.js';
import { LOSER, wait } from './window-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seat = (n) => { const secret = b32(n); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const ROUND = b32(0x77);
const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };
const ROWS = [
  { entry: '11'.repeat(32), attempt: 0, address: 'w@example.com', invoice: 'lnbcrt1', paymentHash: 'bb'.repeat(32), invoiceMsat: '93440',
    payoutMsat: '98000', owedMsat: '98000', gatewayUrl: 'http://gw-a/', gatewayPk: '02c3', expiration: '400' },
  { entry: '22'.repeat(32), attempt: 0, address: 'v@example.com', invoice: 'lnbcrt2', paymentHash: 'aa'.repeat(32), invoiceMsat: '1000',
    payoutMsat: '2000', owedMsat: '2000', gatewayUrl: 'http://gw-a/', gatewayPk: '02c3', expiration: '400' },
];

test('a seat\'s yes is its signature over this plan: unsigned, strangers, other plans, forgeries and doubles do not count; 2 of 2 and 5 of 7 decide', () => {
  const planId = planTakenId({ roundId: ROUND, rows: ROWS });
  const two = [seat(1), seat(2)];
  const sign = (s, id = planId) => signPlanTaken({ planId: id, secret: s.secret, pubkey: s.pubkey });
  const seats2 = two.map((s) => s.pubkey);

  const both = countPlanTaken({ own: sign(two[0]), answers: [{ base: 'B', bytes: sign(two[1]) }], seats: seats2, planId });
  assert.deepEqual([both.agreed, both.needed, both.final], [2, 2, true]);

  const unsigned = countPlanTaken({ own: sign(two[0]), answers: [{ base: 'B', bytes: new TextEncoder().encode('1 send plan(s) checked and kept') }], seats: seats2, planId });
  assert.deepEqual([unsigned.agreed, unsigned.final], [1, false]);
  assert.match(unsigned.refused[0], /B: no signed acceptance/);

  const stranger = countPlanTaken({ own: sign(two[0]), answers: [{ base: 'B', bytes: sign(seat(9)) }], seats: seats2, planId });
  assert.match(stranger.refused[0], /not one of the round's seats/);
  assert.equal(stranger.final, false);

  const moved = [{ ...ROWS[0], payoutMsat: '98001' }, ROWS[1]];
  const other = countPlanTaken({ own: sign(two[0]), answers: [{ base: 'B', bytes: sign(two[1], planTakenId({ roundId: ROUND, rows: moved })) }], seats: seats2, planId });
  assert.match(other.refused[0], /signed another plan/);
  assert.equal(other.final, false);

  const forged = sign(two[1]); forged[100] ^= 1;
  assert.match(countPlanTaken({ own: sign(two[0]), answers: [{ base: 'B', bytes: forged }], seats: seats2, planId }).refused[0], /does not verify/);

  const twice = countPlanTaken({ own: sign(two[0]), answers: [{ base: 'A again', bytes: sign(two[0]) }], seats: seats2, planId });
  assert.deepEqual([twice.agreed, twice.final], [1, false]);
  assert.match(twice.refused[0], /already counted/);

  const seven = [1, 2, 3, 4, 5, 6, 7].map(seat);
  const seats7 = seven.map((s) => s.pubkey);
  const four = countPlanTaken({ own: sign(seven[0]), answers: seven.slice(1, 4).map((s, i) => ({ base: `p${i}`, bytes: sign(s) }))
    .concat([{ base: 'p4', why: 'refused' }, { base: 'p5', bytes: new Uint8Array(0) }, { base: 'p6', bytes: sign(seat(8)) }]), seats: seats7, planId });
  assert.deepEqual([four.agreed, four.needed, four.final], [4, 5, false]);
  const five = countPlanTaken({ own: sign(seven[0]), answers: seven.slice(1, 5).map((s, i) => ({ base: `p${i}`, bytes: sign(s) })), seats: seats7, planId });
  assert.deepEqual([five.agreed, five.needed, five.final], [5, 5, true]);
  assert.equal(five.certificate.length, 5);
});

test('the plan id is the plan: row order and key order do not move it, any field does, and the late entry and the round do', () => {
  const id = toHex(planTakenId({ roundId: ROUND, rows: ROWS }));
  const shuffled = [ROWS[1], Object.fromEntries(Object.entries(ROWS[0]).reverse())];
  assert.equal(toHex(planTakenId({ roundId: ROUND, rows: shuffled })), id);
  for (const k of Object.keys(ROWS[0])) {
    const changed = [{ ...ROWS[0], [k]: k === 'attempt' ? 1 : `${ROWS[0][k]}x` }, ROWS[1]];
    assert.notEqual(toHex(planTakenId({ roundId: ROUND, rows: changed })), id, `${k} did not move the id`);
  }
  assert.notEqual(toHex(planTakenId({ roundId: ROUND, lateEntryId: b32(3), rows: ROWS })), id);
  assert.notEqual(toHex(planTakenId({ roundId: b32(0x78), rows: ROWS })), id);
});

// SINCE WINNINGS-AUTO (RULED 2026-10-01) no winner has a send plan; the seats' signed agreement on a send plan
// still guards a walk-away round's donation sends, so the plan measured here is that one.
test('two signer nodes: a peer that answers the donation send plan 201 with no signature has not agreed - nothing settled, nothing paid; its signed answer settles and pays, and the certificate verifies on its own', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  const asker = proposerOf(w);
  const real = asker.settlements.fetcher;
  // THE PEER'S DOOR, AS A PROXY THAT SAYS YES: the plan reaches the peer and is kept there, and the asker is handed a
  // bare 201 in place of the peer's signature - what the old count took for a seat's agreement.
  let bare = true, bareAnswers = 0;
  asker.settlements.fetcher = async (u, o) => {
    const r = await real(u, o);
    if (bare && o && o.method === 'POST' && String(u).includes('/settle-sends') && r.status === 201) {
      bareAnswers++;
      return new Response('1 send plan(s) checked and kept', { status: 201 });
    }
    return r;
  };
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    // the close, the objection window, the finality - then the asker asks, and asks again
    let got = null;
    for (const stop = Date.now() + 25000; Date.now() < stop && bareAnswers < 3; await wait(250));
    got = await asker.settlements.settle(w.rid);
    console.log('  UNSIGNED:', JSON.stringify({ bareAnswers, ok: got.ok, why: String(got.why).slice(0, 200), settlements: port.settlements.length, payments: port.gatewayPayments.length }));
    assert.ok(bareAnswers >= 1, 'the peer was never asked to take the plan');
    assert.equal(got.ok, false);
    assert.match(got.why, /1 of the 2 seats the settlement needs signed the send plan, so nothing is settled: .*no signed acceptance/);
    assert.equal(port.settlements.length, 0, 'a settlement was submitted on one seat\'s word');
    assert.equal(port.gatewayPayments.length, 0, 'a donation was paid on one seat\'s word');

    bare = false;
    let st;
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      st = await standing(w.a, w);
      const sends = asker.round.sendPlansOf(w.rid).filter((r) => r.donation);
      if (st.state === 'ACCEPTED' && sends.length && sends.every((r) => r.state === 'PAID')) break;
    }
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.equal(port.gatewayPayments.length, TEST_DONATION_SET_REGTEST.recipients.length, 'each donation recipient was not paid once');
    // EVERY SEAT HOLDS THE CERTIFICATE, and it verifies here on its own: two different seats over one plan id.
    const seats = w.c.nodes;
    const other = asker === w.a ? w.b : w.a;
    let planIdSeen = null;
    for (const d of [asker, other]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/settle-taken?round=${toHex(w.rid)}`);
      assert.equal(r.status, 200, `${d === asker ? 'the asker' : 'the other seat'} holds no certificate: ${r.status}`);
      const cert = await r.json();
      const records = splitCertificate(fromHex(cert.certificate));
      const checked = records.map((x) => checkPlanTaken(x, { seats, planId: fromHex(cert.planId) }));
      console.log('  SIGNED:', JSON.stringify({ seat: d === asker ? 'asker' : 'other', state: st.state, settlements: port.settlements.length,
        payments: port.gatewayPayments.length, planId: cert.planId.slice(0, 16), certificate: checked.map((c) => c.ok && c.who.slice(0, 16)) }));
      assert.equal(records.length, 2);
      assert.ok(checked.every((c) => c.ok), 'a record in the certificate does not verify');
      assert.equal(new Set(checked.map((c) => c.who)).size, 2, 'the certificate is not two different seats');
      if (planIdSeen) assert.equal(cert.planId, planIdSeen, 'the seats hold certificates for different plans');
      planIdSeen = cert.planId;
    }
    // AND A SEAT KEEPS NO CERTIFICATE THAT DOES NOT STAND: one for another plan, one short a seat.
    const held = await (await fetch(`http://127.0.0.1:${other.port}/settle-taken?round=${toHex(w.rid)}`)).json();
    const recs = splitCertificate(fromHex(held.certificate));
    const post = (planId, list) => fetch(`http://127.0.0.1:${other.port}/settle-taken?round=${toHex(w.rid)}`,
      { method: 'POST', body: Buffer.concat([Buffer.from(planId), ...list.map((x) => Buffer.from(x))]) });
    const wrong = fromHex(held.planId); wrong[0] ^= 1;
    const r1 = await post(wrong, recs);
    assert.equal(r1.status, 409); assert.match(await r1.text(), /another plan than the one this seat kept/);
    const r2 = await post(fromHex(held.planId), recs.slice(0, 1));
    assert.equal(r2.status, 409); assert.match(await r2.text(), /1 of the 2 seats in that certificate stand here/);
  } finally { asker.settlements.fetcher = real; await w.close(); }
});
