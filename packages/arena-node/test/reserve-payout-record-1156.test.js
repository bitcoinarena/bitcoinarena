// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1156: POST /reserve-payout/record moved every seat's payout record for whoever asked. A SHORT for a passed proposal held its
// payout back for good; a PAID built from public data with the poster's own invoice marked the reserves spent; a kept row was replaced.
// Now: a record is signed by a guardian seat of the federation whose step it is, a SHORT stands only as the seat's own reserves say, a
// step past PLANNED only as the federation says, every write is one compare-and-set step, and a derived row is kept once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as rp from '../src/reserve-payout.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { world, invoiceOf, rand, NODE_KEYS, SECRET_OF, FED, METADATA, PROPOSAL } from './reserve-payout-fixture.js';

// read off the module as a namespace: the same file runs against the source before the fix (the measure), where these are missing
const { PAYOUT, planIdOf } = rp;
const recordDigestOf = rp.recordDigestOf || (() => new Uint8Array(32));
const OUTSIDER = Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? 77 : 5));
const signedBy = (sk, rec) => { const r = { ...rec, from: toHex(schnorr.getPublicKey(sk)) }; return { ...r, sig: toHex(schnorr.sign(recordDigestOf(r), sk)) }; };

test('#1156 an unsigned SHORT, or one signed by a seat that is no guardian, is kept nowhere: the payout is paid', async () => {
  const w = world();
  const short = { proposal: PROPOSAL, state: PAYOUT.SHORT, why: 'the reserves cannot pay', federation: FED };
  for (const s of w.seats) {
    const a = await s.api.learn(short);
    assert.deepEqual([a.ok, a.status], [false, 401], a.why);
    const b = await s.api.learn(signedBy(OUTSIDER, short));
    assert.deepEqual([b.ok, b.status], [false, 403], b.why);
    assert.equal(s.api.stateOf(PROPOSAL), null);
  }
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
});

test('#1156 a guardian\'s SHORT for a payout the reserves cover is refused by every seat that pays: its own reserves say otherwise', async () => {
  const w = world();
  const short = signedBy(SECRET_OF.get(NODE_KEYS[3]), { proposal: PROPOSAL, state: PAYOUT.SHORT, why: 'forged', federation: FED });
  for (const s of w.seats) { const a = await s.api.learn(short); assert.equal(a.ok, false); assert.match(a.why, /cover that payout/); }
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
  // and a real one (reserves too small) is kept as said
  const s2 = world({ amountSats: 200000n });
  const real = signedBy(SECRET_OF.get(NODE_KEYS[0]), { proposal: PROPOSAL, state: PAYOUT.SHORT, why: 'too small', federation: FED });
  assert.equal((await s2.seats[4].api.learn(real)).ok, true);
});

test('#1156 a forged PAID with the poster\'s own invoice and preimage marks nothing spent', async () => {
  const w = world();
  // the attacker's plan from public data: the passed proposal, the reserve key, the oldest outputs, its own invoice
  const pre = rand(32), hash = toHex(sha256(pre));
  await w.seats[0].api.round({ height: 499 });
  const real = (await (async () => { const x = world(); await x.seats[0].api.round({ height: 500 }); return x.seats[0].api.stateOf(PROPOSAL).plan; })());
  const plan = { ...real, invoice: invoiceOf(70000000n, sha256(pre), METADATA), paymentHash: hash };
  const forged = { proposal: PROPOSAL, planId: planIdOf(plan), federation: FED, state: PAYOUT.PAID, plan, txid: 'ee'.repeat(32), preimage: toHex(pre) };
  for (const s of w.seats) {
    assert.equal((await s.api.learn(forged)).ok, false, 'unsigned');
    assert.equal((await s.api.learn(signedBy(OUTSIDER, forged))).ok, false, 'not a guardian');
    assert.equal(s.api.spent().size, 0, 'no input marked spent');
    assert.equal(s.api.stateOf(PROPOSAL), null);
  }
  // even a guardian's signature does not make a transaction the plan does not make
  const g = await w.seats[5].api.learn(signedBy(SECRET_OF.get(NODE_KEYS[2]), forged));
  assert.equal(g.ok, false); assert.match(g.why, /another transaction than its plan makes/);
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
  assert.equal(w.fed.payments.length, 1);
});

test('#1156 a SENT the federation does not hold is refused; the real one, signed, is kept', async () => {
  const w = world();
  await w.seats[0].api.round({ height: 500 });
  const sent = w.seats[1].inbox.find((x) => x.state === PAYOUT.SENT);
  assert.ok(sent && sent.sig && sent.from === w.seats[0].me, 'the coordinator signs what it hands on');
  // the same record with another transaction id: refused, nothing kept
  const fake = signedBy(SECRET_OF.get(NODE_KEYS[0]), { ...sent, txid: 'dd'.repeat(32), sig: undefined, from: undefined });
  assert.equal((await w.seats[1].api.learn(fake)).ok, false);
  // a field changed after signing: refused
  assert.equal((await w.seats[1].api.learn({ ...sent, why: 'changed' })).status, 401);
  await w.deliver();
  assert.ok(w.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.PAID));
});

test('#1156 the step is one compare-and-set: a row kept with other fields undoes it, a terminal state never moves', async () => {
  const w = world();
  await w.seats[0].api.round({ height: 500 });
  // seat 6 already keeps another row at the change's outpoint: the SENT step there is undone whole - no state, no inputs
  const sent = w.seats[6].inbox.find((x) => x.state === PAYOUT.SENT);
  const db = openStore(':memory:'); const round = new Round(db);
  const changeAt = { txid: Buffer.from(sent.txid, 'hex'), outIdx: 1n };
  round.putDonationOutputs([{ outpoint: changeAt, entryId: new Uint8Array(32), roundId: new Uint8Array(32), federationId: Buffer.from(FED, 'hex'), recipientPk: new Uint8Array(33).fill(2),
    amountMsat: 1n, contractId: 'someone-else', senderOnContract: false }]);
  assert.throws(() => round.putDonationOutputsOnce([{ outpoint: changeAt, entryId: new Uint8Array(32), roundId: new Uint8Array(32), federationId: Buffer.from(FED, 'hex'),
    recipientPk: new Uint8Array(33).fill(3), amountMsat: 5n, contractId: 'payout-change:x', senderOnContract: false }]), /other fields/);
  assert.equal(db.prepare('SELECT contract_id FROM donation_outputs').get().contract_id, 'someone-else', 'never replaced');
  // the transition table: terminal states go nowhere
  assert.ok(rp.PAYOUT_NEXT && rp.canMove, 'one transition table');
  for (const t of [PAYOUT.REFUNDED, PAYOUT.SHORT, PAYOUT.CLAIMED]) assert.deepEqual(rp.PAYOUT_NEXT[t], []);
  assert.equal(rp.canMove(PAYOUT.PAID, PAYOUT.SENT), false);
  assert.equal(rp.canMove(PAYOUT.SENT, PAYOUT.PLANNED), false);
  await w.deliver();
  const late = signedBy(SECRET_OF.get(NODE_KEYS[0]), { ...sent, sig: undefined, from: undefined });
  for (const s of w.seats) { await s.api.learn(late); assert.equal(s.api.stateOf(PROPOSAL).state, PAYOUT.PAID, 'PAID does not go back to SENT'); }
});

test('#1156 a seat whose keepRow refuses the change row keeps neither the state nor the inputs', async () => {
  let refuse = true;
  const w = world({ more: (i) => (i === 6 ? { keepRow: () => { if (refuse) throw new Error('kept already with other fields'); } } : {}) });
  await w.seats[0].api.round({ height: 500 });
  const s = w.seats[6];                                         // not asked to commit: no record yet
  assert.equal(s.api.stateOf(PROPOSAL), null);
  const sent = s.inbox.find((x) => x.state === PAYOUT.SENT);
  const r = await s.api.learn(sent);
  assert.equal(r.ok, false); assert.match(r.why, /other fields/);
  assert.equal(s.api.stateOf(PROPOSAL), null, 'no state');
  assert.equal(s.api.spent().size, 0, 'no inputs');
  refuse = false;
  assert.equal((await s.api.learn(sent)).ok, true);
  assert.equal(s.api.stateOf(PROPOSAL).state, PAYOUT.SENT);
  assert.equal(s.api.spent().size, 2);
});

// KANBAN #1221 (audit 2 #1204 RES-2): a record stood when a guardian of the federation IT NAMES signed it, and its inputs were locked by
// outpoint alone. A guardian of federation F2 posted a PLANNED for F2 whose inputs were federation FED's reserve outputs: every seat that is
// no signer of F2 kept it, and FED's reserves read spent for good. Now an input must be a reserve output of the plan's own federation here.
test('#1221 a PLANNED of one federation naming another federation\'s reserve outputs locks nothing', async () => {
  const F2 = 'f2'.repeat(32);
  const create = (o) => rp.createReservePayouts({ ...o,
    guardians: () => new Map([...o.guardians(), [F2, { members: [toHex(schnorr.getPublicKey(OUTSIDER))], key: o.guardians().get(FED).key, needed: 1, signer: null, peers: [] }]]),
    reserveRows: (f) => (f === F2 ? [] : o.reserveRows(f)) });
  const w = world({ create });
  const real = (await (async () => { const x = world(); await x.seats[0].api.round({ height: 500 }); return x.seats[0].api.stateOf(PROPOSAL).plan; })());
  for (const variant of ['F2 names FED\'s outputs', 'the same, a second proposal']) {
    const plan = { ...real, federation: F2 };
    const rec = signedBy(OUTSIDER, { proposal: variant.includes('second') ? 'bb'.repeat(32) : 'cc'.repeat(32), planId: planIdOf(plan), federation: F2, state: PAYOUT.PLANNED, plan });
    for (const s of w.seats) {
      const a = await s.api.learn(rec);
      assert.equal(a.ok, false, `${variant}: kept (${a.why || a.kept})`);
      assert.equal(s.api.spent().size, 0, `${variant}: FED's reserve outputs marked spent`);
    }
  }
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
});
