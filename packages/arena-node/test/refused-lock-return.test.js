// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STAKE LOCKED FOR A ROUND THE SIGNER NODES REFUSE, AND NEVER ENTERED, COMES BACK AT ONCE (2026-10-06
// 08:57: "A round the seats refuse gets an immediate refund. Seats sign the return of a stake that was locked for that round
// and never entered"; §23.2 row REFUSED). Measured live 05:31Z: round 49a50535 refused (donation set not in force), the
// page's 100 sat locked, no entry stored at any seat - the lock came back only after its expiry. On a locked fixture round
// (two signer nodes, a fake federation): a player who dealt the round's handout and locked, then never entered, hands the
// lock to each seat (POST /refused-lock). While the seats offer the round it is refused by name; once they refuse it, each
// seat keeps it on its own record - its own handout for the round, the lock's image that handout's A0, its refund key the
// handout player's, the federation holding it under this round's claim key - lists it at /stake-lock, and the committee
// signs its forfeit (GET /forfeit, the existing two rounds between seats) with no result and no finality. Never for a lock
// a seat holds as an entry's stake, nor one whose refund key is not the handout player's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, LOSER } from './window-fixture.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { skipTo } from './test-clock.js';

test('a lock for a round the seats refuse, never entered, is kept by each seat on its own record and its forfeit signed at once; an entered stake never', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  // the return of a lock that entered nothing after the entry close (the next test) kept far off: this one is about refusal
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    // AN ENTERED LOSER, staked at both seats before the round is refused
    const entered = await lockAndPlay(w, LOSER, { noMarks: true });
    // A PLAYER WHO DEALT THE ROUND'S HANDOUT AND LOCKED, AND NEVER ENTERED
    const key = rand(32); const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const hid = toHex(handoutId(dealt.handout));
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const hand = (d, f = fields, at = outpoint) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });

    // 1. THE ROUND IS OFFERED: refused by name
    const offered = await hand(w.a);
    const offeredWhy = await offered.text();
    // 2. REFUSED: each seat keeps it
    refusing.why = 'test: this signer node refuses the round';
    const kept = [];
    for (const d of w.nodes) { const r = await hand(d); kept.push([r.status, (await r.text()).slice(0, 90)]); }
    // AND ITS NODE-FEE LOCK (the same transaction, image H(F), the same refund key): returned with it (measured live 07:26Z:
    // 49a50535's stake came back, its 2000 msat fee lock stayed locked for its expiry)
    const feeAt = { txid: outpoint.txid, outIdx: 1n };
    const feeFields = { paymentImage: { kind: 'hash', bytes: rand(32) }, amountMsat: 2000n, claimPk: w.claimPk, refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(feeAt, feeFields);
    const feeKept = [];
    for (const d of w.nodes) { const r = await hand(d, feeFields, feeAt); feeKept.push([r.status, (await r.text()).slice(0, 90)]); }
    const listed = await (await fetch(`${base(w.a)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
    const feeRow = listed.find((l) => l.outpoint === `${toHex(feeAt.txid)}:1`);
    const ff = feeRow ? await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${feeRow.entryId}`) : null;
    const ffj = ff && ff.status === 200 ? await ff.json() : { why: ff ? await ff.text() : 'not listed' };
    const feeVerifies = !!ffj.signature && schnorr.verify(fromHex(ffj.signature), fromHex(ffj.contractId), w.claimPk.subarray(1));
    // 3. THE FORFEIT, signed at once
    const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${hid}`);
    const fj = f.status === 200 ? await f.json() : { why: await f.text() };
    const verifies = !!fj.signature && schnorr.verify(fromHex(fj.signature), fromHex(fj.contractId), w.claimPk.subarray(1));
    // NEGATIVES: a refund key that is not the handout player's; the entered loser's own lock; a lock no handout names
    const other = { txid: rand(32), outIdx: 0n };
    const wrongKey = { ...fields, refundPk: refundKeyOf(rand(32)) };
    await w.port.put(other, wrongKey);
    const r1 = await hand(w.a, wrongKey, other); const w1 = await r1.text();
    const r2 = await hand(w.a, entered.fields, entered.outpoint); const w2 = await r2.text();
    const third = { txid: rand(32), outIdx: 0n };
    const noHandout = { ...fields, paymentImage: { kind: 'point', bytes: entered.fields.paymentImage.bytes.map((b, i) => (i === 0 ? b : b ^ 1)) } };
    await w.port.put(third, noHandout);
    const r3 = await hand(w.a, noHandout, third); const w3 = await r3.text();
    console.log('  FACTS:', JSON.stringify({ offered: [offered.status, offeredWhy.slice(0, 90)], kept, listed: listed.map((l) => [l.entryId.slice(0, 8), l.outpoint.slice(0, 8)]),
      forfeit: [f.status, verifies, String(fj.why || '').slice(0, 120)], feeKept, fee: [ff && ff.status, feeVerifies, String(ffj.why || '').slice(0, 120)], wrongKey: [r1.status, w1.slice(0, 90)], entered: [r2.status, w2.slice(0, 90)], noHandout: [r3.status, w3.slice(0, 90)] }));
    assert.equal(offered.status, 409); assert.match(offeredWhy, /offers that round/);
    for (const [s, why] of kept) assert.equal(s, 201, why);
    assert.deepEqual(listed.find((l) => l.entryId === hid) && listed.find((l) => l.entryId === hid).outpoint, `${toHex(outpoint.txid)}:0`);
    for (const [st, why] of feeKept) assert.equal(st, 201, why);
    assert.equal(listed.length, 2, 'the stake and its fee lock are not both listed');
    assert.ok(feeRow && feeRow.entryId !== hid, 'the fee lock is not kept under an id of its own');
    assert.equal(ff && ff.status, 200, ffj.why); assert.equal(feeVerifies, true, 'the fee lock\'s forfeit does not verify');
    assert.equal(f.status, 200, fj.why); assert.equal(verifies, true, 'the forfeit does not verify under the round\'s claim key');
    assert.equal(r1.status, 409); assert.match(w1, /refund key/);
    assert.equal(r2.status, 409); assert.match(w2, /stakes an entry/);
    assert.equal(r3.status, 409); assert.match(w3, /no handout/);
  } finally { await w.close(); }
});

// A LOCK THAT ENTERED NOTHING, ITS ROUND OFFERED, COMES BACK ONCE THE ROUND'S ENTRIES CLOSED (kanban #593, playtest 2026-10-23:
// a page's 100 sat stake for round 9412cdf9, locked while the seats restarted, entered at no seat - back only at its expiry, 1834
// blocks on). While the round takes entries it is refused by name; after its entry close each seat keeps it on its own record and
// the committee signs its forfeit at once. An entered player's stake never.
test('a lock that entered nothing comes back once the round\'s entries closed, the round still offered; an entered stake never', { timeout: 120000 }, async () => {
  const GRACE = 600000;
  const w = await lockRound({ serveOpts: { unenteredGraceMs: GRACE } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const entered = await lockAndPlay(w, LOSER, { noMarks: true });
    const key = rand(32); const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const hid = toHex(handoutId(dealt.handout));
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const hand = (d, f = fields, at = outpoint) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    // 1. INSIDE THE GRACE AFTER THE ENTRY CLOSE: refused by name
    const open = await hand(w.a); const openWhy = await open.text();
    // 2. PAST IT (the fixtures' clock skipped): each seat keeps it, the forfeit is signed
    skipTo(Number(w.c.entryCloseMs) + GRACE + 1000);
    const kept = [];
    for (const d of w.nodes) { const r = await hand(d); kept.push([r.status, (await r.text()).slice(0, 90)]); }
    const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${hid}`);
    const fj = f.status === 200 ? await f.json() : { why: await f.text() };
    const verifies = !!fj.signature && schnorr.verify(fromHex(fj.signature), fromHex(fj.contractId), w.claimPk.subarray(1));
    const r2 = await hand(w.a, entered.fields, entered.outpoint); const w2 = await r2.text();
    console.log('  FACTS:', JSON.stringify({ open: [open.status, openWhy.slice(0, 90)], kept, forfeit: [f.status, verifies, String(fj.why || '').slice(0, 120)], entered: [r2.status, w2.slice(0, 90)] }));
    assert.equal(open.status, 409); assert.match(openWhy, /offers that round and its entries are not closed long enough/);
    for (const [s, why] of kept) assert.equal(s, 201, why);
    assert.equal(f.status, 200, fj.why); assert.equal(verifies, true, 'the forfeit does not verify under the round\'s claim key');
    assert.equal(r2.status, 409); assert.match(w2, /stakes an entry/);
  } finally { await w.close(); }
});
