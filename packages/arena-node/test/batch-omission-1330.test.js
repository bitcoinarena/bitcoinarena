// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1330 (§0A.7b.5 RULED 2026-11-07, #1313): "Each seat signs its answer, and refuses a batch that leaves out an order it reported before the
// cutoff; a leader that then cannot reach the threshold voids and the next leader takes the union." Measured on seven seats: a leader that leaves out
// an order every seat reported gets no signature; the honest leader's batch, the union of the proposals, carries it and is certified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { proposalDigest } from '../src/order-batch.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-1330', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `o${n}`, key: b32(0xb0 + n), worldSecret: b32(0) });

test('#1330 a leader that leaves out a reported order reaches no threshold; the next leader\'s union carries it - seven seats', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  try {
    const A = await lockAndPlay(w, player(0), { noMarks: true, pick: YES, order: { price: 60000n } });
    const Bo = await lockAndPlay(w, player(1), { noMarks: true, pick: NO, order: { price: 45000n } });
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    // every seat answers its proposal for batch k past the cutoff - signed, and it remembers what it reported
    const proposals = await Promise.all(w.nodes.map(async (d) => (await fetch(`${base(d)}/batch-proposal?round=${rid}&k=${k}`)).json()));
    const signedOk = proposals.every((p) => p.signature && schnorr.verify(fromHex(p.signature), proposalDigest(w.rid, k, p.orders), fromHex(p.seat)));
    const L = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    // THE OMITTING LEADER: batch k with A's order alone, B's left out
    const orders = [toHex(A.eid)];
    const record = { k: String(k), orders, cancels: [], sells: [], leader: toHex(L.round.pubkey) };
    record.leaderSig = toHex(schnorr.sign(bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: orders }), L.round.identity.secret));
    const answers = await Promise.all(w.nodes.map(async (d) => { const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) }); return { ok: r.ok, why: r.ok ? '' : (await r.text()).trim() }; }));
    const omittingSigned = answers.filter((a) => a.ok).length;
    // THE NEXT HONEST BATCH: the union of the proposals, led as the seats lead
    const k2 = Math.floor(testNow() / B);
    while (testNow() < (k2 + 1) * B + 20) await wait(5);
    const L2 = w.nodes.find((d) => d.orderBook.leads(w.rid, k2));
    const honest = await L2.orderBook.lead(w.rid, k2);
    const carried = !!(w.nodes[0].orderBook.standing(w.rid, Bo.eid) || {}).filled || (honest.record && honest.record.orders.includes(toHex(Bo.eid)));
    console.log('  MEASURED #1330:', JSON.stringify({ proposalsSigned: signedOk, omittingLeaderSigned: `${omittingSigned} of 7 (threshold ${w.needed})`,
      refusedWhy: (answers.find((a) => !a.ok) || {}).why?.replace(/[0-9a-f]{16}/g, '<id>').slice(0, 120), honestCertified: honest.certified, carriesOmitted: carried }));
    assert.equal(signedOk, true, 'a proposal answer is not signed by its seat');
    assert.ok(omittingSigned < w.needed, 'the batch that left out a reported order reached the threshold');
    assert.equal(honest.ok, true, honest.why);
    assert.ok(carried, 'the next batch did not carry the order the first one left out');
  } finally { await w.close(); }
});
