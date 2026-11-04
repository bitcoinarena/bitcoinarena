// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT REFUSES MONEY INTO A FEDERATION IT HOLDS A RESERVE ALARM FOR (kanban #1108): not only the client's pickFederation - the seat's own doors.
// On a locked fixture round of TEST_FEDERATION_ID: before the alarm no door names a theft; once this seat's book holds an inflation mark for the
// federation, the handout and the entry are refused with the mark named, at once, no restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, b32 } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { createReserveAlarms } from '../src/reserve-alarms.js';

test('an alarm on the round\'s federation: the handout and the entry are refused by the seat itself, naming the mark', { timeout: 120000 }, async () => {
  const book = createReserveAlarms();
  const w = await lockRound({ serveOpts: { reserveAlarmsBook: book } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const deal = async () => {
      const key = rand(32), e = rand(32);
      const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed, curve: feldmanGroup });
      return { key, dealt };
    };
    const entryOf = ({ key, dealt }) => encodeEntryContract({ roundId: w.rid, playerPubkey: key, sessionPubkey: b32(4), stakeMsat: w.c.stakeMsat, feeMsat: 2000n,
      donationMsat: 0n, joinTick: 0, stakeCommitment: b32(5), vssSharesRef: b32(6), worldSecret: b32(9), stakePoint: dealt.handout.commitments[0], feePreimage: b32(0),
      stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) });
    const first = await deal();
    const hand0 = await fetch(`${base(w.a)}/handout`, { method: 'POST', body: encodeHandout(first.dealt.handout) });
    const ent0 = await fetch(`${base(w.a)}/entry`, { method: 'POST', body: entryOf(first) }); const ent0Why = await ent0.text();
    const raised = book.raise({ federation: toHex(TEST_FEDERATION_ID), kind: 'inflation', height: 250, session: 17, issuedMsat: '1000', redeemedMsat: '2024' });
    const second = await deal();
    const hand1 = await fetch(`${base(w.a)}/handout`, { method: 'POST', body: encodeHandout(second.dealt.handout) }); const hand1Why = await hand1.text();
    const ent1 = await fetch(`${base(w.a)}/entry`, { method: 'POST', body: entryOf(first) }); const ent1Why = await ent1.text();
    const alarmsDoor = await (await fetch(`${base(w.a)}/reserve-alarms`)).json();
    console.log('  FACTS:', JSON.stringify({ before: { handout: hand0.status, entry: [ent0.status, ent0Why.slice(0, 90)] }, raised: raised.kept,
      after: { handout: [hand1.status, hand1Why.slice(0, 150)], entry: [ent1.status, ent1Why.slice(0, 150)] }, door: alarmsDoor.alarms.map((a) => [a.kind, a.session]) }));
    assert.equal(hand0.status, 201, 'before the alarm the handout is taken');
    assert.doesNotMatch(ent0Why, /mark of theft/);
    assert.equal(hand1.status, 409); assert.match(hand1Why, /handout refused: this seat saw a mark of theft in federation .*inflation at signed session 17/);
    assert.equal(ent1.status, 409); assert.match(ent1Why, /entry refused: this seat saw a mark of theft/);
    assert.deepEqual(alarmsDoor.alarms.map((a) => [a.kind, a.session]), [['inflation', 17]]);
  } finally { await w.close(); }
});
