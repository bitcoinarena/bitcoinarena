// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT settle a8 r3-1 (gap in #1156's federation read, a sibling of #2925): a seat that holds no share of a federation's reserve key keeps
// a guardian's SENT/PAID record when the federation says (federationSays) that the plan's FIRST input is not stored and the record's txid is
// what the plan makes - a dry run of the record's own plan. One guardian puts a made-up outpoint first (never stored, so "spent"), lists
// every real unspent reserve output of its federation after it, names any change it likes, and signs a SENT for a made-up proposal: every
// non-signer seat marks the real reserves spent and books a phantom change row the federation never held. The safe behaviour: refused,
// nothing marked spent, no row written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as rp from '../src/reserve-payout.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { world, NODE_KEYS, SECRET_OF, FED, KEY, PROPOSAL } from './reserve-payout-fixture.js';

const { PAYOUT, planIdOf, recordDigestOf, nonceOf } = rp;
const signedBy = (sk, rec) => { const r = { ...rec, from: toHex(schnorr.getPublicKey(sk)) }; return { ...r, sig: toHex(schnorr.sign(recordDigestOf(r), sk)) }; };
const outpointOf = (s) => { const [t, i] = String(s).split(':'); return { txid: fromHex(t), outIdx: BigInt(i) }; };

test('a8-3-1 one guardian\'s SENT whose plan puts a made-up input first marks no real reserve spent and books no phantom change at a non-signer seat', async () => {
  const NON_SIGNER = 6;
  const w = world({ more: (i) => (i === NON_SIGNER ? { guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: null, peers: [] }]]) } : {}) });
  // a real plan's shape, from public data (another world's coordinator plan)
  const real = await (async () => { const x = world(); await x.seats[0].api.round({ height: 500 }); return x.seats[0].api.stateOf(PROPOSAL).plan; })();
  const pid = 'cc'.repeat(32);
  const madeUp = { outpoint: `${'ee'.repeat(32)}:0`, amountMsat: '900000000000' };
  const plan = { ...real, proposal: pid, nonce: toHex(nonceOf(pid, 0)), refunds: [madeUp, ...w.reserveRows.map((r) => ({ outpoint: r.outpoint, amountMsat: r.amountMsat }))],
    changeMsat: '500000000000' };
  // the txid is the plan's own dry run, as any guardian computes it with the stock client
  const api = w.seats[NON_SIGNER].api;
  const payouts = api.payoutsOfRecord({ plan });
  const built = await w.port.settle({ claimPk: KEY, claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })), payouts, nonce: fromHex(plan.nonce) });
  const rec = signedBy(SECRET_OF.get(NODE_KEYS[3]), { proposal: pid, planId: planIdOf(plan), federation: FED, state: PAYOUT.SENT, plan, txid: String(built.message) });

  const got = await api.learn(rec);
  const spent = api.spent();
  const phantom = w.state.kept.filter((k) => k.seat === NON_SIGNER);
  console.log(`FACTS a8-3-1: ${JSON.stringify({ ok: got.ok, kept: got.kept, why: got.why, spentReal: w.reserveRows.filter((r) => spent.has(r.outpoint)).length, phantomRows: phantom.map((k) => k.row) })}`);
  assert.equal(got.ok, false, `a non-signer seat kept one guardian's ${rec.state} of a made-up plan (${got.kept})`);
  assert.equal(w.reserveRows.filter((r) => spent.has(r.outpoint)).length, 0, 'the federation\'s real, unspent reserve outputs read spent');
  assert.equal(phantom.length, 0, 'a change row the federation never held was booked');
});
