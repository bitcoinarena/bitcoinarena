// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WALK-AWAY'S DONATION SHARE WHEN THE RECIPIENT DOES NOT ANSWER (RULED 2026-09-30, hole 1 (a)): nobody
// qualifies, nothing answers at the donation set's addresses (127.0.0.1:18777) - the settlement still completes. The
// walker's stake lock is claimed, never refunded; 75% to the sitting signer nodes; the unanswered 25% sits in
// pre-expired contracts under the committee claim key only. Then the recipients answer, and the retry pays that 25% to
// the donation set by the Lightning-address send, spending the held contracts - nothing more to the signer nodes.
// MEASURED BEFORE (74abeed7, the recipients down): no settlement at all - the plan refused "the donation recipient's
// invoice does not stand", the fee locks not claimed either, the walker's lock left to expire back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';

const opKey = (o) => `${toHex(o.txid)}:${o.outIdx}`;

test('no qualifier, the donation set not answering: the walker\'s lock is claimed, 75% to the signer nodes, 25% held under the committee key - then the recipients answer and the retry pays the set', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    w.lnurl.donationDown = true;
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    const results = (d) => d.round.results(w.rid, walker.eid).length;
    for (const stop = Date.now() + 60000; Date.now() < stop && !(results(w.a) && results(w.b)); await wait(250));
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    const p = proposerOf(w);
    const moved = (await (await fetch(`http://127.0.0.1:${p.port}/lock-settlement?round=${toHex(w.rid)}`)).json()).moved;
    const claimed = port.settlements.some((x) => (x.claims || []).some((c) => opKey(c.outpoint) === opKey(walker.outpoint)));
    const donation = () => p.round.sendAttemptsOf(w.rid).filter((r) => r.donation);
    for (const stop = Date.now() + 20000; Date.now() < stop && !donation().every((r) => r.state === 'HELD'); await wait(250));
    const heldRows = donation().filter((r) => r.attempt === 0);
    const heldStored = await Promise.all(heldRows.map(async (r) => !!(r.txid && (await port.status({ txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) })).stored)));
    const first = { state: st.state, why: String(st.why).slice(0, 200), walkerLockClaimed: claimed, walkerLockHeld: port.locks.has(opKey(walker.outpoint)),
      remainder: moved.remainder, nodes: moved.payouts.filter((x) => x.kind === 'remainder node').map((x) => [x.pk.slice(0, 12), x.msat]),
      held: moved.payouts.filter((x) => x.kind === 'held').map((x) => [x.donation.slice(0, 24), x.msat, x.pk === toHex(w.claimPk)]),
      rows: heldRows.map((r) => [r.state, String(r.payoutMsat), r.invoice ? 'invoice' : 'no invoice']), heldStored,
      invoicesAskedOfTheSet: w.lnurl.issued.filter((i) => i.host === '127.0.0.1:18777').length };
    console.log('  FACTS (recipients down):', JSON.stringify(first));
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(first.walkerLockClaimed && !first.walkerLockHeld, 'the walker\'s lock is left to expire back - a refund');
    assert.equal(first.nodes.length, 2);
    assert.equal(first.nodes.reduce((t, x) => t + BigInt(x[1]), 0n), BigInt(moved.remainder.nodesMsat), 'the 75% is not the signer nodes\' whole');
    assert.equal(first.held.length, 2, 'the unanswered 25% is not held, one contract per recipient');
    assert.ok(first.held.every((x) => x[2]), 'a held share is under another key than the committee claim key');
    assert.equal(BigInt(moved.remainder.heldMsat), BigInt(moved.remainder.donationMsat), 'the held contracts are not the whole 25%');
    assert.deepEqual(first.rows.map((r) => r[0]), ['HELD', 'HELD']);
    assert.deepEqual(heldStored, [true, true], 'the held contracts are not in the federation');
    assert.equal(first.invoicesAskedOfTheSet, 0);
    const nodePayoutsBefore = port.settlements.flatMap((x) => (x.payouts || []).filter((q) => !q.sent)).length;

    // THE RECIPIENTS ANSWER: the retry pays the 25% to the donation set
    w.lnurl.donationDown = false;
    let latest = [];
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(500)) {
      latest = p.round.sendPlansOf(w.rid).filter((r) => r.donation);
      if (latest.length === 2 && latest.every((r) => r.state === 'PAID')) break;
    }
    const issued = w.lnurl.issued.filter((i) => i.host === '127.0.0.1:18777');
    const heldAfter = await Promise.all(heldRows.map(async (r) => !!(await port.status({ txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) })).stored));
    const nodePayoutsAfter = port.settlements.flatMap((x) => (x.payouts || []).filter((q) => !q.sent)).length;
    const second = { latest: latest.map((r) => [r.attempt, r.state, String(r.payoutMsat), String(r.invoiceMsat), r.address.slice(0, 24)]),
      invoicesAskedOfTheSet: issued.map((i) => String(i.amountMsat)), heldContractsStillStored: heldAfter,
      atTheOtherNode: (p === w.a ? w.b : w.a).round.sendPlansOf(w.rid).filter((r) => r.donation).map((r) => [r.attempt, r.state]),
      preExpiredPayoutsBefore: nodePayoutsBefore, preExpiredPayoutsAfter: nodePayoutsAfter };
    console.log('  FACTS (recipients answer):', JSON.stringify(second));
    assert.equal(latest.length, 2);
    assert.ok(latest.every((r) => r.state === 'PAID' && r.attempt >= 1), 'the held shares were not re-sent and paid');
    assert.deepEqual(latest.map((r) => r.address).sort(), TEST_DONATION_SET_REGTEST.recipients.map((r) => r.lnurl).sort(), 'paid to another address than the set\'s');
    assert.equal(issued.length, 2, 'the set\'s recipients were not each invoiced once');
    assert.deepEqual(heldAfter, [false, false], 'the held contracts were not spent by the retry');
    assert.equal(nodePayoutsAfter, nodePayoutsBefore, 'the retry paid a pre-expired contract - the 25% went to a key, not the set');
  } finally { await w.close(); }
});

test('5 of 7: the same claim - no qualifier, the donation set not answering; the walker\'s lock claimed, 75% to all seven sitting signer nodes, 25% held under the committee key', async () => {
  const port = lockPort();
  const w = await lockRound({ n: 7, port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    w.lnurl.donationDown = true;
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    const at = () => w.nodes.filter((d) => d.round.results(w.rid, walker.eid).length).length;
    for (const stop = Date.now() + 60000; Date.now() < stop && at() < 7; await wait(250));
    const door = w.nodes.map((d) => d.round.results(w.rid, walker.eid).map((r) => r.bytes.length).length);
    await closeRound(w);
    let st;
    for (const stop = Date.now() + 120000; Date.now() < stop; await wait(500)) {
      st = await (await fetch(`http://127.0.0.1:${proposerOf(w).port}/lock-settlement?round=${toHex(w.rid)}`)).json();
      if (st.state === 'ACCEPTED') break;
    }
    const claimed = port.settlements.some((x) => (x.claims || []).some((c) => opKey(c.outpoint) === opKey(walker.outpoint)));
    const m = st.moved || {};
    const nodeKeys = w.c.nodes.map((k) => toHex(k));
    const facts = { committee: `${w.needed} of ${w.nodes.length}`, doorResultsAt: door, state: st.state, why: String(st.why).slice(0, 200),
      walkerLockClaimed: claimed, walkerLockHeld: port.locks.has(opKey(walker.outpoint)), remainder: m.remainder,
      nodes: (m.payouts || []).filter((x) => x.kind === 'remainder node').map((x) => x.msat),
      nodesAreTheSeven: (m.payouts || []).filter((x) => x.kind === 'remainder node').every((x) => nodeKeys.includes(x.pk.slice(2))),
      held: (m.payouts || []).filter((x) => x.kind === 'held').map((x) => [x.msat, x.pk === toHex(w.claimPk)]) };
    console.log('  FACTS (5 of 7):', JSON.stringify(facts));
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(claimed && !facts.walkerLockHeld, 'the walker\'s lock is left to expire back - a refund');
    assert.equal(facts.nodes.length, 7, 'not every sitting signer node is paid its share of the 75%');
    assert.ok(facts.nodesAreTheSeven);
    assert.equal(facts.nodes.reduce((t, x) => t + BigInt(x), 0n), BigInt(m.remainder.nodesMsat));
    assert.equal(facts.held.length, 2);
    assert.ok(facts.held.every((x) => x[1]), 'a held share is under another key than the committee claim key');
    assert.equal(BigInt(m.remainder.heldMsat), BigInt(m.remainder.donationMsat));
  } finally { await w.close(); }
});

test('the donation set answers the proposer and not the other seat: the recipients the seat names are planned HELD, the walk-away settles, and the retry pays once the seat reaches them', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    const p = proposerOf(w);
    const seat = p === w.a ? w.b : w.a;
    // THE OTHER SEAT CANNOT REACH THE SET; the proposer can.
    let seatDown = true;
    const own = seat.winnings.lnurlFetch;
    seat.winnings.lnurlFetch = (url) => (seatDown && new URL(url).pathname.startsWith('/lnurlp/') ? Promise.reject(new Error('connect ECONNREFUSED')) : own(url));
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    for (const stop = Date.now() + 60000; Date.now() < stop && !(w.a.round.results(w.rid, walker.eid).length && w.b.round.results(w.rid, walker.eid).length); await wait(250));
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    const moved = (await (await fetch(`http://127.0.0.1:${p.port}/lock-settlement?round=${toHex(w.rid)}`)).json()).moved;
    const claimed = port.settlements.some((x) => (x.claims || []).some((c) => opKey(c.outpoint) === opKey(walker.outpoint)));
    const facts = { state: st.state, why: String(st.why).slice(0, 160), walkerLockClaimed: claimed, walkerLockHeld: port.locks.has(opKey(walker.outpoint)),
      held: moved && moved.payouts.filter((x) => x.kind === 'held').map((x) => x.msat), sent: moved && moved.payouts.filter((x) => x.kind === 'sent').length,
      invoicesAskedByTheProposer: w.lnurl.issued.filter((i) => i.host === '127.0.0.1:18777').length };
    console.log('  FACTS (the set down at one seat):', JSON.stringify(facts));
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(claimed && !facts.walkerLockHeld, 'the walker\'s lock is left to expire back - a refund');
    assert.equal(facts.held.length, 2, 'the recipients the seat could not reach are not held');
    assert.equal(facts.sent, 0, 'an invoice the seat could not check was built on');
    // THE SEAT REACHES THE SET: the retry pays it
    seatDown = false;
    let latest = [];
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(500)) {
      latest = p.round.sendPlansOf(w.rid).filter((r) => r.donation);
      if (latest.length === 2 && latest.every((r) => r.state === 'PAID')) break;
    }
    console.log('  FACTS (the seat reaches the set):', JSON.stringify(latest.map((r) => [r.attempt, r.state, String(r.payoutMsat)])));
    assert.ok(latest.length === 2 && latest.every((r) => r.state === 'PAID' && r.attempt >= 1), 'the held shares were not paid once both seats reach the set');
  } finally { await w.close(); }
});
