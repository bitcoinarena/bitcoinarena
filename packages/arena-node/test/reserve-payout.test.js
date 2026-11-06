// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 5-OF-7 LNURL PAYOUT OF A PASSED FUNDING PROPOSAL (§27A.9.3): seven guardian seats in one process, one fake
// federation (contracts, the settle and send the stake-lock tool answers), one fake gateway and one fake LNURL endpoint. the owner's tests:
// a pass pays once; a fail pays nothing; a second attempt does not double-pay; 4 signature shares fail and 5 succeed; a gateway failure
// refunds and records, and nothing is paid twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { contractForInvoice, PAYOUT, planIdOf } from '../src/reserve-payout.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { lnv2FeeMsat, largestPayoutMsat } from '../../arena-protocol/src/lock-settlement.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { world, invoiceOf, curve, rand, DEAL, KEY, FEES, GW, LNURL, METADATA, PROPOSAL } from './reserve-payout-fixture.js';

test('a pass pays once: one plan, one transaction, one gateway payment for X; the preimage checked; all 7 hold the same PAID; the reserves drop by X plus fees', async () => {
  const w = world();
  const before = w.held(0);
  assert.deepEqual(await w.seats[0].api.round({ height: 499 }), [], 'not before the vote\'s decision height');
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.deepEqual([r.ok, r.state], [true, PAYOUT.PAID], r.why);
  await w.deliver();
  assert.equal(w.fed.invoiceAsks, 1); assert.equal(w.fed.submits.length, 1); assert.equal(w.fed.payments.length, 1);
  const invoiceMsat = 70000n * 1000n, contract = contractForInvoice(invoiceMsat, GW.sendFeeDefault);
  assert.equal(w.fed.payments[0].msat, contract, 'the gateway took the contract for exactly X sat');
  const recs = w.seats.map((s) => s.api.stateOf(PROPOSAL));
  assert.ok(recs.every((x) => x.state === PAYOUT.PAID && x.planId === recs[0].planId && x.preimage === recs[0].preimage), JSON.stringify(recs.map((x) => x.state)));
  assert.equal(toHex(sha256(fromHex(recs[0].preimage))), recs[0].plan.paymentHash);
  assert.deepEqual(recs[0].plan.refunds.map((x) => x.amountMsat), ['60000000', '40000000'], 'oldest first, no more than X plus fees needs');
  const spentAll = 100000000n, fee = lnv2FeeMsat(FEES, contract);
  assert.equal(BigInt(recs[0].plan.changeMsat) > 0n, true);
  for (let i = 0; i < 7; i++) assert.equal(before - w.held(i), spentAll - BigInt(recs[0].plan.changeMsat), `seat ${i}: X plus fees left the reserves`);
  assert.ok(before - w.held(0) >= invoiceMsat + (contract - invoiceMsat) + fee, 'X, the gateway fee and the federation fee');
  // run again, on every seat, much later: nothing
  for (const s of w.seats) assert.deepEqual((await s.api.round({ height: 900 })).filter((x) => x.state !== PAYOUT.PAID), []);
  assert.deepEqual([w.fed.invoiceAsks, w.fed.submits.length, w.fed.payments.length], [1, 1, 1]);
});

test('a fail pays nothing: no passed vote (failed vote, failed signal, a vote 5 deep) - no LNURL asked, nothing signed; reserves too small - SHORT for good', async () => {
  const w = world();
  w.state.passed = [];                                      // the seat's own record has no vote decided passed
  for (const s of w.seats) assert.deepEqual(await s.api.round({ height: 900 }), []);
  assert.deepEqual([w.fed.invoiceAsks, w.fed.submits.length, w.fed.payments.length], [0, 0, 0]);
  const short = world({ amountSats: 200000n });             // 200,000 sat; the reserves hold 150,000
  const [r] = await short.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.SHORT);
  await short.deliver();
  assert.ok(short.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.SHORT));
  assert.match(short.seats[3].api.stateOf(PROPOSAL).why, /cannot pay 200000 sat: b1b1b1b1 holds 150000000 msat/);
  assert.deepEqual([short.fed.invoiceAsks, short.fed.submits.length, short.fed.payments.length], [0, 0, 0]);
  assert.deepEqual(await short.seats[0].api.round({ height: 9000 }), [], 'short for good');
});

test('a second attempt does not double-pay: a takeover after the coordinator\'s crash finds the record; a second plan is refused by every signer; spent outputs are not planned again', async () => {
  const w = world();
  await w.seats[0].api.round({ height: 500 });
  const paid = w.seats[0].api.stateOf(PROPOSAL);
  // the coordinator paid, and crashed before its PAID record reached anyone: the others hold it SENT
  for (const s of w.seats) s.inbox = s.inbox.filter((rec) => rec.state !== PAYOUT.PAID);
  await w.deliver();
  assert.equal(w.seats[1].api.stateOf(PROPOSAL).state, PAYOUT.SENT);
  assert.deepEqual(await w.seats[1].api.round({ height: 501 }), [], 'seat 1 waits its 2 blocks');
  const [t] = await w.seats[1].api.round({ height: 502 });
  assert.equal(t.state, PAYOUT.PAID, t.why);
  assert.deepEqual([w.fed.invoiceAsks, w.fed.submits.length, w.fed.payments.length], [1, 1, 1], 'no new plan, no new transaction, no second payment');
  // a second plan for the same proposal - another invoice, X + 1 sat, another LNURL, other inputs - refused by every signer
  const other = { ...paid.plan, invoice: invoiceOf(70000000n, rand(32), METADATA) };
  for (const bad of [other, { ...paid.plan, amountSats: '70001' }, { ...paid.plan, lnurl: 'evil@example.com' }, { ...paid.plan, refunds: [{ outpoint: w.reserveRows[2].outpoint, amountMsat: '50000000' }] }])
    for (const s of w.seats) {
      const c = await s.api.commit({ plan: bad, kind: 'tx' }); assert.equal(c.ok, false, `seat ${s.me.slice(0, 8)}`);
      const l = await s.api.learn({ proposal: PROPOSAL, planId: planIdOf(bad), state: PAYOUT.PLANNED, plan: bad }); assert.equal(l.ok, false, 'nor kept when told');
    }
  // a second proposal: its plan spends neither of the first one's outputs
  w.state.passed = [...w.state.passed, { id: 'bb'.repeat(32), lnurl: LNURL, amountSats: 30000n, decidableAt: 600 }];
  const [, second] = await w.seats[0].api.round({ height: 600 }).then((x) => [null, x.find((y) => y.id === 'bb'.repeat(32))]);
  assert.equal(second.state, PAYOUT.PAID, second.why);
  const p2 = w.seats[0].api.stateOf('bb'.repeat(32)).plan;
  assert.ok(p2.refunds.every((x) => !paid.plan.refunds.some((y) => y.outpoint === x.outpoint)), 'spent outputs are never planned again');
  assert.equal(w.fed.payments.length, 2);
});

test('the threshold: 4 signature shares do not make the reserve key\'s signature, 5 do; with 3 guardians down nothing is signed', async () => {
  const message = sha256(new TextEncoder().encode('payout'));
  const sign = (ids) => {
    const nonces = ids.map((id) => ({ hiding: nonceGenerate340(rand(32), DEAL.shares[id - 1].share), binding: nonceGenerate340(rand(32), DEAL.shares[id - 1].share) }));
    const commitments = ids.map((id, k) => ({ id, hiding: curve.pointFromScalar(nonces[k].hiding), binding: curve.pointFromScalar(nonces[k].binding) }));
    const shares = ids.map((id, k) => signShare340({ id, share: DEAL.shares[id - 1].share, groupPublicKey: KEY, nonces: nonces[k], message, commitments, curve }));
    return schnorr.verify(aggregate340({ commitments, message, groupPublicKey: KEY, shares, curve }).signature, message, KEY.subarray(1));
  };
  assert.equal(sign([1, 2, 3, 4]), false, '4 of 7');
  assert.equal(sign([1, 3, 4, 6, 7]), true, '5 of 7');
  const w = world({ down: [1, 2, 3] });
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.ok, false); assert.match(r.why, /4 of 5 guardian seats committed to the tx/);
  assert.deepEqual([w.fed.submits.length, w.fed.payments.length], [0, 0]);
});

test('a gateway that does not pay: the contract expires and is spent back to the reserve key - REFUNDED, recorded, nothing paid twice', async () => {
  const w = world({ gatewayFails: true });
  const before = w.held(0);
  const [a] = await w.seats[0].api.round({ height: 500 });
  assert.equal(a.ok, false); assert.match(a.why, /gateway did not pay yet/);
  assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.SENT);
  w.fed.height = 1000 + 144 + 1;                              // the outgoing contract has expired
  const [b] = await w.seats[0].api.round({ height: 700 });
  assert.equal(b.state, PAYOUT.REFUNDED, b.why);
  await w.deliver();
  assert.ok(w.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.REFUNDED));
  assert.equal(w.fed.payments.length, 0);
  assert.equal(w.fed.submits.length, 2, 'the payout transaction and its refund');
  const back = w.held(0);
  const plan = w.seats[0].api.stateOf(PROPOSAL).plan;
  const refunded = largestPayoutMsat(FEES, BigInt(plan.contractMsat));
  assert.equal(before - back, 100000000n - BigInt(plan.changeMsat) - refunded, 'the reserves hold the change and the refunded contract back');
  assert.ok(before - back < 3n * lnv2FeeMsat(FEES, BigInt(plan.contractMsat)), `only the federation's fees were lost: ${before - back} msat`);
  w.fed.gatewayFails = false;
  assert.deepEqual(await w.seats[0].api.round({ height: 900 }), [], 'no re-try after a refund in this slice');
  assert.equal(w.fed.payments.length, 0);
});

test('kanban #1154 on the reserves: a plan whose invoice another node signed is refused by every co-signer - nothing signed, nothing paid', async () => {
  // the coordinator's address answers it with invoices of an outsider's node (a coordinator that swaps in its own invoice): the
  // description hash and the amount are right, the payee is not the one the address answers every other seat with
  const OUT = new Uint8Array(32).fill(0x77);
  const evil = {
    invoiceFor: async (address, msat) => { const pre = rand(32), hash = sha256(pre); return { ok: true, invoice: invoiceOf(msat, hash, METADATA, OUT), paymentHash: toHex(hash), metadata: METADATA }; },
    payeeFor: async () => ({ ok: true, payee: toHex(secp256k1.getPublicKey(OUT, true)) }),
  };
  const w = world({ more: (i) => (i === 0 ? evil : {}) });
  const out = await w.seats[0].api.round({ height: 500 });
  await w.deliver();
  assert.equal(w.fed.submits.length, 0, 'no transaction');
  assert.equal(w.fed.payments.length, 0, 'no gateway payment');
  assert.ok(out.every((r) => r.state !== PAYOUT.PAID), JSON.stringify(out));
  assert.ok(w.fed.payeeAsks >= 4, `the co-signers read the address's own invoice (${w.fed.payeeAsks})`);
  // and the honest world still pays, each co-signer having read its own invoice's payee
  const ok = world();
  const [r] = await ok.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
  assert.ok(ok.fed.payeeAsks >= 4, `${ok.fed.payeeAsks} payee reads`);
});
