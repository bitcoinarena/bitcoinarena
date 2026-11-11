// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1159: a reserve payout's PLANNED had no way out. A plan that stopped standing (here: the gateway's fee moved) held its inputs
// for good and every other plan got 409; an outsider could split the signers with a valid plan of its own; a stop after the federation
// took the transaction left the row PLANNED (and a stop after the refund left it SENT). Now: a plan expires PLAN_EXPIRY_BLOCKS after a
// seat first held it (only when the federation shows its inputs unspent) and the turn's guardian plans the next attempt; only the turn's
// guardian opens a plan, by a signed ask; the signed transaction and the refund are persisted (SUBMITTING, REFUNDING) before they go in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as rp from '../src/reserve-payout.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { world, invoiceOf, rand, NODE_KEYS, SECRET_OF, METADATA, PROPOSAL, GW } from './reserve-payout-fixture.js';

// read off the module as a namespace: the same file runs against the source before the fix (the measure)
const { PAYOUT, planIdOf } = rp;
const askDigestOf = rp.askDigestOf || (() => new Uint8Array(32));
const pass = async (w, heights) => { for (const h of heights) for (const s of w.seats) { try { await s.api.round({ height: h }); } catch { /* a pass that throws: the next one runs */ } } await w.deliver(); };
const heights = (from, to) => Array.from({ length: (to - from) / 2 + 1 }, (_, k) => from + 2 * k);
const states = (w) => w.seats.map((s) => (s.api.stateOf(PROPOSAL) || {}).state || '-').join(',');

test('#1159 a plan that stops standing expires: the gateway\'s fee moved after 4 of 5 committed - the next attempt pays once', async () => {
  const w = world({ down: [1, 2, 3] });
  const [a] = await w.seats[0].api.round({ height: 500 });
  assert.equal(a.ok, false); assert.match(a.why, /4 of 5/);
  // the gateway's fee moves; the three seats come back
  w.port.gateways = async () => ({ gateways: [{ ...GW, sendFeeDefault: { baseMsat: 3000, ppm: 1000 } }], height: w.fed.height });
  for (const s of w.seats) s.down = false;
  await pass(w, heights(502, 510));
  assert.equal(w.fed.payments.length, 0, 'nothing before the plan expired');
  await pass(w, heights(512, 540));
  assert.equal(w.fed.payments.length, 1, `paid once (${states(w)})`);
  assert.equal(w.fed.submits.length, 1, 'one transaction');
  assert.ok(w.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.PAID), states(w));
  const plan = w.seats[0].api.stateOf(PROPOSAL).plan;
  assert.ok(rp.attemptOf && rp.attemptOf(plan) >= 1, 'a later attempt, its own nonce');
  assert.equal(plan.nonce, toHex(rp.nonceOf(PROPOSAL, rp.attemptOf(plan))));
});

test('#1159 an expired plan whose inputs the federation shows spent is not expired: it waits for the record', async () => {
  const w = world();
  await w.seats[0].api.round({ height: 500 });
  // seat 6 never committed and missed every record; it learns the PLANNED one only
  const planned = w.seats[6].inbox.find((x) => x.state === PAYOUT.PLANNED);
  w.seats[6].inbox.length = 0;
  assert.equal((await w.seats[6].api.learn(planned)).ok, true);
  await w.seats[6].api.round({ height: 530 });
  const r = w.seats[6].api.stateOf(PROPOSAL);
  assert.notEqual(r.state, PAYOUT.EXPIRED, 'the plan went in: its inputs are not freed');
  assert.equal(w.seats[6].api.spent().size, 2);
});

test('#1159 an outsider\'s plan does not split the signers: unsigned, or from a guardian whose turn it is not, it opens nothing', async () => {
  const w = world();
  // a valid alternative: the same proposal, another invoice from its LNURL
  const ref = world(); await ref.seats[0].api.round({ height: 500 });
  const alt = { ...ref.seats[0].api.stateOf(PROPOSAL).plan, invoice: invoiceOf(70000000n, sha256(rand(32)), METADATA) };
  alt.paymentHash = toHex(sha256(rand(32)));
  const bad = { ...alt, invoice: invoiceOf(70000000n, Buffer.from(alt.paymentHash, 'hex'), METADATA) };
  for (const s of w.seats.slice(1, 4)) await s.api.round({ height: 500 }).catch(() => {});   // every seat has read the height
  for (const s of w.seats.slice(1, 4)) {
    const c = await s.api.commit({ plan: bad, kind: 'tx' });
    assert.equal(c.ok, false, 'unsigned');
    const from = NODE_KEYS[5], ask = { ask: 'commit', kind: 'tx', planId: planIdOf(bad), txid: null, list: null, from };
    const g = await s.api.commit({ plan: bad, kind: 'tx', from, sig: toHex(schnorr.sign(askDigestOf(ask), SECRET_OF.get(from))) });
    assert.equal(g.ok, false, 'not the turn\'s guardian'); assert.match(String(g.why), /turn/);
    assert.equal(s.api.stateOf(PROPOSAL), null);
  }
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.PAID, r.why);
});

test('#1159 a stop after the federation took the transaction: the signed transaction was kept first, the next pass finds it and pays', async () => {
  const w = world();
  // the federation takes the transaction, and its answer is lost: the tool times out and the federation cannot be read until the next pass
  const { settle, status } = w.port;
  let lose = true;
  w.port.settle = async (a) => { const r = await settle(a); if (a.signature && lose) { lose = false; w.down = true; throw new Error('the tool timed out'); } return r; };
  w.port.status = async (a) => { if (w.down) throw new Error('the federation does not answer'); return status(a); };
  let first; try { first = await w.seats[0].api.round({ height: 500 }); } catch (e) { first = e; }
  assert.equal(w.fed.submits.length, 1, 'the federation took it');
  const kept = w.seats[0].api.stateOf(PROPOSAL);
  assert.equal(kept.state, PAYOUT.SUBMITTING, 'its id and signature were persisted before it went in');
  w.down = false;
  const [b] = await w.seats[0].api.round({ height: 501 });
  assert.equal(b.state, PAYOUT.PAID, b.why);
  assert.deepEqual([w.fed.submits.length, w.fed.payments.length], [1, 1]);
  void first;
});

test('#1159 a stop after the refund went in: REFUNDING was kept first, the next pass records REFUNDED and keeps the refund\'s row', async () => {
  const w = world({ gatewayFails: true });
  await w.seats[0].api.round({ height: 500 });
  assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.SENT);
  w.fed.height = 1000 + 144 + 1;
  const { settle, status } = w.port;
  let lose = true;
  w.port.settle = async (a) => { const r = await settle(a); if (a.signature && lose) { lose = false; w.down = true; throw new Error('the tool timed out'); } return r; };
  w.port.status = async (a) => { if (w.down) throw new Error('the federation does not answer'); return status(a); };
  try { await w.seats[0].api.round({ height: 700 }); } catch { /* the answer was lost */ }
  assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.REFUNDING);
  w.down = false;
  const [b] = await w.seats[0].api.round({ height: 702 });
  assert.equal(b.state, PAYOUT.REFUNDED, b.why);
  const rec = w.seats[0].api.stateOf(PROPOSAL);
  assert.ok(w.state.kept.some((k) => k.seat === 0 && k.row.outpoint === `${rec.refundTxid}:0`), 'the refunded contract is a reserve row again');
  assert.equal(w.fed.submits.length, 2, 'the payout and one refund');
});

// KANBAN #1229 (audit 3 #1210 FIXES-10): a SUBMITTING row's kept signature was handed in on every pass, at any height - a coordinator that
// stopped for 12 blocks came back and handed in attempt 0 after the co-signers had expired it and paid a later attempt from other inputs: a
// second contract nobody can authorise or refund, or a leaderboard paid twice. Now a SUBMITTING attempt is handed in only before
// PLAN_EXPIRY_BLOCKS - SUBMIT_CUTOFF_BLOCKS; past that, its output 0 not in the federation, it goes EXPIRED and its signature is dropped.
test('#1229 a signed attempt not taken is handed in again inside its window, never once its plan is due to expire', async () => {
  for (const at of [505, 510]) {
    const w = world();
    const { settle } = w.port;
    let fail = true;
    w.port.settle = async (a) => { if (a.signature && fail) { fail = false; throw new Error('the tool timed out before the federation took it'); } return settle(a); };
    try { await w.seats[0].api.round({ height: 500 }); } catch { /* the hand-in failed */ }
    assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.SUBMITTING);
    assert.equal(w.fed.submits.length, 0);
    let b; try { [b] = await w.seats[0].api.round({ height: at }); } catch (e) { b = { state: 'threw', why: e.message }; }
    const kept = w.seats[0].api.stateOf(PROPOSAL);
    console.log(`  #1229 the coordinator back at ${at}: ${kept.state}, ${w.fed.submits.length} handed in`);
    if (at === 505) assert.equal(w.fed.submits.length, 1, 'inside its window the signed attempt is handed in again');
    else { assert.equal(w.fed.submits.length, 0, 'a signed attempt handed in when its plan was due to expire'); assert.equal(kept.state, PAYOUT.EXPIRED); }
  }
});
