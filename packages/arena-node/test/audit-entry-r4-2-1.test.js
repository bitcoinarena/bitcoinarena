// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit 2026-11-19 r4, entry round 2, finding 1: ONE SEAT (the batch leader) MAKES A BATCH BOTH CERTIFIED AND VOID AT HONEST SEATS.
// A certificate needs `needed` signatures, a void needs n - needed + 1 declines: the two quorums share only ONE seat, and that seat may
// be the faulty one. POST /batch-void (applyVoid) counts the leader's own decline although the leader signed a set of k (its leaderSig is
// in the very record the judging seat holds SIGNED). So the leader of batch k, alone:
//   - signs a set of k and has it signed by itself and four honest seats (5 of 7: certified), hands the certificate to three of them;
//   - asks the two seats it never sent the set for their decline (POST /batch-void-ask, past the next cutoff), signs a decline itself,
//     and POSTs /batch-void with those three declines to the fourth signer and the two decliners.
// Three honest seats hold k CERTIFIED, three hold it VOID, for good (neither state moves again): no 5 honest seats share one book, so
// the market's settlement forms only if the leader joins a side - one seat of 7 freezes or picks the book.
// SAFE: after any one seat's doing, no honest seat holds batch k VOID while another holds it CERTIFIED.
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
import { bookBatchId, batchDeclineId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-r4e2', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `r4e2-${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });

test('audit r4 entry-2 #1: one batch leader cannot leave batch k CERTIFIED at some honest seats and VOID at others', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  const untilCutoff = async (k, extra = 20) => { while (testNow() < (k + 1) * B + extra) await wait(5); };
  const post = async (d, path, body) => { const r = await fetch(`${base(d)}${path}`, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, t }; };
  try {
    const R = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 70000n } });
    const S = await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 35000n } });
    const k = Math.floor(testNow() / B) + 1;
    await untilCutoff(k);
    const L = leaderOf(k);
    const honest = w.nodes.filter((d) => d !== L);
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids });
    const record = { k: String(k), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    // the leader and four honest seats sign the set: 5 of 7
    const signers = [L, ...honest.slice(0, 4)];
    const sigs = [];
    for (const d of signers) {
      const r = await post(d, `/batch?round=${rid}`, record);
      assert.equal(r.status, 201, r.t);
      const j = JSON.parse(r.t); sigs.push({ seat: j.seat, signature: j.signature });
    }
    // the certificate, to the leader and three of the honest signers only
    for (const d of [L, ...honest.slice(0, 3)]) { const r = await post(d, `/batch-certificate?round=${rid}`, { record, sigs }); assert.ok(r.status === 201 || r.status === 200, r.t); }
    // past the next cutoff: the leader's own signed void ask to the two seats it never sent the set - they decline (ABSENT)
    await untilCutoff(k + 1);
    const ask = L.orderBook.voidAskFor(w.rid, k, record);
    const declines = [];
    for (const d of honest.slice(4)) {
      const r = await post(d, `/batch-void-ask?round=${rid}&k=${k}`, ask);
      assert.equal(r.status < 300, true, r.t);
      const j = JSON.parse(r.t); assert.ok(j.declined, r.t);
      declines.push({ seat: j.seat, signature: j.declined });
    }
    // and its own decline, though it signed (and led) the certified set
    declines.push({ seat: toHex(L.round.pubkey), signature: toHex(schnorr.sign(batchDeclineId({ roundId: w.rid, k: BigInt(k) }), L.round.identity.secret)) });
    const voided = [];
    for (const d of honest.slice(3)) voided.push((await post(d, `/batch-void?round=${rid}`, { k: String(k), declines })).status);
    const states = honest.map((d) => d.orderBook.batchState(w.rid, k));
    console.log('  FACTS (r4 entry-2 #1):', JSON.stringify({ k, needed: w.needed, voidPosts: voided, honestStates: states }));
    const certified = states.filter((s) => s === 'CERTIFIED').length, voidN = states.filter((s) => s === 'VOID').length;
    assert.ok(!(certified > 0 && voidN > 0),
      `one seat split the honest seats on batch ${k}: ${certified} hold it CERTIFIED and ${voidN} hold it VOID (${states.join(', ')})`);
  } finally { await w.close(); }
});
