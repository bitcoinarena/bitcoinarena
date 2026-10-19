// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ATTESTED ROUND'S DOOR AND ITS SETTLEMENT, ON TWO SIGNER NODES AND THE FAKE FEDERATION (§0A.7a;
// 2026-10-07, plan 777):
//   - the door: an attestation before the round's entries close, or one observed before they closed, refused by name;
//   - final 600 s after the first standing attestation: inside it nothing settles, and a contradiction makes it DISPUTED;
//   - past it the seats settle the pari-mutuel table by themselves (the sweep): the losers' stake locks and every fee lock
//     claimed, each winner paid its share of the losing pool to its own key, the seats their §22A fee; the winners' own
//     stake locks not claimed;
//   - nobody right: only the fee locks are claimed;
//   - no attestation at all: nothing is claimed;
//   - a contradiction after the settlement is held as proof and undoes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { encodeAttestation, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId, splitDonation } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { MARKET, MARKET_OUTCOMES as OUTCOMES } from './plugins/market/index.js';
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
// ITS ENTRIES OPEN FROM THE COMMITTEE UNTIL HALF A SECOND BEFORE ITS START (the fixture's 60.5 s), so a test has time to pick
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, A1, A2] = MARKET.attestors;
const WINDOW_MS = 600000;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return `${r.status} ${(await r.text()).trim()}`; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const attestBoth = async (w, outcomeIx, by = [A0, A2], at = w.c.entryCloseMs + 1n) => Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: outcomeIx, observedAtMs: at }, by))));
/** The settlement as the seats' sweep makes it, waited for on the fake clock past the window (up to 20 s of real time). */
async function settledBySweep(w, ms = 20000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);

async function marketRound(w, picks, { open = false } = {}) {
  const r = open ? await openLockRound(w, { stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000 }) : w;
  if (open) skipTo(Number(r.c.committeeTimeMs) + 100);
  const target = { network: NETWORK, game: MARKET.registration.donationSet };
  const played = [];
  for (const [i, pick] of picks.entries()) played.push(await lockAndPlay(r, player(i + (open ? 30 : 0)), { noMarks: true, pick }));
  return { r, played };
}

test('the door, the window, the table paid by the seats\' own sweep, and a contradiction after it held as proof', async () => {
  // A ROUND WHOSE ENTRIES ARE STILL OPEN while the first attestation is tried: its end 15 min out, the clock at its committee
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const { played } = await marketRound(w, [0, 0, 1, 2]);
    // THE DOOR: before the entries close nothing is taken; an outcome seen before they closed is refused, after too
    const early = await post(w.a, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 1n }, [A0, A1]));
    // past the entry close, the round still open: no pick
    skipTo(Number(w.c.entryCloseMs) + 10);
    await assert.rejects(lockAndPlay(w, player(9), { noMarks: true, pick: 1 }), /entries closed at .*: an attested round takes no pick after its entry close/);
    await closeRound(w);
    const seenEarly = await post(w.a, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs - 1n }, [A0, A1]));
    console.log('  DOOR:', JSON.stringify({ beforeEntryClose: early, observedBeforeEntryClose: seenEarly }));
    assert.match(early, /^409 that round's entries are still open \(they close at .*\): no outcome is taken before the last pick/);
    assert.match(seenEarly, /^409 that attestation says it was observed at .*, before the round's entries closed at /);
    assert.equal((await outcome(w.a, w.rid)).state, 'OPEN');

    // THE OUTCOME, AT BOTH SEATS; INSIDE THE WINDOW NOTHING SETTLES
    const firstAt = testNow();
    assert.deepEqual((await attestBoth(w, 0)).map((s) => s.slice(0, 3)), ['201', '201']);
    const inside = await w.a.settlements.settle(w.rid);
    const o = await outcome(w.a, w.rid);
    console.log('  WINDOW:', JSON.stringify({ settle: inside.state, why: inside.why, final: o.final, finalInMs: Number(o.finalAtMs) - firstAt }));
    assert.equal(inside.state, 'HELD');
    assert.match(inside.why, /inside its objection window: its outcome is final at /);
    assert.equal(o.final, false);
    assert.ok(Math.abs(Number(o.finalAtMs) - firstAt - WINDOW_MS) < 2000, 'final is not 600 s after the first attestation');
    assert.ok(o.attestation && o.attestation.length > 200, 'GET /outcome carries no attestation bytes for a page to check');

    // PAST THE WINDOW: THE SEATS' SWEEP SETTLES IT
    skipTo(Number(o.finalAtMs) + 100);
    const got = await settledBySweep(w);
    if (got.state !== 'ACCEPTED') console.log('  SETTLE ASKED:', JSON.stringify(await w.a.settlements.settle(w.rid), (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 600));
    const t = (await outcome(w.a, w.rid)).table;
    const keyOf = (e) => toHex(refundKeyOf(e.entry.playerPubkey));
    const moved = got.moved || {};
    const facts = { state: got.state, why: got.why, claims: (moved.claims || []).map((c) => [c.kind, String(c.msat ?? c.amountMsat)]),
      payouts: (moved.payouts || []).map((p) => [p.kind, String(p.pk).slice(0, 10), String(p.msat)]) };
    console.log('  SETTLED:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', got.why);
    // EACH FEE LOCK HOLDS THE MARKET'S 1 %: 0.5 % node fee and 0.5 % donation, both due now, at resolution
    const fee = entryFeeMsat(STAKE, 50);
    const donated = entryFeeMsat(STAKE, 100) - fee;
    const net = STAKE - fee - donated;
    // claims: the two losers' stake locks and all four fee locks
    const stakeClaims = (moved.claims || []).filter((c) => c.kind === 'stake');
    const feeClaims = (moved.claims || []).filter((c) => c.kind === 'fee');
    assert.equal(stakeClaims.length, 2, 'not exactly the two losing stake locks claimed');
    assert.equal(feeClaims.length, 4, 'not every fee lock claimed');
    // winners: each its table share of the losing pool, to its own key; the table's winners are entries 0 and 1
    const winners = played.slice(0, 2);
    for (const e of winners) {
      const row = t.rows.find((r) => r.entryId === toHex(e.eid));
      const p = moved.payouts.find((x) => x.kind === 'qualifier' && String(x.pk) === keyOf(e));
      assert.ok(p, `winner ${keyOf(e).slice(0, 10)} was not paid`);
      assert.equal(BigInt(p.msat), BigInt(row.payoutMsat) - BigInt(row.netMsat), 'a winner was not paid its table share to the msat');
    }
    assert.equal(sum(moved.payouts.filter((x) => x.kind === 'qualifier').map((x) => BigInt(x.msat))), 2n * net, 'the winners were not paid the whole losing pool');
    // the seats: the fee locks, two halves each (no guardian eligible), as 
    const seats = moved.payouts.filter((x) => x.kind === 'signer node');
    assert.equal(sum(seats.map((x) => BigInt(x.msat))), 4n * fee);
    // the donation, from the same fee locks, to the donation keys: half the protocol devs' set, half the game dev's
    const gifts = moved.payouts.filter((x) => x.kind === 'donation key');
    const want = splitDonation({ donationMsat: 4n * donated, recipients: { network: NETWORK, game: MARKET.registration.donationSet } }).shares.filter((x) => x.amountMsat > 0n);
    console.log('  DONATION AT RESOLUTION:', JSON.stringify(gifts.map((x) => [x.donation, x.msat])));
    assert.equal(sum(gifts.map((x) => BigInt(x.msat))), 4n * donated, 'the donation was not paid whole at resolution');
    assert.deepEqual(gifts.map((x) => String(x.pk)).sort(), want.map((x) => toHex(x.recipientPk)).sort(), 'the donation went to other keys than its sets\'');
    // the winners' own stake locks are not claimed: still held by the federation for them
    for (const e of winners) assert.ok((await w.port.status(e.outpoint)).stored, 'a winner\'s own stake lock was claimed');
    for (const e of played.slice(2)) assert.equal((await w.port.status(e.outpoint)).stored, null, 'a loser\'s lock was not claimed');

    // A CONTRADICTION AFTER THE SETTLEMENT: held as proof, nothing undone
    const late = await post(w.a, w.rid, signedBy({ roundId: w.rid, outcome: 2, observedAtMs: w.c.entryCloseMs + 5n }, [A1, A2]));
    const afterLate = await outcome(w.a, w.rid);
    const still = await standing(w.a, w);
    console.log('  LATE CONTRADICTION:', JSON.stringify({ answer: late.slice(0, 3), state: afterLate.state, proof: (afterLate.proof || []).length, settlement: still.state, txid: still.txid === got.txid }));
    assert.equal(late.slice(0, 3), '201');
    assert.equal(afterLate.state, 'DISPUTED');
    assert.equal(afterLate.proof.length, 2);
    assert.equal(still.state, 'ACCEPTED');
    assert.equal(still.txid, got.txid, 'the settlement changed after the contradiction');
  } finally { await w.close(); }
});

test('nobody right: nothing is claimed, the fees neither, every stake back at once; a contradiction: VOID, every stake back at once; no attestation: nothing claimed', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // NOBODY PICKED "below 90k"
    const { played } = await marketRound(w, [0, 1]);
    await closeRound(w);
    await attestBoth(w, 2);
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    // REFUND THE FEES TOO (2026-10-09): nothing is claimed - no stake lock, no fee lock - and every stake
    // comes back by the return door at once, with no settlement to wait for; every fee lock at its expiry
    await wait(6000);                                         // a sweep has passed
    const nothing = await w.a.settlements.settle(w.rid);
    const back = await Promise.all(played.map((e) => fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}`).then(async (r) => `${r.status}`)));
    const nobody = { settle: nothing.state || (nothing.ok ? 'ok' : 'refused'), why: nothing.why, refunded: (await outcome(w.a, w.rid)).table.refunded, stakeBack: back };
    console.log('  NOBODY RIGHT:', JSON.stringify(nobody));
    assert.notEqual(nothing.state, 'ACCEPTED', 'a settlement moved money when nobody was right');
    assert.equal(nobody.refunded, true);
    for (const e of played) {
      assert.ok((await w.port.status(e.outpoint)).stored, 'a stake lock was claimed when nobody was right');
      if (e.feeOutpoint) assert.ok((await w.port.status(e.feeOutpoint)).stored, 'a fee lock was claimed when nobody was right');
    }
    assert.deepEqual(back, played.map(() => '200'), 'a stake did not come back at once when nobody was right');

    // A CONTRADICTION INSIDE THE WINDOW
    const { r: r2, played: r2Played } = await marketRound(w, [0, 1], { open: true });
    await closeRound(r2);
    await attestBoth(r2, 0);
    const contra = await post(r2.a, r2.rid, signedBy({ roundId: r2.rid, outcome: 1, observedAtMs: r2.c.entryCloseMs + 2n }, [A1, A2]));
    // AN ATTESTOR POSTS TO EVERY SEAT: each seat decides the refund on its own record
    await post(r2.b, r2.rid, signedBy({ roundId: r2.rid, outcome: 1, observedAtMs: r2.c.entryCloseMs + 2n }, [A1, A2]));
    skipTo(Number(r2.c.entryCloseMs) + 2 * WINDOW_MS);
    await wait(6000);                                         // a sweep has passed
    const disputed = await outcome(r2.a, r2.rid);
    const held2 = await r2.a.settlements.settle(r2.rid);
    const s2 = await standing(r2.a, r2);
    console.log('  DISPUTED:', JSON.stringify({ contradiction: contra.slice(0, 3), state: disputed.state, settle: held2.state, why: held2.why, settlement: s2.state || 'none' }));
    assert.equal(disputed.state, 'DISPUTED');
    // A CONTRADICTION VOIDS THE ROUND: nothing settles, every stake comes back at once
    assert.equal(held2.state, 'VOID');
    assert.match(held2.why, /contradicted themselves/);
    assert.notEqual(s2.state, 'ACCEPTED');
    const back2 = await Promise.all(r2Played.map((e) => fetch(`http://127.0.0.1:${r2.a.port}/forfeit?round=${toHex(r2.rid)}&entry=${toHex(e.eid)}`).then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).slice(0, 200)}`))));
    console.log('  CONTRADICTION BACK:', JSON.stringify(back2));
    assert.deepEqual(back2, r2Played.map(() => '200'), 'a stake did not come back at once on a contradiction');

    // NO ATTESTATION AT ALL
    const { r: r3 } = await marketRound(w, [0, 2], { open: true });
    await closeRound(r3);
    const held3 = await r3.a.settlements.settle(r3.rid);
    console.log('  NO OUTCOME:', JSON.stringify({ settle: held3.state, why: held3.why }));
    assert.equal(held3.state, 'HELD');
    assert.match(held3.why, /no outcome attested: nothing is settled, and its locks expire back to their players/);
  } finally { await w.close(); }
});

// REFUND AT THE DEADLINE (2026-10-09): a market whose manifest names a resolution time and a deadline -
// here 1 minute after entry close and 1 minute for its attestors - and no attestation by then: the round is VOID, nothing
// is claimed, and every stake comes back at once. Before the deadline it is only held.
const TERMS = { nodeFeeBps: 50, donationBps: 50,
  question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const TERMS_MARKET = testAttestedGame({ name: 'btc-close-terms', outcomes: OUTCOMES, marketTerms: TERMS });
test('a market with terms and no outcome by its deadline: VOID, nothing claimed, every stake back at once; held before it', async () => {
  const round = { ...ROUND, gameId: TERMS_MARKET.registration.gameId };
  // its locks last to its deadline and objection window (lock-expiry.js marketExpiryBlocks, the seat's own guard at open)
  const w = await lockRound({ stakeMsat: STAKE, round, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, TERMS_MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const target = { network: NETWORK, game: TERMS_MARKET.registration.donationSet };
    const played = [];
    for (const [i, pick] of [0, 1].entries()) played.push(await lockAndPlay(w, player(i + 50), { noMarks: true, pick }));
    await closeRound(w, { window: false });                   // the round's own close only: its deadline is 2 min after entry close
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    skipTo(deadlineMs - 1000);
    const before = await w.a.settlements.settle(w.rid);
    const backBefore = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(played[0].eid)}`).then((r) => r.status);
    skipTo(deadlineMs + 1000);
    const after = await w.a.settlements.settle(w.rid);
    const back = await Promise.all(played.map((e) => fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}`).then((r) => r.status)));
    console.log('  DEADLINE:', JSON.stringify({ before: before.state, backBefore, after: after.state, why: after.why, back }));
    assert.equal(before.state, 'HELD');
    assert.notEqual(backBefore, 200, 'a stake came back before the deadline');
    assert.equal(after.state, 'VOID');
    assert.match(after.why, /no outcome was attested by the market's deadline/);
    assert.deepEqual(back, [200, 200]);
    for (const e of played) assert.ok((await w.port.status(e.outpoint)).stored, 'a stake lock was claimed in a VOID market round');
  } finally { await w.close(); }
});

// A CANCEL (2026-10-09: "until then the orders can be cancelled at no cost"; "when an order is filled, the
// fee is of course due too"): before entry close, signed by the entry's session key - out of the table, both locks back at once
test('a cancel before entry close is free: out of the table at every seat, its stake and fee locks back at once; after entry close refused, its fee due', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const cancel = (d, e, by = e) => fetch(`http://127.0.0.1:${d.port}/cancel?entry=${toHex(e.eid)}`,
    { method: 'POST', body: ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), by.session) }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 160)}`);
  const back = (e, lock = '') => fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}${lock}`)
    .then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).slice(0, 160)}`));
  try {
    const { played } = await marketRound(w, [0, 1, 1, 1]);
    // ENTRY 3 CANCELS AT BOTH SEATS (the page posts to every seat); A FORGED CANCEL - ANOTHER ENTRY'S KEY - IS REFUSED
    const forged = await cancel(w.a, played[3], played[1]);
    const both = [await cancel(w.a, played[3]), await cancel(w.b, played[3]), await cancel(w.a, played[3])];
    // BOTH ITS LOCKS BACK AT ONCE, BEFORE ANY OUTCOME: the stake lock and the fee lock
    const free = { stake: await back(played[3]), fee: await back(played[3], '&lock=fee') };
    // A FEE LOCK OF AN ENTRY STILL IN THE ROUND DOES NOT COME BACK: it is due when the market resolves
    const kept = await back(played[0], '&lock=fee');
    // ENTRY 2 CANCELS AT SEAT A ONLY: its return waits for seat B, which pulls the cancel before it settles
    const one = await cancel(w.a, played[2]);
    const oneBack = await back(played[2]);
    console.log('  CANCEL:', JSON.stringify({ forged, both, free, kept, one, oneBack }));
    assert.match(forged, /^403 that cancel is not signed by the entry's session key/);
    assert.deepEqual(both.map((x) => x.slice(0, 3)), ['201', '201', '200']);
    assert.deepEqual(free, { stake: '200', fee: '200' });
    assert.match(kept, /^409 a fee lock comes back at once only for a cancelled order or a refunded market/);
    assert.equal(one.slice(0, 3), '201');
    assert.notEqual(oneBack, '200', 'a cancel one seat holds returned a lock without the other');
    // AFTER ENTRY CLOSE: the order is in the round, its fee is due - no cancel
    await closeRound(w);
    const late = await cancel(w.a, played[0]);
    assert.match(late, /^409 entries closed at .*: that order is in the round now, and its fee is due/);
    // OUTCOME 0: entry 0 wins, entry 1 loses; the cancelled entries 2 and 3 are in no table and pay nothing
    await attestBoth(w, 0);
    const o = await outcome(w.a, w.rid);
    skipTo(Number(o.finalAtMs) + 100);
    const got = await settledBySweep(w);
    const moved = got.moved || {};
    const facts = { state: got.state, why: got.why, rows: (await outcome(w.b, w.rid)).table.rows.length,
      claims: (moved.claims || []).map((c) => c.kind), carried: await back(played[2]) };
    console.log('  SETTLED WITH CANCELS:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(facts.claims.sort(), ['fee', 'fee', 'stake'], 'not the one loser\'s stake lock and the two fee locks still in the round');
    for (const e of played.slice(2)) {
      assert.ok((await w.port.status(e.outpoint)).stored, 'a cancelled entry\'s stake lock was claimed');
      assert.ok((await w.port.status(e.feeOutpoint)).stored, 'a cancelled entry\'s fee lock was claimed');
    }
    assert.equal(facts.carried, '200', 'seat B did not pull the cancel it was never sent');
  } finally { await w.close(); }
});
