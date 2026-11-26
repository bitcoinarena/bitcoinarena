// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit 2026-11-25 a8 entry round 1, finding 1: a gap in #2819's fix. OrderBook.certify() first asks whether batch k is held CERTIFIED
// here already, and if so runs #recordId over the POSTED record - every sell through #sellStands (entry decode + Ed25519 verify) - before
// #check, so before #recordTooBig and before the leader's signature. Any stranger holding one order of the market (lockless is enough)
// signs thousands of sells with his own session key and POSTs /batch-certificate naming a k that is already certified at that seat.
// SAFE: such a certificate is refused without verifying thousands of sells (well under a second).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, bookBatchId, YES } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-a81', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `a81-${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });

test('a8 entry-1 #1: a certificate for an already certified batch is refused without verifying thousands of sells', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const post = async (d, path, body) => { const r = await fetch(`${base(d)}${path}`, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, t }; };
  try {
    // an honest batch k with one order, certified at seat d
    const X = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 40_000n } });
    const k = Math.floor(testNow() / B) + 1;
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const L = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const ids = [toHex(X.eid)];
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids });
    const record = { k: String(k), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const sigs = [];
    for (const d of w.nodes) { const r = await post(d, `/batch?round=${rid}`, record); if (r.status === 201 || r.status === 200) { const j = JSON.parse(r.t); sigs.push({ seat: j.seat, signature: j.signature }); } }
    const d = w.nodes.find((x) => x !== L);
    { const r = await post(d, `/batch-certificate?round=${rid}`, { record, sigs }); assert.ok(r.status === 201 || r.status === 200, r.t); }
    assert.equal(d.orderBook.batchState(w.rid, k), 'CERTIFIED');

    // the stranger's (here: the order holder's) forged certificate for the same k: 4000 of his own fresh sells, junk leader signature
    const N = 4000;
    const sells = [];
    for (let i = 0; i < N; i++) {
      const s = { entry: toHex(X.eid), outcome: YES, price: '10000', sharesMsat: '1000', nonce: String(5000 + i) };
      s.signature = toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: X.eid, outcome: YES, price: 10000n, sharesMsat: 1000n, nonce: BigInt(s.nonce) }), X.session));
      sells.push(s);
    }
    const forged = { k: String(k), orders: ids, cancels: [], sells, leader: toHex(L.round.pubkey), leaderSig: '11'.repeat(64) };
    const body = JSON.stringify({ record: forged, sigs: [] });
    const t0 = performance.now();
    const r = await fetch(`${base(d)}/batch-certificate?round=${rid}`, { method: 'POST', body });
    const why = (await r.text()).trim();
    const ms = Math.round(performance.now() - t0);
    console.log('  a8 entry-1 #1:', JSON.stringify({ sells: N, bodyBytes: body.length, status: r.status, why: why.slice(0, 120), ms }));
    assert.notEqual(r.status, 201);
    // SAFE: an honest batch carries at most nodes x MAX_PROPOSAL_SELLS = 1792 sells; this is refused by count/leader first
    assert.ok(ms < 1000, `one forged certificate for an already certified batch held the seat ${ms} ms (${N} sell signatures verified before the leader's)`);
  } finally { await w.close(); }
});
