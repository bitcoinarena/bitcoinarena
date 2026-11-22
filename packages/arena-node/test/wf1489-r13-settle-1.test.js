// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r13-settle-1: ONE guardian seat's signed SHORT is kept for good by every seat that holds no reserve key share.
// reserve-payout.js shortStands answers { ok: true } at once on a seat with no signer share ("a seat that pays nothing keeps the
// signed record as it was said"): it does not ask whether the proposal passed, whether the reserves cover it, or whether the
// federation named is the one that pays. SHORT is terminal (PAYOUT_NEXT[SHORT] = []), so the coordinator's real SENT/PAID that
// follows is answered "kept: SHORT" there: the payout reads "nothing is paid, for good" while it was paid, its inputs are never
// marked spent there (reserves overstated), and a seat seated as a guardian later refuses to sign it ("SHORT here").
// Safe behaviour: a lone guardian's SHORT does not freeze a non-signer's record against the guardians' later PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as rp from '../src/reserve-payout.js';
import { openStore } from '../src/store.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { world, curve, rand, NODE_KEYS, SECRET_OF, FED, KEY, PROPOSAL } from './reserve-payout-fixture.js';

const { PAYOUT, recordDigestOf } = rp;
const signedBy = (sk, rec) => { const r = { ...rec, from: toHex(schnorr.getPublicKey(sk)) }; return { ...r, sig: toHex(schnorr.sign(recordDigestOf(r), sk)) }; };
const OBSERVER_SK = Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? 88 : 3));

test('r13-settle-1: one guardian\'s forged SHORT does not hold a non-signer seat\'s record against the real PAID', async () => {
  const w = world();                                  // the reserves cover the payout: 70,000 sat of 150,000
  // an eighth seat of the network that holds no share of the reserve key (most seats of 14)
  const observer = rp.createReservePayouts({ db: openStore(':memory:'), me: toHex(schnorr.getPublicKey(OBSERVER_SK)), heightNow: () => 500, curve, random: rand,
    network: 'testnet4', sign: (d) => schnorr.sign(d, OBSERVER_SK), passed: () => w.state.passed, reserveRows: () => w.reserveRows,
    portOf: async () => w.port, payRequest: w.lnurl.payRequest, invoiceFor: w.lnurl.invoiceFor, payeeFor: w.lnurl.payeeFor,
    keepRow: () => {}, broadcast: () => {},
    guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: null, peers: [] }]]) });

  // guardian seat 3 alone signs a SHORT the reserves contradict, and posts it to the observer before the payout is planned
  const forged = signedBy(SECRET_OF.get(NODE_KEYS[3]), { proposal: PROPOSAL, state: PAYOUT.SHORT, why: 'forged by one guardian', federation: FED });
  const a = await observer.learn(forged);

  // the six other guardians pay it as always
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
  assert.equal(w.fed.payments.length, 1, 'the federation paid the payout');
  // the coordinator's records reach the observer as they reach every seat
  for (const rec of w.seats[1].inbox) await observer.learn(rec);

  const st = observer.stateOf(PROPOSAL);
  assert.equal(st && st.state, PAYOUT.PAID,
    `the observer still reads the paid payout as ${st && st.state} (forged SHORT answered ${JSON.stringify(a)}); spent inputs here: ${observer.spent().size}`);
  assert.ok(observer.spent().size > 0, 'the paid inputs are marked spent at the observer');
});

test('r13-settle-1: a guardian\'s SHORT for a proposal that never passed is not kept by a non-signer seat', async () => {
  const w = world();
  const observer = rp.createReservePayouts({ db: openStore(':memory:'), me: toHex(schnorr.getPublicKey(OBSERVER_SK)), heightNow: () => 400, curve, random: rand,
    network: 'testnet4', sign: (d) => schnorr.sign(d, OBSERVER_SK), passed: () => [], reserveRows: () => w.reserveRows,
    portOf: async () => w.port, payRequest: w.lnurl.payRequest, invoiceFor: w.lnurl.invoiceFor, payeeFor: w.lnurl.payeeFor,
    keepRow: () => {}, broadcast: () => {},
    guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: null, peers: [] }]]) });
  // any 32-byte id, even one still in its vote - the proposal's later payout is then pre-empted at this seat
  const forged = signedBy(SECRET_OF.get(NODE_KEYS[3]), { proposal: 'cd'.repeat(32), state: PAYOUT.SHORT, why: 'pre-empted', federation: FED });
  const a = await observer.learn(forged);
  assert.equal(a.ok, false, `a SHORT of a proposal this seat has no passed vote for was kept: ${JSON.stringify(a)}`);
});

test('r13-settle-1 control: without the forged SHORT the same non-signer seat reads the payout PAID', async () => {
  const w = world();
  const observer = rp.createReservePayouts({ db: openStore(':memory:'), me: toHex(schnorr.getPublicKey(OBSERVER_SK)), heightNow: () => 500, curve, random: rand,
    network: 'testnet4', sign: (d) => schnorr.sign(d, OBSERVER_SK), passed: () => w.state.passed, reserveRows: () => w.reserveRows,
    portOf: async () => w.port, payRequest: w.lnurl.payRequest, invoiceFor: w.lnurl.invoiceFor, payeeFor: w.lnurl.payeeFor,
    keepRow: () => {}, broadcast: () => {},
    guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: null, peers: [] }]]) });
  await w.seats[0].api.round({ height: 500 });
  for (const rec of w.seats[1].inbox) await observer.learn(rec);
  assert.equal(observer.stateOf(PROPOSAL).state, PAYOUT.PAID);
  assert.ok(observer.spent().size > 0);
});
