// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WALK-AWAY IS NEVER A REFUND, EVEN WITH NO QUALIFIER (RULED 2026-09-30, destination 1): the walker - staked,
// no first mark - is FORFEIT 0 at both signer nodes at the door, never ENTRY_VOID, and when the round ends with nobody
// qualifying its stake lock is claimed all the same and paid by the ruled remainder split: 75% to the round's sitting
// signer nodes (pre-expired contracts to their own keys, as the fee locks pay them), 25% to the donation set by
// share_bps (each recipient by the Lightning-address send a winner is paid by). A first mark past the line is the same
// door. A player who played and FAILED keeps the no-qualifier expiry, alone or beside a walker.
// MEASURED BEFORE (this file's first test on 53d97748): ACCEPTED, the fee locks only (2 payouts to the signer nodes,
// 1 lock claimed), the walker's stake lock not claimed and still held - due to expire back to the walker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait, say } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lnv2FeeMsat } from '../../arena-protocol/src/lock-settlement.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };
const FAILER = { ...LOSER, name: 'failed', key: b32(0x22) };
const opKey = (o) => `${toHex(o.txid)}:${o.outIdx}`;

async function round() {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  return { port, w };
}

/** The door, as both signer nodes decide it: FORFEIT 0, never ENTRY_VOID. */
async function atTheDoor(w, played) {
  const results = (d) => d.round.results(w.rid, played.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
  for (const stop = Date.now() + 60000; Date.now() < stop && !(results(w.a).length && results(w.b).length); await wait(250));
  const door = { a: results(w.a).map((r) => [r.outcome, r.score]), b: results(w.b).map((r) => [r.outcome, r.score]),
    entryVoid: [w.a.round.entryVoid(played.eid), w.b.round.entryVoid(played.eid)] };
  assert.deepEqual(door.a, [['FORFEIT', 0]]); assert.deepEqual(door.b, [['FORFEIT', 0]]);
  assert.deepEqual(door.entryVoid, [null, null], 'never ENTRY_VOID');
  return door;
}

/** The close, and what it did to each named lock. */
async function closeAndRead(port, w, named) {
  await closeRound(w);
  const st = await untilSettled(w, 90000);
  const claimed = new Set(port.settlements.flatMap((x) => (x.claims || []).map((c) => opKey(c.outpoint))));
  const locks = Object.fromEntries(Object.entries(named).map(([k, p]) => [k, { claimed: claimed.has(opKey(p.outpoint)), held: port.locks.has(opKey(p.outpoint)) }]));
  const forfeit = Object.fromEntries(await Promise.all(Object.entries(named).map(async ([k, p]) =>
    [k, (await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).status])));
  return { st, locks, forfeit };
}

/** The 75/25 the proposer built, and the donation sends carried to PAID. */
async function split(port, w) {
  const moved = (await (await fetch(`http://127.0.0.1:${proposerOf(w).port}/lock-settlement?round=${toHex(w.rid)}`)).json()).moved;
  let sends = [];
  for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250)) {
    sends = proposerOf(w).round.sendPlansOf(w.rid).filter((r) => r.donation);
    if (sends.length && sends.every((r) => r.state === 'PAID')) break;
  }
  const fees = await port.fees();
  const stake = moved.claims.filter((c) => c.kind === 'stake').reduce((s, c) => s + BigInt(c.msat), 0n);
  const spendable = stake - moved.claims.filter((c) => c.kind === 'stake').reduce((s, c) => s + lnv2FeeMsat(fees, BigInt(c.msat)), 0n);
  return { moved, sends, stake, spendable, fees,
    nodePayouts: moved.payouts.filter((p) => p.kind === 'remainder node'), donationPayouts: moved.payouts.filter((p) => p.donation) };
}

test('no qualifier: the walk-away is FORFEIT 0 at the door, never ENTRY_VOID, and its stake lock is claimed, 75% to the signer nodes and 25% to the donation set', async () => {
  const { port, w } = await round();
  try {
    const walker = await lockAndPlay(w, WALKER, { noMarks: true });
    console.log('  FACTS (door):', JSON.stringify(await atTheDoor(w, walker)));
    const got = await closeAndRead(port, w, { walker });
    const s = await split(port, w);
    const facts = { state: got.st.state, why: String(got.st.why).slice(0, 260), locks: got.locks, forfeitDoor: got.forfeit, stakeMsat: String(s.stake),
      spendableMsat: String(s.spendable), remainder: s.moved.remainder, nodes: s.nodePayouts.map((p) => [p.pk.slice(0, 12), p.msat, p.feeMsat]),
      donations: s.donationPayouts.map((p) => [p.donation.slice(0, 24), p.kind, p.msat, p.feeMsat]),
      sends: s.sends.map((r) => [r.address.slice(0, 24), String(r.payoutMsat), String(r.invoiceMsat), r.state]),
      unspentMsat: s.moved.unspentMsat };
    console.log('  FACTS (settled):', JSON.stringify(facts));
    assert.equal(got.st.state, 'ACCEPTED', got.st.why);
    assert.ok(got.locks.walker.claimed, 'the walker\'s stake lock is not among the settlement\'s claims');
    assert.equal(got.locks.walker.held, false, 'the walker\'s stake lock is left to expire back - a refund');
    assert.equal(got.forfeit.walker, 409, 'a forfeit signature would hand the lock back');
    // 75 / 25 of what the walker's lock pays after the guardians' input fee
    assert.equal(BigInt(s.moved.remainder.nodesMsat), (s.spendable * 75n) / 100n);
    assert.equal(BigInt(s.moved.remainder.nodesMsat) + BigInt(s.moved.remainder.donationMsat), s.spendable);
    assert.equal(s.nodePayouts.length, 2, 'each sitting signer node one pre-expired contract to its own key');
    const nodeKeys = w.c.nodes.map((k) => toHex(k).slice(-64));
    for (const p of s.nodePayouts) assert.ok(nodeKeys.includes(p.pk.slice(-64)), `a remainder payout to a key that is no sitting signer node: ${p.pk}`);
    assert.equal(s.donationPayouts.length, TEST_DONATION_SET_REGTEST.recipients.length, 'one send per donation recipient');
    assert.ok(s.donationPayouts.every((p) => p.kind === 'sent'), 'a donation share paid by anything but the Lightning-address send');
    assert.equal(s.sends.length, TEST_DONATION_SET_REGTEST.recipients.length);
    assert.ok(s.sends.every((r) => r.state === 'PAID'), `the donation sends did not reach PAID: ${JSON.stringify(facts.sends)}`);
    // BY RECIPIENT, not by output order (the outputs sort by payment hash): each share its share_bps of the 25%
    const gross = (r) => { const p = s.donationPayouts.find((x) => x.donation === r.lnurl); return BigInt(p.msat) + BigInt(p.feeMsat); };
    const [r0, r1] = TEST_DONATION_SET_REGTEST.recipients;
    const donation = BigInt(s.moved.remainder.donationMsat);
    assert.equal(gross(r1), (donation * BigInt(r1.shareBps)) / 10000n, 'the second recipient\'s share is not its share_bps');
    assert.equal(gross(r0), donation - gross(r1), 'the first recipient\'s share is not its share_bps and the remainder');
  } finally { await w.close(); }
});

test('a first mark past the line is the same door: FORFEIT at both, and with nobody qualifying its stake lock is claimed', async () => {
  const { port, w } = await round();
  try {
    const walker = await lockAndPlay(w, WALKER, { noMarks: true });
    await atTheDoor(w, walker);
    const said = [];
    for (const d of [w.a, w.b]) for (const m of walker.late) said.push(String(await say(d.port, m)).slice(0, 90));
    const late = [w.a.round.startForfeit(walker.eid), w.b.round.startForfeit(walker.eid)].map((x) => !!x);
    const got = await closeAndRead(port, w, { walker });
    console.log('  FACTS (late first mark):', JSON.stringify({ said, lateRecorded: late, state: got.st.state, why: String(got.st.why).slice(0, 200),
      locks: got.locks, forfeitDoor: got.forfeit }));
    assert.deepEqual(late, [true, true], 'the late first mark is not recorded FORFEIT at both');
    assert.equal(got.st.state, 'ACCEPTED', got.st.why);
    assert.ok(got.locks.walker.claimed && !got.locks.walker.held, 'the late starter\'s lock is left to expire back');
    assert.equal(got.forfeit.walker, 409);
  } finally { await w.close(); }
});

test('control: a player who played and FAILED, nobody qualifying, keeps the no-qualifier expiry - the lock is not claimed', async () => {
  const { port, w } = await round();
  try {
    const failed = await lockAndPlay(w, FAILER);
    const got = await closeAndRead(port, w, { failed });
    console.log('  FACTS (control):', JSON.stringify({ state: got.st.state, why: String(got.st.why).slice(0, 200), locks: got.locks }));
    assert.equal(got.st.state, 'ACCEPTED', got.st.why);
    assert.equal(got.locks.failed.claimed, false, 'a FAILED player\'s lock claimed with nobody to pay');
    assert.equal(got.locks.failed.held, true, 'the FAILED player\'s lock is no longer there to expire back');
  } finally { await w.close(); }
});

test('mixed: a walker and a FAILED player, nobody qualifying - only the walker\'s lock is claimed', async () => {
  const { port, w } = await round();
  try {
    const walker = await lockAndPlay(w, WALKER, { noMarks: true });
    const failed = await lockAndPlay(w, FAILER);
    await atTheDoor(w, walker);
    const got = await closeAndRead(port, w, { walker, failed });
    const s = await split(port, w);
    console.log('  FACTS (mixed):', JSON.stringify({ state: got.st.state, why: String(got.st.why).slice(0, 260), locks: got.locks,
      forfeitDoor: got.forfeit, stakeMsat: String(s.stake), remainder: s.moved.remainder, sends: s.sends.map((r) => r.state) }));
    assert.equal(got.st.state, 'ACCEPTED', got.st.why);
    assert.ok(got.locks.walker.claimed && !got.locks.walker.held, 'the walker\'s lock is not claimed');
    assert.equal(got.locks.failed.claimed, false, 'the FAILED player\'s lock claimed beside the walker');
    assert.equal(got.locks.failed.held, true);
    assert.equal(s.stake, BigInt(walker.fields.amountMsat), 'the claimed stake is the walker\'s alone');
  } finally { await w.close(); }
});
