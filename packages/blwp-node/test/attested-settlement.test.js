// AN ATTESTED ROUND'S DOOR AND ITS SETTLEMENT, ON TWO SIGNER NODES AND THE FAKE FEDERATION (kanban #206 slice 2, §0A.7a;
// the owner 2026-10-07, plan 777):
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
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { encodeAttestation, pariMutuelTable } from '../../protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { toHex } from '../../protocol/src/hash.js';

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
  for (const [i, pick] of picks.entries()) played.push(await lockAndPlay(r, player(i + (open ? 30 : 0)), { noMarks: true, pick, donation: { msat: STAKE * 500n / 10000n, target } }));
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
    const fee = entryFeeMsat(STAKE);
    const net = STAKE - fee - STAKE * 500n / 10000n;
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
    // the seats: the fee locks, two halves each (no guardian eligible), as #205
    const seats = moved.payouts.filter((x) => x.kind === 'signer node');
    assert.equal(sum(seats.map((x) => BigInt(x.msat))), 4n * fee);
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

test('nobody right: only the fee locks are claimed; a contradiction inside the window: DISPUTED, nothing settles; no attestation: nothing claimed', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // NOBODY PICKED "below 90k"
    const { played } = await marketRound(w, [0, 1]);
    await closeRound(w);
    await attestBoth(w, 2);
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    const got = await settledBySweep(w);
    const moved = got.moved || {};
    const nobody = { state: got.state, claims: (moved.claims || []).map((c) => c.kind), payouts: (moved.payouts || []).map((p) => p.kind), refunded: (await outcome(w.a, w.rid)).table.refunded };
    console.log('  NOBODY RIGHT:', JSON.stringify(nobody));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(nobody.claims, ['fee', 'fee']);
    assert.ok(nobody.payouts.every((k) => k === 'signer node'));
    assert.equal(nobody.refunded, true);
    for (const e of played) assert.ok((await w.port.status(e.outpoint)).stored, 'a stake lock was claimed when nobody was right');

    // A CONTRADICTION INSIDE THE WINDOW
    const { r: r2 } = await marketRound(w, [0, 1], { open: true });
    await closeRound(r2);
    await attestBoth(r2, 0);
    const contra = await post(r2.a, r2.rid, signedBy({ roundId: r2.rid, outcome: 1, observedAtMs: r2.c.entryCloseMs + 2n }, [A1, A2]));
    skipTo(Number(r2.c.entryCloseMs) + 2 * WINDOW_MS);
    await wait(6000);                                         // a sweep has passed
    const disputed = await outcome(r2.a, r2.rid);
    const held2 = await r2.a.settlements.settle(r2.rid);
    const s2 = await standing(r2.a, r2);
    console.log('  DISPUTED:', JSON.stringify({ contradiction: contra.slice(0, 3), state: disputed.state, settle: held2.state, why: held2.why, settlement: s2.state || 'none' }));
    assert.equal(disputed.state, 'DISPUTED');
    assert.equal(held2.state, 'HELD');
    assert.match(held2.why, /contradicted themselves/);
    assert.notEqual(s2.state, 'ACCEPTED');

    // NO ATTESTATION AT ALL
    const { r: r3 } = await marketRound(w, [0, 2], { open: true });
    await closeRound(r3);
    const held3 = await r3.a.settlements.settle(r3.rid);
    console.log('  NO OUTCOME:', JSON.stringify({ settle: held3.state, why: held3.why }));
    assert.equal(held3.state, 'HELD');
    assert.match(held3.why, /no outcome attested: nothing is settled, and its locks expire back to their players/);
  } finally { await w.close(); }
});
