// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// POSITIONS BACKED BY LOCKS (comment 1127; 2026-10-09: "Pick (a)"). Seven seats of one Up/Down market
// round; every order an entry with its stake lock (budget less 1 %) and fee lock (the 1 %), the player locking first. Each
// case of the plan, in one round: placement, a match all seats agree, a match that fails agreement (void), a leader that
// drops its batch's signatures, a cancel of an unfilled and of a partly filled order, a sell before resolution, and the
// settlement - every filled lock claimed whole, every unfilled lock back whole, to the msat. Every seat-to-seat request of
// the book waits one round trip measured to a live seat through its tunnel (order-batch.test.js's samples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { cancelId, sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-locks', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 10_000n;                          // 10 sat an order: a 9,900 msat stake lock and a 100 msat fee lock
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const RTT_MS = [56, 54, 57, 53, 55, 58, 52, 56, 60, 54, 55, 57, 53, 56, 59, 61, 55, 54, 66, 57, 53, 56, 58, 55, 67, 54, 52, 57, 56, 106, 55, 54, 58, 56, 62, 53, 57, 55, 54, 60];
const B = 500;
const [A0, A1] = UPDOWN.attestors;
const player = (n) => ({ ...LOSER, name: `o${n}`, key: b32(0x60 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// 170 S OF ITS OWN (the suite's per-test default is 120 s, its per-file cap 180 s): seven seats and a settlement of 16 locks
// took 46-80 s alone and in a suite, and over 120 s once under a heavier suite (1,197 event-loop stalls logged in that file)
test('positions backed by locks: placement, an agreed match, a failed one (void), a dropped certificate, cancels, a sell, and the settlement - seven seats, to the msat', { timeout: 170000 }, async () => {
  const T0 = Date.now();
  const phases = [];
  const mark = (name) => phases.push([name, Date.now() - T0]);
  const w = await lockRound({ n: 7, stakeMsat: STAKE, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  let turn = 0;
  const drop = new Set();                       // seat bases whose POST /batch this round's leader loses (a partition)
  for (const d of w.nodes) {
    d.orderBook.intervalMs = B;
    d.orderBook.fetcher = async (u, o) => {
      await wait(RTT_MS[turn++ % RTT_MS.length]);
      if (o && o.method === 'POST' && /\/batch\?round=/.test(u) && [...drop].some((b) => u.startsWith(b))) throw new Error('lost on the way (a partition)');
      return fetch(u, o);
    };
  }
  const base = (d) => `http://127.0.0.1:${d.port}`;
  const times = [];
  // ONE BATCH: the next cutoff on the seats' clock, led by the round's seat k mod 7
  // `k`: a batch named ahead (the partition below is set for that batch's leader); else the batch whose cutoff comes next
  const batch = async ({ k: named = null, ...opts } = {}) => {
    const k = named ?? Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k, opts);
    assert.equal(got.ok, true, got.why);
    if (got.timings && got.certified) times.push(got.timings.certifiedMs);
    return { ...got, k, leader };
  };
  const back = (e, lock = '', d = w.nodes[0]) => fetch(`${base(d)}/forfeit?round=${rid}&entry=${toHex(e.eid)}${lock}`).then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).trim()}`));
  const book = (d) => fetch(`${base(d)}/book?round=${rid}`).then((r) => r.json());
  const stored = async (e) => !!(await w.port.status(e.outpoint)).stored && !!(await w.port.status(e.feeOutpoint)).stored;
  const order = (n, outcome, c, extra = {}) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c), ...extra });
  const facts = {};
  try {
    mark('placement');
    // 1. PLACEMENT: the door refuses a price off the cent and an expiry already past; an order whose locks only 3 seats
    //    verified is not tradable (fewer than 5) and is in no batch
    const offCent = await order(0, YES, 55, { order: { price: 55500n } }).then(() => 'taken', (e) => e.message);
    const expired = await order(1, YES, 55, { order: { price: 55000n, expiryMs: BigInt(testNow() - 1000) } }).then(() => 'taken', (e) => e.message);
    const A = await order(2, YES, 60);
    const Bo = await order(3, NO, 45);
    const C = await order(4, YES, 40);
    const X = await order(5, NO, 70, { only: [0, 1, 2] });
    facts.door = { offCent: offCent.slice(0, 90), expired: expired.slice(0, 90) };
    assert.match(offCent, /a limit price is a whole cent below 1/);
    assert.match(expired, /that order's expiry has passed/);

    mark('agreed');
    // 2. A MATCH ALL SEATS AGREE: certified; nothing moves in the federation; a filled order's locks are closed
    const b1 = await batch();
    const books1 = await Promise.all(w.nodes.map(book));
    facts.agreed = { orders: b1.orderIds.length, heldBy: b1.heldBy, certified: b1.certified, price: books1[0].batches[0].price,
      x: b1.orderIds.includes(toHex(X.eid)), aBack: await back(A), aFeeBack: await back(A, '&lock=fee'), cBack: await back(C), locksStored: await stored(A) && await stored(Bo) };
    assert.equal(b1.certified, true);
    assert.equal(b1.heldBy, 7);
    assert.equal(facts.agreed.x, false, 'an order whose locks only 3 seats verified was batched');
    for (const b of books1) assert.equal(JSON.stringify(b.batches), JSON.stringify(books1[0].batches), 'two seats hold the book differently');
    assert.equal(facts.agreed.locksStored, true, 'a lock moved in the federation at a fill');
    assert.match(facts.agreed.aBack, /^409 that order filled: its locks are claimed at resolution/);
    assert.match(facts.agreed.aFeeBack, /^409 that order filled/);
    assert.match(facts.agreed.cBack, /^409 that order stands unfilled/);

    mark('failed');
    // 3. A MATCH THAT FAILS AGREEMENT: the leader's set reaches only 4 seats (3 partitioned): no certificate, no seat counts it,
    //    the order waits; the next leader finds it can no longer reach 5 (3 declined) - VOID - and the order fills in that batch
    const D = await order(6, NO, 65);
    // THE BATCH AFTER NEXT, named once: its leader is known before its cutoff, and the 3 partitioned seats are never it
    const k2 = Math.floor(testNow() / B) + 1;
    { const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k2));
      for (const d of w.nodes.filter((x) => x !== leader).slice(0, 3)) drop.add(base(d)); }
    const b2 = await batch({ k: k2 });
    drop.clear();
    // asked at a seat that signed the failed batch (a partitioned seat never held it: there D simply stands unfilled)
    const signer = w.nodes.find((d) => d.orderBook.pending(w.rid).length);
    const dWaits = await back(D, '', signer);
    const dElsewhere = await back(D, '', w.nodes.find((d) => !d.orderBook.pending(w.rid).length));
    const counted2 = (await Promise.all(w.nodes.map(book))).map((b) => b.batches.length);
    const b3 = await batch();
    facts.failed = { heldBy: b2.heldBy, certified: b2.certified, booksAfter: counted2, dWhilePending: dWaits, dAtPartitioned: dElsewhere, decided: b3.decided.map((x) => x.state),
      dIn3: b3.orderIds.includes(toHex(D.eid)), certified3: b3.certified, dLocksStored: await stored(D) };
    assert.equal(b2.heldBy, 4);
    assert.equal(b2.certified, false);
    assert.deepEqual(counted2, [1, 1, 1, 1, 1, 1, 1], 'a seat counted a batch that never reached 5');
    assert.match(dWaits, /^409 that order is in a batch not decided yet/);
    assert.match(dElsewhere, /^409 that order stands unfilled/);
    assert.deepEqual(facts.failed.decided, ['VOID']);
    assert.equal(facts.failed.dIn3, true, 'the void batch\'s order was not batched again');
    assert.equal(b3.certified, true);
    assert.equal(facts.failed.dLocksStored, true);

    mark('dropped');
    // 4. A LEADER THAT DROPS ITS BATCH'S SIGNATURES: 7 signed, no certificate handed out; the next leader certifies it from
    //    the seats' own signatures; every seat counts it, and its orders are not batched again
    const E = await order(7, YES, 50);
    const F = await order(8, NO, 55);
    const b4 = await batch({ dropCertificate: true });
    const counted4 = (await Promise.all(w.nodes.map(book))).map((b) => b.batches.length);
    const b5 = await batch();
    const counted5 = (await Promise.all(w.nodes.map(book))).map((b) => b.batches.length);
    facts.dropped = { signed: b4.heldBy, certified: b4.certified, booksBefore: counted4, decided: b5.decided.map((x) => `${x.state}:${x.sigs}`), booksAfter: counted5,
      rebatched: (b5.orderIds || []).some((o) => o === toHex(E.eid) || o === toHex(F.eid)) };
    assert.equal(b4.heldBy, 7);
    assert.equal(b4.certified, false);
    assert.deepEqual(counted4, [2, 2, 2, 2, 2, 2, 2]);
    assert.equal(b5.decided[0].state, 'CERTIFIED');
    assert.equal(facts.dropped.rebatched, false);
    for (const n of counted5) assert.equal(n, 3, 'a seat does not count the batch its leader dropped');

    mark('cancel-unfilled');
    // 5. CANCEL, UNFILLED: G rests unfilled; its cancel rides in the next batch with an order that would have filled it -
    //    G does not fill, and both its locks come back at once, whole
    const G = await order(9, YES, 30);
    await batch();
    const cancel = (e) => Promise.all(w.nodes.map((d) => fetch(`${base(d)}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session) }).then((r) => r.status)));
    const gAsked = await cancel(G);
    const H = await order(10, NO, 75);
    const b7 = await batch();
    const L7 = w.nodes[0].orderBook.ledger(w.rid);
    facts.cancelUnfilled = { asked: gAsked, cancels: b7.cancels, gCost: String(L7.positions.get(toHex(G.eid)).cost), back: await back(G), feeBack: await back(G, '&lock=fee') };
    assert.deepEqual(gAsked, [202, 202, 202, 202, 202, 202, 202]);
    assert.equal(b7.cancels, 1);
    assert.equal(facts.cancelUnfilled.gCost, '0');
    assert.equal(facts.cancelUnfilled.back, '200');
    assert.equal(facts.cancelUnfilled.feeBack, '200');

    mark('cancel-partly');
    // 6. CANCEL, PARTLY FILLED: B filled part of its budget in batch 1; its cancel takes the rest out of the book; its locks stay
    //    closed - the rest comes back at settlement (a)
    const bBefore = w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(Bo.eid));
    await cancel(Bo);
    const I = await order(11, YES, 70);
    await batch();
    const bAfter = w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(Bo.eid));
    facts.cancelPartly = { costBefore: String(bBefore.cost), costAfter: String(bAfter.cost), N: String(bAfter.N), cancelled: bAfter.cancelled, back: await back(Bo) };
    assert.ok(bBefore.cost > 0n && bBefore.cost < bBefore.N, 'B did not fill partly in batch 1');
    assert.equal(bAfter.cost, bBefore.cost, 'B filled after its cancel');
    assert.equal(bAfter.cancelled, true);
    assert.match(facts.cancelPartly.back, /^409 that order filled/);

    mark('sell');
    // 7. A SELL BEFORE RESOLUTION: A sells 5 sat of its Up at >= 0.70 to J; a sell of more than A holds unsold is left out;
    //    nothing moves in the federation; the shares pass to the buyer
    const aPos = w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(A.eid));
    const sell = (sharesMsat, nonce) => { const s = { roundId: w.rid, entryId: A.eid, outcome: YES, price: 70000n, sharesMsat, nonce };
      return { entry: toHex(A.eid), outcome: YES, price: '70000', sharesMsat: String(sharesMsat), nonce: String(nonce), signature: toHex(ed25519.sign(sellId(s), A.session)) }; };
    for (const d of w.nodes) for (const s of [sell(5000n, 1n), sell(aPos.shares[YES] + 1n, 2n)])
      assert.equal((await fetch(`${base(d)}/sell?round=${rid}`, { method: 'POST', body: JSON.stringify(s) })).status, 201);
    const J = await order(12, YES, 75);
    const b9 = await batch();
    const L9 = w.nodes[0].orderBook.ledger(w.rid);
    const a9 = L9.positions.get(toHex(A.eid));
    facts.sell = { sells: b9.sells, aUp: String(a9.shares[YES]), aDown: String(a9.shares[NO]), debt: String(a9.sellDebt), fee: String(a9.sellFee),
      jUp: String(L9.positions.get(toHex(J.eid)).shares[YES]), aLocks: await stored(A) };
    assert.equal(b9.sells, 1, 'the oversell was not left out, or the sell not carried');
    assert.equal(a9.shares[NO], 5000n, 'the sold shares did not pass');
    assert.ok(L9.positions.get(toHex(J.eid)).shares[YES] >= 5000n);
    assert.equal(facts.sell.aLocks, true);

    mark('resolution');
    // 8. RESOLUTION: Up. Every filled order's two locks claimed once, whole; every unfilled one back whole; each payout the
    //    table's to the msat; the nodes and the donation the fees due; the sum of the payouts the sum of the locks claimed
    skipTo(Number(w.c.entryCloseMs) + 2 * B + 10);
    // NO RUN TO WAIT FOR: an order is an entry with no run, so the replay window's wait for published runs (closeRound's
    // default, up to 30 s) is skipped - the market's own objection window is the one that holds it (finalAtMs, below)
    await closeRound(w, { window: false });
    mark('closed');
    const body = { roundId: w.rid, outcome: YES, observedAtMs: w.c.entryCloseMs + 1n };
    await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/outcome?round=${rid}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [A0, A1].map((a) => attestorSign(a, body)) }) })));
    const o = await (await fetch(`${base(w.nodes[0])}/outcome?round=${rid}`)).json();
    skipTo(Number(o.finalAtMs) + 100);
    mark('final');
    let got;
    // THE SEATS' OWN SETTLE, ASKED EVERY 3 S (the call their 5 s sweep makes; every 1 s added load of its own under the suite): each step - propose, sign, submit, find it in
    // the federation - comes a second apart instead of a sweep apart; measured in the suite under load, 40 s of sweeps left it
    // SUBMITTING. The check is the same: ACCEPTED, then every payout to the msat below.
    let nudged = 0;
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      got = await standing(w.a, w);
      if (got.state === 'ACCEPTED') break;
      if (Date.now() - nudged > 3000) { nudged = Date.now(); await Promise.all(w.nodes.map((d) => d.settlements.settle(w.rid).catch(() => null))); }
    }
    if (got.state !== 'ACCEPTED') {
      const asked = await Promise.all(w.nodes.map((d) => d.settlements.settle(w.rid).catch((e) => ({ why: e.stack }))));
      console.log('  SETTLE ASKED:', JSON.stringify(asked.map((x) => ({ state: x.state, ok: x.ok, why: String(x.why || '').slice(0, 400) }))));
    }
    mark('settled');
    assert.equal(got.state, 'ACCEPTED', got.why);
    const L = w.nodes[0].orderBook.ledger(w.rid);
    const table = bookSettlement({ positions: L.positions, outcome: YES });
    const moved = got.moved || {};
    const claims = moved.claims || [];
    const payouts = moved.payouts || [];
    const all = { A, Bo, C, D, E, F, G, H, I, J, X };
    const filled = Object.entries(all).filter(([, e]) => table.claimed.some((r) => r.entry === toHex(e.eid)));
    const unfilled = Object.entries(all).filter(([, e]) => !table.claimed.some((r) => r.entry === toHex(e.eid)));
    for (const [name, e] of filled) {
      assert.equal(!!(await w.port.status(e.outpoint)).stored, false, `${name}'s stake lock was not claimed`);
      assert.equal(!!(await w.port.status(e.feeOutpoint)).stored, false, `${name}'s fee lock was not claimed`);
      const r = table.claimed.find((x) => x.entry === toHex(e.eid));
      const p = payouts.find((x) => x.kind === 'qualifier' && String(x.pk) === toHex(refundKeyOf(e.entry.playerPubkey)));
      if (r.outMsat > 0n) assert.equal(BigInt(p ? p.msat : -1), r.outMsat, `${name} was not paid its table out to the msat`);
    }
    const backs = {};
    for (const [name, e] of unfilled) backs[name] = [await back(e), await back(e, '&lock=fee')];
    const bRow = table.claimed.find((r) => r.entry === toHex(Bo.eid));
    facts.settled = { claims: claims.length, filled: filled.map(([n]) => n), unfilled: backs, pool: String(table.poolMsat), feesDue: String(table.feesDueMsat),
      paid: String(sum(payouts.map((x) => BigInt(x.msat)))), locks: String(sum(claims.map((c) => BigInt(c.msat ?? c.amountMsat)))),
      bOut: String(bRow.outMsat), bRest: String((bRow.stakeMsat - bAfter.cost) + (bRow.feeMsat - bAfter.buyFee)),
      kinds: [...new Set(payouts.map((x) => x.kind))] };
    assert.equal(claims.length, 2 * filled.length, 'not exactly two locks claimed per filled order');
    // X's locks were verified at 3 seats only: its return cannot reach 5 signatures - it comes back at its locks' expiry
    for (const [name, [s, f]] of Object.entries(backs)) {
      if (name === 'X') { assert.match(s, /^409 /); continue; }
      assert.deepEqual([s, f], ['200', '200'], `${name}'s unfilled locks did not come back whole`);
    }
    assert.equal(facts.settled.paid, facts.settled.locks, 'the payouts are not the locks claimed, to the msat');
    assert.equal(facts.settled.bOut, facts.settled.bRest, 'B did not get exactly its unfilled rest back at settlement (a)');
    assert.equal(sum(payouts.filter((x) => x.kind !== 'qualifier').map((x) => BigInt(x.msat))), table.feesDueMsat, 'the nodes and the donation are not paid the fees due');
    facts.timing = { batches: times.length, p50: Math.round(pct(times, 0.5)), max: Math.round(Math.max(...times)) };
    mark('end');
    facts.phasesMs = phases;
    console.log('  LOCKS:', JSON.stringify(facts));
  } finally { await w.close(); }
});
